import { asc, isNull, lte, sql } from "drizzle-orm";

import { env } from "../../config/env.js";
import { db } from "../../db/client.js";
import { syncOutbox } from "../../db/schema/syncOutbox.js";
import { logger } from "../logger.js";

// Desk-side sync pusher (offline mode only). Drains sync_outbox in change_seq
// order and POSTs batches to the cloud /sync/ingest. At-least-once: a row is
// marked pushed ONLY after the cloud acks it, so a lost ack just re-sends
// (the cloud dedups by (device, change_seq), making replay a no-op). Money is
// already durable in local Postgres before this runs — push is pure backup, so
// there is no "lost payment" risk here, only "push it again."
//
// Config (from env / handshake): SYNC_INGEST_URL, SYNC_DEVICE_ID,
// SYNC_DEVICE_TOKEN. When any is absent, the pusher stays idle (Phase 1 desks
// run with no cloud replica yet).

const BATCH = 200;
const BASE_BACKOFF_MS = 15 * 1000;
const MAX_BACKOFF_MS = 10 * 60 * 1000;

type PushConfig = {
  ingestUrl: string;
  deviceId: string;
  token: string;
};

function config(): PushConfig | null {
  const ingestUrl = process.env.SYNC_INGEST_URL;
  const deviceId = process.env.SYNC_DEVICE_ID;
  const token = process.env.SYNC_DEVICE_TOKEN;
  if (!ingestUrl || !deviceId || !token) return null;
  return { ingestUrl, deviceId, token };
}

// Injectable transport so tests can drive the pusher without a real network.
export type PushTransport = (
  cfg: PushConfig,
  changes: unknown[],
) => Promise<{ ok: boolean; ackSeq?: number; error?: string }>;

const httpTransport: PushTransport = async (cfg, changes) => {
  try {
    const resp = await fetch(cfg.ingestUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.token}`,
      },
      body: JSON.stringify({ deviceId: cfg.deviceId, changes }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` };
    const json = (await resp.json()) as { data?: { ackSeq?: number } };
    return { ok: true, ackSeq: json.data?.ackSeq };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "network error" };
  }
};

let transport: PushTransport = httpTransport;
export function setPushTransport(fn: PushTransport): void {
  transport = fn;
}

/**
 * Drain one batch. Returns the number of rows pushed (0 if nothing pending or
 * offline/unconfigured or the push failed). Exposed for tests.
 */
export async function pushOnce(now = new Date()): Promise<number> {
  const cfg = config();
  if (!cfg) return 0;

  const pending = await db
    .select()
    .from(syncOutbox)
    .where(isNull(syncOutbox.pushedAt))
    .orderBy(asc(syncOutbox.changeSeq))
    .limit(BATCH);

  if (pending.length === 0) return 0;

  const changes = pending.map((r) => ({
    changeSeq: r.changeSeq,
    tableName: r.tableName,
    op: r.op,
    rowId: r.rowId,
    rowData: r.rowData,
  }));

  const result = await transport(cfg, changes);
  if (!result.ok) {
    logger.debug({ err: result.error }, "sync push failed (will retry)");
    return 0;
  }

  // Mark everything up to the acked seq as pushed. The cloud acks the highest
  // seq it durably applied/deduped, so this is safe even if the batch was a
  // partial replay.
  const ackSeq = result.ackSeq ?? pending[pending.length - 1]!.changeSeq;
  await db
    .update(syncOutbox)
    .set({ pushedAt: now })
    .where(lte(syncOutbox.changeSeq, ackSeq));

  logger.info({ pushed: changes.length, ackSeq }, "sync batch pushed");
  return changes.length;
}

let timer: NodeJS.Timeout | null = null;
let backoff = BASE_BACKOFF_MS;

/** Start the periodic pusher (offline mode only). No-op if already running or
 * no cloud replica configured. */
export function startSyncPusher(intervalMs = BASE_BACKOFF_MS): void {
  if (!env.OFFLINE_MODE) return;
  if (!config()) {
    logger.info("sync pusher idle — no cloud replica configured (SYNC_INGEST_URL unset)");
    return;
  }
  if (timer) return;

  const tick = async () => {
    try {
      const n = await pushOnce();
      // Reset backoff on any successful drain; grow it when there's nothing
      // to push or the push failed.
      backoff = n > 0 ? BASE_BACKOFF_MS : Math.min(backoff * 2, MAX_BACKOFF_MS);
    } catch (err) {
      logger.debug({ err: err instanceof Error ? err.message : err }, "sync push tick error");
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    }
    timer = setTimeout(tick, backoff);
    timer.unref?.();
  };
  timer = setTimeout(tick, intervalMs);
  timer.unref?.();
  logger.info("sync pusher started");
}

export function stopSyncPusher(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

// Count of un-pushed changes — for the offline UI's sync-status indicator.
export async function pendingPushCount(): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(syncOutbox)
    .where(isNull(syncOutbox.pushedAt));
  return row?.n ?? 0;
}
