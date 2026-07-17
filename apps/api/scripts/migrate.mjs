// Match the runtime's layered env loader (see apps/api/src/config/env.ts):
//   1. .env.<NODE_ENV>.local  — machine-specific overrides
//   2. .env.<NODE_ENV>        — per-environment file
//   3. .env                   — legacy fallback
// Earlier wins; real process env always wins over all of them.
// Without this, `node scripts/migrate.mjs` from apps/api fails with
// "DATABASE_URL is required" because the repo uses .env.development
// rather than a plain .env.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import postgres from "postgres";

const __dirname = dirname(fileURLToPath(import.meta.url));
const API_ROOT = resolve(__dirname, "..");
const MIGRATIONS_DIR = join(API_ROOT, "migrations");

const nodeEnv = process.env.NODE_ENV ?? "development";
for (const file of [`.env.${nodeEnv}.local`, `.env.${nodeEnv}`, ".env"]) {
  const path = resolve(API_ROOT, file);
  if (existsSync(path)) dotenv.config({ path });
}

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

// Block accidental runs against a remote (prod) DB from a dev machine.
const { assertLocalDbTarget } = await import("./guard-db-target.mjs");
assertLocalDbTarget(process.env.DATABASE_URL);

const sql = postgres(process.env.DATABASE_URL, { max: 1 });

try {
  // Bootstrap the ledger table itself (it's also in 0001_baseline.sql, but we
  // need it before we can check what's applied).
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const appliedRows = await sql`SELECT name FROM schema_migrations`;
  const applied = new Set(appliedRows.map((r) => r.name));

  let ran = 0;
  for (const file of files) {
    if (applied.has(file)) {
      console.log(`= ${file} (already applied)`);
      continue;
    }
    const body = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    console.log(`→ ${file}`);
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`INSERT INTO schema_migrations (name) VALUES (${file})`;
    });
    ran++;
  }

  console.log(ran === 0 ? "Nothing to apply." : `Applied ${ran} migration(s).`);
} catch (err) {
  console.error("Migration failed:", err.message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
