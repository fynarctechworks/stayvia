import { env } from "../config/env.js";
import { localRead } from "./localStorage.js";
import { logger } from "./logger.js";
import { directSenders, type EmailMessage, type SmsMessage } from "./messaging.js";
import type { OutboxDeliverer } from "./outbox.js";
import { getSupabaseAdmin, supabaseEnabled } from "./supabase.js";

// Direct outbox delivery for the offline desk.
//
// The original Phase-2 design routed queued messages through a VPS send-proxy
// so provider credentials never lived on the desk. That proxy was never
// built, which left the queue draining into a stub that always failed. This
// deliverer replaces it: the desk sends DIRECTLY via the same Twilio/Resend
// clients the cloud API uses, using operator-provided credentials from
// %LOCALAPPDATA%\SLDT\messaging.env (see config/handshake.ts). No creds or no
// internet → transient result, the queue waits without burning attempts.

// Serialized attachment shape written by outbox.enqueueMessage.
interface StoredAttachment {
  filename: string;
  contentType?: string;
  contentBase64: string;
}

const NETWORK_ERROR = /fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|UND_ERR|network|socket/i;

// Loopback signed URLs minted by localSignedUrl() — only these get mirrored.
const LOOPBACK_FILE_URL = /http:\/\/127\.0\.0\.1:\d+\/api\/v1\/local-files\/([a-z0-9-]+)\/([^\s"'?]+)(\?[^\s"']*)?/g;

const MIRROR_CONTENT_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

// Mirror one locally-stored file to the public cloud bucket so a guest-facing
// link in a queued message resolves outside the desk PC. Only the public
// "documents" bucket (invoice/receipt PDFs) is mirrored — KYC and expense
// files are private and never belong in guest messages.
async function mirrorLocalFile(bucket: string, encodedPath: string): Promise<string | null> {
  if (bucket !== "documents" || !supabaseEnabled) return null;
  const path = decodeURIComponent(encodedPath);
  let body: Buffer;
  try {
    body = localRead(bucket, path);
  } catch {
    return null; // file gone — leave the original link
  }
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  const { error } = await getSupabaseAdmin()
    .storage.from(bucket)
    .upload(path, body, {
      contentType: MIRROR_CONTENT_TYPES[ext] ?? "application/octet-stream",
      upsert: true,
    });
  if (error) {
    logger.warn({ bucket, path, error: error.message }, "outbox: cloud mirror failed");
    return null;
  }
  const { data } = getSupabaseAdmin().storage.from(bucket).getPublicUrl(path);
  return data.publicUrl ?? null;
}

// Replace every loopback file link in the message body with its mirrored
// public URL. Best-effort: unmirrorable links are left untouched (the message
// still sends — a broken link beats an undelivered confirmation).
async function rewriteLoopbackLinks(text: string): Promise<string> {
  const matches = [...text.matchAll(LOOPBACK_FILE_URL)];
  let out = text;
  for (const m of matches) {
    const publicUrl = await mirrorLocalFile(m[1]!, m[2]!).catch(() => null);
    if (publicUrl) out = out.replace(m[0], publicUrl);
  }
  return out;
}

function classify(error: string | undefined): { transient: boolean } {
  return { transient: !!error && NETWORK_ERROR.test(error) };
}

export function createDirectDeliverer(): OutboxDeliverer {
  return async (channel, _recipient, payload) => {
    if (channel === "sms") {
      if (!directSenders.isWhatsAppConfigured()) {
        return {
          ok: false,
          transient: true,
          error: "Twilio not configured — add credentials to %LOCALAPPDATA%\\SLDT\\messaging.env",
        };
      }
      const msg = { ...(payload as SmsMessage) };
      msg.text = await rewriteLoopbackLinks(msg.text);
      const result = await directSenders.whatsapp(msg);
      if (result.ok) return { ok: true };
      return { ok: false, error: result.error, ...classify(result.error) };
    }

    if (!directSenders.isResendConfigured()) {
      return {
        ok: false,
        transient: true,
        error: "Resend not configured — add credentials to %LOCALAPPDATA%\\SLDT\\messaging.env",
      };
    }
    const stored = payload as Omit<EmailMessage, "attachments"> & {
      attachments?: StoredAttachment[];
    };
    const msg: EmailMessage = {
      ...stored,
      text: await rewriteLoopbackLinks(stored.text),
      html: stored.html ? await rewriteLoopbackLinks(stored.html) : undefined,
      attachments: (stored.attachments ?? []).map((a) => ({
        filename: a.filename,
        contentType: a.contentType,
        content: Buffer.from(a.contentBase64, "base64"),
      })),
    };
    const result = await directSenders.email(msg);
    if (result.ok) return { ok: true };
    return { ok: false, error: result.error, ...classify(result.error) };
  };
}

// True when the desk can actually deliver at least one channel — surfaced in
// the system-status endpoint so the UI banner can say "messages will send"
// vs "add messaging credentials".
export function deliveryConfigured(): { whatsapp: boolean; email: boolean } {
  return {
    whatsapp: directSenders.isWhatsAppConfigured(),
    email: directSenders.isResendConfigured(),
  };
}
