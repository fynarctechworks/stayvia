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
const CACHE_TTL_MS = 60_000;
type CacheEntry = { sub: Subscription | null; expires: number };
const cache = new Map<string, CacheEntry>();

export function invalidateSubscriptionCache(propertyId?: string): void {
  if (propertyId) cache.delete(propertyId);
  else cache.clear();
}

// Pure decision helper — exported for tests/smoke checks.
export function isSubscriptionActive(
  sub: Pick<Subscription, "status" | "trialEndsAt"> | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!sub) return false;
  if (sub.status === "active") return true;
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
