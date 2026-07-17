// Property-local calendar helpers. The hotel runs on IST regardless of
// where the server is hosted, so "today" must be derived from the
// property timezone, never the server clock's local date.
// (dashboard.ts has richer variants of these for its forecast windows.)

export const PROPERTY_TIMEZONE = "Asia/Kolkata";

// Format an instant as a yyyy-MM-dd string in the property timezone,
// WITHOUT depending on ICU locale data.
//
// The packaged desktop sidecar runs on a small-icu Node build (pkg's base
// binary), which only carries the en-US locale. There, the intuitive
// `toLocaleDateString("en-CA", …)` silently falls back to en-US and returns
// "M/D/YYYY" instead of "yyyy-MM-dd" — feeding `new Date("7/9/2026T…")` an
// unparseable string (Invalid Date) that crashed every date-scoped query.
// formatToParts still yields correct numeric fields under small-icu (only the
// pattern/ordering is locale-dependent, and we build the pattern ourselves).
export function propertyDateString(instant: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: PROPERTY_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const f: Record<string, string> = {};
  for (const p of parts) f[p.type] = p.value;
  return `${f.year}-${f.month}-${f.day}`;
}

export function propertyToday(): string {
  return propertyDateString(new Date());
}

// Inclusive timestamp bounds for a property-local calendar date.
// "2026-06-11" → 11 Jun 00:00 IST / 11 Jun 23:59:59.999 IST. Date
// filters that naively did `new Date("yyyy-MM-dd")` got midnight UTC
// for BOTH ends, so a single-day window ("Today") matched nothing.
export function propertyDayStart(dateStr: string): Date {
  return new Date(`${dateStr}T00:00:00+05:30`);
}
export function propertyDayEnd(dateStr: string): Date {
  return new Date(`${dateStr}T23:59:59.999+05:30`);
}
