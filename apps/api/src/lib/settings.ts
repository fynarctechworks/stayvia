import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { settings, type Settings } from "../db/schema/settings.js";

// Per-property cache. One entry per hotel, keyed by property id.
const cache = new Map<string, { value: Settings; expiresAt: number }>();
const TTL_MS = 60_000;

export async function getSettings(propertyId: string): Promise<Settings> {
  const hit = cache.get(propertyId);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  const rows = await db
    .select()
    .from(settings)
    .where(eq(settings.propertyId, propertyId))
    .limit(1);
  if (!rows.length) {
    throw new Error(`Settings row not found for property ${propertyId}.`);
  }
  cache.set(propertyId, { value: rows[0]!, expiresAt: Date.now() + TTL_MS });
  return rows[0]!;
}

// Clears one property's cached settings, or every property's when no id is
// given (used by the pub/sub fallback path).
export function invalidateSettings(propertyId?: string) {
  if (propertyId) cache.delete(propertyId);
  else cache.clear();
}
