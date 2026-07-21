import { z } from "zod";

// Query schema for GET /invoices, /invoices/summary and /invoices/export.
//
// These three read every filter straight off req.query with no validation.
// `page`/`per_page` were hand-clamped with Math.max/Math.min, which do NOT
// filter NaN — `?page=abc` produced `.limit(NaN).offset(NaN)` and a 500 from
// the driver. A partial date like `?date_to=2026-07` reached
// propertyDayEnd(), yielding an Invalid Date whose .toISOString() throws a
// RangeError. And `?q[]=a` made `q` an array, so `q.trim()` threw.
//
// Mirrors expenseListQuerySchema, which already got this right.
export const invoiceListQuerySchema = z.object({
  status: z.enum(["issued", "partial", "paid", "voided"]).optional(),
  scope: z.enum(["room", "combined", "partial"]).optional(),
  date_from: z.string().date().optional(),
  date_to: z.string().date().optional(),
  q: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(200).default(50),
});

// POST /payments/:id/mark-received. A money-path write that carried
// idempotent() but no validate(): `notes` was taken off an untyped cast and
// written straight to payments.notes, so an object landed in the column as
// JSON and an unbounded string was accepted on a financial record — while the
// sibling POST /payments caps the same field at 500 chars.
// Deliberately NOT PAYMENT_METHODS: that list includes "unpaid", which is
// meaningless here — this route exists to convert a pending promise INTO
// collected money. Matches the route's previous inline allowlist.
export const markReceivedSchema = z.object({
  paymentMethod: z.enum(["cash", "upi", "card", "bank_transfer"]),
  notes: z.string().max(500).optional(),
});

// PUT /settings/templates/:key — the only template-mutating route registered
// without validate(). `body`/`subject`/`enabled` came off a TypeScript cast
// (erased at runtime), so `{"body": null}` hit null.trim() and returned an
// unhandled 500, and an unbounded body was persisted and then rendered into
// every outbound guest WhatsApp/email for that hotel.
export const templateUpdateSchema = z.object({
  subject: z.string().max(200).nullable().optional(),
  body: z.string().min(1).max(2000).optional(),
  enabled: z.boolean().optional(),
});

export type InvoiceListQuery = z.infer<typeof invoiceListQuerySchema>;
export type MarkReceivedInput = z.infer<typeof markReceivedSchema>;
export type TemplateUpdateInput = z.infer<typeof templateUpdateSchema>;
