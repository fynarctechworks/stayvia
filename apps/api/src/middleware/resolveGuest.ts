// Resolve :id on the guests router from either a UUID or a phone
// number. Phone is the only reasonably-stable human identifier we
// have for guests — full names are too collision-prone for URL use.
//
// CAVEATS the caller should be aware of:
//   - Phones aren't strictly immutable (a guest can update theirs). We
//     accept that the URL goes stale on phone change; the cache TTL
//     limits how long.
//   - The phone index in the guests schema is UNIQUE so resolution is
//     unambiguous when it succeeds.
//
// Inputs Express passes us may be raw ("9876543210") or
// percent-encoded ("%2B919876543210" for "+919876543210"). Express
// already decodes path params, so we usually see the literal "+".

import type { NextFunction, Request, Response } from "express";
import { desc, eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { guestPhoneHistory, guests } from "../db/schema/guests.js";
import { normalisePhone } from "../lib/phone.js";
import { fail } from "../lib/response.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Loose phone shape: optional +, then 7-15 digits, optional spaces/
// dashes/parens. Common Indian + international formats. Stricter than
// "anything goes" — won't accidentally match weird inputs.
const PHONE_RE = /^\+?[\d\s\-()]{7,20}$/;

const CACHE_MAX = 200;
const CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
  uuid: string;
  expiresAt: number;
}
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

export async function resolveGuestId(
  req: Request,
  res: Response,
  next: NextFunction,
  value?: string,
): Promise<void> {
  const raw = value ?? req.params.id;
  if (!raw) return next();

  if (UUID_RE.test(raw)) return next();

  if (PHONE_RE.test(raw)) {
    const normalised = normalisePhone(raw);
    const cached = cacheGet(normalised);
    if (cached) {
      req.params.id = cached;
      return next();
    }

    // Primary lookup: live guests table, exact match. Fast — hits the
    // unique index on guests.phone.
    const live = await db
      .select({ id: guests.id })
      .from(guests)
      .where(eq(guests.phone, normalised))
      .limit(1);

    if (live.length) {
      cacheSet(normalised, live[0]!.id);
      req.params.id = live[0]!.id;
      return next();
    }

    // Fallback 1: phone_history exact match. A guest who updated
    // their phone leaves their old number(s) here. Pick the row with
    // the latest valid_from so two guests who shared a number at
    // different times resolve to the most recent owner.
    const historic = await db
      .select({ guestId: guestPhoneHistory.guestId })
      .from(guestPhoneHistory)
      .where(eq(guestPhoneHistory.phone, normalised))
      .orderBy(desc(guestPhoneHistory.validFrom))
      .limit(1);

    if (historic.length) {
      cacheSet(normalised, historic[0]!.guestId);
      req.params.id = historic[0]!.guestId;
      return next();
    }

    // Fallback 2: tolerant match. Strips the same characters from the
    // STORED phone at query time and compares. Covers any legacy rows
    // that pre-date phone normalisation on write (e.g. imported data
    // with spaces or dashes). Skips the index, but only fires after
    // the indexed lookups missed, so cost is bounded.
    const tolerant = await db
      .select({ id: guests.id })
      .from(guests)
      .where(
        sql`regexp_replace(${guests.phone}, '[\\s\\-()]', '', 'g') = ${normalised}`,
      )
      .limit(1);

    if (tolerant.length) {
      cacheSet(normalised, tolerant[0]!.id);
      req.params.id = tolerant[0]!.id;
      return next();
    }

    fail(res, 404, "NOT_FOUND", "Guest not found");
    return;
  }

  return next();
}

export function _clearGuestIdCache(): void {
  cache.clear();
}
