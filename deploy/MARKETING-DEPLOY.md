# Marketing site deploy — domain split

Goal: marketing landing on the **root** `stayvia.infynarc.com`, product app moves to
`app.stayvia.infynarc.com`. Two Vercel projects, one Git repo. API (VPS) domain is
unchanged. **All steps are human-run in dashboards** — nothing here deploys itself.

> DNS note: the `infynarc.com` zone is managed by **Vercel DNS**, so attaching a domain
> to a Vercel project auto-creates its DNS record. No manual A/CNAME edits needed.

Do the parts **in order** — Part 1 makes the app reachable at its new home before Part 2
frees the root, so guests are never dropped.

---

## Part 1 — Move the product app to `app.stayvia.infynarc.com`

No web rebuild needed: the app reads the API via `VITE_API_URL` (unchanged) and does auth
redirects off `window.location.origin`. Only the CORS lock + Supabase whitelist move.

1. **Vercel → the existing web project** (the one serving `stayvia.infynarc.com`)
   → Settings → Domains → **Add** `app.stayvia.infynarc.com`. Wait for "Valid".
   Leave `stayvia.infynarc.com` attached for now (both resolve during the transition).

2. **Supabase → Authentication → URL Configuration**
   - Site URL → `https://app.stayvia.infynarc.com`
   - Redirect URLs → add `https://app.stayvia.infynarc.com/**` (keep the old one for now).

3. **VPS → `apps/api/.env.production`** → set
   `FRONTEND_URL=https://app.stayvia.infynarc.com`, then restart the container
   (`bash deploy/deploy.sh` or `docker compose -f deploy/docker-compose.prod.yml restart`).
   ⚠️ CORS allows exactly one origin — the instant this changes, the *old* root-domain app
   stops talking to the API. That's fine (we're moving to `app.*`), but do steps 1–2 first.

4. **Verify** `https://app.stayvia.infynarc.com`: page loads, login works, API calls
   succeed (no CORS errors in console), one booking + one payment flow work.

---

## Part 2 — Deploy the marketing site to root `stayvia.infynarc.com`

5. **Vercel → New Project** → import the same Git repo.
   - Project name: `stayvia-marketing`
   - **Root Directory: `apps/marketing`**  ← important
   - Framework preset: Vite (build/install/output all come from `apps/marketing/vercel.json`)
   - Environment Variables (Production): `VITE_APP_URL = https://app.stayvia.infynarc.com`
   - Deploy. Open the `*.vercel.app` preview → confirm it loads and every CTA
     ("Start free trial" / "Sign in") points at `https://app.stayvia.infynarc.com/...`.

6. **Hand the root domain to marketing:**
   - Vercel → **web project** → Settings → Domains → **remove** `stayvia.infynarc.com`.
   - Vercel → **stayvia-marketing** → Settings → Domains → **add** `stayvia.infynarc.com`
     (optionally add `www.stayvia.infynarc.com` and redirect it to the apex).

7. **Verify:**
   - `https://stayvia.infynarc.com` → marketing landing.
   - CTA → `https://app.stayvia.infynarc.com/signup`.
   - `https://stayvia.infynarc.com/h/<token>` and `/r/<token>` → **301** to the app
     (covers any QR printed against the old root domain; see `apps/marketing/vercel.json`).

---

## Part 3 — Cleanup

8. **Supabase** → remove the now-stale `https://stayvia.infynarc.com/**` redirect URL
   (root is marketing now, not the app).
9. **Razorpay** → if any checkout return/callback URL points at the app, update it to
   `app.stayvia.infynarc.com`. (The webhook targets the **API** domain — unchanged.)
10. Optional doc hygiene: `DEPLOY.md` still uses the old `sldt.infynarc.com` names — update
    when convenient.

---

## Env-var summary

| Where | Var | Value |
|---|---|---|
| Vercel · stayvia-marketing | `VITE_APP_URL` | `https://app.stayvia.infynarc.com` |
| Vercel · web (app) | `VITE_API_URL` | *(unchanged — the API domain does not move)* |
| VPS · `apps/api/.env.production` | `FRONTEND_URL` | `https://app.stayvia.infynarc.com` |
| Supabase · Auth | Site URL | `https://app.stayvia.infynarc.com` |
| Supabase · Auth | Redirect URLs | `https://app.stayvia.infynarc.com/**` |

## Rollback
Re-attach `stayvia.infynarc.com` to the web project, revert `FRONTEND_URL` and the Supabase
Site URL to the root domain, restart the API container. Marketing project can stay (idle) on
its `*.vercel.app` URL.
