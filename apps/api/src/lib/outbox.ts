import { and, eq, lte, sql } from "drizzle-orm";

import { db } from "../db/client.js";
import { messageOutbox } from "../db/schema/messageOutbox.js";
import { logger } from "./logger.js";
import type { EmailMessage, SmsMessage } from "./messaging.js";

// Offline message outbox: enqueue + connectivity-gated drainer.
//
// In offline mode, messaging.sendSms/sendEmail call enqueue() and return
// immediately. A background loop (startOutboxDrainer) attempts delivery via the
// VPS send-proxy whenever the desk has connectivity, with exponential backoff
// on failure. Delivery credentials (Twilio/Resend) live on the VPS, never on
// the desk — the drainer only holds a per-device send token.

const MAX_ATTEMPTS = 12;
const BASE_BACKOFF_MS = 30 * 1000; // 30s, doubling up to ~a few hours

/** Enqueue a message for later delivery. Returns immediately. */
export async function enqueueMessage(
  channel: "sms" | "email",
  recipient: string,
  payload: SmsMessage | EmailMessage,
): Promise<void> {
  // Serialize binary attachments (invoice/receipt PDFs, ~100-300KB) as base64
  // so the deliverer can reattach them at drain time. Buffers don't survive
  // JSON.stringify on their own (they become {type:"Buffer",data:[...]}, 4x
  // the size), so encode explicitly.
  const safePayload: Record<string, unknown> = { ...payload };
  if ("attachments" in safePayload && Array.isArray(safePayload.attachments)) {
    safePayload.attachments = (safePayload.attachments as { filename: string; content: Buffer; contentType?: string }[]).map(
      (a) => ({
        filename: a.filename,
        contentType: a.contentType,
        contentBase64: Buffer.isBuffer(a.content) ? a.content.toString("base64") : String(a.content),
      }),
    );
  }

  await db.insert(messageOutbox).values({
    channel,
    recipient,
    payload: JSON.stringify(safePayload),
  });
  logger.debug({ channel, recipient }, "message enqueued (offline)");
}

/** Count of undelivered messages — surfaced in the UI's offline banner. */
export async function pendingMessageCount(): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(messageOutbox)
    .where(eq(messageOutbox.status, "pending"));
  return row?.n ?? 0;
}

/** Count of permanently-failed messages — surfaced alongside pending. */
export async function failedMessageCount(): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(messageOutbox)
    .where(eq(messageOutbox.status, "failed"));
  return row?.n ?? 0;
}

/**
 * Requeue every failed message. Run once at boot: before the direct deliverer
 * existed, rows exhausted their attempts against a stub that always failed
 * ("delivery proxy not configured") and were parked as failed. They never
 * actually went anywhere, so re-arming them is safe (no duplicate sends).
 */
export async function requeueFailedMessages(): Promise<number> {
  const rows = await db
    .update(messageOutbox)
    .set({ status: "pending", attempts: 0, nextAttemptAt: new Date(), lastError: null })
    .where(eq(messageOutbox.status, "failed"))
    .returning({ id: messageOutbox.id });
  if (rows.length) logger.info({ count: rows.length }, "requeued failed outbox messages");
  return rows.length;
}

// The delivery transport. Wired to the direct Twilio/Resend deliverer at boot
// (lib/outboxDeliverer.ts); injectable so tests can plug in their own.
// `transient: true` means "couldn't even try — no credentials or no internet";
// those failures don't consume attempts, so a desk that's offline for a week
// still delivers everything when connectivity returns.
export type OutboxDeliverer = (
  channel: "sms" | "email",
  recipient: string,
  payload: unknown,
) => Promise<{ ok: boolean; error?: string; transient?: boolean }>;

// Default until wired: stay queued, don't burn attempts.
let deliverer: OutboxDeliverer = async () => ({
  ok: false,
  transient: true,
  error: "deliverer not wired",
});

export function setOutboxDeliverer(fn: OutboxDeliverer): void {
  deliverer = fn;
}

/** Attempt to deliver all due pending messages once. Returns #delivered. */
export async function drainOnce(now = new Date()): Promise<number> {
  const due = await db
    .select()
    .from(messageOutbox)
    .where(and(eq(messageOutbox.status, "pending"), lte(messageOutbox.nextAttemptAt, now)))
    .limit(50);

  let delivered = 0;
  for (const row of due) {
    let payload: unknown;
    try {
      payload = JSON.parse(row.payload);
    } catch {
      await db
        .update(messageOutbox)
        .set({ status: "failed", lastError: "unparseable payload" })
        .where(eq(messageOutbox.id, row.id));
      continue;
    }

    const result = await deliverer(row.channel, row.recipient, payload);
    if (result.ok) {
      await db
        .update(messageOutbox)
        .set({ status: "sent", sentAt: new Date(), lastError: null })
        .where(eq(messageOutbox.id, row.id));
      delivered++;
    } else if (result.transient) {
      // Couldn't attempt at all (no internet / no credentials): reschedule a
      // minute out WITHOUT consuming an attempt. Messages must survive
      // arbitrarily long offline stretches.
      await db
        .update(messageOutbox)
        .set({
          lastError: result.error ?? "no connectivity",
          nextAttemptAt: new Date(now.getTime() + 60 * 1000),
        })
        .where(eq(messageOutbox.id, row.id));
    } else {
      const attempts = row.attempts + 1;
      const backoff = Math.min(BASE_BACKOFF_MS * 2 ** row.attempts, 4 * 60 * 60 * 1000);
      const status = attempts >= MAX_ATTEMPTS ? "failed" : "pending";
      await db
        .update(messageOutbox)
        .set({
          attempts,
          status,
          lastError: result.error ?? "delivery failed",
          nextAttemptAt: new Date(now.getTime() + backoff),
        })
        .where(eq(messageOutbox.id, row.id));
    }
  }
  return delivered;
}

let timer: NodeJS.Timeout | null = null;

/** Start the periodic drainer. No-op if already running. */
export function startOutboxDrainer(intervalMs = 60 * 1000): void {
  if (timer) return;
  timer = setInterval(() => {
    drainOnce().catch((err) =>
      logger.debug({ err: err instanceof Error ? err.message : err }, "outbox drain tick failed"),
    );
  }, intervalMs);
  // Don't keep the process alive just for the drainer.
  timer.unref?.();
  logger.info("message outbox drainer started");
}

export function stopOutboxDrainer(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
