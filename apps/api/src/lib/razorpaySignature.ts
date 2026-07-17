import { createHmac, timingSafeEqual } from "node:crypto";

// Razorpay webhook signature check: X-Razorpay-Signature is the hex
// HMAC-SHA256 of the RAW request body keyed with the webhook secret.
// Pure helper (no env access) so it unit-tests without an app context.
// timingSafeEqual keeps the comparison constant-time; the length check
// before it is required (timingSafeEqual throws on unequal lengths) and
// leaks nothing an attacker doesn't already know (the digest length).
export function verifyRazorpaySignature(
  rawBody: string | Buffer,
  signature: string,
  secret: string,
): boolean {
  if (!signature || !secret) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
