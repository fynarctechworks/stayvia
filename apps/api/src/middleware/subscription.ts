import { eq } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";
import { db } from "../db/client.js";
import { subscriptions, type Subscription } from "../db/schema/subscriptions.js";
import { fail } from "../lib/response.js";

// Subscription gate for business routes. Runs after requireAuth (needs
// req.propertyId). Passes when the hotel is `active`, or `trialing` with
// time left on the trial; everything else — past_due, cancelled, expired,
// lapsed trial, missing row — is 402 SUBSCRIPTION_REQUIRED. The web app
// intercepts 402 and routes admins to the Billing page.

// In-process cache: one subscription lookup per property per minute instead
// of one per request. Billing writes + webhook updates call
// invalidateSubscriptionCache so a payment unlocks immediately.
// SUBSCRIPTION_CACHE_TTL_MS overrides the TTL — the e2e harness sets 0 so
// direct DB status flips are visible on the next request; absent/invalid
// falls back to the 60s default.
const ttlOverride = Number(process.env.SUBSCRIPTION_CACHE_TTL_MS);
const CACHE_TTL_MS = Number.isFinite(ttlOverride) ? ttlOverride : 60_000;
type CacheEntry = { sub: Subscription | null; expires: number };
const cache = new Map<string, CacheEntry>();

export function invalidateSubscriptionCache(propertyId?: string): void {
  if (propertyId) cache.delete(propertyId);
  else cache.clear();
}

// Grace period past currentPeriodEnd before a paid hotel is locked out.
// Razorpay's own retry/dunning window plus webhook delivery lag both land in
// here, so this must be generous enough that a hotel is never locked out for a
// renewal that is merely in flight.
const ACTIVE_GRACE_MS = 3 * 24 * 60 * 60 * 1000;

// Pure decision helper — exported for tests/smoke checks.
export function isSubscriptionActive(
  sub:
    | Pick<Subscription, "status" | "trialEndsAt" | "currentPeriodEnd">
    | null
    | undefined,
  now: Date = new Date(),
): boolean {
  if (!sub) return false;

  if (sub.status === "active") {
    // Time-bounded, like the trial branch. `active` used to return true
    // unconditionally and currentPeriodEnd was never read by the gate at all,
    // so the ONLY thing that could ever re-lock a paying hotel was a
    // successfully delivered webhook. If Razorpay's bounded retries were
    // exhausted while the API was mid-deploy — or while
    // RAZORPAY_WEBHOOK_SECRET was unset, which makes every webhook 503 — the
    // row stayed 'active' with a currentPeriodEnd months in the past and the
    // hotel kept full access forever at zero revenue, with nothing in the
    // codebase able to notice. Also closes the replay angle: an old
    // subscription.charged redelivered out of order can no longer grant
    // indefinite access, because the stale period end it carries now expires.
    if (!sub.currentPeriodEnd) return true; // pre-webhook row; don't lock out
    return sub.currentPeriodEnd.getTime() + ACTIVE_GRACE_MS > now.getTime();
  }

  // A cancellation scheduled with cancel_at_cycle_end is still PAID through
  // the end of the current period — see POST /billing/cancel.
  if (sub.status === "cancelled") {
    return !!sub.currentPeriodEnd && sub.currentPeriodEnd > now;
  }

  return sub.status === "trialing" && !!sub.trialEndsAt && sub.trialEndsAt > now;
}

async function loadSubscription(propertyId: string): Promise<Subscription | null> {
  const entry = cache.get(propertyId);
  if (entry && entry.expires > Date.now()) return entry.sub;
  const [row] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.propertyId, propertyId))
    .limit(1);
  cache.set(propertyId, { sub: row ?? null, expires: Date.now() + CACHE_TTL_MS });
  return row ?? null;
}

export async function requireActiveSubscription(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  if (!req.propertyId) {
    return fail(res, 401, "UNAUTHENTICATED", "Not authenticated");
  }
  const sub = await loadSubscription(req.propertyId);
  if (!isSubscriptionActive(sub)) {
    return fail(
      res,
      402,
      "SUBSCRIPTION_REQUIRED",
      "Your trial has ended or the subscription is inactive. Renew from the Billing page.",
    );
  }
  next();
}
