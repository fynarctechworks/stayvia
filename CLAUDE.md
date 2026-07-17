# SLDT Stay Inn (HotelDesk) — Claude Instructions

Hotel PMS for **SLDT Stay Inn**, Sabbavaram (AP, India). **LIVE system** — staff use it
daily; real guests, GST invoices, WhatsApp. npm-workspaces monorepo: `apps/api`
(Express 4 + Drizzle + Supabase Postgres), `apps/web` (Vite 6 + React 18 + Tailwind 3 +
Tauri desktop shell), `packages/shared` (Zod schemas + enums for both apps).

**Source of truth:** `CONTEXT.md` (exhaustive; parts predate RBAC/offline work — code wins
on conflict). Design system: `apps/web/DESIGN.md` (Supabase-inspired tokens).

## Commands
```bash
npm run dev:api        # API :3001 (nodemon + tsx)
npm run dev:web        # Web :5180 (Vite)
npm run db:migrate --workspace=@hoteldesk/api   # apply numbered SQL migrations (guarded)
npm run db:seed --workspace=@hoteldesk/api
npm run test --workspace=@hoteldesk/api          # Vitest (pure helpers)
npm run test:e2e       # Playwright browser suite (throwaway stack, offset ports)
npm run test:e2e:app   # Playwright vs built Tauri desktop app
npm run lint           # eslint apps + packages
npx tsc --noEmit -p apps/api/tsconfig.json       # API type-check
npx tsc -b apps/web    # Web type-check
```

## Hard Rules
- Schema changes ONLY via a new numbered SQL file in `apps/api/migrations/` + Drizzle
  schema edit + `db/bootstrap/baseline.sql` mirror. **Never `drizzle-kit push`** (broken,
  bypasses the prod guard). No destructive SQL without explicit human approval.
- Dev DB can be the same Supabase project as production — treat every DB touch as live.
- Never read/print/commit `.env*`. Never rotate `ENCRYPTION_KEY` (bricks KYC decryption).
- No deploys (Vercel web, VPS Docker API, Tauri bundles are human-run). Deploy
  auto-applies pending migrations — flag every new migration file.
- After editing `packages/shared`: rebuild (`npx tsc -p packages/shared/tsconfig.json`).
- API is ESM with `.js` extensions on relative imports. Restart API after schema/env edits.
- Dual runtime: same API runs cloud AND offline Tauri sidecar (local JWT, embedded
  Postgres, sync/message outboxes) — gate cloud-only services like neighbouring code does.

## Agent Workflow (Multi-Agent Orchestration)

Multi-agent build workflow via Claude Code subagents in `.claude/agents/` (note:
`.claude/` is gitignored — agent definitions are local to this machine). One
**orchestrator** plans and delegates; specialists work in their own context windows.
Only the orchestrator has the `Agent` tool.

### Available Agents
| Agent | Role | Tools | Model |
|-------|------|-------|-------|
| `orchestrator` | Loads context (CLAUDE.md, CONTEXT.md, Drizzle schema, code), decomposes, delegates, integrates | Read, Grep, Glob, Agent | Opus |
| `db-architect` | Drizzle schema files, numbered SQL migrations, offline baseline, seeds | Read, Write, Edit, Bash, Grep, Glob | Sonnet |
| `api-builder` | Express route files, shared Zod schemas, RBAC guards, lib helpers, outboxes | Read, Write, Edit, Bash, Grep, Glob | Sonnet |
| `component-builder` | Reusable components in `apps/web/src/components/`, design-system enforcement | Read, Write, Edit, Bash, Grep, Glob | Sonnet |
| `frontend-builder` | Route-level pages, TanStack Query wiring, App.tsx routes, Sidebar + BottomNav | Read, Write, Edit, Bash, Grep, Glob | Sonnet |
| `test-writer` | Vitest helper tests; Playwright e2e (browser + desktop suites) | Read, Write, Edit, Bash, Grep, Glob | Sonnet |

### How to Use
```
Use the orchestrator agent to plan and build the <feature> module.
```
The orchestrator reads context, decomposes the work, and delegates self-contained prompts
to specialists in dependency order; each reports back and the orchestrator integrates.

### Build Order (per module)
**Schema → Migration (+offline baseline) → Shared Zod → API route → Components → Pages
(+ nav/route registration) → Tests.** A layer is delegated only after its dependency is
done and verified.

### Notes specific to this repo
- **Single property, live data.** Rows are scoped by `property_id` (PRIMARY property via
  `lib/currentProperty.ts`); multi-property is a future hook, not current behaviour.
- **No controller/service layers** — fat route files + `lib/` helpers. Match that.
- **Auth:** Supabase Auth online / local JWT offline; guards `requireAuth`,
  `requireRole`, `requirePermission`. Roles: `admin`, `frontdesk`, `housekeeping`.
- **One web app** (no admin/customer split) + Tauri desktop wrapper of the same SPA.
- **Money paths** (payments, invoices, credit notes) need idempotency middleware, IST
  date handling (`lib/propertyTime.ts`), and sequence-based numbering (`lib/numbers.ts`).
- **E2E never touches live infra** — its harness provisions a throwaway stack on offset
  ports (web 5273 / API 3020 / PG 5434).
