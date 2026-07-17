# Stayvia — Hotel Management SaaS

Multi-tenant hotel property-management platform: reservations, housekeeping, guest
profiles (KYC), GST invoicing, payments, WhatsApp notifications, and reports — one
subscription, any hotel.

**Status:** SaaS conversion in progress. The codebase started as a single-property PMS
and is being converted to multi-tenant (see `CLAUDE.md` for the phase plan).

## Stack

| Layer | Tech |
|---|---|
| API | Express 4 + TypeScript (ESM), Drizzle ORM, postgres-js |
| DB / Auth / Storage | Supabase (Postgres, Auth, Storage) |
| Cache | Upstash Redis (optional) |
| Web | Vite 6 + React 18 + Tailwind CSS 3 + TanStack Query 5 |
| Shared | `@stayvia/shared` — Zod schemas + enums for both apps |
| PDFs | Puppeteer (server-rendered invoices/receipts) |
| Billing | Razorpay (single subscription plan) |
| E2E | Playwright (isolated throwaway stack) |

## Monorepo

```
apps/api        Express API (port 3001 in dev)
apps/web        React SPA (port 5180 in dev)
packages/shared Zod schemas + enums
e2e             Playwright browser suite
deploy          Docker + nginx configs (API on VPS), web on Vercel
```

## Development

```bash
npm install
# fill apps/api/.env.development and apps/web/.env.development from the .example files
npm run db:migrate --workspace=@stayvia/api
npm run db:seed --workspace=@stayvia/api
npm run dev:api     # :3001
npm run dev:web     # :5180
```

Tests: `npm run test --workspace=@stayvia/api` (Vitest), `npm run test:e2e` (Playwright).

## Docs

- `CLAUDE.md` — working conventions, agent workflow, phase plan
- `CONTEXT.md` — deep architecture reference (inherited from the original PMS; being updated as the SaaS conversion lands)
- `apps/web/DESIGN.md` — design system (Supabase-inspired)
- `DEPLOY.md`, `deploy/README.md` — deployment
