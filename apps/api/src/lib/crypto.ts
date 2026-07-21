import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { env } from "../config/env.js";

const ALGO = "aes-256-gcm";
const KEY = Buffer.from(env.ENCRYPTION_KEY, "hex");
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

export function encrypt(plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGO, KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

export function decrypt(payload: string): string {
  const data = Buffer.from(payload, "base64");
  const iv = data.subarray(0, IV_LENGTH);
  const tag = data.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = data.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv(ALGO, KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

export function last4(value: string): string {
  return value.slice(-4);
}

// Blind index over a government ID number, for duplicate detection.
//
// encrypt() is randomised (fresh IV per call), so two rows holding the SAME id
// produce different ciphertext and cannot be compared. Dedup previously fell
// back to id_proof_last4 — only 10,000 possible values, so unrelated guests
// collided and the second one could not be registered at all (migration 0010).
//
// A keyed hash gives comparability without reversibility: equal ids hash
// equal, but the digest reveals nothing, and an attacker holding the database
// cannot brute-force the (short, low-entropy) ID space without ENCRYPTION_KEY.
// Domain-separated from any other HMAC use of the same key.
//
// Normalisation matters: "1234-5678-9012", "1234 5678 9012" and
// "123456789012" are one Aadhaar. Case-fold too — PAN and passport numbers
// contain letters.
export function idProofHash(idNumber: string): string {
  const normalised = idNumber.replace(/[\s-]/g, "").toUpperCase();
  return createHmac("sha256", KEY).update(`idproof:v1:${normalised}`).digest("hex");
}
