import { boolean, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { properties } from "./properties.js";

export const TEMPLATE_KEYS = [
  "checkin_guest_sms",
  "checkin_owner_sms",
  "checkout_guest_sms",
  "checkout_owner_sms",
  "otp_guest_sms",
  "payment_reminder_guest_sms",
  "booking_advance_guest_sms",
  "booking_advance_owner_sms",
  // Phase 5 — post-stay review prompt. Sent 4 hours after check-out.
  // {review_link} is the optional GOOGLE_REVIEW_URL; if empty, the
  // template renders without the link line — keep that in mind when
  // editing the default body.
  "review_prompt_guest_sms",
] as const;
export type TemplateKey = (typeof TEMPLATE_KEYS)[number];

export const messageTemplates = pgTable(
  "message_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    propertyId: uuid("property_id")
      .notNull()
      .references(() => properties.id),
    // Unique per hotel (was global) — each hotel edits its own copies.
    key: text("key").notNull(),
    subject: text("subject"),
    body: text("body").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    propertyKeyUnique: uniqueIndex("uq_message_templates_property_key").on(t.propertyId, t.key),
    propertyIdx: index("idx_message_templates_property").on(t.propertyId),
  }),
);

export type MessageTemplate = typeof messageTemplates.$inferSelect;
export type NewMessageTemplate = typeof messageTemplates.$inferInsert;
