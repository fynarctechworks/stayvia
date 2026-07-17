// Normalise a phone for storage and lookup: drop spaces, dashes, and
// parens but keep the leading + so country codes are preserved.
// Matches the resolver's normalisation so a URL like
// /guests/(987)%20654-3210 hits the same DB row as /guests/9876543210.
//
// We deliberately do NOT do anything sophisticated like libphonenumber
// here — staff enter phones in whatever shape is convenient at the
// desk, and the goal is just "the same number in different
// formattings hits the same cache key."
export function normalisePhone(raw: string): string {
  return raw.replace(/[\s\-()]/g, "");
}
