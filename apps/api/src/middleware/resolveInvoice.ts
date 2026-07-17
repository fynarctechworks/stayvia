// Resolve :id on the invoices router from either a UUID or the
// SLDT-INV-NNNN number. Invoice numbers are immutable once issued, so
// the cache lifetime is bounded only by TTL eviction.

import type { NextFunction, Request, Response } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { invoices } from "../db/schema/invoices.js";
import { fail } from "../lib/response.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Matches both ordinary invoices (SLDT-INV-####) and credit notes
// (SLDT-CN-####) — both live in the invoices table and are previewed
// through the same PDF route.
const INVOICE_NUMBER_RE = /^SLDT-(INV|CN)-\d+$/i;

const CACHE_MAX = 100;
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

export async function resolveInvoiceId(
  req: Request,
  res: Response,
  next: NextFunction,
  value?: string,
): Promise<void> {
  const raw = value ?? req.params.id;
  if (!raw) return next();
  if (UUID_RE.test(raw)) return next();

  if (INVOICE_NUMBER_RE.test(raw)) {
    const key = raw.toUpperCase();
    const cached = cacheGet(key);
    if (cached) {
      req.params.id = cached;
      return next();
    }

    const r = await db
      .select({ id: invoices.id })
      .from(invoices)
      .where(eq(invoices.invoiceNumber, key))
      .limit(1);

    if (!r.length) {
      fail(res, 404, "NOT_FOUND", "Invoice not found");
      return;
    }

    cacheSet(key, r[0]!.id);
    req.params.id = r[0]!.id;
    return next();
  }

  return next();
}

export function _clearInvoiceIdCache(): void {
  cache.clear();
}
