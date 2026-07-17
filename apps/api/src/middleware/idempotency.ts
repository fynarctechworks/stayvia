// Idempotency-key middleware for mutation endpoints.
//
// Usage: attach `idempotent("payment")` to a route. The first request with a
// given Idempotency-Key header runs normally; the response is captured and
// persisted. Any retry with the same key from the same user replays the
// stored response without touching downstream state — so double-clicks,
// browser retries, and flaky network reposts don't create duplicate
// payments or duplicate ledger entries.
//
// Key lifetime: 24 hours, then GC'd.
// Same-key-different-body: returns 409 (almost certainly a client bug).
// Missing key: passes through (legacy clients still work, but lose the
// double-submit protection — better than rejecting).

import { createHash } from "node:crypto";
import { eq, lt } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";
import { db } from "../db/client.js";
import { idempotencyKeys } from "../db/schema/idempotencyKeys.js";
import { logger } from "../lib/logger.js";
import { fail } from "../lib/response.js";

const KEY_TTL_HOURS = 24;
const GC_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

// Periodic GC. Tiny query, cheap to run hourly even if rarely needed.
let gcInitialised = false;
function ensureGc() {
  if (gcInitialised) return;
  gcInitialised = true;
  setInterval(() => {
    db.delete(idempotencyKeys)
      .where(lt(idempotencyKeys.expiresAt, new Date()))
      .catch((err) =>
        logger.debug(
          { err: err instanceof Error ? err.message : err },
          "idempotency GC failed (next run will retry)",
        ),
      );
  }, GC_INTERVAL_MS).unref();
}

function hashBody(body: unknown): string {
  // Canonical-ish JSON. Stable-ordering not strictly necessary here; the
  // hash is only used to detect "same key, different payload" client bugs.
  try {
    return createHash("sha256").update(JSON.stringify(body ?? {})).digest("hex");
  } catch {
    return "";
  }
}

export function idempotent(routeKey: string) {
  ensureGc();
  return async function idempotencyMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const key = req.header("idempotency-key")?.trim();
    if (!key) {
      // No key supplied → legacy / non-idempotent caller. Pass through.
      next();
      return;
    }
    if (!req.user) {
      // requireAuth should run before idempotent(); guard anyway.
      next();
      return;
    }
    if (key.length > 128) {
      fail(res, 400, "INVALID_IDEMPOTENCY_KEY", "Idempotency-Key too long");
      return;
    }

    const compositeId = `${req.user.id}::${routeKey}::${key}`;
    const bodyHash = hashBody(req.body);

    // Look up existing record.
    const [existing] = await db
      .select()
      .from(idempotencyKeys)
      .where(eq(idempotencyKeys.id, compositeId))
      .limit(1);

    if (existing) {
      if (existing.expiresAt < new Date()) {
        // Stale — clear it and let the new request run fresh.
        await db.delete(idempotencyKeys).where(eq(idempotencyKeys.id, compositeId));
      } else if (existing.requestHash !== bodyHash) {
        // Same key, different body. Almost always a client-side bug
        // (the client reused a key it should have rotated).
        logger.warn(
          { userId: req.user.id, routeKey, key },
          "idempotency-key replayed with different payload",
        );
        fail(
          res,
          409,
          "IDEMPOTENCY_CONFLICT",
          "Idempotency-Key was already used with a different request body",
        );
        return;
      } else {
        // Cache hit — replay the stored response.
        logger.info(
          { userId: req.user.id, routeKey, key, status: existing.statusCode },
          "idempotency-key replay",
        );
        res.status(existing.statusCode).type("application/json").send(existing.responseBody);
        return;
      }
    }

    // First-time request. Intercept res.send/.json so we can capture the
    // response after the handler runs, then persist it.
    const originalJson = res.json.bind(res);
    let captured: string | null = null;
    res.json = ((body: unknown) => {
      try {
        captured = JSON.stringify(body);
      } catch {
        captured = null;
      }
      return originalJson(body);
    }) as typeof res.json;

    res.on("finish", () => {
      // Only cache successful responses (2xx). Errors should be retryable.
      if (!captured || res.statusCode < 200 || res.statusCode >= 300) return;
      const expiresAt = new Date(Date.now() + KEY_TTL_HOURS * 60 * 60 * 1000);
      db.insert(idempotencyKeys)
        .values({
          id: compositeId,
          userId: req.user!.id,
          routeKey,
          key,
          requestHash: bodyHash,
          statusCode: res.statusCode,
          responseBody: captured,
          expiresAt,
        })
        .onConflictDoNothing()
        .catch((err) =>
          logger.warn(
            { err: err instanceof Error ? err.message : err, routeKey, key },
            "failed to persist idempotency record",
          ),
        );
    });

    next();
  };
}
