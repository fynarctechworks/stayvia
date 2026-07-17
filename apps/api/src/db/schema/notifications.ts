import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { profiles } from "./profiles.js";

export const NOTIFICATION_TYPES = [
  "reservation_created",
  "reservation_cancelled",
  "guest_checked_in",
  "guest_checked_out",
  "housekeeping_assigned",
  "housekeeping_completed",
  "invoice_issued",
  "message_received",
  "system",
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    recipientId: uuid("recipient_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    type: text("type", { enum: NOTIFICATION_TYPES }).notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    href: text("href"),
    payload: jsonb("payload"),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    recipientIdx: index("idx_notifications_recipient_unread").on(t.recipientId, t.readAt),
    createdIdx: index("idx_notifications_recipient_created").on(t.recipientId, t.createdAt),
  }),
);

export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;
