// Checks that annotation failures reach the AI as MCP errors (isError: true).
// Starts the relay and the MCP server from source, and answers commands with a
// pretend Figma plugin, so no Figma app is needed.
// Usage: bun scripts/check-annotation-errors.ts [repo root]
import { join } from "path";

const root = process.argv[2] ?? process.cwd();
const RELAY = "ws://localhost:3055";
const CHANNEL = "annotation-check";
const DEEP_ID = "I1:2;3:4;5:6;7:8";
const OK_ID = "1:2";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || !detail ? "" : ` (${detail})`}`);
};

const portFree = await new Promise<boolean>((res) => {
  const ws = new WebSocket(RELAY);
  ws.onopen = () => { ws.close(); res(false); };
  ws.onerror = () => res(true);
});
if (!portFree) {
  console.log("FAIL port 3055 is already in use; stop the running relay first");
  process.exit(1);
}

const relay = Bun.spawn(["bun", join(root, "src/socket.ts")], { stdout: "ignore", stderr: "ignore" });
await sleep(1500);

// Pretend plugin: replies the same way ui.html does (result, or error + empty result).
const plugin = new WebSocket(RELAY);
await new Promise((r) => (plugin.onopen = r));
plugin.send(JSON.stringify({ type: "join", channel: CHANNEL, id: "plugin-join" }));
const reply = (id: string, body: object) =>
  plugin.send(JSON.stringify({ id, type: "message", channel: CHANNEL, message: { id, ...body } }));
plugin.onmessage = (e) => {
  const data = JSON.parse(e.data as string);
  const msg = data.message;
  if (!msg?.command) return;
  const p = msg.params ?? {};
  switch (msg.command) {
    case "get_annotations":
      if (p.nodeId === DEEP_ID) return reply(msg.id, { error: `Node not found: ${p.nodeId}`, result: {} });
      return reply(msg.id, { result: { nodeId: p.nodeId, name: "ok", annotations: [] } });
    case "set_annotation":
      if (p.nodeId === DEEP_ID) return reply(msg.id, { result: { success: false, error: `Node not found: ${p.nodeId}` } });
      return reply(msg.id, { result: { success: true, nodeId: p.nodeId, name: "ok", annotations: [] } });
    case "set_multiple_annotations": {
      const results = p.annotations.map((a: any) =>
        a.nodeId === DEEP_ID
          ? { success: false, nodeId: a.nodeId, error: `Node not found: ${a.nodeId}` }
          : { success: true, nodeId: a.nodeId });
      const applied = results.filter((r: any) => r.success).length;
      return reply(msg.id, {
        result: {
          success: applied > 0,
          annotationsApplied: applied,
          annotationsFailed: results.length - applied,
          totalAnnotations: results.length,
          results,
        },
      });
    }
  }
};
await sleep(300);

const mcp = Bun.spawn(["bun", join(root, "src/talk_to_figma_mcp/server.ts")], {
  stdin: "pipe", stdout: "pipe", stderr: "ignore",
});
const pending = new Map<number, (m: any) => void>();
(async () => {
  const reader = mcp.stdout.getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += new TextDecoder().decode(value);
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      try {
        const m = JSON.parse(line);
        if (m.id != null && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); }
      } catch {}
    }
  }
})();
let nextId = 1;
const rpc = (method: string, params: object) =>
  new Promise<any>((res, rej) => {
    const id = nextId++;
    pending.set(id, res);
    mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    mcp.stdin.flush();
    setTimeout(() => rej(new Error(`${method} timed out`)), 15000);
  });
const call = async (name: string, args: object) => (await rpc("tools/call", { name, arguments: args })).result;

try {
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "check", version: "1" } });
  mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  await sleep(1000);
  const joined = await call("join_channel", { channel: CHANNEL });
  check("MCP server joined the pretend plugin's channel", /Successfully joined/.test(joined?.content?.[0]?.text ?? ""));

  const label = "check";
  let r = await call("set_annotation", { nodeId: DEEP_ID, labelMarkdown: label });
  check("set_annotation failure on deep node is an error", r?.isError === true, JSON.stringify(r));
  r = await call("set_annotation", { nodeId: OK_ID, labelMarkdown: label });
  check("set_annotation success is not an error", r?.isError !== true, JSON.stringify(r));

  r = await call("get_annotations", { nodeId: DEEP_ID });
  check("get_annotations failure on deep node is an error", r?.isError === true, JSON.stringify(r));
  r = await call("get_annotations", { nodeId: OK_ID });
  check("get_annotations success is not an error", r?.isError !== true, JSON.stringify(r));

  r = await call("set_multiple_annotations", {
    nodeId: OK_ID,
    annotations: [{ nodeId: OK_ID, labelMarkdown: label }, { nodeId: DEEP_ID, labelMarkdown: label }],
  });
  check("set_multiple_annotations with a failed node is an error", r?.isError === true, JSON.stringify(r));
  check("set_multiple_annotations names the failed node", JSON.stringify(r).includes(DEEP_ID));
  r = await call("set_multiple_annotations", { nodeId: OK_ID, annotations: [{ nodeId: OK_ID, labelMarkdown: label }] });
  check("set_multiple_annotations all-success is not an error", r?.isError !== true, JSON.stringify(r));

  relay.kill();
  await sleep(1000);
  r = await call("set_annotation", { nodeId: OK_ID, labelMarkdown: label });
  check("set_annotation with the relay down is an error", r?.isError === true, JSON.stringify(r).slice(0, 200));
} catch (e) {
  check("check ran to completion", false, String(e));
} finally {
  mcp.kill();
  relay.kill();
}
process.exit(failed ? 1 : 0);
