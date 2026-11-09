// Fails if a tool that deletes or overwrites Figma content is missing `destructiveHint: true`.
// Starts the MCP server from source, asks it for its tool list, and checks each tool's annotations.
// Run with: bun run check:annotations

// Tools that delete nodes or replace existing content/properties in the Figma file.
const DESTRUCTIVE_TOOLS = [
  "delete_node",
  "delete_multiple_nodes",
  "set_text_content",
  "set_multiple_text_contents",
  "set_fill_color",
  "set_stroke_color",
  "set_image_fill",
  "set_annotation",
  "set_multiple_annotations",
  "set_instance_overrides",
  "move_node",
  "resize_node",
  "set_corner_radius",
  "rename_node",
  "set_parent",
  "set_layout_mode",
  "set_padding",
  "set_axis_align",
  "set_layout_sizing",
  "set_item_spacing",
];

// Any tool whose name starts with one of these is treated as destructive, even if not listed above.
const DESTRUCTIVE_PREFIXES = ["delete_", "remove_", "clear_", "replace_"];

type Tool = { name: string; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } };

async function listTools(): Promise<Tool[]> {
  const serverPath = new URL("../src/talk_to_figma_mcp/server.ts", import.meta.url).pathname;
  const proc = Bun.spawn(["bun", serverPath], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  const send = (msg: object) => {
    proc.stdin.write(JSON.stringify(msg) + "\n");
    proc.stdin.flush();
  };
  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "annotation-check", version: "1" } },
  });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list" });

  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + 20000;
  let buffer = "";
  try {
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value);
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          const msg = JSON.parse(line);
          if (msg.id === 2) return msg.result?.tools ?? [];
        } catch {}
      }
    }
  } finally {
    proc.kill();
  }
  throw new Error("MCP server did not return a tool list");
}

const tools = await listTools();
const byName = new Map(tools.map((t) => [t.name, t]));
const failures: string[] = [];

for (const name of DESTRUCTIVE_TOOLS) {
  if (!byName.has(name)) failures.push(`${name}: listed as destructive but the server has no such tool`);
}

for (const tool of tools) {
  const a = tool.annotations ?? {};
  const mustBeDestructive =
    DESTRUCTIVE_TOOLS.includes(tool.name) || DESTRUCTIVE_PREFIXES.some((p) => tool.name.startsWith(p));

  if (mustBeDestructive) {
    if (a.destructiveHint !== true) failures.push(`${tool.name}: deletes or overwrites content but is missing destructiveHint: true`);
    if (a.readOnlyHint === true) failures.push(`${tool.name}: destructive tool must not be marked readOnlyHint: true`);
  } else if (typeof a.readOnlyHint !== "boolean") {
    failures.push(`${tool.name}: missing readOnlyHint annotation`);
  } else if (a.readOnlyHint === false && typeof a.destructiveHint !== "boolean") {
    failures.push(`${tool.name}: changes the document but does not say whether it is destructive (set destructiveHint)`);
  }
}

if (tools.length === 0) failures.push("server returned no tools");

if (failures.length > 0) {
  console.error(`FAIL tool annotations (${failures.length} problem(s)):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
const destructiveCount = tools.filter((t) => t.annotations?.destructiveHint === true).length;
console.log(`PASS tool annotations: ${tools.length} tools checked, ${destructiveCount} marked destructive`);
process.exit(0);
