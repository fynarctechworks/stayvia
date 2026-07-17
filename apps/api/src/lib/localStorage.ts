import { createHmac } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

import { env } from "../config/env.js";

// Local-filesystem storage backend for offline desktop mode. Mirrors the
// subset of the Supabase Storage API that lib/storage.ts uses (put / signed
// URL / delete), but writes under %LOCALAPPDATA%\SLDT\storage\<bucket>\<path>.
//
// "Signed URLs": there's no CDN offline, so we serve files through the local
// sidecar at /api/v1/local-files/<bucket>/<path>?sig=<hmac>&exp=<ts>. The HMAC
// (keyed by LOCAL_JWT_SECRET) makes the link unguessable and expiring, matching
// the security property of a Supabase signed URL. The serve route
// (routes/localFiles.ts) verifies the signature.

function storageRoot(): string {
  // User-relocatable root, set by the Tauri shell from the Settings → Data
  // Storage location (config.json). Falls back to the classic default.
  if (process.env.SLDT_STORAGE_DIR) return resolve(process.env.SLDT_STORAGE_DIR);
  // %LOCALAPPDATA%\SLDT\storage on Windows; a dev-friendly fallback otherwise.
  const base =
    process.env.LOCALAPPDATA ??
    (process.env.HOME ? join(process.env.HOME, ".local", "share") : process.cwd());
  return resolve(base, "SLDT", "storage");
}

// Only these buckets exist; reject anything else so a signed URL can't be
// pointed at an arbitrary directory name.
const BUCKETS = new Set(["kyc-docs", "expense-bills", "documents"]);

function absPath(bucket: string, path: string): string {
  if (!BUCKETS.has(bucket)) {
    throw new Error(`unknown storage bucket: ${bucket}`);
  }
  // Resolve and confirm containment rather than string-stripping "..", which a
  // non-recursive strip (e.g. "....//") could defeat. The stored `path` is
  // server-generated (guestId/token.jpg), so this is defense in depth.
  const root = resolve(storageRoot(), bucket);
  const dest = resolve(root, path);
  if (dest !== root && !dest.startsWith(root + sep)) {
    throw new Error("path escapes bucket root");
  }
  return dest;
}

export function localPut(bucket: string, path: string, body: Buffer): void {
  const dest = absPath(bucket, path);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, body);
}

export function localRead(bucket: string, path: string): Buffer {
  return readFileSync(absPath(bucket, path));
}

export function localDelete(bucket: string, path: string): void {
  try {
    rmSync(absPath(bucket, path), { force: true });
  } catch {
    /* already gone */
  }
}

function sigSecret(): string {
  // The local session secret is the file-URL signing key. Env validation
  // guarantees it's present in offline mode — no default fallback, so a
  // misconfiguration fails loudly instead of signing with a known constant.
  if (!env.LOCAL_JWT_SECRET) {
    throw new Error("LOCAL_JWT_SECRET is required to sign local file URLs");
  }
  return env.LOCAL_JWT_SECRET;
}

/** Compute the HMAC signature for a local file URL. */
export function signLocalFile(bucket: string, path: string, expEpochMs: number): string {
  // JSON-encode the fields so a delimiter (':' in a path/bucket) can't create a
  // field-ambiguity collision. Verify uses the identical encoding.
  return createHmac("sha256", sigSecret())
    .update(JSON.stringify([bucket, path, expEpochMs]))
    .digest("hex");
}

/** Build a signed, expiring URL served by the local sidecar. */
export function localSignedUrl(
  bucket: string,
  path: string,
  expiresInSeconds: number,
): string {
  const exp = Date.now() + expiresInSeconds * 1000;
  const sig = signLocalFile(bucket, path, exp);
  const base = `http://127.0.0.1:${env.PORT}`;
  const enc = encodeURIComponent(path);
  return `${base}/api/v1/local-files/${bucket}/${enc}?exp=${exp}&sig=${sig}`;
}

/** Constant-time-ish verification for the serve route. */
export function verifyLocalFileSig(
  bucket: string,
  path: string,
  expEpochMs: number,
  sig: string,
): boolean {
  if (!Number.isFinite(expEpochMs) || expEpochMs < Date.now()) return false;
  const expected = signLocalFile(bucket, path, expEpochMs);
  return expected.length === sig.length && timingSafeEqualStr(expected, sig);
}

function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
