// Automatic guest lifecycle tags.
//
// Tags like "First Time", "Repeat", "VIP" should be earned by the
// underlying numbers, not pinned by hand. This module computes the
// lifecycle tags from the guest's stay history + spend, so the
// answer is consistent across the whole app and can't drift from
// reality.
//
// Manual custom tags (free-text staff entries — "Corporate Account
// #X", "Birthday gift", "Family of 5") are preserved alongside.
// The split is: SYSTEM_TAGS are computed from data; everything else
// is opaque text that staff control.
//
// Thresholds are intentionally hardcoded for now — the small property
// this targets doesn't need them tunable yet. When more properties
// need different cutoffs, move them to the settings table.

const SYSTEM_TAGS = [
  "First Time",
  "New Customer",
  "Repeat",
  "VIP",
  "High Value",
  "Corporate",
  "Blacklist",
] as const;
export type SystemTag = (typeof SYSTEM_TAGS)[number];

// Returns true when a string matches one of the system-managed tag
// names. Comparison is case-insensitive so legacy data ("repeat",
// "REPEAT") still gets reclassified.
export function isSystemTag(tag: string): boolean {
  const norm = tag.trim().toLowerCase();
  return SYSTEM_TAGS.some((t) => t.toLowerCase() === norm);
}

export interface GuestForTagging {
  // From the guests table
  createdAt: Date | string;
  isBlacklisted?: boolean | null;
  gstin?: string | null;
  // Aggregated from reservations + payments — same numbers the guest
  // profile already computes for its "Total stays" / "Total paid"
  // tiles, so we don't redo the work here.
  completedStays: number;
  totalSpent: number;
}

// The thresholds. Same defaults proposed when this feature was
// scoped. Tweak here if the property feels them.
const HIGH_VALUE_SPEND = 50_000; // ₹
const VIP_SPEND = 100_000; // ₹
const VIP_STAYS = 5;
const REPEAT_MIN_STAYS = 2;
const REPEAT_MAX_STAYS = 4;
const NEW_CUSTOMER_AGE_DAYS = 60;

function daysSince(d: Date | string): number {
  const ms = Date.now() - new Date(d).getTime();
  return Math.max(0, Math.floor(ms / 86_400_000));
}

// Compute the auto-tags for one guest. Returns an ordered list:
// status tags first (First Time / Repeat / VIP), then attribute
// tags (High Value / Corporate). Blacklist always sticks at the end
// when present so it's visually obvious.
export function computeGuestLifecycleTags(g: GuestForTagging): SystemTag[] {
  const out: SystemTag[] = [];
  const stays = Math.max(0, g.completedStays | 0);
  const spent = Math.max(0, Number(g.totalSpent) || 0);

  // Lifecycle bucket — mutually exclusive. A guest is in exactly one
  // of First Time / New Customer / Repeat / VIP. VIP wins over Repeat
  // when both qualify.
  if (stays === 0) {
    out.push("First Time");
  } else if (stays >= VIP_STAYS || spent >= VIP_SPEND) {
    out.push("VIP");
  } else if (stays >= REPEAT_MIN_STAYS && stays <= REPEAT_MAX_STAYS) {
    out.push("Repeat");
  } else if (stays === 1 && daysSince(g.createdAt) <= NEW_CUSTOMER_AGE_DAYS) {
    out.push("New Customer");
  }
  // Note: a guest with 5+ stays but spend < VIP threshold still becomes
  // VIP via the stay-count branch, which is the intended behaviour
  // (loyal customers earn VIP even if they spend modestly).

  // Attribute tags — these stack on top of the lifecycle tag.
  if (spent >= HIGH_VALUE_SPEND && !out.includes("VIP")) {
    // VIP already implies high value, so the chip would be redundant.
    out.push("High Value");
  }
  if (g.gstin && g.gstin.trim() !== "") {
    out.push("Corporate");
  }

  // Blacklist last so it's the visual anchor when present.
  if (g.isBlacklisted) {
    out.push("Blacklist");
  }

  return out;
}

// Strip system-managed tags from an arbitrary tags array so what's
// left is only the manual / custom strings staff have added. Used
// before merging computed tags so we don't get duplicates like
// "Repeat" appearing twice.
export function stripSystemTags(tags: string[] | null | undefined): string[] {
  if (!tags || tags.length === 0) return [];
  return tags.filter((t) => !isSystemTag(t));
}

// One-shot helper: take the existing stored tags + the guest's
// numbers, return the final tag list (computed system tags +
// preserved manual tags). This is what every read path should call
// before returning a guest to the UI.
export function mergeTagsForRead(
  storedTags: string[] | null | undefined,
  g: GuestForTagging,
): string[] {
  const auto = computeGuestLifecycleTags(g);
  const manual = stripSystemTags(storedTags);
  return [...auto, ...manual];
}

// Mirror of mergeTagsForRead for the WRITE path. When admin saves
// a tag list via PATCH, we drop any system tags they tried to set
// (those are computed) and keep only their manual additions. The
// next read will recompute the system tags fresh.
export function sanitizeTagsForWrite(
  submittedTags: string[] | null | undefined,
): string[] {
  return stripSystemTags(submittedTags);
}
