# Marketing site deploy

Layout (low-risk — the product app does **not** move):

```
stayviawebsite.infynarc.com  ──▶  marketing landing (Vercel project "stayvia-marketing")
stayvia.infynarc.com         ──▶  product app        (unchanged)
api.<...>.infynarc.com       ──▶  VPS API            (unchanged)
```

The marketing site is a **second Vercel project**, Root Directory `apps/marketing`,
building from the same Git repo (`main`). No Supabase / CORS / Razorpay / app changes —
the app keeps its domain, and marketing CTAs just link to it.

> DNS note: the `infynarc.com` zone is managed by **Vercel DNS**, so attaching a domain to
> a Vercel project auto-creates its DNS record. No manual A/CNAME edits.

## One-time setup (already done)
- Vercel project `stayvia-marketing`, Root Directory `apps/marketing`.
- Env var `VITE_APP_URL = https://stayvia.infynarc.com` (Production).
- Live on `stayvia-marketing.vercel.app`; CTAs verified → `stayvia.infynarc.com/signup`.

## Attach the real domain
1. Vercel → **stayvia-marketing** → Settings → **Domains** → **Add** `stayviawebsite.infynarc.com`.
2. Connect to **Production**. DNS auto-configures (Vercel-managed zone). Wait for "Valid".
3. Verify `https://stayviawebsite.infynarc.com` loads and CTAs land on `stayvia.infynarc.com`.

That's it — the app on `stayvia.infynarc.com` is untouched.

## Env-var summary
| Where | Var | Value |
|---|---|---|
| Vercel · stayvia-marketing | `VITE_APP_URL` | `https://stayvia.infynarc.com` |

## Redeploys
The project is Git-connected — any push to `main` that touches `apps/marketing/**`
(or `apps/marketing/vercel.json`) triggers a rebuild automatically. Env-var changes
need a manual **Redeploy** (Deployments → ⋯ → Redeploy) to bake in.

## Rollback
Remove `stayviawebsite.infynarc.com` from the project's Domains. The `*.vercel.app` URL
keeps working; the product app is never affected.
