import { env } from "../config/env.js";
import { logger } from "./logger.js";
import { enqueueMessage } from "./outbox.js";

export interface SmsMessage {
  to: string;
  text: string;
  templateId?: string;
  variables?: Record<string, string>;
}

export interface EmailAttachment {
  filename: string;
  content: Buffer;
  contentType?: string;
}

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  attachments?: EmailAttachment[];
}

export interface SendResult {
  ok: boolean;
  provider: string;
  id?: string;
  error?: string;
}

// Mask sequences that look like OTP codes (4-8 contiguous digits) so the
// stub log doesn't leak codes. Other meaningful content stays readable
// for development.
function redactOtpFromText(text: string): string {
  return text.replace(/\b\d{4,8}\b/g, "******");
}

// Mask the middle of a phone or email so log diagnostics still tie back to
// the right guest but the full identifier doesn't sit in plaintext.
function maskRecipient(to: string): string {
  if (to.includes("@")) {
    const [user, domain] = to.split("@");
    if (!user || !domain) return "***@***";
    return `${user.slice(0, 2)}***@${domain}`;
  }
  const digits = to.replace(/\D/g, "");
  if (digits.length < 4) return "***";
  return `***${digits.slice(-4)}`;
}

async function sendWhatsAppStub(msg: SmsMessage): Promise<SendResult> {
  // Stub mode is for local development. We log a masked recipient + a
  // redacted preview of the body so a developer can confirm a message
  // was triggered without seeing the OTP or the full guest contact.
  logger.info(
    {
      provider: "stub",
      to: maskRecipient(msg.to),
      preview: redactOtpFromText(msg.text).slice(0, 200),
    },
    "[WHATSAPP STUB]",
  );
  return { ok: true, provider: "stub", id: `stub-${Date.now()}` };
}

async function sendEmailStub(_msg: EmailMessage): Promise<SendResult> {
  // Email channel disabled — fallback used when no provider is set.
  return { ok: true, provider: "disabled", id: "skipped" };
}

// Send via Resend (https://resend.com). Feature-flagged on env:
// RESEND_API_KEY + RESEND_FROM must both be present. If either is
// missing we fall back to the stub silently so the calling code path
// (e.g. DPDP export with email-delivery) still completes.
async function sendEmailResend(msg: EmailMessage): Promise<SendResult> {
  if (!env.RESEND_API_KEY || !env.RESEND_FROM) {
    return sendEmailStub(msg);
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: env.RESEND_FROM,
        to: [msg.to],
        subject: msg.subject,
        text: msg.text,
        html: msg.html,
        // Resend takes base64 content for attachments (invoice/receipt PDFs).
        attachments: (msg.attachments ?? []).map((a) => ({
          filename: a.filename,
          content: a.content.toString("base64"),
          content_type: a.contentType,
        })),
      }),
    });
    const json = (await res.json().catch(() => ({}))) as {
      id?: string;
      message?: string;
      name?: string;
    };
    if (!res.ok) {
      return { ok: false, provider: "resend", error: json.message ?? `HTTP ${res.status}` };
    }
    return { ok: true, provider: "resend", id: json.id };
  } catch (err) {
    return {
      ok: false,
      provider: "resend",
      error: err instanceof Error ? err.message : "unknown",
    };
  }
}

function normalizeIndianNumber(raw: string): string {
  const digits = raw.replace(/[^\d]/g, "");
  if (raw.startsWith("+")) return raw;
  if (digits.startsWith("91") && digits.length === 12) return `+${digits}`;
  if (digits.length === 10) return `+91${digits}`;
  return `+${digits}`;
}

function withWhatsAppPrefix(e164: string): string {
  return e164.startsWith("whatsapp:") ? e164 : `whatsapp:${e164}`;
}

async function sendWhatsAppLive(msg: SmsMessage): Promise<SendResult> {
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) {
    logger.warn("Twilio not configured, falling back to stub");
    return sendWhatsAppStub(msg);
  }
  if (!env.TWILIO_WHATSAPP_FROM && !env.TWILIO_MESSAGING_SERVICE_SID) {
    logger.warn(
      "Twilio: set TWILIO_WHATSAPP_FROM (e.g. +14155238886) or TWILIO_MESSAGING_SERVICE_SID, falling back to stub",
    );
    return sendWhatsAppStub(msg);
  }
  try {
    const to = withWhatsAppPrefix(normalizeIndianNumber(msg.to));
    const params = new URLSearchParams();
    params.set("To", to);
    params.set("Body", msg.text);
    if (env.TWILIO_MESSAGING_SERVICE_SID) {
      params.set("MessagingServiceSid", env.TWILIO_MESSAGING_SERVICE_SID);
    } else if (env.TWILIO_WHATSAPP_FROM) {
      params.set("From", withWhatsAppPrefix(env.TWILIO_WHATSAPP_FROM));
    }

    const auth = Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString("base64");
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`,
      {
        method: "POST",
        headers: {
          authorization: `Basic ${auth}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: params.toString(),
      },
    );
    const json = (await res.json().catch(() => ({}))) as {
      sid?: string;
      status?: string;
      message?: string;
      code?: number;
      error_code?: number;
      error_message?: string;
    };
    logger.info(
      {
        to: maskRecipient(to.replace("whatsapp:", "")),
        httpStatus: res.status,
        twilioStatus: json.status,
        sid: json.sid,
        errorCode: json.error_code ?? json.code,
        errorMessage: json.error_message ?? json.message,
      },
      "[twilio whatsapp] response",
    );
    if (!res.ok) {
      return {
        ok: false,
        provider: "twilio_whatsapp",
        error: json.message ?? `HTTP ${res.status}${json.code ? ` (code ${json.code})` : ""}`,
      };
    }
    // Twilio may return 201 with status=failed/undelivered when sandbox recipient hasn't joined
    if (json.status === "failed" || json.status === "undelivered") {
      return {
        ok: false,
        provider: "twilio_whatsapp",
        error: json.error_message ?? `Twilio reports ${json.status}. If using sandbox, recipient must first send "join <keyword>" to ${env.TWILIO_WHATSAPP_FROM}.`,
      };
    }
    return { ok: true, provider: "twilio_whatsapp", id: json.sid };
  } catch (err) {
    return {
      ok: false,
      provider: "twilio_whatsapp",
      error: err instanceof Error ? err.message : "unknown",
    };
  }
}

// Direct provider sends, exported for the offline outbox deliverer: the desk
// drains its queue with the SAME Twilio/Resend clients the cloud API uses,
// authenticated by operator-provided credentials (see config/handshake.ts's
// messaging.env loader). Stub results are treated as "not configured" there.
export const directSenders = {
  whatsapp: sendWhatsAppLive,
  email: sendEmailResend,
  isWhatsAppConfigured: () =>
    !!(
      env.TWILIO_ACCOUNT_SID &&
      env.TWILIO_AUTH_TOKEN &&
      (env.TWILIO_WHATSAPP_FROM || env.TWILIO_MESSAGING_SERVICE_SID)
    ),
  isResendConfigured: () => !!(env.RESEND_API_KEY && env.RESEND_FROM),
};

export const messaging = {
  // Sends via Twilio WhatsApp Business API (or stub in dev mode).
  // Kept the name `sendSms` for backwards-compat with existing call sites.
  async sendSms(msg: SmsMessage): Promise<SendResult> {
    if (env.OFFLINE_MODE) {
      // No internet in the hot path: enqueue and return success. The drainer
      // delivers when the desk reconnects. (outbox imports messaging only as
      // a type, so a static import here is cycle-free and pkg-compatible.)
      await enqueueMessage("sms", msg.to, msg);
      return { ok: true, provider: "outbox", id: "queued" };
    }
    return env.NOTIFICATIONS_PROVIDER === "live" ? sendWhatsAppLive(msg) : sendWhatsAppStub(msg);
  },
  // Email channel — uses Resend when configured, stub otherwise. The
  // switch is purely env-driven: presence of RESEND_API_KEY + RESEND_FROM
  // turns the channel on; absence keeps it disabled.
  async sendEmail(msg: EmailMessage): Promise<SendResult> {
    if (env.OFFLINE_MODE) {
      await enqueueMessage("email", msg.to, msg);
      return { ok: true, provider: "outbox", id: "queued" };
    }
    if (env.RESEND_API_KEY && env.RESEND_FROM) return sendEmailResend(msg);
    return sendEmailStub(msg);
  },
  isEmailConfigured(): boolean {
    // Offline: email is "configured" in the sense that it queues and will send.
    return env.OFFLINE_MODE || !!(env.RESEND_API_KEY && env.RESEND_FROM);
  },
};
