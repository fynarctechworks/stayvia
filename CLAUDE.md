# Stayvia — Claude Instructions

**Stayvia** is a multi-tenant hotel-management SaaS (reservations, housekeeping, guest
KYC, GST invoicing, payments, WhatsApp notifications, reports) sold as ONE subscription
plan (Razorpay). npm-workspaces monorepo: `apps/api` (Express 4 + Drizzle + Supabase
Postgres), `apps/web` (Vite 6 + React 18 + Tailwind 3), `packages/shared` (Zod schemas +
enums for both apps). Cloud-only — the legacy desktop/offline layer is being removed.

**Reference:** `CONTEXT.md` documents the original single-property PMS this code started
from (historical; code wins on conflict). Design system: `apps/web/DESIGN.md`
(Supabase-inspired tokens).

## SaaS Conversion — Phase Plan (current state)

| Phase | Scope | Status |
|---|---|---|
| 0 | Fresh repo, Stayvia rebrand, desktop/Tauri removal, agent workflow | **done** |
| 1 | New infra: Supabase, Upstash, Vercel, Razorpay accounts + env wiring | **user provisioning** |
| 2 | Multi-tenant core: offline-layer removal, squashed baseline (property_id everywhere, per-hotel counters), per-request tenant resolution, every query scoped + adversarially verified | **done** |
| 3 | Public signup + trial + Razorpay single-plan subscription + webhook + 402 gate | **done** |
| 4 | Web signup/billing pages, 402 redirect, per-hotel shell branding, get-started card | **done** |
| 5 | Cloud e2e harness (test-only auth shim, prod-guarded), two-hotel isolation suite (13 tests), billing lifecycle suite (5 tests) | **done** |
| 6 | Deploy: Vercel web + VPS Docker API + Razorpay plan/webhook config | pending (needs Phase 1 keys) |

Marketing/landing page: not built yet (product app assumed the deliverable; landing site is a separate follow-up).

## Commands
```bash
npm run dev:api        # API :3001 (nodemon + tsx)
npm run dev:web        # Web :5180 (Vite)
npm run db:migrate --workspace=@stayvia/api     # apply numbered SQL migrations (guarded)
npm run db:seed --workspace=@stayvia/api
npm run test --workspace=@stayvia/api           # Vitest (pure helpers)
npm run test:e2e       # Playwright browser suite (throwaway stack, offset ports)
npm run lint           # eslint apps + packages
npx tsc --noEmit -p apps/api/tsconfig.json      # API type-check
npx tsc -b apps/web    # Web type-check
```

## Hard Rules
- **Tenant isolation is rule zero.** Every business row carries `property_id` (tenant =
  hotel); every query filters by the requester's hotel. Cross-tenant leakage is the worst
  bug this product can have. Document numbers, settings, storage paths, reports — all
  per-hotel.
- Schema changes ONLY via a new numbered SQL file in `apps/api/migrations/` + Drizzle
  schema edit, applied with `npm run db:migrate` (guard blocks remote targets).
  **Never `drizzle-kit push`** (broken in this repo, bypasses the guard). Destructive SQL
  needs explicit human approval once any real hotel is onboarded.
- Never read/print/commit `.env*`. Never rotate `ENCRYPTION_KEY` once real KYC data exists.
- No deploys (Vercel web, VPS Docker API are human-run). Deploy auto-applies pending
  migrations — flag every new migration file.
- No real Twilio/WhatsApp sends or Razorpay charges in dev — stub providers only.
- After editing `packages/shared`: rebuild (`npx tsc -p packages/shared/tsconfig.json`).
- API is ESM with `.js` extensions on relative imports. Restart API after schema/env edits.
- Legacy offline/desktop code (outboxes, `authLocal`, `localFiles`, `db/bootstrap/`,
  `lib/offlineMode.ts`) is scheduled for removal — never build on it; flag when met.

## Agent Workflow (Multi-Agent Orchestration)

Subagents in `.claude/agents/` (gitignored — local to this machine). One **orchestrator**
plans and delegates; specialists work in their own context windows. Only the orchestrator
has the `Agent` tool.

### Available Agents
| Agent | Role | Tools | Model |
|-------|------|-------|-------|
| `orchestrator` | Loads context, decomposes, delegates, integrates | Read, Grep, Glob, Agent | Opus |
| `db-architect` | Drizzle schema files, numbered SQL migrations, seeds | Read, Write, Edit, Bash, Grep, Glob | Sonnet |
| `api-builder` | Express route files, shared Zod schemas, RBAC guards, lib helpers | Read, Write, Edit, Bash, Grep, Glob | Sonnet |
| `component-builder` | Reusable components in `apps/web/src/components/`, design-system enforcement | Read, Write, Edit, Bash, Grep, Glob | Sonnet |
| `frontend-builder` | Route-level pages, TanStack Query wiring, App.tsx routes, Sidebar + BottomNav | Read, Write, Edit, Bash, Grep, Glob | Sonnet |
| `test-writer` | Vitest helper tests; Playwright browser e2e; tenant-isolation suites | Read, Write, Edit, Bash, Grep, Glob | Sonnet |

### How to Use
```
Use the orchestrator agent to plan and build the <feature> module.
```

### Build Order (per module)
**Schema → Migration → Shared Zod → API route → Components → Pages (+ nav/route
registration) → Tests.** A layer is delegated only after its dependency is done and verified.

### Notes specific to this repo
- **No controller/service layers** — fat route files + `lib/` helpers. Match that.
- **Auth:** Supabase Auth (JWT bearer); guards `requireAuth`, `requireRole`,
  `requirePermission`. Roles: `admin`, `frontdesk`, `housekeeping` (per hotel).
- **Money paths** (payments, invoices, credit notes) need idempotency middleware, IST
  date handling (`lib/propertyTime.ts`), and per-hotel numbering (`lib/numbers.ts` —
  being converted from global sequences in Phase 2).
- **E2E never touches live infra** — its harness provisions a throwaway stack on offset
  ports (web 5273 / API 3020 / PG 5434).
