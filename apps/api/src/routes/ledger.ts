import { desc, eq } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";
import { db } from "../db/client.js";
import { guests } from "../db/schema/guests.js";
import { guestLedger } from "../db/schema/guestLedger.js";
import { logActivity } from "../lib/activity.js";
import { addLedgerEntry, getGuestBalance } from "../lib/ledger.js";
import { fail, ok } from "../lib/response.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";
import { idempotent } from "../middleware/idempotency.js";
import { validate } from "../middleware/validate.js";

const router = Router();

router.get(
  "/guests/:id/ledger",
  requireAuth,
  requirePermission("view_guests"),
  async (req, res) => {
    const id = req.params.id!;
    const g = await db.select({ id: guests.id }).from(guests).where(eq(guests.id, id)).limit(1);
    if (!g.length) return fail(res, 404, "NOT_FOUND", "Guest not found");

    const [entries, balance] = await Promise.all([
      db
        .select()
        .from(guestLedger)
        .where(eq(guestLedger.guestId, id))
        .orderBy(desc(guestLedger.createdAt)),
      getGuestBalance(id),
    ]);
    return ok(res, { balance, entries });
  },
);

const cashoutSchema = z.object({
  amount: z.coerce.number().positive(),
  note: z.string().max(500).optional(),
});

router.post(
  "/guests/:id/ledger/cashout",
  requireAuth,
  requirePermission("view_guests"),
  idempotent("ledger.cashout"),
  validate(cashoutSchema),
  async (req, res) => {
    const id = req.params.id!;
    const { amount, note } = req.body as z.infer<typeof cashoutSchema>;
    const balance = await getGuestBalance(id);
    if (amount > balance + 0.009) {
      return fail(res, 400, "INSUFFICIENT_BALANCE", `Available balance is ₹${balance.toFixed(2)}`);
    }
    const entry = await addLedgerEntry({
      guestId: id,
      entryType: "cashout",
      amount,
      note: note ?? "Cash refund from wallet credit",
      createdBy: req.user!.id,
    });
    await logActivity({
      action: "ledger_cashout",
      entityType: "guest",
      entityId: id,
      description: `Wallet cashout ₹${amount.toFixed(2)}`,
      performedBy: req.user!.id,
      ipAddress: req.ip,
      metadata: { ledgerEntryId: entry.id },
    });
    return ok(res, { entry, balance: await getGuestBalance(id) });
  },
);

const adjustSchema = z.object({
  amount: z.coerce.number(),
  note: z.string().min(1).max(500),
});

router.post(
  "/guests/:id/ledger/adjust",
  requireAuth,
  requirePermission("manage_settings"),
  idempotent("ledger.adjust"),
  validate(adjustSchema),
  async (req, res) => {
    const id = req.params.id!;
    const { amount, note } = req.body as z.infer<typeof adjustSchema>;
    if (Math.abs(amount) < 0.01) return fail(res, 400, "ZERO", "Amount cannot be zero");

    const entryType: "credit_issued" | "cashout" = amount > 0 ? "credit_issued" : "cashout";
    const entry = await addLedgerEntry({
      guestId: id,
      entryType,
      amount: Math.abs(amount),
      note,
      createdBy: req.user!.id,
    });
    await logActivity({
      action: "ledger_adjustment",
      entityType: "guest",
      entityId: id,
      description: `Wallet ${amount > 0 ? "credit" : "debit"} ₹${Math.abs(amount).toFixed(2)} — ${note}`,
      performedBy: req.user!.id,
      ipAddress: req.ip,
      metadata: { ledgerEntryId: entry.id, signed: amount },
    });
    return ok(res, { entry, balance: await getGuestBalance(id) });
  },
);

export default router;
