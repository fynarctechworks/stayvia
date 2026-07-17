# Migrations

Tracked, idempotent SQL migrations applied via `npm run db:migrate`.

## How it works

- Each file is `NNNN_short_name.sql`, applied in lexical order.
- Applied filenames are recorded in `schema_migrations(name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ)`.
- The runner skips files that are already recorded.
- Files must be **idempotent** (`IF NOT EXISTS`, `ON CONFLICT DO NOTHING`, guarded `DO` blocks)
  so re-running against a partially-migrated DB is safe.

## The squashed baseline

Stayvia targets a **fresh database**: `0001_stayvia_baseline.sql` is the complete
multi-tenant schema, squashed from the 53 legacy single-property migrations with
tenancy baked in — `property_id` on every operational table, per-property composite
uniques (document numbers, room numbers, guest dedup, slugs, template keys, role keys),
the `property_counters` table replacing the global `sldt_*` document sequences, the
`subscriptions` table, and no offline sync layer. The legacy migration files were
deleted; recover them from git history if archaeology is ever needed.

Hotels are provisioned in code (`src/lib/provisionProperty.ts`, used by `db:seed`
and the public signup route) — the baseline seeds no rows.

## Adding a new migration

1. Create `migrations/NNNN_descriptive_name.sql` (next sequential number).
2. Write idempotent DDL.
3. Mirror any schema column changes in `src/db/schema/*.ts`.
4. Run `npm run db:migrate` locally.
5. Commit both the SQL and schema TS changes.
