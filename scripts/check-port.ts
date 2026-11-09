// Checks that the relay and the MCP server use port 3055 by default and TALK_TO_FIGMA_PORT when set.
// Run with: bun run check:port
import { DEFAULT_PORT, PORT_ENV_VAR, resolvePort } from "../src/port";

const CUSTOM_PORT = 3077;
const root = new URL("..", import.meta.url).pathname;
let failed = 0;
const check = (name: string, ok: boolean) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
  if (!ok) failed++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function envWith(port?: string) {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  delete env[PORT_ENV_VAR];
  if (port !== undefined) env[PORT_ENV_VAR] = port;
  return env;
}

// Exit code, or null if the process is still running after 5s (it is then killed).
async function exitCode(proc: Bun.Subprocess) {
  const code = await Promise.race([proc.exited, sleep(5000).then(() => null)]);
  if (code === null) { proc.kill(); await proc.exited; }
  return code;
}

async function portIsFree(port: number) {
  try {
    Bun.serve({ port, fetch: () => new Response("") }).stop(true);
    return true;
  } catch {
    return false;
  }
}

function canJoinRelay(port: number) {
  return new Promise<boolean>((resolve) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    const done = (ok: boolean) => { clearTimeout(timer); ws.close(); resolve(ok); };
    const timer = setTimeout(() => done(false), 3000);
    ws.onmessage = (e) => done(JSON.parse(String(e.data)).type === "system");
    ws.onerror = () => done(false);
  });
}

async function startRelay(port?: string) {
  const proc = Bun.spawn(["bun", "src/socket.ts"], { cwd: root, env: envWith(port), stdout: "pipe", stderr: "pipe" });
  await sleep(1500);
  return proc;
}

// Fake relay that only counts how many clients connect to it.
function fakeRelay(port: number) {
  const seen = { count: 0 };
  const server = Bun.serve({
    port,
    fetch(req, srv) { return srv.upgrade(req) ? undefined : new Response(""); },
    websocket: { open() { seen.count++; }, message() {} },
  });
  return { seen, stop: () => server.stop(true) };
}

async function startMcpServer(port?: string) {
  const proc = Bun.spawn(["bun", "src/talk_to_figma_mcp/server.ts"], { cwd: root, env: envWith(port), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  await sleep(3000);
  return proc;
}

for (const port of [DEFAULT_PORT, CUSTOM_PORT]) {
  if (!(await portIsFree(port))) {
    console.log(`FAIL port ${port} is already in use; stop whatever is using it and re-run`);
    process.exit(1);
  }
}

console.log("== port setting");
check("unset -> 3055", resolvePort(undefined) === 3055);
check("empty -> 3055", resolvePort("") === 3055);
check(`"${CUSTOM_PORT}" -> ${CUSTOM_PORT}`, resolvePort(String(CUSTOM_PORT)) === CUSTOM_PORT);
for (const bad of ["abc", "0", "70000", "30.5", "-1"]) {
  let threw = false;
  try { resolvePort(bad); } catch { threw = true; }
  check(`"${bad}" is rejected`, threw);
}

console.log("== relay");
let relay = await startRelay();
check("default: relay answers on 3055", await canJoinRelay(DEFAULT_PORT));
relay.kill(); await relay.exited;

relay = await startRelay(String(CUSTOM_PORT));
check(`custom: relay answers on ${CUSTOM_PORT}`, await canJoinRelay(CUSTOM_PORT));
check("custom: relay is not on 3055", !(await canJoinRelay(DEFAULT_PORT)));
relay.kill(); await relay.exited;

relay = await startRelay("abc");
const relayCode = await exitCode(relay);
check("invalid: relay exits with an error", relayCode !== null && relayCode !== 0);

console.log("== MCP server");
let onDefault = fakeRelay(DEFAULT_PORT);
let onCustom = fakeRelay(CUSTOM_PORT);
let mcp = await startMcpServer();
check("default: MCP server connects to 3055", onDefault.seen.count > 0);
check(`default: MCP server does not connect to ${CUSTOM_PORT}`, onCustom.seen.count === 0);
mcp.kill(); await mcp.exited; onDefault.stop(); onCustom.stop();

onDefault = fakeRelay(DEFAULT_PORT);
onCustom = fakeRelay(CUSTOM_PORT);
mcp = await startMcpServer(String(CUSTOM_PORT));
check(`custom: MCP server connects to ${CUSTOM_PORT}`, onCustom.seen.count > 0);
check("custom: MCP server does not connect to 3055", onDefault.seen.count === 0);
mcp.kill(); await mcp.exited; onDefault.stop(); onCustom.stop();

mcp = await startMcpServer("abc");
const mcpCode = await exitCode(mcp);
check("invalid: MCP server exits with an error", mcpCode !== null && mcpCode !== 0);

console.log(failed ? `${failed} check(s) failed` : "All port checks passed");
process.exit(failed ? 1 : 0);
