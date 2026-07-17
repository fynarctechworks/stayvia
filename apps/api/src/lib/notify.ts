import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/client.js";
import { profiles } from "../db/schema/profiles.js";
import { notifications, type NotificationType } from "../db/schema/notifications.js";
import type { Role } from "../db/schema/enums.js";
import { logger } from "./logger.js";
import { messaging } from "./messaging.js";
// Static import — settings.ts pulls only db/schema, no cycle. Dynamic import()
// fails inside the pkg-bundled sidecar, which silently broke owner alerts.
import { getSettings } from "./settings.js";
import { env } from "../config/env.js";

interface DispatchInput {
  // Tenant the notification belongs to — role expansion only reaches THIS
  // hotel's staff, and the rows are stamped with it.
  propertyId: string;
  type: NotificationType;
  title: string;
  body: string;
  href?: string;
  payload?: Record<string, unknown>;
  recipientRoles?: Role[];
  recipientIds?: string[];
}

export async function dispatchNotification(input: DispatchInput): Promise<void> {
  const ids = new Set<string>(input.recipientIds ?? []);

  if (input.recipientRoles && input.recipientRoles.length > 0) {
    const rows = await db
      .select({ id: profiles.id })
      .from(profiles)
      .where(
        and(
          inArray(profiles.role, input.recipientRoles),
          eq(profiles.propertyId, input.propertyId),
        ),
      );
    for (const r of rows) ids.add(r.id);
  }

  if (ids.size === 0) {
    logger.warn({ type: input.type }, "dispatchNotification: no recipients");
    return;
  }

  const rows = Array.from(ids).map((recipientId) => ({
    propertyId: input.propertyId,
    recipientId,
    type: input.type,
    title: input.title,
    body: input.body,
    href: input.href,
    payload: input.payload ?? null,
  }));

  await db.insert(notifications).values(rows);
}

interface GuestSmsInput {
  to: string | null | undefined;
  text: string;
}
interface GuestEmailInput {
  to: string | null | undefined;
  subject: string;
  text: string;
  html?: string;
  attachments?: { filename: string; content: Buffer; contentType?: string }[];
}

export async function notifyGuestSms(input: GuestSmsInput): Promise<void> {
  if (!input.to) return;
  const r = await messaging.sendSms({ to: input.to, text: input.text });
  if (!r.ok) logger.warn({ err: r.error }, "guest SMS failed");
}

export async function notifyGuestEmail(input: GuestEmailInput): Promise<void> {
  if (!input.to) return;
  const r = await messaging.sendEmail({
    to: input.to,
    subject: input.subject,
    text: input.text,
    html: input.html,
    attachments: input.attachments,
  });
  if (!r.ok) logger.warn({ err: r.error }, "guest email failed");
}

// Per-property hotel display name for guest-facing messages.
// env.HOTEL_DISPLAY_NAME is only the last-resort fallback when the property's
// settings row can't be loaded.
export async function hotelDisplayName(propertyId: string): Promise<string> {
  try {
    const s = await getSettings(propertyId);
    if (s.hotelName) return s.hotelName;
  } catch (err) {
    logger.warn({ err }, "hotel name lookup failed; using env fallback");
  }
  return env.HOTEL_DISPLAY_NAME;
}

export async function notifyOwner(propertyId: string, text: string): Promise<void> {
  try {
    const s = await getSettings(propertyId);
    if (!s.ownerNotifyEnabled || !s.ownerPhone) return;
    const r = await messaging.sendSms({ to: s.ownerPhone, text });
    if (!r.ok) logger.warn({ err: r.error }, "owner SMS failed");
  } catch (err) {
    logger.warn({ err }, "owner notify lookup failed");
  }
}

