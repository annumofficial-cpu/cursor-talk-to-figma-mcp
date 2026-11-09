// Checks that a channel name containing a new line cannot forge a log line in
// the relay (src/socket.ts) or the MCP server (src/talk_to_figma_mcp/server.ts).
// Starts both on port 3055, so nothing else may be using that port.
const root = new URL("..", import.meta.url).pathname;
const FAKE = "[ERROR] FAKE-LOG-ENTRY";
const CRAFTED = [`tofu\r\n${FAKE}`, `tofu\n${FAKE}`, `tofu\r${FAKE}`];
const VALID = "valid_room-1";
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

// 1. Send crafted channel names straight to the relay, on both join and message.
const sock = new WebSocket("ws://localhost:3055");
const relayReplies: any[] = [];
sock.onmessage = (e) => relayReplies.push(JSON.parse(e.data as string));
await new Promise((r) => (sock.onopen = r));
for (const channel of CRAFTED) {
  sock.send(JSON.stringify({ type: "join", channel, id: "j" }));
  sock.send(JSON.stringify({ type: "message", channel, id: "m", message: { command: "ping" } }));
}
await sleep(500);
sock.close();

// 2. Call join_channel through the MCP server with crafted names, then a valid one.
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
const callJoin = async (id: number, channel: string) => {
  send({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "join_channel", arguments: { channel } } });
  await waitFor(() => !!results[id]);
};
send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "check", version: "1" } } });
send({ jsonrpc: "2.0", method: "notifications/initialized" });
await waitFor(() => mcpErr.text.includes("Connected to Figma socket server"));
for (let i = 0; i < CRAFTED.length; i++) await callJoin(10 + i, CRAFTED[i]);
await callJoin(20, VALID);
await sleep(500);
mcp.kill();
relay.kill();

const forged = (text: string) => text.split(/\r\n|\r|\n/).some((l) => l.trimStart().startsWith(FAKE));
const text = (id: number) => results[id]?.result?.content?.[0]?.text ?? "";
const rejected = relayReplies.filter((m) => m.type === "error" && /Invalid channel name/.test(m.message)).length;
const checks: [string, boolean][] = [
  ["relay rejects every crafted join and message", rejected === CRAFTED.length * 2],
  ["relay log has no forged line", !forged(relayOut.text + relayErr.text)],
  ["join_channel rejects every crafted name", CRAFTED.every((_, i) => text(10 + i).includes("Invalid channel name"))],
  ["MCP server log has no forged line", !forged(mcpErr.text)],
  ["join_channel still accepts a valid name", text(20) === `Successfully joined channel: ${VALID}`],
  ["MCP server logs the valid join", mcpErr.text.includes(`[INFO] Joined channel: ${VALID}`)],
  ["relay logs the valid join", relayOut.text.includes(`Client joined channel "${VALID}"`)],
];
let failed = 0;
for (const [name, ok] of checks) { console.log(`${ok ? "PASS" : "FAIL"} ${name}`); if (!ok) failed++; }
process.exit(failed ? 1 : 0);
