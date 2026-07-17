// Resolve "which property is this request acting on".
//
// Today: every request acts on the PRIMARY property (single-tenant).
// Tomorrow: the user's profile may declare a default property, or the
// request may carry a `X-Property-Id` header chosen by a property
// switcher in the UI. Either way, code that needs to INSERT a
// property_id should call resolveCurrentPropertyId(req) instead of
// hard-coding anything.

import type { Request } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { properties, PRIMARY_PROPERTY_CODE } from "../db/schema/properties.js";
import { logger } from "./logger.js";

// 60-second cache. The bootstrap property's id never changes, so this
// is effectively a one-time lookup per process; the TTL is a defensive
// upper bound in case a future migration reseeds the table.
let cached: { id: string; expiresAt: number } | null = null;

export async function resolveCurrentPropertyId(_req?: Request): Promise<string> {
  // Future: read `_req.user.defaultPropertyId` or `req.header("x-property-id")`
  // here, validate it against the caller's allowed properties, and
  // return that. For now we always return PRIMARY.
  if (cached && cached.expiresAt > Date.now()) return cached.id;

  const [row] = await db
    .select({ id: properties.id })
    .from(properties)
    .where(eq(properties.code, PRIMARY_PROPERTY_CODE))
    .limit(1);

  if (!row) {
    logger.error(
      { code: PRIMARY_PROPERTY_CODE },
      "PRIMARY property row missing — migration 0013 must run before any property-scoped insert",
    );
    throw new Error("PRIMARY property not found. Apply migration 0013.");
  }

  cached = { id: row.id, expiresAt: Date.now() + 60_000 };
  return row.id;
}

export function clearPropertyCache() {
  cached = null;
}
