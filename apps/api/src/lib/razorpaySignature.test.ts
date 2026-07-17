import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyRazorpaySignature } from "./razorpaySignature.js";

const SECRET = "whsec_test_secret";

function sign(body: string | Buffer, secret = SECRET): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

describe("verifyRazorpaySignature", () => {
  it("accepts a valid signature over the raw body", () => {
    const body = JSON.stringify({ event: "subscription.activated", payload: {} });
    expect(verifyRazorpaySignature(body, sign(body), SECRET)).toBe(true);
    // Buffer input (what express.raw hands the route) verifies identically.
    expect(verifyRazorpaySignature(Buffer.from(body), sign(body), SECRET)).toBe(true);
  });

  it("rejects an invalid signature", () => {
    const body = JSON.stringify({ event: "subscription.charged" });
    expect(verifyRazorpaySignature(body, sign(body, "wrong-secret"), SECRET)).toBe(false);
    // Same length as a real digest but wrong content.
    expect(verifyRazorpaySignature(body, "0".repeat(64), SECRET)).toBe(false);
    // Malformed / truncated signature (length mismatch path).
    expect(verifyRazorpaySignature(body, "deadbeef", SECRET)).toBe(false);
  });

  it("rejects a tampered body", () => {
    const body = JSON.stringify({ event: "subscription.charged", amount: 100 });
    const sig = sign(body);
    const tampered = JSON.stringify({ event: "subscription.charged", amount: 999999 });
    expect(verifyRazorpaySignature(tampered, sig, SECRET)).toBe(false);
  });

  it("rejects empty signature or secret", () => {
    const body = "{}";
    expect(verifyRazorpaySignature(body, "", SECRET)).toBe(false);
    expect(verifyRazorpaySignature(body, sign(body), "")).toBe(false);
  });
});
