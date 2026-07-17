import { createHash, randomInt } from "node:crypto";
import { env } from "../config/env.js";

export function generateOtp(): string {
  const max = 10 ** env.OTP_LENGTH;
  return String(randomInt(0, max)).padStart(env.OTP_LENGTH, "0");
}

export function hashOtp(code: string): string {
  // Pepper the OTP hash with a server secret — stable per deployment, which
  // is all the hash needs.
  return createHash("sha256").update(`${code}:${env.SUPABASE_JWT_SECRET}`).digest("hex");
}

export function expiresAt(): Date {
  return new Date(Date.now() + env.OTP_TTL_SECONDS * 1000);
}

export function maskTarget(target: string, channel: "sms" | "email"): string {
  if (channel === "email") {
    const [u, d] = target.split("@");
    if (!u || !d) return target;
    return `${u.slice(0, 2)}${"*".repeat(Math.max(1, u.length - 2))}@${d}`;
  }
  const digits = target.replace(/\D/g, "");
  if (digits.length < 4) return target;
  return `${"*".repeat(digits.length - 4)}${digits.slice(-4)}`;
}
