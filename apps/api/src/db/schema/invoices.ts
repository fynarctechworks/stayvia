import { sql } from "drizzle-orm";
import { boolean, check, date, integer, numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { INVOICE_STATUSES, LINE_ITEM_TYPES, PAYMENT_METHODS } from "./enums.js";
import { guests } from "./guests.js";
import { profiles } from "./profiles.js";
import { properties } from "./properties.js";
import { reservations } from "./reservations.js";

export const invoices = pgTable("invoices", {
  id: uuid("id").primaryKey().defaultRandom(),
  invoiceNumber: text("invoice_number").notNull().unique(),
  // Phase 2: every operational row is scoped to a property. Today
  // there's exactly one (PRIMARY); the field is NOT NULL once
  // migration 0013 has back-filled the bootstrap id.
  propertyId: uuid("property_id")
    .notNull()
    .references(() => properties.id),
  reservationId: uuid("reservation_id")
    .notNull()
    .references(() => reservations.id),
  guestId: uuid("guest_id")
    .notNull()
    .references(() => guests.id),
  // Phase 2 Revenue & Ops — optional B2B attribution.
  companyId: uuid("company_id"),
  hotelName: text("hotel_name").notNull(),
  hotelAddress: text("hotel_address").notNull(),
  hotelGstin: text("hotel_gstin").notNull(),
  guestName: text("guest_name").notNull(),
  guestAddress: text("guest_address"),
  guestGstin: text("guest_gstin"),
  subtotal: numeric("subtotal", { precision: 10, scale: 2 }).notNull(),
  cgstRate: numeric("cgst_rate", { precision: 5, scale: 2 }).notNull(),
  cgstAmount: numeric("cgst_amount", { precision: 10, scale: 2 }).notNull(),
  sgstRate: numeric("sgst_rate", { precision: 5, scale: 2 }).notNull(),
  sgstAmount: numeric("sgst_amount", { precision: 10, scale: 2 }).notNull(),
  grandTotal: numeric("grand_total", { precision: 10, scale: 2 }).notNull(),
  // Wallet credit redeemed against this invoice. Reduces balance_due
  // but not subtotal/GST (GST was already collected on the bill).
  walletCreditApplied: numeric("wallet_credit_applied", { precision: 10, scale: 2 })
    .notNull()
    .default("0"),
  totalPaid: numeric("total_paid", { precision: 10, scale: 2 }).notNull().default("0"),
  balanceDue: numeric("balance_due", { precision: 10, scale: 2 }).notNull(),
  status: text("status", { enum: INVOICE_STATUSES }).notNull().default("issued"),
  // Migration 0042 — credit notes share this table. 'invoice' = an
  // ordinary tax invoice; 'credit_note' = a GST credit note that
  // reverses creditNoteFor. A credit note carries NEGATIVE money columns
  // (subtotal/grandTotal/etc.) so it nets against the original.
  documentType: text("document_type", { enum: ["invoice", "credit_note"] as const })
    .notNull()
    .default("invoice"),
  creditNoteFor: uuid("credit_note_for"),
  notes: text("notes"),
  issueDate: date("issue_date"),
  reissuedFrom: uuid("reissued_from"),
  voidedReason: text("voided_reason"),
  voidedBy: uuid("voided_by").references(() => profiles.id),
  // Migration 0017 — per-room invoicing. 'combined' = the full
  // reservation (legacy behaviour, default). 'room' = covers only the
  // listed scopeRoomIds. 'partial' is reserved for future use (e.g.
  // staff issuing an early invoice for one room while others are
  // still in-house).
  scope: text("scope", { enum: ["combined", "room", "partial"] as const })
    .notNull()
    .default("combined"),
  scopeRoomIds: uuid("scope_room_ids").array(),
  issuedBy: uuid("issued_by")
    .notNull()
    .references(() => profiles.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const invoiceLineItems = pgTable("invoice_line_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  invoiceId: uuid("invoice_id")
    .notNull()
    .references(() => invoices.id, { onDelete: "cascade" }),
  description: text("description").notNull(),
  sacCode: text("sac_code").notNull().default("9963"),
  quantity: integer("quantity").notNull().default(1),
  rate: numeric("rate", { precision: 10, scale: 2 }).notNull(),
  amount: numeric("amount", { precision: 10, scale: 2 }).notNull(),
  gstRate: numeric("gst_rate", { precision: 5, scale: 2 }).notNull(),
  gstAmount: numeric("gst_amount", { precision: 10, scale: 2 }).notNull(),
  itemType: text("item_type", { enum: LINE_ITEM_TYPES }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const payments = pgTable(
  "payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    receiptNumber: text("receipt_number").unique(),
    // Phase 2: payments live under a property. Back-filled by 0013.
    propertyId: uuid("property_id")
      .notNull()
      .references(() => properties.id),
    invoiceId: uuid("invoice_id").references(() => invoices.id),
    reservationId: uuid("reservation_id")
      .notNull()
      .references(() => reservations.id),
    // Phase 2 Revenue & Ops — optional folio linkage. When set, the
    // folio's paid_total trigger keeps the per-payer balance in sync.
    folioId: uuid("folio_id"),
    amount: numeric("amount", { precision: 10, scale: 2 }).notNull(),
    paymentMethod: text("payment_method", { enum: PAYMENT_METHODS }).notNull(),
    status: text("status", { enum: ["received", "pending"] }).notNull().default("received"),
    paymentDate: timestamp("payment_date", { withTimezone: true }).notNull().defaultNow(),
    receivedBy: uuid("received_by")
      .notNull()
      .references(() => profiles.id),
    notes: text("notes"),
    voided: boolean("voided").notNull().default(false),
    voidedReason: text("voided_reason"),
    voidedBy: uuid("voided_by"),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Sign is meaningful: positive = money in, negative = refund (money
    // out). ₹0 receipts are intentional placeholders for a booking/check-in
    // with no advance. Migration 0041 relaxed the old `>= 0` check to
    // `IS NOT NULL` so refund rows are allowed; keep the schema in sync.
    amountNotNull: check("payment_amount_not_null", sql`${t.amount} IS NOT NULL`),
  }),
);

export const additionalCharges = pgTable("additional_charges", {
  id: uuid("id").primaryKey().defaultRandom(),
  reservationId: uuid("reservation_id")
    .notNull()
    .references(() => reservations.id, { onDelete: "cascade" }),
  // Migration 0018 — per-room attribution. NULL = reservation-wide
  // (lands on whichever invoice covers the booker / last remaining
  // room). NOT NULL = bill onto that specific room's per-room invoice.
  roomId: uuid("room_id"),
  description: text("description").notNull(),
  quantity: integer("quantity").notNull().default(1),
  rate: numeric("rate", { precision: 10, scale: 2 }).notNull(),
  amount: numeric("amount", { precision: 10, scale: 2 }).notNull(),
  gstRate: numeric("gst_rate", { precision: 5, scale: 2 }).notNull().default("18"),
  addedBy: uuid("added_by")
    .notNull()
    .references(() => profiles.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Invoice = typeof invoices.$inferSelect;
export type NewInvoice = typeof invoices.$inferInsert;
export type InvoiceLineItem = typeof invoiceLineItems.$inferSelect;
export type NewInvoiceLineItem = typeof invoiceLineItems.$inferInsert;
export type Payment = typeof payments.$inferSelect;
export type NewPayment = typeof payments.$inferInsert;
export type AdditionalCharge = typeof additionalCharges.$inferSelect;
export type NewAdditionalCharge = typeof additionalCharges.$inferInsert;
