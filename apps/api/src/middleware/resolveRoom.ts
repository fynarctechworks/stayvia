// Resolve :id on the rooms router from either a UUID or a room_number
// (the human-readable "201", "302", etc.). Mirrors the pattern used
// for reservations — handlers downstream keep reading req.params.id
// as the UUID and don't care how the client addressed it.
//
// Room numbers are immutable for the life of a room row, so cache hits
// stay valid until the row is deleted.

import type { NextFunction, Request, Response } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { rooms } from "../db/schema/rooms.js";
import { fail } from "../lib/response.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Room numbers in the seeded data are short numerics ("101", "201"),
// but the schema allows free-form text — alphanumerics + dashes is a
// safe upper bound that won't collide with a UUID's shape.
const ROOM_NUMBER_RE = /^[A-Za-z0-9-]{1,16}$/;

const CACHE_MAX = 50;
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

export async function resolveRoomId(
  req: Request,
  res: Response,
  next: NextFunction,
  value?: string,
): Promise<void> {
  const raw = value ?? req.params.id;
  if (!raw) return next();

  if (UUID_RE.test(raw)) return next();

  // Distinguish room-number from anything bogus. UUIDs were caught
  // above; UUIDs ALSO match the alphanumeric pattern, hence the order.
  if (ROOM_NUMBER_RE.test(raw)) {
    const key = raw;
    const cached = cacheGet(key);
    if (cached) {
      req.params.id = cached;
      return next();
    }

    const r = await db
      .select({ id: rooms.id })
      .from(rooms)
      .where(eq(rooms.roomNumber, key))
      .limit(1);

    if (!r.length) {
      fail(res, 404, "NOT_FOUND", "Room not found");
      return;
    }

    cacheSet(key, r[0]!.id);
    req.params.id = r[0]!.id;
    return next();
  }

  return next();
}

export function _clearRoomIdCache(): void {
  cache.clear();
}
