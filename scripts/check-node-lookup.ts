// Fails if the Figma plugin uses the deprecated synchronous figma.getNodeById.
// Usage: bun scripts/check-node-lookup.ts [repo root]
import { readFileSync } from "fs";
import { join } from "path";

const root = process.argv[2] ?? process.cwd();
const file = join(root, "src/cursor_mcp_plugin/code.js");
const lines = readFileSync(file, "utf8").split("\n");
const hits = lines
  .map((line, i) => ({ line: line.trim(), n: i + 1 }))
  .filter(({ line }) => /\bgetNodeById\s*\(/.test(line));

if (hits.length > 0) {
  for (const h of hits) console.log(`FAIL code.js:${h.n} uses getNodeById: ${h.line}`);
  console.log("Use `await figma.getNodeByIdAsync(id)` instead.");
  process.exit(1);
}
console.log("PASS plugin never uses the synchronous figma.getNodeById");
