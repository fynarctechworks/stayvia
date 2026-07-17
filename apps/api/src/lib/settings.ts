import { db } from "../db/client.js";
import { settings, type Settings } from "../db/schema/settings.js";

let cached: { value: Settings; expiresAt: number } | null = null;
const TTL_MS = 60_000;

export async function getSettings(): Promise<Settings> {
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const rows = await db.select().from(settings).limit(1);
  if (!rows.length) throw new Error("Settings row not found. Run db:seed.");
  cached = { value: rows[0]!, expiresAt: Date.now() + TTL_MS };
  return rows[0]!;
}

export function invalidateSettings() {
  cached = null;
}
