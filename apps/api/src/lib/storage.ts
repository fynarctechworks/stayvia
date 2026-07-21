import { createHmac, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { asc } from "drizzle-orm";
import { env } from "../config/env.js";
import { db } from "../db/client.js";
import { properties } from "../db/schema/properties.js";
import { logger } from "./logger.js";
import { supabaseAdmin } from "./supabase.js";

const BUCKET = "kyc-docs";

// Every object path is namespaced `${propertyId}/…` so two hotels can never
// collide (same guest at two hotels, or matching per-hotel invoice numbers).
// Signed-url/delete helpers verify the stored path belongs to the caller's
// property before acting. Legacy pre-tenancy paths have no UUID prefix — they
// resolve only for the first hotel ever provisioned (the only property that
// existed before namespacing), never for other tenants.
const UUID_SEGMENT_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let legacyPropertyId: string | null | undefined;
async function getLegacyPropertyId(): Promise<string | null> {
  if (legacyPropertyId !== undefined) return legacyPropertyId;
  const [oldest] = await db
    .select({ id: properties.id })
    .from(properties)
    .orderBy(asc(properties.createdAt))
    .limit(1);
  legacyPropertyId = oldest?.id ?? null;
  return legacyPropertyId;
}

async function pathBelongsToProperty(propertyId: string, path: string): Promise<boolean> {
  const first = path.split("/")[0] ?? "";
  if (UUID_SEGMENT_RE.test(first)) return first === propertyId;
  // Legacy path from before property namespacing — owned by the oldest hotel.
  return propertyId === (await getLegacyPropertyId());
}

// Lazy sharp loader. Cached after the first attempt. Returns null if the native
// module can't load (so callers degrade gracefully in a stripped offline
// bundle). Top-level importing sharp would crash the pkg-bundled exe at boot.
//
// createRequire, NOT dynamic import(): the pkg snapshot cannot execute runtime
// ESM import() at all (ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING), but its patched
// CJS require works. Two resolution bases: this module (dev / plain node), then
// the exe directory (packaged app, where build-sidecar ships node_modules/sharp
// next to api.exe).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sharpModule: any | null | undefined;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadSharp(): Promise<any | null> {
  if (sharpModule !== undefined) return sharpModule;
  const bases = [import.meta.url, join(dirname(process.execPath), "package.json")];
  for (const base of bases) {
    try {
      const mod = createRequire(base)("sharp");
      sharpModule = mod?.default ?? mod;
      return sharpModule;
    } catch (err) {
      logger.debug(
        { base, err: err instanceof Error ? err.message : err },
        "sharp not resolvable from base",
      );
    }
  }
  logger.warn("sharp failed to load — images stored without processing");
  sharpModule = null;
  return sharpModule;
}

export type KycSide = "front" | "back" | "photo";

// Strict whitelist. SVG is blocked explicitly because it can carry JS; PDFs
// are blocked because guests upload via the same flow and a PDF here is
// almost always a misuse (and harder to scan than an image).
const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_BYTES = 8 * 1024 * 1024;

// Image dimension caps. Anything bigger is downscaled before storing —
// nothing legitimate needs a 12-megapixel ID photo and oversized images
// chew through Supabase storage + Puppeteer memory.
const MAX_DIMENSION = 2400;
const OUTPUT_QUALITY = 85;

// Quick magic-byte sniff so a renamed `.jpg.exe` or an HTML file pretending
// to be image/jpeg via header tampering is rejected before reaching Sharp.
function sniffImageType(buf: Buffer): "jpeg" | "png" | "webp" | null {
  if (buf.length < 12) return null;
  // JPEG: starts FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  )
    return "png";
  // WEBP: "RIFF" .... "WEBP"
  if (
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  )
    return "webp";
  return null;
}

export function validateKycFile(file: { mimetype: string; size: number }): string | null {
  if (!ALLOWED_MIME.has(file.mimetype)) return "File must be JPEG, PNG, or WEBP";
  if (file.size > MAX_BYTES) return "File must be under 8 MB";
  return null;
}

// Re-encodes the uploaded image with Sharp:
//   * confirms the actual file matches what the multipart claimed (defends
//     against header lies / polyglot files)
//   * strips ALL metadata (EXIF GPS, camera serial, comments, color profiles)
//   * caps dimensions so we don't store a 50 MP camera shot
//   * writes JPEG at quality 85 — small, fast to ship over WhatsApp
// Returns the sanitized JPEG bytes plus the new mimetype.
async function sanitizeImage(
  buffer: Buffer,
  mimetype: string,
): Promise<{ buffer: Buffer; mimetype: string }> {
  const sniffed = sniffImageType(buffer);
  if (!sniffed) {
    throw new Error("File does not look like a valid image");
  }
  // Cross-check header vs magic bytes. Mild discrepancy (jpg/jpeg) is fine.
  const headerType = mimetype.replace("image/", "").toLowerCase();
  if (headerType !== sniffed && !(headerType === "jpg" && sniffed === "jpeg")) {
    throw new Error(
      `File header says ${headerType} but content is ${sniffed}; refusing upload`,
    );
  }

  // Lazy-load sharp so the pkg-bundled offline sidecar boots even if sharp's
  // native module isn't present. If it can't load (missing native binary in a
  // stripped offline bundle), fall back to storing the already-sniffed +
  // size-capped image as-is: no resize / EXIF-strip, but still a validated
  // image. The full sanitizer is used everywhere sharp IS available (online,
  // and offline once @img is bundled).
  const sharp = await loadSharp();
  if (!sharp) {
    logger.warn("sharp unavailable — storing KYC image without resize/EXIF-strip");
    return { buffer, mimetype: sniffed === "jpeg" ? "image/jpeg" : `image/${sniffed}` };
  }

  const out = await sharp(buffer, { failOn: "warning" })
    .rotate() // honor EXIF orientation before stripping
    .resize({
      width: MAX_DIMENSION,
      height: MAX_DIMENSION,
      fit: "inside",
      withoutEnlargement: true,
    })
    .toFormat("jpeg", { quality: OUTPUT_QUALITY, mozjpeg: true })
    // withMetadata is NOT called → metadata is stripped by default. Spelling
    // this out so a future reader doesn't "fix" it.
    .toBuffer();
  return { buffer: out, mimetype: "image/jpeg" };
}

// Human-readable storage folder: "Ajay-Kumar-7e5e9967". The name half lets an
// operator browsing the storage drive see whose files these are; the id half
// keeps the folder unique (two guests can share a name) and ties it back to
// the DB row even if the guest is later renamed. Windows-illegal characters
// are stripped; empty names fall back to the bare label.
export function storageFolderLabel(
  name: string | null | undefined,
  // Human-meaningful unique part: the guest's phone digits when available
  // (what the desk actually knows customers by), else a short row-id prefix.
  uniquePart: string,
  fallback = "guest",
): string {
  const safe = (name ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 40)
    .replace(/[.\-\s]+$/g, "");
  return `${safe || fallback}-${uniquePart}`;
}

// Same lazy self-provisioning as the expense/docs buckets — a fresh
// Supabase project (local CLI stack or new cloud project) starts with no
// buckets at all, and the first KYC upload used to die with "Bucket not
// found".
let kycBucketEnsured = false;
async function ensureKycBucket() {
  if (kycBucketEnsured) return;
  const { data: buckets, error: listErr } = await supabaseAdmin.storage.listBuckets();
  if (listErr) {
    logger.warn({ err: listErr.message }, "storage listBuckets failed");
    return;
  }
  if (!buckets?.some((b) => b.name === BUCKET)) {
    const { error: createErr } = await supabaseAdmin.storage.createBucket(BUCKET, {
      public: false,
    });
    if (createErr) {
      logger.warn({ err: createErr.message }, "kyc bucket create failed");
      return;
    }
    logger.info("created kyc-docs bucket");
  }
  kycBucketEnsured = true;
}

export async function uploadKycPhoto(
  // Tenant that owns the file — becomes the first path segment.
  propertyId: string,
  // Storage folder for this guest — pass storageFolderLabel(fullName, guestId)
  // so the files on disk carry the customer's name.
  guestFolder: string,
  side: KycSide,
  file: { buffer: Buffer; mimetype: string },
): Promise<string> {
  await ensureKycBucket();
  // Sanitize first — caller already validated MIME + size, but this is the
  // last line of defense.
  let safe: { buffer: Buffer; mimetype: string };
  try {
    safe = await sanitizeImage(file.buffer, file.mimetype);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : err, guestFolder, side },
      "KYC image sanitization rejected upload",
    );
    throw new Error(
      err instanceof Error ? err.message : "Could not process the uploaded image",
    );
  }

  // Random filename. Previously `side-${Date.now()}.ext` was guessable from
  // the guest ID + upload time. We now use a 16-byte hex token so even a
  // signed-URL leak doesn't help an attacker enumerate other KYC files.
  const token = randomBytes(16).toString("hex");
  const path = `${propertyId}/${guestFolder}/${side}-${token}.jpg`;
  const { error } = await supabaseAdmin.storage
    .from(BUCKET)
    .upload(path, safe.buffer, {
      contentType: safe.mimetype,
      upsert: true,
      // Force a sane Cache-Control even for "private" buckets — signed URLs
      // are short-lived but downstream CDNs shouldn't keep these forever.
      cacheControl: "private, max-age=0, no-store",
    });
  if (error) throw new Error(`KYC upload failed: ${error.message}`);
  return path;
}

export async function signedKycUrl(
  propertyId: string,
  path: string,
  expiresInSeconds = 300,
): Promise<string | null> {
  if (!path) return null;
  if (!(await pathBelongsToProperty(propertyId, path))) return null;
  const { data, error } = await supabaseAdmin.storage
    .from(BUCKET)
    .createSignedUrl(path, expiresInSeconds);
  if (error) return null;
  return data.signedUrl;
}

export async function deleteKycFile(propertyId: string, path: string): Promise<void> {
  if (!path) return;
  if (!(await pathBelongsToProperty(propertyId, path))) return;
  await supabaseAdmin.storage.from(BUCKET).remove([path]);
}

// ============ EXPENSE ATTACHMENTS (vendor bills / receipts) ============
// Private bucket — only senior staff (manage_expenses) should ever
// see a property bill. Same access pattern as KYC: signed URLs.
//
// Bills may legitimately be PDFs (utility invoices) AND images
// (phone photos of paper bills), so the whitelist is broader than
// KYC. Sharp is NOT used here — we don't want to lossy-recompress a
// scanned PDF tax invoice. Inputs are still magic-byte sniffed and
// size-capped at the multer layer before they ever reach us.

const EXPENSE_BUCKET = "expense-bills";
const EXPENSE_ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
]);
const EXPENSE_MAX_BYTES = 10 * 1024 * 1024; // 10 MB — PDFs run bigger than KYC

export function validateExpenseAttachment(file: {
  mimetype: string;
  size: number;
}): string | null {
  if (!EXPENSE_ALLOWED_MIME.has(file.mimetype))
    return "File must be JPEG, PNG, WEBP, or PDF";
  if (file.size > EXPENSE_MAX_BYTES) return "File must be under 10 MB";
  return null;
}

let expenseBucketEnsured = false;
async function ensureExpenseBucket() {
  if (expenseBucketEnsured) return;
  const { data: buckets, error: listErr } =
    await supabaseAdmin.storage.listBuckets();
  if (listErr) {
    logger.warn({ err: listErr.message }, "storage listBuckets failed");
    return;
  }
  if (!buckets?.some((b) => b.name === EXPENSE_BUCKET)) {
    const { error: createErr } = await supabaseAdmin.storage.createBucket(
      EXPENSE_BUCKET,
      { public: false },
    );
    if (createErr) {
      logger.warn({ err: createErr.message }, "expense bucket create failed");
      return;
    }
    logger.info("created expense-bills bucket");
  }
  expenseBucketEnsured = true;
}

export async function uploadExpenseAttachment(
  // Tenant that owns the file — becomes the first path segment.
  propertyId: string,
  // Storage folder for this expense — pass storageFolderLabel(description,
  // expenseId, "expense") so bills on disk carry what they were for.
  expenseFolder: string,
  file: { buffer: Buffer; mimetype: string; originalName?: string },
): Promise<string> {
  await ensureExpenseBucket();
  // Random suffix so even a leaked storage listing doesn't enumerate
  // bills by predictable filename. Extension comes from the mimetype
  // (not the original name) so a renamed `bill.pdf.exe` can't sneak
  // through.
  const ext =
    file.mimetype === "application/pdf"
      ? "pdf"
      : file.mimetype === "image/png"
        ? "png"
        : file.mimetype === "image/webp"
          ? "webp"
          : "jpg";
  const token = randomBytes(16).toString("hex");
  const path = `${propertyId}/${expenseFolder}/bill-${token}.${ext}`;
  const { error } = await supabaseAdmin.storage
    .from(EXPENSE_BUCKET)
    .upload(path, file.buffer, {
      contentType: file.mimetype,
      upsert: true,
      cacheControl: "private, max-age=0, no-store",
    });
  if (error)
    throw new Error(`Expense attachment upload failed: ${error.message}`);
  return path;
}

export async function signedExpenseAttachmentUrl(
  propertyId: string,
  path: string,
  expiresInSeconds = 300,
): Promise<string | null> {
  if (!path) return null;
  if (!(await pathBelongsToProperty(propertyId, path))) return null;
  const { data, error } = await supabaseAdmin.storage
    .from(EXPENSE_BUCKET)
    .createSignedUrl(path, expiresInSeconds);
  if (error) return null;
  return data.signedUrl;
}

export async function deleteExpenseAttachment(propertyId: string, path: string): Promise<void> {
  if (!path) return;
  if (!(await pathBelongsToProperty(propertyId, path))) return;
  await supabaseAdmin.storage.from(EXPENSE_BUCKET).remove([path]);
}

// ============ DOCUMENT LINKS (invoices, receipts, slips) ============
// Public bucket so the link works in WhatsApp without auth.
const DOCS_BUCKET = "documents";
let docsBucketEnsured = false;

async function ensureDocsBucket() {
  if (docsBucketEnsured) return;
  const { data: buckets, error: listErr } = await supabaseAdmin.storage.listBuckets();
  if (listErr) {
    logger.warn({ err: listErr.message }, "storage listBuckets failed");
    return;
  }
  if (!buckets?.some((b) => b.name === DOCS_BUCKET)) {
    const { error: createErr } = await supabaseAdmin.storage.createBucket(DOCS_BUCKET, {
      public: true,
    });
    if (createErr) {
      logger.warn({ err: createErr.message }, "storage createBucket failed");
      return;
    }
    logger.info("created documents bucket");
  }
  docsBucketEnsured = true;
}

// Bucket is public so the link works in WhatsApp without auth, but invoice/receipt
// numbers are sequential and would be guessable. Suffix every uploaded path with
// a random token so paths are unguessable in practice.
function withSuffix(pathInBucket: string, suffix: string): string {
  const dot = pathInBucket.lastIndexOf(".");
  if (dot < 0) return `${pathInBucket}-${suffix}`;
  return `${pathInBucket.slice(0, dot)}-${suffix}${pathInBucket.slice(dot)}`;
}

// Filename tag for guest documents: "Ajay-9347868290". Operators browse the
// storage drive by customer, so the file itself must say WHO it belongs to —
// a random token told them nothing. Stable names also mean a regenerated
// receipt overwrites its predecessor instead of piling up copies.
export function documentLabel(
  name: string | null | undefined,
  phone: string | null | undefined,
): string {
  const safeName = (name ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 40)
    .replace(/[.\-\s]+$/g, "");
  const digits = (phone ?? "").replace(/\D/g, "");
  return [safeName, digits].filter(Boolean).join("-");
}

export async function uploadPublicPdf(
  propertyId: string,
  pathInBucket: string,
  pdf: Buffer,
  // Customer tag ("Ajay-9347868290") appended to the filename. When absent,
  // a random token keeps the (publicly-served) path unguessable.
  label?: string,
): Promise<string | null> {
  return uploadPublicFile(propertyId, pathInBucket, pdf, "application/pdf", label);
}

// Generic public-bucket uploader. Used for invoice/receipt PDFs as well
// as room gallery images (Phase 1 amenities work). Same bucket, same
// public-URL pattern — the caller decides the content type. The property
// prefix is prepended in-function so every caller inherits the namespacing.
// Unguessable-but-stable path token.
//
// The bucket is PUBLIC, so the object path is the only thing standing between
// a guest document and anyone on the internet. The customer label alone was
// not enough: paths looked like
//   <propertyId>/invoices/INV-0044-Ajay-9347868290.pdf
// and every component is knowable to someone who has received one invoice —
// the property UUID from their own link, the invoice number by decrementing
// (they are sequential per hotel), and another guest's name + phone by simply
// knowing that person. That yields their full tax invoice: address, GSTIN,
// stay dates, payment history and every co-guest's ID details.
//
// A purely random token would fix that but break the stable-path property the
// label was introduced for — regenerating a receipt would orphan the old
// object instead of overwriting it, and nothing persists the previous path.
// So the token is an HMAC over the logical path instead: deterministic (same
// document → same path → clean overwrite, operators keep the readable name)
// but unguessable without ENCRYPTION_KEY, which never leaves the server.
function pathToken(propertyId: string, pathInBucket: string): string {
  return createHmac("sha256", env.ENCRYPTION_KEY)
    .update(`docpath:v1:${propertyId}/${pathInBucket}`)
    .digest("hex")
    .slice(0, 24);
}

export async function uploadPublicFile(
  propertyId: string,
  pathInBucket: string,
  body: Buffer,
  contentType: string,
  label?: string,
): Promise<string | null> {
  try {
    // Named documents keep the customer tag so operators can still browse the
    // bucket by guest — but the keyed token is ALWAYS appended, so the label
    // is a convenience, never the thing protecting the file.
    const token = pathToken(propertyId, pathInBucket);
    const suffix = label && label.length > 0 ? `${label}-${token}` : token;
    const obfuscatedPath = `${propertyId}/${withSuffix(pathInBucket, suffix)}`;
    await ensureDocsBucket();
    const { error } = await supabaseAdmin.storage
      .from(DOCS_BUCKET)
      .upload(obfuscatedPath, body, { contentType, upsert: true });
    if (error) {
      // Log the LOGICAL path only. The resolved path contains the token, and
      // an application log is a much weaker secret store than the bucket.
      logger.warn({ err: error.message, path: pathInBucket }, "public upload failed");
      return null;
    }
    const { data } = supabaseAdmin.storage.from(DOCS_BUCKET).getPublicUrl(obfuscatedPath);
    // Deliberately NOT logging data.publicUrl: it embeds the token, so logging
    // it turned the log into a ready-made index of every guest document.
    logger.info({ path: pathInBucket }, "public file uploaded");
    return data.publicUrl;
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, "uploadPublicFile threw");
    return null;
  }
}
