// Checks that set_annotation / get_annotations report plugin failures as MCP errors
// (isError: true) instead of looking like successes, using a fake Figma plugin.
// Usage: bun scripts/check-annotation-errors.ts [path/to/server.ts]
import { readFileSync } from "fs";

const root = new URL("..", import.meta.url).pathname;
const serverPath = process.argv[2] ?? `${root}src/talk_to_figma_mcp/server.ts`;
const CHANNEL = "check-annotation-errors";
const DEEP_ID = "I1:1;2:2;3:3;4:4";
const OK_ID = "1:1";
let failures = 0;
const check = (name: string, ok: boolean) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
  if (!ok) failures++;
};

const pluginCode = readFileSync(`${root}src/cursor_mcp_plugin/code.js`, "utf8");
check("plugin never calls sync figma.getNodeById()", !/figma\.getNodeById\s*\(/.test(pluginCode));

const relay = Bun.spawn(["bun", `${root}src/socket.ts`], { stdout: "ignore", stderr: "ignore" });
await Bun.sleep(1500);

const plugin = new WebSocket("ws://localhost:3055");
await new Promise((r) => plugin.addEventListener("open", r, { once: true }));
plugin.send(JSON.stringify({ type: "join", channel: CHANNEL }));
plugin.addEventListener("message", (e) => {
  const data = JSON.parse(String(e.data));
  if (data.type !== "broadcast" || !data.message?.command) return;
  const { id, command, params } = data.message;
  const reply = (message: object) =>
    plugin.send(JSON.stringify({ id, type: "message", channel: CHANNEL, message: { id, ...message } }));
  const found = params?.nodeId === OK_ID;
  if (command === "set_annotation") {
    reply({ result: found ? { success: true, nodeId: OK_ID } : { success: false, error: `Node not found: ${params.nodeId}` } });
  } else if (command === "get_annotations") {
    reply(found ? { result: { nodeId: OK_ID, annotations: [] } } : { error: `Node not found: ${params.nodeId}`, result: {} });
  }
});

const mcp = Bun.spawn(["bun", serverPath], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
const responses = new Map<number, any>();
(async () => {
  const reader = mcp.stdout.getReader();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += new TextDecoder().decode(value);
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      try {
        const m = JSON.parse(line);
        if (m.id !== undefined) responses.set(m.id, m);
      } catch {}
    }
  }
})();
let nextId = 1;
const call = async (method: string, params: object) => {
  const id = nextId++;
  mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  mcp.stdin.flush();
  const deadline = Date.now() + 15000;
  while (!responses.has(id) && Date.now() < deadline) await Bun.sleep(50);
  return responses.get(id);
};
const tool = async (name: string, args: object) => (await call("tools/call", { name, arguments: args }))?.result;

try {
  await call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "check", version: "1" } });
  mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  await Bun.sleep(1000);
  const joined = await tool("join_channel", { channel: CHANNEL });
  check("join_channel succeeds", !!joined && !joined.isError);

  const setFail = await tool("set_annotation", { nodeId: DEEP_ID, labelMarkdown: "x" });
  check("set_annotation on missing deep node is reported as an error", setFail?.isError === true);
  const setOk = await tool("set_annotation", { nodeId: OK_ID, labelMarkdown: "x" });
  check("set_annotation on found node is not an error", !!setOk && !setOk.isError);
  const getFail = await tool("get_annotations", { nodeId: DEEP_ID });
  check("get_annotations on missing deep node is reported as an error", getFail?.isError === true);
  const getOk = await tool("get_annotations", { nodeId: OK_ID });
  check("get_annotations on found node is not an error", !!getOk && !getOk.isError);
} finally {
  mcp.kill();
  plugin.close();
  relay.kill();
}
process.exit(failures ? 1 : 0);
