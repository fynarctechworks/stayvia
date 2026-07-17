import { createHash } from "node:crypto";

import { sql } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";

import { db } from "../db/client.js";
import { ingestBatch, type SyncChange } from "../lib/sync/ingest.js";
import { logger } from "../lib/logger.js";
import { fail, ok } from "../lib/response.js";
import { validate } from "../middleware/validate.js";

// Cloud-side sync ingest endpoint (VPS replica only — mounted online, never
// offline). The desk authenticates with a per-device bearer token
// (sync_devices); the token is the ONLY credential the desk holds for the
// cloud, so it's scoped to sync ingest and revocable.

const router = Router();

const changeSchema = z.object({
  changeSeq: z.number().int().nonnegative(),
  tableName: z.string().min(1).max(63),
  op: z.enum(["I", "U", "D"]),
  rowId: z.string().uuid(),
  rowData: z.record(z.unknown()).nullable(),
});

const ingestSchema = z.object({
  deviceId: z.string().min(1).max(128),
  // Ordered by changeSeq ascending — the ingest relies on this for FK-safe
  // replay. Capped to bound a single request; the pusher chunks larger drains.
  changes: z.array(changeSchema).max(500),
});

// Verify the device bearer token against sync_devices (sha256 of the token).
async function authDevice(deviceId: string, token: string): Promise<boolean> {
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const [row] = await db.execute(sql`
    SELECT device_id FROM sync_devices
    WHERE device_id = ${deviceId}
      AND token_hash = ${tokenHash}
      AND revoked_at IS NULL
    LIMIT 1
  `) as unknown as Array<{ device_id: string }>;
  return !!row;
}

router.post("/ingest", validate(ingestSchema), async (req, res) => {
  const { deviceId, changes } = req.body as z.infer<typeof ingestSchema>;

  const header = req.header("authorization") ?? "";
  if (!header.startsWith("Bearer ")) {
    return fail(res, 401, "UNAUTHENTICATED", "Missing device token");
  }
  const token = header.slice("Bearer ".length).trim();
  if (!(await authDevice(deviceId, token))) {
    logger.warn({ deviceId, ip: req.ip }, "sync ingest: bad device token");
    return fail(res, 401, "UNAUTHENTICATED", "Invalid device token");
  }

  // Ensure ascending change_seq order (defense — the pusher already orders).
  const ordered = [...changes].sort((a, b) => a.changeSeq - b.changeSeq);

  try {
    const result = await ingestBatch(deviceId, ordered as SyncChange[]);
    // Record liveness (best-effort).
    await db
      .execute(sql`UPDATE sync_devices SET last_seen_at = now() WHERE device_id = ${deviceId}`)
      .catch(() => {});
    // Ack the highest seq we durably applied/skipped — the pusher marks
    // everything up to here as pushed.
    const ackSeq = ordered.length ? ordered[ordered.length - 1]!.changeSeq : 0;
    return ok(res, { ...result, ackSeq });
  } catch (err) {
    logger.error({ err, deviceId }, "sync ingest failed");
    return fail(res, 500, "INGEST_FAILED", "Sync ingest failed");
  }
});

export default router;

// Exported for tests / provisioning tooling.
export { authDevice };
