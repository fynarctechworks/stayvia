// Resolve "which property is this request acting on".
//
// TODO(phase-2.3): replace with req.propertyId set by requireAuth from the
// authenticated profile's property_id — then delete this module and its
// call sites. Until then, this dev convenience resolves the FIRST (and, in
// a freshly-provisioned dev database, only) property row. It intentionally
// throws when more than one hotel exists so a multi-tenant deployment can
// never silently attribute writes to the wrong hotel.

import type { Request } from "express";
import { asc } from "drizzle-orm";
import { db } from "../db/client.js";
import { properties } from "../db/schema/properties.js";
import { logger } from "./logger.js";

// 60-second cache — a single-hotel dev DB doesn't change under us; the
// TTL bounds staleness if the table is reseeded.
let cached: { id: string; expiresAt: number } | null = null;

export async function resolveCurrentPropertyId(_req?: Request): Promise<string> {
  if (cached && cached.expiresAt > Date.now()) return cached.id;

  const rows = await db
    .select({ id: properties.id })
    .from(properties)
    .orderBy(asc(properties.createdAt))
    .limit(2);

  if (rows.length === 0) {
    logger.error("No properties row — run db:seed (provisionProperty) before property-scoped writes");
    throw new Error("No property provisioned. Run the seed first.");
  }
  if (rows.length > 1) {
    // Multiple hotels: the tenant MUST come from the authenticated
    // profile (phase 2.3). Failing loudly beats guessing.
    throw new Error(
      "Multiple properties exist — resolveCurrentPropertyId cannot pick one. Tenant resolution via req.propertyId required.",
    );
  }

  cached = { id: rows[0]!.id, expiresAt: Date.now() + 60_000 };
  return rows[0]!.id;
}

export function clearPropertyCache() {
  cached = null;
}
