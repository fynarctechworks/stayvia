import { Router } from "express";

import { localRead, verifyLocalFileSig } from "../lib/localStorage.js";
import { logger } from "../lib/logger.js";

// Serves locally-stored files (KYC, expense bills, invoice PDFs) in offline
// mode, replacing Supabase signed URLs. Access is gated by the HMAC signature
// minted in localStorage.localSignedUrl — so this route is intentionally NOT
// behind requireAuth (the signature IS the capability, exactly like a Supabase
// signed URL). Only mounted when OFFLINE_MODE is set (see index.ts).

const router = Router();

const CONTENT_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  pdf: "application/pdf",
};

router.get("/:bucket/:path", (req, res) => {
  const { bucket, path } = req.params as { bucket: string; path: string };
  const exp = Number(req.query.exp);
  const sig = String(req.query.sig ?? "");

  // Express already percent-decodes route params, so use `path` directly — a
  // second decodeURIComponent would double-decode (e.g. %252F -> %2F -> /).
  const decodedPath = path;

  if (!verifyLocalFileSig(bucket, decodedPath, exp, sig)) {
    return res.status(403).json({ success: false, error: { code: "FORBIDDEN", message: "Invalid or expired link" } });
  }

  let body: Buffer;
  try {
    body = localRead(bucket, decodedPath);
  } catch (err) {
    logger.debug({ err: err instanceof Error ? err.message : err, bucket, path: decodedPath }, "local file not found");
    return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "File not found" } });
  }

  const ext = decodedPath.slice(decodedPath.lastIndexOf(".") + 1).toLowerCase();
  res.setHeader("Content-Type", CONTENT_TYPES[ext] ?? "application/octet-stream");
  res.setHeader("Cache-Control", "private, max-age=0, no-store");
  // Override helmet's global Cross-Origin-Resource-Policy: same-origin. The
  // desktop webview lives at http://tauri.localhost while these files come
  // from http://127.0.0.1:<port> — a different origin — so with same-origin
  // Chromium silently blocks <img> embeds (fetch/XHR still worked via CORS,
  // which is why data loaded but every KYC photo showed broken). The HMAC
  // signature is the capability and the listener is loopback-only, so
  // cross-origin embedding is safe here.
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  return res.send(body);
});

export default router;
