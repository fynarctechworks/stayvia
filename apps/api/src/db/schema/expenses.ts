import {
  check,
  date,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { EXPENSE_CATEGORIES, EXPENSE_PAYMENT_METHODS } from "./enums.js";
import { profiles } from "./profiles.js";
import { properties } from "./properties.js";

// Property expenses ledger. See migration 0025 for the rationale,
// the index strategy, and the permission grants.
export const expenses = pgTable(
  "expenses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    propertyId: uuid("property_id")
      .notNull()
      .references(() => properties.id),
    expenseDate: date("expense_date").notNull(),
    category: text("category", { enum: EXPENSE_CATEGORIES }).notNull(),
    subcategory: text("subcategory"),
    description: text("description").notNull(),
    amount: numeric("amount", { precision: 10, scale: 2 }).notNull(),
    gstAmount: numeric("gst_amount", { precision: 10, scale: 2 })
      .notNull()
      .default("0"),
    paymentMethod: text("payment_method", { enum: EXPENSE_PAYMENT_METHODS })
      .notNull()
      .default("cash"),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    vendorName: text("vendor_name"),
    vendorPhone: text("vendor_phone"),
    billNumber: text("bill_number"),
    attachmentUrl: text("attachment_url"),
    recordedBy: uuid("recorded_by")
      .notNull()
      .references(() => profiles.id),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    amountNonNegative: check("expenses_amount_nonneg", sql`${t.amount} >= 0`),
    gstNonNegative: check("expenses_gst_nonneg", sql`${t.gstAmount} >= 0`),
    byDateCategory: index("idx_expenses_date_category").on(
      t.expenseDate,
      t.category,
    ),
    byPropertyDate: index("idx_expenses_property_date").on(
      t.propertyId,
      t.expenseDate,
    ),
  }),
);

export type Expense = typeof expenses.$inferSelect;
export type NewExpense = typeof expenses.$inferInsert;
