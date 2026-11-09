// Checks that a channel name containing CR/LF cannot forge a log line in the
// relay (src/socket.ts) or the MCP server (src/talk_to_figma_mcp/server.ts).
// Starts both on port 3055, so nothing else may be using that port.
const root = new URL("..", import.meta.url).pathname;
const FAKE = "[ERROR] FAKE-LOG-ENTRY";
const BAD = `tofu\r\n${FAKE}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function capture(stream: ReadableStream<Uint8Array>) {
  const out = { text: "" };
  (async () => {
    for await (const chunk of stream) out.text += new TextDecoder().decode(chunk);
  })();
  return out;
}

const relay = Bun.spawn(["bun", "src/socket.ts"], { cwd: root, stdout: "pipe", stderr: "pipe" });
const relayOut = capture(relay.stdout);
const relayErr = capture(relay.stderr);
await sleep(1500);

// 1. Talk to the relay directly with a crafted channel name.
const ws = new WebSocket("ws://localhost:3055");
const relayReplies: any[] = [];
ws.onmessage = (e) => relayReplies.push(JSON.parse(e.data as string));
await new Promise((r) => (ws.onopen = r));
ws.send(JSON.stringify({ type: "join", channel: BAD, id: "1" }));
ws.send(JSON.stringify({ type: "message", channel: BAD, id: "2", message: { command: "ping" } }));
await sleep(500);
ws.close();

// 2. Call join_channel through the MCP server, with a crafted name and then a valid one.
const mcp = Bun.spawn(["bun", "src/talk_to_figma_mcp/server.ts"], { cwd: root, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
const mcpErr = capture(mcp.stderr);
const send = (o: any) => { mcp.stdin.write(JSON.stringify(o) + "\n"); mcp.stdin.flush(); };
const results: Record<number, any> = {};
(async () => {
  let buf = "";
  for await (const chunk of mcp.stdout) {
    buf += new TextDecoder().decode(chunk);
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      try { const m = JSON.parse(line); if (m.id) results[m.id] = m; } catch {}
    }
  }
})();
const waitFor = async (cond: () => boolean, ms = 10000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await sleep(100);
};
send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "check", version: "1" } } });
send({ jsonrpc: "2.0", method: "notifications/initialized" });
await waitFor(() => mcpErr.text.includes("Connected to Figma socket server"));
send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "join_channel", arguments: { channel: BAD } } });
await waitFor(() => !!results[2]);
send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "join_channel", arguments: { channel: "valid_room-1" } } });
await waitFor(() => !!results[3]);
await sleep(500);
mcp.kill();
relay.kill();

const forged = (text: string) => text.split(/\r\n|\r|\n/).some((l) => l.trimStart().startsWith(FAKE));
const text = (id: number) => results[id]?.result?.content?.[0]?.text ?? "";
const checks: [string, boolean][] = [
  ["relay rejects crafted channel name on join", relayReplies.some((m) => m.type === "error" && /Invalid channel name/.test(m.message))],
  ["relay log has no forged line", !forged(relayOut.text + relayErr.text)],
  ["join_channel rejects crafted channel name", text(2).includes("Invalid channel name")],
  ["MCP server log has no forged line", !forged(mcpErr.text)],
  ["join_channel still accepts a valid name", text(3) === "Successfully joined channel: valid_room-1"],
  ["valid join is logged by MCP server", mcpErr.text.includes("[INFO] Joined channel: valid_room-1")],
  ["valid join is logged by relay", relayOut.text.includes('Client joined channel "valid_room-1"')],
];
let failed = 0;
for (const [name, ok] of checks) { console.log(`${ok ? "PASS" : "FAIL"} ${name}`); if (!ok) failed++; }
process.exit(failed ? 1 : 0);
