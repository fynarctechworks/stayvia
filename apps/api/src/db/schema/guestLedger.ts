import { numeric, pgTable, text, timestamp, uuid, index } from "drizzle-orm/pg-core";
import { guests } from "./guests.js";

export const LEDGER_ENTRY_TYPES = [
  "credit_issued",
  "credit_used",
  "cashout",
  "adjustment",
] as const;
export type LedgerEntryType = (typeof LEDGER_ENTRY_TYPES)[number];

export const guestLedger = pgTable(
  "guest_ledger",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    guestId: uuid("guest_id")
      .notNull()
      .references(() => guests.id, { onDelete: "cascade" }),
    entryType: text("entry_type", { enum: LEDGER_ENTRY_TYPES }).notNull(),
    amount: numeric("amount", { precision: 10, scale: 2 }).notNull(),
    reservationId: uuid("reservation_id"),
    invoiceId: uuid("invoice_id"),
    paymentId: uuid("payment_id"),
    note: text("note"),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    guestIdx: index("idx_guest_ledger_guest").on(t.guestId),
    createdIdx: index("idx_guest_ledger_created").on(t.createdAt),
  }),
);

export type GuestLedgerEntry = typeof guestLedger.$inferSelect;
export type NewGuestLedgerEntry = typeof guestLedger.$inferInsert;
