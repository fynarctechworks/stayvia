// Billing — one plan ("standard"), Razorpay Subscriptions.
//
// Admin-only management surface (mounted at /billing on the v1 router):
//   GET  /billing            → subscription state + computed lock info
//   POST /billing/subscribe  → create Razorpay customer+subscription, return checkout params
//   POST /billing/cancel     → cancel at cycle end
//
// Webhook (exported separately, mounted in index.ts BEFORE express.json so
// it receives the raw body for signature verification):
//   POST /api/v1/billing/webhook
//
// Razorpay is called with plain fetch + Basic auth — same house style as
// Twilio in lib/messaging.ts. No SDK.

import { eq } from "drizzle-orm";
import { Router, type Request, type Response } from "express";
import { env } from "../config/env.js";
import { db } from "../db/client.js";
import {
  subscriptions,
  type Subscription,
  type SubscriptionStatus,
} from "../db/schema/subscriptions.js";
import { logger } from "../lib/logger.js";
import { verifyRazorpaySignature } from "../lib/razorpaySignature.js";
import { fail, ok } from "../lib/response.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { invalidateSubscriptionCache, isSubscriptionActive } from "../middleware/subscription.js";

const RAZORPAY_BASE = "https://api.razorpay.com/v1";

function razorpayConfigured(): boolean {
  return !!(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET && env.RAZORPAY_PLAN_ID);
}

type RazorpayResult<T> = { ok: true; data: T } | { ok: false; error: string };

async function razorpayPost<T>(
  path: string,
  body: Record<string, unknown>,
): Promise<RazorpayResult<T>> {
  const auth = Buffer.from(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`).toString("base64");
  try {
    const res = await fetch(`${RAZORPAY_BASE}${path}`, {
      method: "POST",
      headers: {
        authorization: `Basic ${auth}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as {
      error?: { code?: string; description?: string };
    };
    if (!res.ok) {
      return { ok: false, error: json.error?.description ?? `HTTP ${res.status}` };
    }
    return { ok: true, data: json as T };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "unknown" };
  }
}

async function loadSubscriptionRow(propertyId: string): Promise<Subscription | null> {
  const [row] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.propertyId, propertyId))
    .limit(1);
  return row ?? null;
}

const router = Router();
router.use(requireAuth, requireRole("admin"));

router.get("/", async (req, res) => {
  const sub = await loadSubscriptionRow(req.propertyId);
  if (!sub) return fail(res, 404, "NOT_FOUND", "No subscription record for this hotel");

  const now = new Date();
  const locked = !isSubscriptionActive(sub, now);
  // Days remaining on whichever clock applies: the trial, or the paid period.
  const until =
    sub.status === "trialing" ? sub.trialEndsAt : sub.status === "active" ? sub.currentPeriodEnd : null;
  const daysLeft = until
    ? Math.max(0, Math.ceil((until.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)))
    : 0;

  return ok(res, {
    plan: sub.plan,
    status: sub.status,
    trialEndsAt: sub.trialEndsAt,
    currentPeriodEnd: sub.currentPeriodEnd,
    razorpaySubscriptionId: sub.razorpaySubscriptionId,
    locked,
    daysLeft,
  });
});

router.post("/subscribe", async (req, res) => {
  if (!razorpayConfigured()) {
    return fail(res, 503, "BILLING_NOT_CONFIGURED", "Online billing is not configured yet");
  }
  const sub = await loadSubscriptionRow(req.propertyId);
  if (!sub) return fail(res, 404, "NOT_FOUND", "No subscription record for this hotel");

  // 1. Razorpay customer (once per hotel). fail_existing=0 returns the
  //    existing customer for this email instead of erroring.
  let customerId = sub.razorpayCustomerId;
  if (!customerId) {
    const customer = await razorpayPost<{ id: string }>("/customers", {
      name: req.user!.fullName,
      email: req.user!.email,
      fail_existing: 0,
    });
    if (!customer.ok) {
      logger.warn({ propertyId: req.propertyId, error: customer.error }, "razorpay customer create failed");
      return fail(res, 502, "BILLING_PROVIDER_ERROR", "Could not reach the payment provider. Try again.");
    }
    customerId = customer.data.id;
    await db
      .update(subscriptions)
      .set({ razorpayCustomerId: customerId, updatedAt: new Date() })
      .where(eq(subscriptions.id, sub.id));
  }

  // 2. Razorpay subscription on the single standard plan. total_count 120
  //    = ten years of monthly cycles (Razorpay requires a finite count).
  //    Activation comes back through the webhook, not this response.
  const created = await razorpayPost<{ id: string }>("/subscriptions", {
    plan_id: env.RAZORPAY_PLAN_ID,
    customer_id: customerId,
    total_count: 120,
    customer_notify: 1,
  });
  if (!created.ok) {
    logger.warn({ propertyId: req.propertyId, error: created.error }, "razorpay subscription create failed");
    return fail(res, 502, "BILLING_PROVIDER_ERROR", "Could not start the subscription. Try again.");
  }

  await db
    .update(subscriptions)
    .set({ razorpaySubscriptionId: created.data.id, updatedAt: new Date() })
    .where(eq(subscriptions.id, sub.id));
  invalidateSubscriptionCache(req.propertyId);

  logger.info(
    { propertyId: req.propertyId, razorpaySubscriptionId: created.data.id },
    "razorpay subscription created",
  );
  // The client opens Razorpay Checkout with these.
  return ok(res, { subscriptionId: created.data.id, keyId: env.RAZORPAY_KEY_ID });
});

router.post("/cancel", async (req, res) => {
  const sub = await loadSubscriptionRow(req.propertyId);
  if (!sub) return fail(res, 404, "NOT_FOUND", "No subscription record for this hotel");
  if (!sub.razorpaySubscriptionId) {
    return fail(res, 400, "NOTHING_TO_CANCEL", "No paid subscription to cancel");
  }
  if (!razorpayConfigured()) {
    return fail(res, 503, "BILLING_NOT_CONFIGURED", "Online billing is not configured yet");
  }

  // Cancel at cycle end — the hotel keeps access it has paid for; the
  // subscription.cancelled webhook confirms the final state from Razorpay.
  const cancelled = await razorpayPost<{ id: string; status: string }>(
    `/subscriptions/${sub.razorpaySubscriptionId}/cancel`,
    { cancel_at_cycle_end: 1 },
  );
  if (!cancelled.ok) {
    logger.warn({ propertyId: req.propertyId, error: cancelled.error }, "razorpay cancel failed");
    return fail(res, 502, "BILLING_PROVIDER_ERROR", "Could not cancel the subscription. Try again.");
  }

  await db
    .update(subscriptions)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(eq(subscriptions.id, sub.id));
  invalidateSubscriptionCache(req.propertyId);

  logger.info(
    { propertyId: req.propertyId, razorpaySubscriptionId: sub.razorpaySubscriptionId },
    "subscription cancelled (at cycle end)",
  );
  return ok(res, { status: "cancelled" });
});

// ---------------------------------------------------------------------------
// Webhook. Mounted in index.ts with express.raw BEFORE the app-level
// express.json — signature verification needs the exact raw bytes. No auth;
// the HMAC over the body IS the authentication.
// ---------------------------------------------------------------------------

interface RazorpaySubscriptionEntity {
  id?: string;
  current_start?: number | null;
  current_end?: number | null;
}

interface RazorpayWebhookPayload {
  event?: string;
  payload?: { subscription?: { entity?: RazorpaySubscriptionEntity } };
}

const WEBHOOK_STATUS_MAP: Record<string, SubscriptionStatus> = {
  "subscription.activated": "active",
  "subscription.charged": "active",
  "subscription.halted": "past_due",
  "subscription.cancelled": "cancelled",
  "subscription.completed": "expired",
};

function epochToDate(seconds: number | null | undefined): Date | undefined {
  return typeof seconds === "number" && seconds > 0 ? new Date(seconds * 1000) : undefined;
}

export async function razorpayWebhook(req: Request, res: Response) {
  if (!env.RAZORPAY_WEBHOOK_SECRET) {
    return fail(res, 503, "BILLING_NOT_CONFIGURED", "Webhook secret not configured");
  }
  const signature = req.header("x-razorpay-signature") ?? "";
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
  if (!verifyRazorpaySignature(rawBody, signature, env.RAZORPAY_WEBHOOK_SECRET)) {
    logger.warn({ ip: req.ip ?? "unknown" }, "razorpay webhook: bad signature");
    return fail(res, 400, "INVALID_SIGNATURE", "Signature verification failed");
  }

  let payload: RazorpayWebhookPayload;
  try {
    payload = JSON.parse(rawBody.toString("utf8")) as RazorpayWebhookPayload;
  } catch {
    return fail(res, 400, "INVALID_PAYLOAD", "Body is not valid JSON");
  }

  const event = payload.event ?? "unknown";
  const entity = payload.payload?.subscription?.entity;
  const razorpaySubscriptionId = entity?.id;
  logger.info({ event, razorpaySubscriptionId }, "razorpay webhook received");

  const status = WEBHOOK_STATUS_MAP[event];
  // Unhandled event types are acknowledged so Razorpay doesn't retry-loop.
  if (!status || !razorpaySubscriptionId) return ok(res, { ignored: true });

  const [sub] = await db
    .select({ id: subscriptions.id, propertyId: subscriptions.propertyId })
    .from(subscriptions)
    .where(eq(subscriptions.razorpaySubscriptionId, razorpaySubscriptionId))
    .limit(1);
  // Unknown subscription id (e.g. test-mode events) — acknowledge, don't 4xx.
  if (!sub) {
    logger.warn({ event, razorpaySubscriptionId }, "razorpay webhook: unknown subscription id");
    return ok(res, { ignored: true });
  }

  // Idempotent by construction: the update sets absolute values derived
  // from the event, so redelivery converges on the same row state.
  const patch: Partial<typeof subscriptions.$inferInsert> = { status, updatedAt: new Date() };
  if (status === "active") {
    const periodStart = epochToDate(entity?.current_start);
    const periodEnd = epochToDate(entity?.current_end);
    if (periodStart) patch.currentPeriodStart = periodStart;
    if (periodEnd) patch.currentPeriodEnd = periodEnd;
  }
  await db.update(subscriptions).set(patch).where(eq(subscriptions.id, sub.id));
  invalidateSubscriptionCache(sub.propertyId);

  logger.info(
    { event, razorpaySubscriptionId, propertyId: sub.propertyId, status },
    "razorpay webhook applied",
  );
  return ok(res, { processed: true });
}

export default router;
