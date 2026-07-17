import { useAuth } from "@/auth/AuthContext";
import { inr } from "@/lib/utils";

// Hook companion to <Money> for non-JSX call sites — modal messages,
// confirm strings, exported CSV column values, etc. Returns either the
// formatted rupee string or the same mask <Money> uses, so the two stay
// consistent.
export function useMaskedInr(): (value: number | string | null | undefined) => string {
  const { can } = useAuth();
  return (value) => (can("view_revenue") ? inr(value ?? 0) : "•••••");
}

// Render a rupee amount, masked when the current user lacks `view_revenue`.
// Use this everywhere a number is shown to staff (Dashboard, Collections,
// Reservation Detail, receipts on screen, etc.) so non-admin roles get
// dotted placeholders instead of actual figures.
//
// IMPORTANT: this is a display-only mask, not a security boundary. The
// server still strips numbers from money-heavy endpoints (/dashboard's
// revenue_today is dropped for non-admin). For workflows where staff
// MUST type a rupee amount themselves (recording a payment), use the
// raw input — masking the input would block the workflow entirely.
export function Money({
  value,
  className,
  mask = "•••••",
}: {
  value: number | string | null | undefined;
  className?: string;
  // Override the placeholder used when masked. Default is a row of dots.
  mask?: string;
}) {
  const { can } = useAuth();
  if (!can("view_revenue")) {
    return <span className={className} aria-label="amount hidden">{mask}</span>;
  }
  return <span className={className}>{inr(value ?? 0)}</span>;
}
