// Legacy role tags. Kept for back-compat with the small handful of code
// paths that still inspect profiles.role directly (audit log filters,
// seed scripts). The authoritative model is RBAC via roles +
// role_permissions; new roles (manager, accountant, owner) are seeded
// into that system, not added here, because adding to this enum forces
// schema-level CHECK constraints we don't want on a soft tag.
export const ROLES = ["admin", "frontdesk", "housekeeping"] as const;
export type Role = (typeof ROLES)[number];

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

// Reservation lifecycle. `inquiry`, `hold`, and `pending_payment` are
// pre-confirmation states added in Phase 1:
//   inquiry         — guest asked about availability; no rooms blocked.
//   hold            — rooms tentatively blocked for N hours (auto-expires
//                     via the holds_expire scheduled job — see TODO).
//   confirmed       — booking is firm.
//   pending_payment — confirmed but the agreed deposit hasn't arrived.
//                     Surfaces in Collections as a follow-up.
//   checked_in / checked_out — physical-presence states.
//   cancelled / no_show — terminal negative states.
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

// Statuses that block room inventory. Used by availability checks and
// the dashboard "occupied vs reserved" logic. inquiry doesn't block;
// hold and pending_payment do (they were promised a room).
export const RESERVATION_BLOCKING_STATUSES: readonly ReservationStatus[] = [
  "hold",
  "pending_payment",
  "confirmed",
  "checked_in",
];

export const INVOICE_STATUSES = ["issued", "paid", "partial", "voided"] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export const PAYMENT_METHODS = ["cash", "upi", "card", "bank_transfer", "unpaid"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

// Expense ledger (migration 0025). Categories are the fixed,
// reportable buckets; subcategory stays free-text. Adding a value
// requires a DB enum migration so this list is deliberately small.
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

// Distinct from PAYMENT_METHODS because expenses carry a "pending"
// (bill recorded but not yet paid) state that doesn't make sense for
// guest payments.
export const EXPENSE_PAYMENT_METHODS = [
  "cash",
  "upi",
  "card",
  "bank_transfer",
  "pending",
] as const;
export type ExpensePaymentMethod = (typeof EXPENSE_PAYMENT_METHODS)[number];

export const LINE_ITEM_TYPES = ["room_charge", "additional_charge"] as const;
export type LineItemType = (typeof LINE_ITEM_TYPES)[number];

export const BOOKING_SOURCES = ["walkin", "phone_whatsapp", "complimentary"] as const;
export type BookingSource = (typeof BOOKING_SOURCES)[number];

export const REVENUE_EXCLUDED_SOURCES: readonly BookingSource[] = ["complimentary"];
