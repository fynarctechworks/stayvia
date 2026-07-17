import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { messageTemplates, type TemplateKey } from "../db/schema/messageTemplates.js";
import { logger } from "./logger.js";

export interface TemplateDefault {
  subject?: string;
  body: string;
}

export const TEMPLATE_DEFAULTS: Record<TemplateKey, TemplateDefault> = {
  checkin_guest_sms: {
    body:
      "{hotel}: Welcome! Check-in confirmed for {reservation_number}. Enjoy your stay.",
  },
  checkin_owner_sms: {
    body: "Checked in: {guest_name} ({guest_phone}), {reservation_number}",
  },
  checkout_guest_sms: {
    body:
      "{hotel}: Thank you for staying with us. Invoice {invoice_number} has been generated.",
  },
  checkout_owner_sms: {
    body: "Checked out: {guest_name}, {reservation_number}. Invoice {invoice_number}.",
  },
  otp_guest_sms: {
    body:
      "{hotel}: Your check-in OTP is {otp_code}. Valid for {otp_minutes} minutes. Do not share.",
  },
  payment_reminder_guest_sms: {
    body:
      "🙏 Hello {guest_name},\n\nThis is a friendly reminder from {hotel} about a pending balance from your stay.\n\nAmount due: ₹{balance}\n\nWe'd appreciate it if you could settle this at your convenience. For any clarification, please reach us on {hotel_phone}.\n\nThank you,\n— {hotel}, Sabbavaram",
  },
  booking_advance_guest_sms: {
    body:
      "🙏 Hello {guest_name},\n\nThank you for your booking with {hotel}.\n\nReservation: {reservation_number}\nCheck-in: {check_in_date}\nCheck-out: {check_out_date}\n\nAdvance received: ₹{advance_paid}\nBalance at check-in: ₹{balance}{receipt_block}\n\nWe look forward to hosting you.\n— {hotel}, Sabbavaram",
  },
  booking_advance_owner_sms: {
    body:
      "New booking: {guest_name} ({guest_phone}), {reservation_number}. {check_in_date} → {check_out_date}. Advance ₹{advance_paid}. Total ₹{total}.",
  },
  review_prompt_guest_sms: {
    body:
      "🙏 Hi {guest_name}, thank you for staying with {hotel}!\n\nWe'd love to hear about your experience. If you have 30 seconds, would you mind leaving us a review?\n\n{review_link}\n\nThank you,\n— {hotel}",
  },
};

export const TEMPLATE_VARS: Record<TemplateKey, readonly string[]> = {
  checkin_guest_sms: ["hotel", "guest_name", "guest_phone", "reservation_number", "check_in_date", "check_out_date", "room_numbers", "total", "advance_paid", "balance", "receipt_link", "hotel_phone", "wifi_ssid", "wifi_password"],
  checkin_owner_sms: ["hotel", "guest_name", "guest_phone", "reservation_number", "check_in_date", "room_numbers", "total", "advance_paid", "balance"],
  checkout_guest_sms: ["hotel", "guest_name", "reservation_number", "invoice_number", "invoice_link", "total", "hotel_phone"],
  checkout_owner_sms: ["hotel", "guest_name", "reservation_number", "invoice_number", "check_out_date", "total"],
  otp_guest_sms: ["hotel", "otp_code", "otp_minutes"],
  payment_reminder_guest_sms: ["hotel", "hotel_phone", "guest_name", "guest_phone", "balance"],
  booking_advance_guest_sms: ["hotel", "hotel_phone", "guest_name", "guest_phone", "reservation_number", "check_in_date", "check_out_date", "advance_paid", "balance", "total", "receipt_link", "receipt_block"],
  booking_advance_owner_sms: ["hotel", "guest_name", "guest_phone", "reservation_number", "check_in_date", "check_out_date", "advance_paid", "total"],
  review_prompt_guest_sms: ["hotel", "guest_name", "reservation_number", "review_link"],
};

export const TEMPLATE_LABELS: Record<TemplateKey, { group: string; label: string; channel: "sms" | "email"; recipient: "guest" | "owner" }> = {
  checkin_guest_sms: { group: "Check-in", label: "WhatsApp to guest", channel: "sms", recipient: "guest" },
  checkin_owner_sms: { group: "Check-in", label: "WhatsApp to owner", channel: "sms", recipient: "owner" },
  checkout_guest_sms: { group: "Check-out", label: "WhatsApp to guest", channel: "sms", recipient: "guest" },
  checkout_owner_sms: { group: "Check-out", label: "WhatsApp to owner", channel: "sms", recipient: "owner" },
  otp_guest_sms: { group: "OTP verification", label: "WhatsApp to guest", channel: "sms", recipient: "guest" },
  payment_reminder_guest_sms: { group: "Payment reminder", label: "WhatsApp to guest", channel: "sms", recipient: "guest" },
  booking_advance_guest_sms: { group: "Pre-booking advance", label: "WhatsApp to guest", channel: "sms", recipient: "guest" },
  booking_advance_owner_sms: { group: "Pre-booking advance", label: "WhatsApp to owner", channel: "sms", recipient: "owner" },
  review_prompt_guest_sms: { group: "Review prompt", label: "WhatsApp to guest (post-stay)", channel: "sms", recipient: "guest" },
};

const cache = new Map<TemplateKey, { subject?: string | null; body: string; enabled: boolean }>();
let cacheLoadedAt = 0;
const TTL = 60_000;

async function loadCache() {
  if (cache.size > 0 && Date.now() - cacheLoadedAt < TTL) return;
  cache.clear();
  const rows = await db.select().from(messageTemplates);
  for (const row of rows) {
    cache.set(row.key as TemplateKey, {
      subject: row.subject,
      body: row.body,
      enabled: row.enabled,
    });
  }
  cacheLoadedAt = Date.now();
}

export function invalidateTemplateCache() {
  cache.clear();
  cacheLoadedAt = 0;
}

function fillVars(text: string, vars: Record<string, string | number | null | undefined>): string {
  return text.replace(/\{(\w+)\}/g, (_, key: string) => {
    const v = vars[key];
    if (v === null || v === undefined) return "";
    return String(v);
  });
}

export interface RenderResult {
  enabled: boolean;
  subject?: string;
  body: string;
}

export async function renderTemplate(
  key: TemplateKey,
  vars: Record<string, string | number | null | undefined>,
): Promise<RenderResult> {
  try {
    await loadCache();
  } catch (err) {
    logger.warn({ err }, "template cache load failed; using defaults");
  }
  const row = cache.get(key);
  const def = TEMPLATE_DEFAULTS[key];
  const subjectTpl = row?.subject ?? def.subject;
  const bodyTpl = row?.body ?? def.body;
  const enabled = row?.enabled ?? true;
  return {
    enabled,
    subject: subjectTpl ? fillVars(subjectTpl, vars) : undefined,
    body: fillVars(bodyTpl, vars),
  };
}

export async function getAllTemplatesForUI(): Promise<
  {
    key: TemplateKey;
    group: string;
    label: string;
    channel: "sms" | "email";
    recipient: "guest" | "owner";
    subject: string | null;
    body: string;
    enabled: boolean;
    defaults: TemplateDefault;
    availableVars: readonly string[];
  }[]
> {
  await loadCache();
  return (Object.keys(TEMPLATE_DEFAULTS) as TemplateKey[]).map((key) => {
    const row = cache.get(key);
    const def = TEMPLATE_DEFAULTS[key];
    const meta = TEMPLATE_LABELS[key];
    return {
      key,
      ...meta,
      subject: row?.subject ?? def.subject ?? null,
      body: row?.body ?? def.body,
      enabled: row?.enabled ?? true,
      defaults: def,
      availableVars: TEMPLATE_VARS[key],
    };
  });
}

export async function upsertTemplate(
  key: TemplateKey,
  patch: { subject?: string | null; body?: string; enabled?: boolean },
): Promise<void> {
  // Try update first
  const existing = await db.select().from(messageTemplates).where(eq(messageTemplates.key, key)).limit(1);
  if (existing.length > 0) {
    await db
      .update(messageTemplates)
      .set({
        ...(patch.subject !== undefined ? { subject: patch.subject } : {}),
        ...(patch.body !== undefined ? { body: patch.body } : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        updatedAt: new Date(),
      })
      .where(eq(messageTemplates.key, key));
  } else {
    const def = TEMPLATE_DEFAULTS[key];
    await db.insert(messageTemplates).values({
      key,
      subject: patch.subject ?? def.subject ?? null,
      body: patch.body ?? def.body,
      enabled: patch.enabled ?? true,
    });
  }
  invalidateTemplateCache();
}
