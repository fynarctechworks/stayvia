import { z } from "zod";
import { EXPENSE_CATEGORIES, EXPENSE_PAYMENT_METHODS } from "../enums.js";

// Shared base — the fields that appear on both create and update.
// Each is marked optional on update; create extends with required
// versions of the must-haves.
const expenseBaseSchema = z.object({
  expenseDate: z.string().date(),
  category: z.enum(EXPENSE_CATEGORIES),
  subcategory: z
    .string()
    .max(60)
    .optional()
    .nullable()
    .transform((v) => (v === "" ? null : v)),
  description: z.string().min(1).max(200),
  amount: z.coerce.number().nonnegative().max(99999999),
  gstAmount: z.coerce.number().nonnegative().max(99999999).optional().default(0),
  paymentMethod: z.enum(EXPENSE_PAYMENT_METHODS).optional().default("cash"),
  // Only meaningful when paymentMethod !== 'pending'. Server fills
  // this in automatically when staff records a paid expense and
  // didn't pick a date.
  paidAt: z.string().datetime({ offset: true }).optional().nullable(),
  vendorName: z
    .string()
    .max(120)
    .optional()
    .nullable()
    .transform((v) => (v === "" ? null : v)),
  vendorPhone: z
    .string()
    .max(20)
    .optional()
    .nullable()
    .transform((v) => (v === "" ? null : v)),
  billNumber: z
    .string()
    .max(60)
    .optional()
    .nullable()
    .transform((v) => (v === "" ? null : v)),
  // Server-managed in practice (file upload writes this); the schema
  // accepts it so we can clear it via PATCH (send `null`).
  attachmentUrl: z
    .string()
    .max(500)
    .optional()
    .nullable()
    .transform((v) => (v === "" ? null : v)),
  notes: z
    .string()
    .max(1000)
    .optional()
    .nullable()
    .transform((v) => (v === "" ? null : v)),
});

export const expenseCreateSchema = expenseBaseSchema;

// Update — every field optional. PATCH semantics; server merges
// non-undefined keys into the existing row.
export const expenseUpdateSchema = expenseBaseSchema.partial();

// Query params for GET /expenses. Pagination, date window,
// category, payment status, and a free-text search across
// description/vendor/bill number.
export const expenseListQuerySchema = z.object({
  date_from: z.string().date().optional(),
  date_to: z.string().date().optional(),
  category: z.enum(EXPENSE_CATEGORIES).optional(),
  payment_method: z.enum(EXPENSE_PAYMENT_METHODS).optional(),
  // "paid" / "pending" — quick filter that's friendlier than the
  // raw payment_method values. Maps server-side: 'paid' = anything
  // not 'pending'; 'pending' = exactly 'pending'.
  status: z.enum(["paid", "pending"]).optional(),
  q: z.string().trim().min(1).max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(25),
});

export type ExpenseCreateInput = z.infer<typeof expenseCreateSchema>;
export type ExpenseUpdateInput = z.infer<typeof expenseUpdateSchema>;
export type ExpenseListQuery = z.infer<typeof expenseListQuerySchema>;
