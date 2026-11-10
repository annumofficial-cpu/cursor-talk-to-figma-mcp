// Checks that set_annotation / get_annotations failures on deeply nested node IDs
// reach the AI as MCP errors (isError: true) instead of looking like successes.
// Runs without Figma: starts the relay, a fake plugin, and the MCP server.
// Uses port 3055, so don't run it at the same time as other relay checks.
// Usage: bun scripts/check-annotation-errors.ts [repo root]
import { readFileSync } from "fs";
import { join } from "path";

const root = process.argv[2] ?? process.cwd();
const CHANNEL = "check-annotation-errors";
const DEEP_ID = "I10:1;20:2;30:3;40:4";
const OK_ID = "1:2";
let failed = false;
const check = (name: string, ok: boolean) => {
  console.log((ok ? "PASS " : "FAIL ") + name);
  if (!ok) failed = true;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 1. The plugin must look nodes up with the async API (works for nested instance IDs).
const plugin = readFileSync(join(root, "src/cursor_mcp_plugin/code.js"), "utf8");
check("plugin never calls the synchronous figma.getNodeById", !/\bgetNodeById\s*\(/.test(plugin));
for (const fn of ["getAnnotations", "setAnnotation"]) {
  const body = plugin.slice(plugin.indexOf(`async function ${fn}(`)).split(/\nasync function /)[1] ?? "";
  check(`${fn} uses figma.getNodeByIdAsync`, body.includes("figma.getNodeByIdAsync(nodeId)"));
}

// 2. End to end with a fake plugin that fails for the deeply nested ID.
const relay = Bun.spawn(["bun", join(root, "src/socket.ts")], { stdout: "ignore", stderr: "ignore" });
const server = Bun.spawn(["bun", join(root, "src/talk_to_figma_mcp/server.ts")], {
  stdin: "pipe", stdout: "pipe", stderr: "ignore",
});
const cleanup = () => { server.kill(); relay.kill(); };

try {
  await sleep(1500);
  const seenIds: Record<string, string[]> = { set_annotation: [], get_annotations: [] };
  const fake = new WebSocket("ws://localhost:3055");
  await new Promise((res, rej) => { fake.onopen = res; fake.onerror = rej; });
  fake.onmessage = (e) => {
    const msg = JSON.parse(String(e.data));
    const req = msg.type === "broadcast" ? msg.message : null;
    if (!req?.command || !(req.command in seenIds)) return;
    const nodeId = req.params?.nodeId;
    seenIds[req.command].push(nodeId);
    const notFound = nodeId === DEEP_ID;
    let message: any;
    if (req.command === "set_annotation") {
      message = { id: req.id, result: notFound
        ? { success: false, error: `Node not found: ${nodeId}` }
        : { success: true, nodeId, annotations: [{ labelMarkdown: "hi" }] } };
    } else {
      message = notFound
        ? { id: req.id, error: `Node not found: ${nodeId}`, result: {} }
        : { id: req.id, result: { nodeId, annotations: [] } };
    }
    fake.send(JSON.stringify({ id: req.id, type: "message", channel: CHANNEL, message }));
  };
  fake.send(JSON.stringify({ type: "join", channel: CHANNEL, id: "fake-plugin" }));

  const pending = new Map<number, (m: any) => void>();
  (async () => {
    const reader = server.stdout.getReader();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += new TextDecoder().decode(value);
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        try { const m = JSON.parse(line); if (m.id && pending.has(m.id)) pending.get(m.id)!(m); } catch {}
      }
    }
  })();
  let nextId = 1;
  const rpc = (method: string, params: any) => new Promise<any>((res) => {
    const id = nextId++;
    const timer = setTimeout(() => res({ timeout: true }), 15000);
    pending.set(id, (m) => { clearTimeout(timer); res(m); });
    server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    server.stdin.flush();
  });
  const call = async (name: string, args: any) => (await rpc("tools/call", { name, arguments: args })).result;

  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "check", version: "1" } });
  server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  await sleep(1000);
  const joined = await call("join_channel", { channel: CHANNEL });
  check("MCP server joined the channel", JSON.stringify(joined ?? "").includes("Successfully joined"));

  const setDeep = await call("set_annotation", { nodeId: DEEP_ID, labelMarkdown: "hi" });
  check("set_annotation failure on deeply nested node is reported as an error", setDeep?.isError === true);
  const setOk = await call("set_annotation", { nodeId: OK_ID, labelMarkdown: "hi" });
  check("set_annotation success is not reported as an error", !!setOk && setOk.isError !== true);
  const getDeep = await call("get_annotations", { nodeId: DEEP_ID });
  check("get_annotations failure on deeply nested node is reported as an error", getDeep?.isError === true);
  const getOk = await call("get_annotations", { nodeId: OK_ID });
  check("get_annotations success is not reported as an error", !!getOk && getOk.isError !== true);

  for (const cmd of Object.keys(seenIds)) {
    check(`${cmd} passes the deeply nested node ID to the plugin unchanged`, seenIds[cmd].includes(DEEP_ID));
  }
  fake.close();
} catch (e) {
  check(`check ran without crashing (${e})`, false);
} finally {
  cleanup();
}
process.exit(failed ? 1 : 0);
