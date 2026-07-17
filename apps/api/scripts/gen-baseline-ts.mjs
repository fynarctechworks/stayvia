// Embed baseline.sql as a TS string module so the pkg-bundled exe compiles it
// into JS (no dependence on pkg's asset filesystem, which cached a stale copy).
// Run whenever baseline.sql changes.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sqlPath = resolve(root, "src/db/bootstrap/baseline.sql");
const sql = readFileSync(sqlPath, "utf8");

const badLines = sql.split("\n").filter((l) => l.startsWith("\\"));
if (badLines.length) {
  console.error(`baseline.sql still has ${badLines.length} psql backslash line(s) — clean it first`);
  process.exit(1);
}

// Escape for a JS template literal: backslash, backtick, and ${.
const esc = sql
  .replaceAll("\\", "\\\\")
  .replaceAll("`", "\\`")
  .replaceAll("${", "\\${");

const out =
  "// AUTO-GENERATED from baseline.sql by scripts/gen-baseline-ts.mjs — do not edit.\n" +
  "// Embedded as a string so the pkg-bundled sidecar compiles it into JS.\n" +
  "export const BASELINE_SQL = `" +
  esc +
  "`;\n";

writeFileSync(resolve(root, "src/db/bootstrap/baseline.ts"), out);
console.log(`wrote baseline.ts (${out.length} chars, ${sql.split("\n").length} SQL lines)`);
