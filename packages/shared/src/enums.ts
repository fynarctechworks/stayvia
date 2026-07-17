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

export const RESERVATION_STATUSES = [
  "confirmed",
  "checked_in",
  "checked_out",
  "cancelled",
  "no_show",
] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

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
