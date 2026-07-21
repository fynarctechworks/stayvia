import {
  editPaymentSchema,
  markReceivedSchema,
  paymentSchema,
  voidPaymentSchema,
} from "@stayvia/shared";
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { Router } from "express";
import { db } from "../db/client.js";
import { invoiceLineItems, invoices, payments } from "../db/schema/invoices.js";
import { reservations } from "../db/schema/reservations.js";
import { guests } from "../db/schema/guests.js";
import { logActivity } from "../lib/activity.js";
import { loadGuestExtra } from "../lib/guestExtra.js";
import { logger } from "../lib/logger.js";
import { propertyDayEnd, propertyDayStart } from "../lib/propertyTime.js";
import {
  recomputeInvoiceTotals,
  recomputeReservationBalance,
} from "../lib/reservationBalance.js";
import { renderInvoicePdf, renderReceiptPdf } from "../lib/pdf.js";
import { generateReceiptNumber } from "../lib/receipt.js";
import { invalidateDashboard } from "../lib/redis.js";
import { getSettings } from "../lib/settings.js";
import { documentLabel, uploadPublicPdf } from "../lib/storage.js";
import { fail, ok } from "../lib/response.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";
import { idempotent } from "../middleware/idempotency.js";
import { resolvePaymentId } from "../middleware/resolvePayment.js";
import { validate } from "../middleware/validate.js";

const router = Router();

// Accept either UUID or SLDT-RCP-NNNN receipt number on every :id
// route so receipts can be referenced by their human number.
router.param("id", resolvePaymentId as never);

router.post(
  "/",
  requireAuth,
  requirePermission("record_payments"),
  idempotent("payments.record"),
  validate(paymentSchema),
  async (req, res) => {
    const input = req.body as import("@stayvia/shared").PaymentInput;
    const inv = await db
      .select()
      .from(invoices)
      .where(and(eq(invoices.id, input.invoiceId), eq(invoices.propertyId, req.propertyId)))
      .limit(1);
    if (!inv.length) return fail(res, 404, "NOT_FOUND", "Invoice not found");
    if (inv[0]!.status === "voided") return fail(res, 409, "VOIDED", "Invoice is voided");

    const result = await db.transaction(async (tx) => {
      const rcpNum = await generateReceiptNumber(tx, inv[0]!.propertyId);
      const [pay] = await tx
        .insert(payments)
        .values({
          receiptNumber: rcpNum,
          // Payment inherits its invoice's property scope.
          propertyId: inv[0]!.propertyId,
          invoiceId: input.invoiceId,
          reservationId: inv[0]!.reservationId,
          amount: String(input.amount),
          paymentMethod: input.paymentMethod,
          receivedBy: req.user!.id,
          notes: input.notes ?? null,
        })
        .returning();

      // Derive the invoice's totals from the payment rows inside this
      // transaction, exactly the way the reservation balance already is.
      //
      // The previous version computed `stale.totalPaid + input.amount` from a
      // snapshot read at the top of the handler, OUTSIDE the transaction, and
      // wrote it unconditionally. Two concurrent payments on one invoice both
      // read the same base and the second clobbered the first: two ₹1,000 rows
      // against a ₹2,000 invoice left it claiming ₹1,000 paid and ₹1,000 still
      // owed. The reservation-level number self-healed (it is fact-derived),
      // which made the divergence silent — the reservation said settled while
      // the invoice, its PDF and the /invoices/summary tiles chased the guest
      // for money already collected.
      await recomputeInvoiceTotals(tx, inv[0]!.reservationId);

      // Reservation balanceDue is recomputed from facts, not derived
      // from this invoice's balance — a booking may have multiple
      // invoices and we mustn't overwrite the cross-invoice picture
      // with this one's number.
      await recomputeReservationBalance(tx, inv[0]!.reservationId);

      // Read back the status the recompute just settled on, rather than
      // predicting it from the stale snapshot.
      const [afterInv] = await tx
        .select({ status: invoices.status })
        .from(invoices)
        .where(eq(invoices.id, input.invoiceId))
        .limit(1);
      const newStatus = afterInv?.status ?? "partial";

      // If this real payment fully settles the invoice, auto-void any
      // still-pending "collect later" promises that were sitting on the
      // same invoice — they're now satisfied by this actual collection.
      // Pending payments have status='pending' and didn't count toward
      // totalPaid, so no balance recompute is needed.
      let autoVoided: { id: string; amount: string }[] = [];
      if (newStatus === "paid") {
        autoVoided = await tx
          .update(payments)
          .set({
            voided: true,
            voidedReason: `Auto-voided: settled by ${rcpNum}`,
            voidedBy: req.user!.id,
            voidedAt: new Date(),
          })
          .where(
            and(
              eq(payments.invoiceId, input.invoiceId),
              eq(payments.propertyId, req.propertyId),
              eq(payments.status, "pending"),
              eq(payments.voided, false),
            ),
          )
          .returning({ id: payments.id, amount: payments.amount });
      }

      return { pay: pay!, autoVoided };
    });

    for (const v of result.autoVoided) {
      await logActivity({
        propertyId: req.propertyId,
        action: "payment_voided",
        entityType: "payment",
        entityId: v.id,
        description: `Pending promise ₹${v.amount} auto-voided: settled by ${result.pay.receiptNumber ?? "real payment"}`,
        performedBy: req.user!.id,
        ipAddress: req.ip,
      });
    }
    const created = result.pay;

    // If this payment was recorded by the "collect previous balance" flow,
    // its notes look like "Collected at check-out of <SLDT-RES-XXXX>"
    // (or, on legacy rows, "<uuid>"). Resolve to a reservation id and
    // regenerate that source reservation's public invoice PDF so the
    // companion-footer block stays current. Async-safe: failures warn.
    const marker = extractCheckoutSourceReservation(input.notes ?? "");
    if (marker) {
      const propertyId = req.propertyId;
      void (async () => {
        try {
          let resvId: string | null = null;
          if (marker.kind === "id") {
            const [row] = await db
              .select({ id: reservations.id })
              .from(reservations)
              .where(and(eq(reservations.id, marker.value), eq(reservations.propertyId, propertyId)))
              .limit(1);
            resvId = row?.id ?? null;
          } else {
            const [row] = await db
              .select({ id: reservations.id })
              .from(reservations)
              .where(
                and(
                  eq(reservations.reservationNumber, marker.value),
                  eq(reservations.propertyId, propertyId),
                ),
              )
              .limit(1);
            resvId = row?.id ?? null;
          }
          if (resvId) await regenerateInvoicePdfForReservation(propertyId, resvId);
        } catch (err) {
          logger.warn({ err, marker }, "companion-collection invoice PDF regen failed");
        }
      })();
    }

    await logActivity({
      propertyId: req.propertyId,
      action: "payment_recorded",
      entityType: "invoice",
      entityId: input.invoiceId,
      description: `Payment ₹${input.amount} via ${input.paymentMethod} on ${inv[0]!.invoiceNumber}`,
      performedBy: req.user!.id,
      ipAddress: req.ip,
    });
    await invalidateDashboard(req.propertyId);
    return ok(res, created, 201);
  },
);

router.get("/", requireAuth, requirePermission("view_revenue"), async (req, res) => {
  const { date_from, date_to, method } = req.query as Record<string, string | undefined>;
  const conditions = [eq(payments.propertyId, req.propertyId)];
  if (date_from) conditions.push(gte(payments.paymentDate, propertyDayStart(date_from)));
  if (date_to) conditions.push(lte(payments.paymentDate, propertyDayEnd(date_to)));
  if (method) conditions.push(eq(payments.paymentMethod, method as never));

  const rows = await db
    .select()
    .from(payments)
    .where(and(...conditions))
    .orderBy(desc(payments.paymentDate))
    .limit(500);
  return ok(res, rows);
});

router.get("/:id/receipt", requireAuth, requirePermission("record_payments"), async (req, res) => {
  const id = req.params.id!;
  const pay = await db
    .select()
    .from(payments)
    .where(and(eq(payments.id, id), eq(payments.propertyId, req.propertyId)))
    .limit(1);
  if (!pay.length) return fail(res, 404, "NOT_FOUND", "Payment not found");

  const r = await db
    .select()
    .from(reservations)
    .where(
      and(eq(reservations.id, pay[0]!.reservationId), eq(reservations.propertyId, req.propertyId)),
    )
    .limit(1);
  const g = r.length
    ? await db
        .select()
        .from(guests)
        .where(and(eq(guests.id, r[0]!.guestId), eq(guests.propertyId, req.propertyId)))
        .limit(1)
    : [];
  const inv = pay[0]!.invoiceId
    ? await db
        .select()
        .from(invoices)
        .where(and(eq(invoices.id, pay[0]!.invoiceId), eq(invoices.propertyId, req.propertyId)))
        .limit(1)
    : [];
  const settings = await getSettings(req.propertyId);

  const pdf = await renderReceiptPdf({
    payment: pay[0]!,
    reservation: r[0]!,
    guest: g[0]!,
    invoice: inv[0] ?? null,
    settings,
  });
  const inline = req.query.disposition === "inline";
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `${inline ? "inline" : "attachment"}; filename="${pay[0]!.receiptNumber ?? "receipt"}.pdf"`,
  );
  return res.send(pdf);
});

router.patch(
  "/:id",
  requireAuth,
  requirePermission("record_payments"),
  validate(editPaymentSchema),
  async (req, res) => {
    const id = req.params.id!;
    const input = req.body as {
      paymentDate?: string;
      paymentMethod?: string;
      notes?: string | null;
    };

    const existing = await db
      .select()
      .from(payments)
      .where(and(eq(payments.id, id), eq(payments.propertyId, req.propertyId)))
      .limit(1);
    if (!existing.length) return fail(res, 404, "NOT_FOUND", "Payment not found");
    if (existing[0]!.voided) return fail(res, 400, "VOIDED", "Payment is voided");

    const ageMs = Date.now() - new Date(existing[0]!.createdAt).getTime();
    if (ageMs > 24 * 60 * 60 * 1000) {
      return fail(res, 400, "EXPIRED", "Payment can only be edited within 24 hours of creation");
    }

    const patch: Record<string, unknown> = {};
    if (input.paymentDate !== undefined) patch.paymentDate = new Date(input.paymentDate);
    if (input.paymentMethod !== undefined) patch.paymentMethod = input.paymentMethod;
    if (input.notes !== undefined) patch.notes = input.notes;

    const [updated] = await db
      .update(payments)
      .set(patch)
      .where(and(eq(payments.id, id), eq(payments.propertyId, req.propertyId)))
      .returning();
    await logActivity({
      propertyId: req.propertyId,
      action: "payment_edited",
      entityType: "payment",
      entityId: id,
      description: `Payment ${id.slice(0, 8)} edited`,
      performedBy: req.user!.id,
      ipAddress: req.ip,
      metadata: input,
    });
    return ok(res, updated);
  },
);

router.post(
  "/:id/void",
  requireAuth,
  requirePermission("void_payments"),
  idempotent("payments.void"),
  validate(voidPaymentSchema),
  async (req, res) => {
    const id = req.params.id!;
    const { reason } = req.body as { reason: string };

    const existing = await db
      .select()
      .from(payments)
      .where(and(eq(payments.id, id), eq(payments.propertyId, req.propertyId)))
      .limit(1);
    if (!existing.length) return fail(res, 404, "NOT_FOUND", "Payment not found");
    if (existing[0]!.voided) return fail(res, 400, "ALREADY_VOIDED", "Already voided");

    const invoiceId = existing[0]!.invoiceId;
    const inv = invoiceId
      ? await db
          .select()
          .from(invoices)
          .where(and(eq(invoices.id, invoiceId), eq(invoices.propertyId, req.propertyId)))
          .limit(1)
      : [];

    await db.transaction(async (tx) => {
      await tx
        .update(payments)
        .set({
          voided: true,
          voidedReason: reason,
          voidedBy: req.user!.id,
          voidedAt: new Date(),
        })
        .where(and(eq(payments.id, id), eq(payments.propertyId, req.propertyId)));

      if (inv.length) {
        // Post-invoice void: re-derive the invoice ledger from the surviving
        // payment rows. Same reasoning as POST / — the old code subtracted
        // from a totalPaid snapshot read outside the transaction, so a void
        // racing a payment (or another void) wrote a figure that ignored the
        // other one.
        await recomputeInvoiceTotals(tx, existing[0]!.reservationId);
      }
      // Reservation balance is the cross-invoice picture; recompute
      // from the payment facts regardless of whether the voided payment
      // was attached to an invoice or sitting as a pre-invoice advance.
      await recomputeReservationBalance(tx, existing[0]!.reservationId);
    });

    await logActivity({
      propertyId: req.propertyId,
      action: "payment_voided",
      entityType: "payment",
      entityId: id,
      description: `Payment ₹${existing[0]!.amount} voided: ${reason}`,
      performedBy: req.user!.id,
      ipAddress: req.ip,
    });
    await invalidateDashboard(req.propertyId);
    return ok(res, { success: true });
  },
);

// Mark a pending (unpaid) payment as received with the actual method
router.post(
  "/:id/mark-received",
  requireAuth,
  requirePermission("record_payments"),
  idempotent("payments.markReceived"),
  validate(markReceivedSchema),
  async (req, res) => {
    const id = req.params.id!;
    const body = req.body as { paymentMethod?: string; notes?: string };
    const validMethods = ["cash", "upi", "card", "bank_transfer"] as const;
    if (!body.paymentMethod || !validMethods.includes(body.paymentMethod as never)) {
      return fail(res, 400, "INVALID_METHOD", "Choose cash / upi / card / bank_transfer");
    }

    const [existing] = await db
      .select()
      .from(payments)
      .where(and(eq(payments.id, id), eq(payments.propertyId, req.propertyId)))
      .limit(1);
    if (!existing) return fail(res, 404, "NOT_FOUND", "Payment not found");
    if (existing.status !== "pending") {
      return fail(res, 400, "NOT_PENDING", "Payment is not pending");
    }
    if (existing.voided) return fail(res, 400, "VOIDED", "Payment is voided");

    await db.transaction(async (tx) => {
      await tx
        .update(payments)
        .set({
          status: "received",
          paymentMethod: body.paymentMethod as "cash" | "upi" | "card" | "bank_transfer",
          paymentDate: new Date(),
          receivedBy: req.user!.id,
          notes: body.notes ? body.notes : existing.notes,
        })
        .where(and(eq(payments.id, id), eq(payments.propertyId, req.propertyId)));

      if (existing.invoiceId) {
        // Re-derive from payment rows rather than adding this amount onto a
        // read-modify-write, for the same concurrency reason as POST / and
        // POST /:id/void. The flip to 'received' above is already visible to
        // this transaction, so the recompute picks it up.
        await recomputeInvoiceTotals(tx, existing.reservationId);
      }
      // The pending → received flip turns this payment into "real money"
      // for the first time, so the reservation-level rollup needs to
      // re-pick it up regardless of whether an invoice is attached.
      await recomputeReservationBalance(tx, existing.reservationId);
    });

    await logActivity({
      propertyId: req.propertyId,
      action: "payment_marked_received",
      entityType: "payment",
      entityId: id,
      description: `Pending ₹${existing.amount} marked received via ${body.paymentMethod}`,
      performedBy: req.user!.id,
      ipAddress: req.ip,
    });
    await invalidateDashboard(req.propertyId);
    return ok(res, { success: true });
  },
);

// Parses the FIFO marker on a payment's `notes` field.
//   - new format: "Collected at check-out of SLDT-RES-XXXX" → returns
//     { kind:"number", value: "SLDT-RES-XXXX" }
//   - legacy:     "Collected at check-out of <uuid>"        → returns
//     { kind:"id", value: uuid }
// Returns null if neither matches. Callers resolve the value to a
// reservation id before triggering the PDF regenerator.
function extractCheckoutSourceReservation(
  notes: string,
): { kind: "id" | "number"; value: string } | null {
  const uuidMatch = notes.match(
    /Collected at check-out of ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
  );
  if (uuidMatch) return { kind: "id", value: uuidMatch[1]! };
  const numberMatch = notes.match(/Collected at check-out of ((?:[A-Z0-9]+-)?RES-\d+)/i);
  if (numberMatch) return { kind: "number", value: numberMatch[1]! };
  return null;
}

// Re-renders + re-uploads the public invoice PDF for a given reservation so
// the static link reflects the latest data (e.g. a freshly recorded
// companion collection that should appear in the footer). Best-effort —
// callers `.catch()` on this.
async function regenerateInvoicePdfForReservation(
  propertyId: string,
  reservationId: string,
): Promise<void> {
  const [inv] = await db
    .select()
    .from(invoices)
    .where(and(eq(invoices.reservationId, reservationId), eq(invoices.propertyId, propertyId)))
    .limit(1);
  if (!inv) return;
  const [items, pays, settings, companion, [resRow]] = await Promise.all([
    db.select().from(invoiceLineItems).where(eq(invoiceLineItems.invoiceId, inv.id)),
    db
      .select()
      .from(payments)
      .where(and(eq(payments.invoiceId, inv.id), eq(payments.propertyId, propertyId))),
    getSettings(propertyId),
    collectCompanionCollections(propertyId, reservationId, inv.id),
    db
      .select()
      .from(reservations)
      .where(and(eq(reservations.id, reservationId), eq(reservations.propertyId, propertyId)))
      .limit(1),
  ]);
  const pdf = await renderInvoicePdf({
    invoice: inv,
    lineItems: items,
    payments: pays,
    settings,
    stay: resRow
      ? {
          checkInDate: resRow.checkInDate,
          checkOutDate: resRow.checkOutDate,
          numNights: Number(resRow.numNights),
          checkedInAt: resRow.checkedInAt
            ? resRow.checkedInAt.toISOString()
            : null,
          plannedCheckInAt: resRow.plannedCheckInAt
            ? resRow.plannedCheckInAt.toISOString()
            : null,
          plannedCheckOutAt: resRow.plannedCheckOutAt
            ? resRow.plannedCheckOutAt.toISOString()
            : null,
        }
      : undefined,
    guestExtra: await loadGuestExtra(reservationId),
    companionCollections: companion,
  });
  const [gLab] = resRow
    ? await db
        .select({ fullName: guests.fullName, phone: guests.phone })
        .from(guests)
        .where(and(eq(guests.id, resRow.guestId), eq(guests.propertyId, propertyId)))
        .limit(1)
    : [];
  await uploadPublicPdf(
    propertyId,
    `invoices/${inv.invoiceNumber}.pdf`,
    pdf,
    documentLabel(gLab?.fullName ?? inv.guestName, gLab?.phone),
  );
}

// Companion-collection lookup — duplicate of routes/invoices.ts helper so
// the payments route stays self-contained without a circular import.
// Mirrors the same logic: LEFT JOIN invoices so pre-invoice payments
// (those whose target reservation hasn't been checked out yet) are also
// counted in the footer.
async function collectCompanionCollections(
  propertyId: string,
  reservationId: string,
  thisInvoiceId: string,
): Promise<
  { invoiceNumber: string | null; reservationNumber: string; amount: string }[]
> {
  // Same dual-marker logic as routes/invoices.ts. See there for the
  // rationale. Mirror kept in-file to avoid a circular import.
  const [thisRes] = await db
    .select({ reservationNumber: reservations.reservationNumber })
    .from(reservations)
    .where(and(eq(reservations.id, reservationId), eq(reservations.propertyId, propertyId)))
    .limit(1);
  const newMarker = thisRes
    ? `Collected at check-out of ${thisRes.reservationNumber}`
    : null;
  const legacyMarker = `Collected at check-out of ${reservationId}`;
  const rows = await db
    .select({
      paymentReservationId: payments.reservationId,
      amount: payments.amount,
      invoiceId: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      otherReservationNumber: reservations.reservationNumber,
    })
    .from(payments)
    .innerJoin(reservations, eq(reservations.id, payments.reservationId))
    .leftJoin(invoices, eq(invoices.reservationId, payments.reservationId))
    .where(
      and(
        eq(payments.propertyId, propertyId),
        eq(payments.voided, false),
        newMarker
          ? sql`${payments.notes} IN (${legacyMarker}, ${newMarker})`
          : eq(payments.notes, legacyMarker),
        sql`(${invoices.id} IS NULL OR ${invoices.id} <> ${thisInvoiceId})`,
      ),
    );
  const byReservation = new Map<
    string,
    {
      invoiceNumber: string | null;
      reservationNumber: string;
      total: number;
    }
  >();
  for (const r of rows) {
    if (!r.paymentReservationId) continue;
    const cur = byReservation.get(r.paymentReservationId);
    const amt = Number(r.amount);
    if (cur) cur.total += amt;
    else
      byReservation.set(r.paymentReservationId, {
        invoiceNumber: r.invoiceNumber ?? null,
        reservationNumber: r.otherReservationNumber,
        total: amt,
      });
  }
  return Array.from(byReservation.values()).map((v) => ({
    invoiceNumber: v.invoiceNumber,
    reservationNumber: v.reservationNumber,
    amount: v.total.toFixed(2),
  }));
}

export default router;
