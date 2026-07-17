// Middleware that lets every route in routes/reservations.ts accept
// either a UUID or the human-readable SLDT-RES-NNNN number in :id.
// Sits in front of the router so handlers can keep using
// req.params.id as the canonical UUID without caring how the client
// addressed it.
//
// Lookups by reservation_number are cached in-memory (small LRU)
// because the mapping is immutable once issued — a reservation number
// always points at the same UUID for the life of the row. We bound
// the cache so a never-restarted process can't accumulate stale
// entries forever; TTL is a belt-and-braces if someone ever wipes a
// row through a back-channel.

import type { NextFunction, Request, Response } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { reservations } from "../db/schema/reservations.js";
import { fail } from "../lib/response.js";

const RES_NUMBER_RE = /^SLDT-RES-\d+$/i;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CACHE_MAX = 100;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface CacheEntry {
  uuid: string;
  expiresAt: number;
}

// Simple LRU: Map preserves insertion order, so the oldest key is
// always the first one. On hit we delete + re-set to move it to the
// end. On overflow we delete the first key (the oldest).
const cache = new Map<string, CacheEntry>();

function cacheGet(key: string): string | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) {
    cache.delete(key);
    return null;
  }
  cache.delete(key);
  cache.set(key, hit);
  return hit.uuid;
}

function cacheSet(key: string, uuid: string): void {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(key, { uuid, expiresAt: Date.now() + CACHE_TTL_MS });
}

// Compatible with router.param(): Express passes the matched value
// as the 4th arg. We accept it but also fall back to req.params.id so
// the same function can be mounted as plain middleware in tests.
export async function resolveReservationId(
  req: Request,
  res: Response,
  next: NextFunction,
  value?: string,
): Promise<void> {
  const raw = value ?? req.params.id;
  // No :id param on this route — nothing to do.
  if (!raw) return next();

  // Already a UUID. Pass through. We don't validate existence here:
  // the handler will do its own existence check and return 404 if
  // wrong. Avoiding the extra query on the common path matters.
  if (UUID_RE.test(raw)) return next();

  // Recognised reservation-number shape. Resolve to UUID.
  if (RES_NUMBER_RE.test(raw)) {
    const key = raw.toUpperCase();
    const cached = cacheGet(key);
    if (cached) {
      req.params.id = cached;
      return next();
    }

    const rows = await db
      .select({ id: reservations.id })
      .from(reservations)
      .where(eq(reservations.reservationNumber, key))
      .limit(1);

    if (!rows.length) {
      fail(res, 404, "NOT_FOUND", "Reservation not found");
      return;
    }

    cacheSet(key, rows[0]!.id);
    req.params.id = rows[0]!.id;
    return next();
  }

  // Neither UUID nor reservation-number shape — let the handler
  // reject it. (Keeps a window open for future ID formats.)
  return next();
}

// Test-only hook for clearing the cache between tests.
export function _clearReservationIdCache(): void {
  cache.clear();
}
