import { integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

// Offline message queue. In offline mode, every WhatsApp/email send enqueues a
// row here and returns immediately; a connectivity-gated drainer delivers them
// (via the VPS send-proxy) when the desk is back online. Online mode does not
// use this table — sends go direct.
export const messageOutbox = pgTable("message_outbox", {
  id: uuid("id").primaryKey().defaultRandom(),
  channel: text("channel", { enum: ["sms", "email"] }).notNull(),
  recipient: text("recipient").notNull(),
  // JSON-serialized SmsMessage | EmailMessage payload (minus binary
  // attachments, which are referenced by storage path where needed).
  payload: text("payload").notNull(),
  status: text("status", { enum: ["pending", "sent", "failed"] })
    .notNull()
    .default("pending"),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type MessageOutboxRow = typeof messageOutbox.$inferSelect;
export type NewMessageOutboxRow = typeof messageOutbox.$inferInsert;
