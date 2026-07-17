import {
  expenseCreateSchema,
  expenseListQuerySchema,
  expenseUpdateSchema,
} from "@stayvia/shared";
import { and, desc, eq, gte, ilike, lte, ne, or, sql } from "drizzle-orm";
import { Router } from "express";
import multer from "multer";
import { db } from "../db/client.js";
import { expenses } from "../db/schema/expenses.js";
import { profiles } from "../db/schema/profiles.js";
import { logActivity } from "../lib/activity.js";
import { resolveCurrentPropertyId } from "../lib/currentProperty.js";
import { logger } from "../lib/logger.js";
import { fail, list, ok } from "../lib/response.js";
import {
  deleteExpenseAttachment,
  signedExpenseAttachmentUrl,
  storageFolderLabel,
  uploadExpenseAttachment,
  validateExpenseAttachment,
} from "../lib/storage.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";

const router = Router();

// Multer for bill uploads. Strict whitelist at the multipart layer —
// same defence-in-depth pattern as KYC. Real validation happens in
// validateExpenseAttachment before the upload to storage.
const ALLOWED_UPLOAD_MIMES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
]);
const upload = multer({
  storage: multer.memoryStorage(),
  // 20 fields is comfortable headroom for the 11 text fields the
  // current create form sends plus a few future ones. Multer counts
  // every non-file form field, so this needs to be larger than the
  // longest form we'll ever submit through this route.
  limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 20 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_UPLOAD_MIMES.has(file.mimetype)) {
      cb(new Error("Only JPEG, PNG, WEBP, or PDF accepted"));
      return;
    }
    cb(null, true);
  },
});

// Same status mapping as the Zod schema's `status` filter.
function statusCondition(status?: "paid" | "pending") {
  if (status === "paid") return ne(expenses.paymentMethod, "pending");
  if (status === "pending") return eq(expenses.paymentMethod, "pending");
  return undefined;
}

// GET /expenses — paginated list with filters. Joins recordedBy → profiles
// so the UI can show who entered each expense without a per-row fetch.
router.get(
  "/",
  requireAuth,
  requirePermission("view_expenses"),
  validate(expenseListQuerySchema, "query"),
  async (req, res) => {
    const {
      date_from,
      date_to,
      category,
      payment_method,
      status,
      q,
      page,
      per_page,
    } = req.query as unknown as {
      date_from?: string;
      date_to?: string;
      category?: string;
      payment_method?: string;
      status?: "paid" | "pending";
      q?: string;
      page: number;
      per_page: number;
    };

    const conditions = [];
    if (date_from) conditions.push(gte(expenses.expenseDate, date_from));
    if (date_to) conditions.push(lte(expenses.expenseDate, date_to));
    if (category) conditions.push(eq(expenses.category, category as never));
    if (payment_method)
      conditions.push(eq(expenses.paymentMethod, payment_method as never));
    const sc = statusCondition(status);
    if (sc) conditions.push(sc);
    if (q && q.trim()) {
      const needle = `%${q.trim()}%`;
      conditions.push(
        or(
          ilike(expenses.description, needle),
          ilike(expenses.vendorName, needle),
          ilike(expenses.billNumber, needle),
          ilike(expenses.subcategory, needle),
        )!,
      );
    }
    const where = conditions.length ? and(...conditions) : undefined;

    const [rows, total] = await Promise.all([
      db
        .select({
          id: expenses.id,
          expenseDate: expenses.expenseDate,
          category: expenses.category,
          subcategory: expenses.subcategory,
          description: expenses.description,
          amount: expenses.amount,
          gstAmount: expenses.gstAmount,
          paymentMethod: expenses.paymentMethod,
          paidAt: expenses.paidAt,
          vendorName: expenses.vendorName,
          vendorPhone: expenses.vendorPhone,
          billNumber: expenses.billNumber,
          attachmentUrl: expenses.attachmentUrl,
          notes: expenses.notes,
          createdAt: expenses.createdAt,
          updatedAt: expenses.updatedAt,
          recordedById: expenses.recordedBy,
          recordedByName: profiles.fullName,
        })
        .from(expenses)
        .leftJoin(profiles, eq(profiles.id, expenses.recordedBy))
        .where(where)
        .orderBy(desc(expenses.expenseDate), desc(expenses.createdAt))
        .limit(per_page)
        .offset((page - 1) * per_page),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(expenses)
        .where(where),
    ]);

    return list(res, rows, {
      total: total[0]?.count ?? 0,
      page,
      per_page,
    });
  },
);

// GET /expenses/summary — money totals + per-category breakdown for the
// current filter set. Same query semantics as list above so the
// dashboard tiles agree with the list.
router.get(
  "/summary",
  requireAuth,
  requirePermission("view_expenses"),
  async (req, res) => {
    const { date_from, date_to, category, payment_method, status, q } =
      req.query as Record<string, string | undefined>;
    const conditions = [];
    if (date_from) conditions.push(gte(expenses.expenseDate, date_from));
    if (date_to) conditions.push(lte(expenses.expenseDate, date_to));
    if (category) conditions.push(eq(expenses.category, category as never));
    if (payment_method)
      conditions.push(eq(expenses.paymentMethod, payment_method as never));
    const sc = statusCondition(status as "paid" | "pending" | undefined);
    if (sc) conditions.push(sc);
    if (q && q.trim()) {
      const needle = `%${q.trim()}%`;
      conditions.push(
        or(
          ilike(expenses.description, needle),
          ilike(expenses.vendorName, needle),
          ilike(expenses.billNumber, needle),
          ilike(expenses.subcategory, needle),
        )!,
      );
    }
    const where = conditions.length ? and(...conditions) : undefined;

    const [agg] = await db
      .select({
        count: sql<number>`count(*)::int`,
        total: sql<string>`COALESCE(SUM(${expenses.amount}), 0)::text`,
        paid: sql<string>`COALESCE(SUM(CASE WHEN ${expenses.paymentMethod} <> 'pending' THEN ${expenses.amount} ELSE 0 END), 0)::text`,
        pending: sql<string>`COALESCE(SUM(CASE WHEN ${expenses.paymentMethod} = 'pending' THEN ${expenses.amount} ELSE 0 END), 0)::text`,
        gst: sql<string>`COALESCE(SUM(${expenses.gstAmount}), 0)::text`,
      })
      .from(expenses)
      .where(where);

    const byCategory = await db
      .select({
        category: expenses.category,
        total: sql<string>`COALESCE(SUM(${expenses.amount}), 0)::text`,
        count: sql<number>`count(*)::int`,
      })
      .from(expenses)
      .where(where)
      .groupBy(expenses.category)
      .orderBy(sql`sum(${expenses.amount}) DESC`);

    return ok(res, {
      count: agg?.count ?? 0,
      total: agg?.total ?? "0",
      paid: agg?.paid ?? "0",
      pending: agg?.pending ?? "0",
      gst: agg?.gst ?? "0",
      byCategory,
    });
  },
);

// GET /:id — single row, with a signed URL for the attachment so the
// UI can render it without storing the storage path.
router.get(
  "/:id",
  requireAuth,
  requirePermission("view_expenses"),
  async (req, res) => {
    const id = req.params.id!;
    const [row] = await db
      .select({
        id: expenses.id,
        expenseDate: expenses.expenseDate,
        category: expenses.category,
        subcategory: expenses.subcategory,
        description: expenses.description,
        amount: expenses.amount,
        gstAmount: expenses.gstAmount,
        paymentMethod: expenses.paymentMethod,
        paidAt: expenses.paidAt,
        vendorName: expenses.vendorName,
        vendorPhone: expenses.vendorPhone,
        billNumber: expenses.billNumber,
        attachmentUrl: expenses.attachmentUrl,
        notes: expenses.notes,
        createdAt: expenses.createdAt,
        updatedAt: expenses.updatedAt,
        recordedById: expenses.recordedBy,
        recordedByName: profiles.fullName,
      })
      .from(expenses)
      .leftJoin(profiles, eq(profiles.id, expenses.recordedBy))
      .where(eq(expenses.id, id))
      .limit(1);
    if (!row) return fail(res, 404, "NOT_FOUND", "Expense not found");
    const signedUrl = row.attachmentUrl
      ? await signedExpenseAttachmentUrl(row.attachmentUrl)
      : null;
    return ok(res, { ...row, attachmentSignedUrl: signedUrl });
  },
);

// POST / — create. Multipart form with optional `bill` file.
router.post(
  "/",
  requireAuth,
  requirePermission("manage_expenses"),
  upload.single("bill"),
  async (req, res) => {
    // multer puts text fields on req.body as strings; we re-validate
    // them through the same Zod create schema.
    const parsed = expenseCreateSchema.safeParse({
      ...req.body,
      // Zod expects number for `amount` / `gstAmount` after coerce,
      // but multer ships everything as string. z.coerce handles it.
    });
    if (!parsed.success) {
      return fail(res, 400, "VALIDATION", "Invalid expense", {
        issues: parsed.error.issues,
      });
    }
    const input = parsed.data;

    // Attachment file is optional — validate first, store after the
    // row exists so the path can use the expense id.
    let attachmentPath: string | null = null;
    if (req.file) {
      const v = validateExpenseAttachment(req.file);
      if (v) return fail(res, 400, "BAD_FILE", v);
    }

    const propertyId = await resolveCurrentPropertyId(req);
    // If staff didn't pick a paidAt but marked the payment as
    // anything other than pending, stamp the current time.
    const paidAt =
      input.paidAt !== undefined && input.paidAt !== null
        ? new Date(input.paidAt)
        : input.paymentMethod !== "pending"
          ? new Date()
          : null;

    const [created] = await db
      .insert(expenses)
      .values({
        propertyId,
        expenseDate: input.expenseDate,
        category: input.category,
        subcategory: input.subcategory ?? null,
        description: input.description,
        amount: String(input.amount),
        gstAmount: String(input.gstAmount ?? 0),
        paymentMethod: input.paymentMethod ?? "cash",
        paidAt,
        vendorName: input.vendorName ?? null,
        vendorPhone: input.vendorPhone ?? null,
        billNumber: input.billNumber ?? null,
        attachmentUrl: null,
        recordedBy: req.user!.id,
        notes: input.notes ?? null,
      })
      .returning();

    // Upload the bill now that we have the row id for the path.
    if (req.file && created) {
      try {
        attachmentPath = await uploadExpenseAttachment(
          storageFolderLabel(created.description, created.id.slice(0, 8), "expense"),
          {
            buffer: req.file.buffer,
            mimetype: req.file.mimetype,
            originalName: req.file.originalname,
          },
        );
        await db
          .update(expenses)
          .set({ attachmentUrl: attachmentPath, updatedAt: new Date() })
          .where(eq(expenses.id, created.id));
      } catch (err) {
        // Don't fail the create — the row is committed and the bill
        // can be uploaded later via PATCH.
        logger.warn(
          { err: err instanceof Error ? err.message : err, expenseId: created.id },
          "expense bill upload failed; row persisted without attachment",
        );
      }
    }

    await logActivity({
      action: "expense_created",
      entityType: "expense",
      entityId: created!.id,
      description: `Expense recorded: ${input.description} (₹${input.amount})`,
      performedBy: req.user!.id,
      ipAddress: req.ip,
    });

    return ok(
      res,
      { ...created!, attachmentUrl: attachmentPath ?? created!.attachmentUrl },
      201,
    );
  },
);

// PATCH /:id — partial update. JSON body (no file). To replace the
// bill, send a fresh multipart POST to /:id/bill below.
router.patch(
  "/:id",
  requireAuth,
  requirePermission("manage_expenses"),
  validate(expenseUpdateSchema),
  async (req, res) => {
    const id = req.params.id!;
    const input = req.body as Record<string, unknown>;
    const [existing] = await db
      .select()
      .from(expenses)
      .where(eq(expenses.id, id))
      .limit(1);
    if (!existing) return fail(res, 404, "NOT_FOUND", "Expense not found");

    const update: Record<string, unknown> = { updatedAt: new Date() };
    for (const [k, v] of Object.entries(input)) {
      if (v === undefined) continue;
      if (k === "amount" || k === "gstAmount") {
        update[k] = String(v);
      } else if (k === "paidAt") {
        update[k] = v === null ? null : new Date(v as string);
      } else {
        update[k] = v;
      }
    }
    // Auto-stamp paidAt when staff flips a row from pending → paid
    // and didn't supply a paidAt themselves.
    if (
      input.paymentMethod &&
      input.paymentMethod !== "pending" &&
      input.paidAt === undefined &&
      !existing.paidAt
    ) {
      update.paidAt = new Date();
    }

    const [updated] = await db
      .update(expenses)
      .set(update)
      .where(eq(expenses.id, id))
      .returning();

    await logActivity({
      action: "expense_updated",
      entityType: "expense",
      entityId: id,
      description: `Expense edited: ${updated!.description}`,
      performedBy: req.user!.id,
      ipAddress: req.ip,
    });
    return ok(res, updated);
  },
);

// POST /:id/bill — upload (or replace) the bill attachment after
// the row exists. Reads multipart with field name "bill".
router.post(
  "/:id/bill",
  requireAuth,
  requirePermission("manage_expenses"),
  upload.single("bill"),
  async (req, res) => {
    const id = req.params.id!;
    if (!req.file) return fail(res, 400, "NO_FILE", "Upload a bill file");
    const v = validateExpenseAttachment(req.file);
    if (v) return fail(res, 400, "BAD_FILE", v);

    const [existing] = await db
      .select()
      .from(expenses)
      .where(eq(expenses.id, id))
      .limit(1);
    if (!existing) return fail(res, 404, "NOT_FOUND", "Expense not found");

    // Best-effort delete of the prior attachment so we don't accumulate
    // orphaned files when staff re-uploads.
    if (existing.attachmentUrl) {
      try {
        await deleteExpenseAttachment(existing.attachmentUrl);
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : err, expenseId: id },
          "expense prior attachment delete failed; continuing",
        );
      }
    }

    const path = await uploadExpenseAttachment(
      storageFolderLabel(existing.description, id.slice(0, 8), "expense"),
      {
        buffer: req.file.buffer,
        mimetype: req.file.mimetype,
        originalName: req.file.originalname,
      },
    );
    const [updated] = await db
      .update(expenses)
      .set({ attachmentUrl: path, updatedAt: new Date() })
      .where(eq(expenses.id, id))
      .returning();
    const signedUrl = await signedExpenseAttachmentUrl(path);
    return ok(res, { ...updated, attachmentSignedUrl: signedUrl });
  },
);

// DELETE /:id — hard delete. Also cleans up the attachment.
router.delete(
  "/:id",
  requireAuth,
  requirePermission("manage_expenses"),
  async (req, res) => {
    const id = req.params.id!;
    const [existing] = await db
      .select()
      .from(expenses)
      .where(eq(expenses.id, id))
      .limit(1);
    if (!existing) return fail(res, 404, "NOT_FOUND", "Expense not found");

    if (existing.attachmentUrl) {
      try {
        await deleteExpenseAttachment(existing.attachmentUrl);
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : err, expenseId: id },
          "expense attachment delete failed; row will still be removed",
        );
      }
    }
    await db.delete(expenses).where(eq(expenses.id, id));
    await logActivity({
      action: "expense_deleted",
      entityType: "expense",
      entityId: id,
      description: `Expense deleted: ${existing.description} (₹${existing.amount})`,
      performedBy: req.user!.id,
      ipAddress: req.ip,
    });
    return ok(res, { deleted: true });
  },
);

export default router;
