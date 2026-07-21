export const ROLES = ["admin", "frontdesk", "housekeeping"] as const;
export type Role = (typeof ROLES)[number];

// Room types are stored in the `room_types` table and managed from Settings.
// Keeping a plain alias here so legacy type imports still compile.
export type RoomType = string;

export const ROOM_STATUSES = [
  "available",
  "occupied",
  "reserved",
  "maintenance",
  "dirty",
] as const;
export type RoomStatus = (typeof ROOM_STATUSES)[number];

export const ID_PROOF_TYPES = [
  "aadhaar",
  "pan",
  "passport",
  "driving_license",
  "voter_id",
] as const;
export type IdProofType = (typeof ID_PROOF_TYPES)[number];

// Single source of truth — apps/api/src/db/schema/enums.ts re-exports this.
//
// The two copies had diverged: this one was missing `inquiry`, `hold` and
// `pending_payment`, and because it backs reservationListQuerySchema, the API
// rejected GET /reservations?status=hold with a 400 even though the DB stores
// the value. Those are exactly the rows an operator needs to triage — a `hold`
// silently consuming inventory, a `pending_payment` awaiting a deposit — and
// the list could not filter for them. Typecheck could never catch it, since
// each app imported its own copy.
export const RESERVATION_STATUSES = [
  "inquiry",
  "hold",
  "pending_payment",
  "confirmed",
  "checked_in",
  "checked_out",
  "cancelled",
  "no_show",
] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

// Statuses that block room inventory. Used by availability checks and the
// dashboard "occupied vs reserved" logic. `inquiry` does not block.
//
// `hold` is deliberately NOT here. The status was declared to auto-expire via
// a scheduled `holds_expire` job that was never written, and no
// hold_expires_at column exists on reservations or in any migration — so
// nothing could ever transition a row out of it. As a blocking status that
// made any held room permanently unsellable and revenue-blocked until a human
// noticed and hand-edited the row. Until the feature is actually finished
// (deadline column + a sweep, scoped per property_id), a hold must not consume
// inventory.
export const RESERVATION_BLOCKING_STATUSES: readonly ReservationStatus[] = [
  "pending_payment",
  "confirmed",
  "checked_in",
];

export const INVOICE_STATUSES = ["issued", "paid", "partial", "voided"] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export const PAYMENT_METHODS = ["cash", "upi", "card", "bank_transfer", "unpaid"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const BOOKING_SOURCES = ["walkin", "phone_whatsapp", "complimentary"] as const;
export type BookingSource = (typeof BOOKING_SOURCES)[number];

export const REVENUE_EXCLUDED_SOURCES: readonly BookingSource[] = ["complimentary"];

// Expense ledger (migration 0025).
export const EXPENSE_CATEGORIES = [
  "utilities",
  "repairs_maintenance",
  "supplies",
  "salaries_wages",
  "food_kitchen",
  "marketing",
  "government_compliance",
  "other",
] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

export const EXPENSE_PAYMENT_METHODS = [
  "cash",
  "upi",
  "card",
  "bank_transfer",
  "pending",
] as const;
export type ExpensePaymentMethod = (typeof EXPENSE_PAYMENT_METHODS)[number];
