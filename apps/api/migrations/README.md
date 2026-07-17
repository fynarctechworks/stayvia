# Migrations

Tracked, idempotent SQL migrations applied via `npm run db:migrate`.

## How it works

- Each file is `NNNN_short_name.sql`, applied in lexical order.
- Applied filenames are recorded in `schema_migrations(name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ)`.
- The runner skips files that are already recorded.
- Files must be **idempotent** (`IF NOT EXISTS`, `ON CONFLICT DO NOTHING`, etc.) so re-running against a partially-migrated DB is safe.

## Adopting on an existing database

This project ran under `drizzle-kit push` originally, so existing prod DBs already contain everything declared in `src/db/schema/*.ts`. The first migration (`0001_baseline.sql`) only creates the `schema_migrations` table and a couple of extensions, and is safe to run against any state. Subsequent migrations carry the real DDL.

## Adding a new migration

1. Create `migrations/NNNN_descriptive_name.sql` (next sequential number).
2. Write idempotent DDL.
3. Mirror any schema column changes in `src/db/schema/*.ts`.
4. Run `npm run db:migrate` locally.
5. Commit both the SQL and schema TS changes.
