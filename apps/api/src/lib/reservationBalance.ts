// Single source of truth for a reservation's balanceDue + advancePaid.
//
// Why this exists:
// Historically every payment-event code path computed and wrote
// reservations.balanceDue inline. With multi-invoice bookings (per-room,
// combined + per-room, late-issued invoices) those inline writes started
// to drift — e.g. setting reservation balance = one invoice's balance
// silently zeroed out the other invoice's debt. The fix is to never
// write the balance inline; always recompute from the authoritative
// payment + charge facts and write that one number.
//
// The maths:
//   balanceDue   = max(0, grandTotal - sumOfReceivedPayments - walletCreditApplied)
//   advancePaid  = sumOfReceivedPayments (kept for legacy fields; UI
//                  treats grandTotal − balanceDue as "paid")
//
// Pending and voided payments do NOT count. Wallet credit is treated as
// money applied to the bill (matches how it's recorded at booking).
//
// Callers MUST pass a transaction (or the db client when not inside one)
// so the recompute runs against the same snapshot as the payment write
// it follows.

import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { invoices, payments } from "../db/schema/invoices.js";
import { reservationRooms, reservations } from "../db/schema/reservations.js";
import { rooms } from "../db/schema/rooms.js";
import { generateReceiptNumber } from "./receipt.js";

type Tx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface RecomputedBalance {
  grandTotal: number;
  sumReceivedPayments: number;
  walletCreditApplied: number;
  balanceDue: number;
}

// Recompute and persist reservations.balanceDue + advancePaid from facts.
// Returns the new numbers so callers can use them in the same response
// (e.g. to surface "paid in full" to the UI immediately).
export async function recomputeReservationBalance(
  tx: Tx,
  reservationId: string,
): Promise<RecomputedBalance> {
  const [r] = await tx
    .select({
      grandTotal: reservations.grandTotal,
      walletCreditApplied: reservations.walletCreditApplied,
    })
    .from(reservations)
    .where(eq(reservations.id, reservationId))
    .limit(1);
  if (!r) {
    throw new Error(`recomputeReservationBalance: reservation ${reservationId} not found`);
  }

  // Sum every non-voided, "received" payment on this reservation. Pending
  // payments (promises to pay) and voided rows are excluded.
  const [paid] = await tx
    .select({
      total: sql<string>`COALESCE(SUM(${payments.amount}), 0)::text`,
    })
    .from(payments)
    .where(
      and(
        eq(payments.reservationId, reservationId),
        eq(payments.voided, false),
        eq(payments.status, "received"),
      ),
    );

  const grandTotal = Number(r.grandTotal);
  const walletCreditApplied = Number(r.walletCreditApplied ?? 0);
  const sumReceivedPayments = Number(paid?.total ?? 0);
  const balanceDue = +Math.max(
    0,
    grandTotal - sumReceivedPayments - walletCreditApplied,
  ).toFixed(2);

  await tx
    .update(reservations)
    .set({
      // advancePaid carries the historical name but, post-rework, it is
      // simply "money received for this booking so far". Legacy reads
      // that subtract it from grandTotal still get the right answer.
      advancePaid: sumReceivedPayments.toFixed(2),
      balanceDue: balanceDue.toFixed(2),
      updatedAt: new Date(),
    })
    .where(eq(reservations.id, reservationId));

  return {
    grandTotal,
    sumReceivedPayments,
    walletCreditApplied,
    balanceDue,
  };
}

// Recompute every invoice on a reservation from the payments attached to
// it. Used after an orphan payment is re-linked, or after a void, to
// keep invoices.totalPaid / balanceDue / status honest.
export async function recomputeInvoiceTotals(
  tx: Tx,
  reservationId: string,
): Promise<void> {
  const invs = await tx
    .select({
      id: invoices.id,
      grandTotal: invoices.grandTotal,
      walletCreditApplied: invoices.walletCreditApplied,
      status: invoices.status,
      documentType: invoices.documentType,
    })
    .from(invoices)
    .where(eq(invoices.reservationId, reservationId));

  for (const inv of invs) {
    if (inv.status === "voided") continue;
    // Credit notes carry fixed negative totals (they mirror the invoice
    // they reverse). They never hold payments, so recomputing their
    // balance from payment rows would wrongly flip them to a positive
    // balance. Leave them exactly as issued.
    if (inv.documentType === "credit_note") continue;
    const [paid] = await tx
      .select({
        total: sql<string>`COALESCE(SUM(${payments.amount}), 0)::text`,
      })
      .from(payments)
      .where(
        and(
          eq(payments.invoiceId, inv.id),
          eq(payments.voided, false),
          eq(payments.status, "received"),
        ),
      );
    const grand = Number(inv.grandTotal);
    const wallet = Number(inv.walletCreditApplied ?? 0);
    const collected = Number(paid?.total ?? 0) + wallet;
    const balance = +Math.max(0, grand - collected).toFixed(2);
    const status =
      balance <= 0.009 ? "paid" : collected > 0 ? "partial" : "issued";
    await tx
      .update(invoices)
      .set({
        totalPaid: collected.toFixed(2),
        balanceDue: balance.toFixed(2),
        status,
        updatedAt: new Date(),
      })
      .where(eq(invoices.id, inv.id));
  }
}

// Convenience wrapper: re-link any orphan (invoiceId IS NULL) payments
// on a reservation to a specific invoice, then recompute both invoice
// totals and reservation balance. Used at invoice-issue time so an
// advance collected before the invoice existed (the "Collected at
// check-out of SLDT-RES-XXXX" flow) lands on the right ledger.
// Distributes any orphan (invoice_id = NULL) payments on a reservation
// across its invoices proportionally to each invoice's remaining
// balance. Used at end-of-checkout to land the booking-time advance
// against the right invoices.
//
// Why proportional, not "all on one":
// In multi-room checkouts each room gets its own invoice. The advance
// taken at booking time is for the whole stay, so dumping it on a
// single invoice (the old behaviour) made INV-0001 look overpaid and
// INV-0002 look short by the advance amount — even though the
// reservation total was correct. Proportional split means each invoice
// reflects what it's actually owed.
//
// The fallback parameter is the legacy "all-on-one" target. Kept so
// the combined-invoice path (single invoice in the reservation) still
// works trivially — the proportional logic collapses to 100% on that
// one invoice — and so single-invoice reservations with stray
// reservation-level payments (refunds, manual entries) still have a
// concrete attach point.
export async function attachOrphanPaymentsAndRecompute(
  tx: Tx,
  reservationId: string,
  fallbackInvoiceId: string,
): Promise<void> {
  // 1. Pull every orphan payment for this reservation, in deterministic
  //    order (oldest first) so the distribution is repeatable. Notes
  //    come along so we can read a "Room NNN" hint where present.
  //    Method + propertyId + receivedBy are needed when we split a
  //    payment across invoices (one row can't straddle two invoices).
  const orphans = await tx
    .select({
      id: payments.id,
      amount: payments.amount,
      notes: payments.notes,
      receiptNumber: payments.receiptNumber,
      paymentMethod: payments.paymentMethod,
      propertyId: payments.propertyId,
      receivedBy: payments.receivedBy,
      paymentDate: payments.paymentDate,
    })
    .from(payments)
    .where(
      and(
        eq(payments.reservationId, reservationId),
        sql`${payments.invoiceId} IS NULL`,
        eq(payments.voided, false),
      ),
    )
    .orderBy(payments.createdAt);

  if (orphans.length === 0) {
    await recomputeInvoiceTotals(tx, reservationId);
    await recomputeReservationBalance(tx, reservationId);
    return;
  }

  // Money beyond what the existing invoices need is only an
  // "overpayment" once every room has its invoice. While non-cancelled
  // rooms are still awaiting theirs, the surplus is the advance for
  // those future per-room invoices and must STAY orphaned — parking it
  // on the fallback invoice would make the next room's checkout quote
  // find no advance and ask staff to collect the whole bill again.
  const [pendingRooms] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(reservationRooms)
    .where(
      and(
        eq(reservationRooms.reservationId, reservationId),
        sql`${reservationRooms.invoiceId} IS NULL`,
        sql`${reservationRooms.status} <> 'cancelled'`,
      ),
    );
  const keepSurplusOrphaned = (pendingRooms?.n ?? 0) > 0;

  // 2. Snapshot each invoice's owed amount (grand total minus what's
  //    already attached). Voided invoices are excluded. We work on a
  //    local copy so we can drain it as we allocate.
  // Only ordinary invoices that still expect money are candidates for
  // the orphan payment. Exclude:
  //   • credit notes (negative reversal docs, never hold payments), and
  //   • any invoice that HAS a credit note pointing at it — that
  //     original is fully settled and being reversed; its payment was
  //     just detached and must flow to the NEW invoices, not back here.
  const reversedRows = await tx
    .select({ id: invoices.creditNoteFor })
    .from(invoices)
    .where(
      and(
        eq(invoices.reservationId, reservationId),
        eq(invoices.documentType, "credit_note"),
        sql`${invoices.creditNoteFor} IS NOT NULL`,
      ),
    );
  const reversedOriginalIds = new Set(
    reversedRows.map((r) => r.id).filter((x): x is string => !!x),
  );
  const allInvs = await tx
    .select({
      id: invoices.id,
      grandTotal: invoices.grandTotal,
      walletCreditApplied: invoices.walletCreditApplied,
      scopeRoomIds: invoices.scopeRoomIds,
      documentType: invoices.documentType,
    })
    .from(invoices)
    .where(
      and(
        eq(invoices.reservationId, reservationId),
        sql`${invoices.status} <> 'voided'`,
      ),
    )
    .orderBy(invoices.createdAt);
  const invs = allInvs.filter(
    (i) => i.documentType !== "credit_note" && !reversedOriginalIds.has(i.id),
  );

  // Map "201" → invoice UUID so receipt notes that name a room can
  // route there directly. Built from invoices.scope_room_ids ⨯ rooms.
  const roomNumberToInvoice = new Map<string, string>();
  const allRoomIds = invs.flatMap((i) => i.scopeRoomIds ?? []);
  if (allRoomIds.length > 0) {
    const roomRows = await tx
      .select({ id: rooms.id, roomNumber: rooms.roomNumber })
      .from(rooms)
      .where(inArray(rooms.id, allRoomIds));
    const roomNumberById = new Map(roomRows.map((r) => [r.id, r.roomNumber]));
    for (const inv of invs) {
      for (const rid of inv.scopeRoomIds ?? []) {
        const num = roomNumberById.get(rid);
        if (num) roomNumberToInvoice.set(num, inv.id);
      }
    }
  }

  const owedByInv = new Map<string, number>();
  for (const inv of invs) {
    const [attached] = await tx
      .select({
        total: sql<string>`COALESCE(SUM(${payments.amount}), 0)::text`,
      })
      .from(payments)
      .where(
        and(
          eq(payments.invoiceId, inv.id),
          eq(payments.voided, false),
          eq(payments.status, "received"),
        ),
      );
    const owed = Math.max(
      0,
      Number(inv.grandTotal) -
        Number(inv.walletCreditApplied ?? 0) -
        Number(attached?.total ?? 0),
    );
    owedByInv.set(inv.id, +owed.toFixed(2));
  }

  // 3. Walk orphan payments oldest-first and allocate each across the
  //    invoices that need money. A single payment row can't span
  //    multiple invoices (the FK is on the row), so when a payment is
  //    larger than the first targeted invoice's need we SPLIT it:
  //    reduce the original row to the invoice's need and insert one
  //    new payment row per spill-over slice. Each new row carries a
  //    fresh receipt number and a note linking back to the original.
  //    The reservation-level sum is preserved exactly.
  for (const op of orphans) {
    const remaining = Number(op.amount);
    if (remaining <= 0.009) {
      // Zero-value receipt (e.g. "Booking — no advance collected"). Park
      // it on the fallback invoice so it's not left orphaned.
      await tx
        .update(payments)
        .set({ invoiceId: fallbackInvoiceId })
        .where(eq(payments.id, op.id));
      continue;
    }

    // Build the allocation plan first (no writes), so we know how many
    // parts the payment will end up as before we touch any row.
    // invoiceId: null means "keep this slice orphaned" (advance held
    // back for rooms that don't have their invoice yet).
    const plan: { invoiceId: string | null; amount: number }[] = [];
    let toPlace = remaining;

    // Preferred first hop: the invoice whose room number appears in
    // the receipt notes. Keeps "Per-room share of check-out collection
    // (Room 202)" landing on Room 202's invoice.
    const hint = op.notes?.match(/Room (\d+)/i);
    if (hint) {
      const hintedInvId = roomNumberToInvoice.get(hint[1]!);
      const owed = hintedInvId ? owedByInv.get(hintedInvId) ?? 0 : 0;
      if (hintedInvId && owed > 0.009) {
        const consumed = Math.min(toPlace, owed);
        plan.push({ invoiceId: hintedInvId, amount: consumed });
        owedByInv.set(hintedInvId, +(owed - consumed).toFixed(2));
        toPlace = +(toPlace - consumed).toFixed(2);
      }
    }
    // Greedy fill of remaining invoices in creation order.
    for (const [invId, owed] of owedByInv) {
      if (toPlace <= 0.009) break;
      if (owed <= 0.009) continue;
      const consumed = Math.min(toPlace, owed);
      plan.push({ invoiceId: invId, amount: consumed });
      owedByInv.set(invId, +(owed - consumed).toFixed(2));
      toPlace = +(toPlace - consumed).toFixed(2);
    }
    // Anything left over after every invoice is satisfied: if rooms are
    // still awaiting their invoices, it's their advance — keep it
    // orphaned (the whole row, when nothing was allocated from it).
    // Otherwise it's a genuine over-payment; park it on the fallback so
    // the row keeps a home — recomputeInvoiceTotals will clamp the
    // invoice balance at 0 and expose the surplus via the reservation's
    // advance_paid > grand_total.
    if (toPlace > 0.009) {
      if (keepSurplusOrphaned) {
        if (plan.length === 0) continue;
        plan.push({ invoiceId: null, amount: toPlace });
      } else {
        plan.push({ invoiceId: fallbackInvoiceId, amount: toPlace });
      }
      toPlace = 0;
    }

    if (plan.length === 0) {
      // Defensive: no invoices at all. Park on fallback.
      await tx
        .update(payments)
        .set({ invoiceId: fallbackInvoiceId })
        .where(eq(payments.id, op.id));
      continue;
    }

    // Apply the plan. The first slice updates the original row in
    // place (preserving its receipt number, created_at, etc.). Each
    // additional slice is a NEW payment row with a fresh receipt
    // number and a note pointing back to the original receipt.
    const total = plan.length;
    const first = plan[0]!;
    const baseNote = op.notes ?? "";
    const firstNote =
      total === 1
        ? op.notes
        : baseNote
          ? `${baseNote} · part 1/${total}`
          : `Part 1/${total}`;
    await tx
      .update(payments)
      .set({
        invoiceId: first.invoiceId,
        amount: String(first.amount.toFixed(2)),
        notes: firstNote,
      })
      .where(eq(payments.id, op.id));

    for (let i = 1; i < plan.length; i++) {
      const slice = plan[i]!;
      const rcpNum = await generateReceiptNumber(tx);
      const splitNote = baseNote
        ? `${baseNote} · part ${i + 1}/${total} (split from ${op.receiptNumber})`
        : `Part ${i + 1}/${total} (split from ${op.receiptNumber})`;
      await tx.insert(payments).values({
        receiptNumber: rcpNum,
        propertyId: op.propertyId,
        invoiceId: slice.invoiceId,
        reservationId,
        amount: String(slice.amount.toFixed(2)),
        paymentMethod: op.paymentMethod,
        status: "received",
        receivedBy: op.receivedBy,
        paymentDate: op.paymentDate,
        notes: splitNote,
      });
    }
  }

  await recomputeInvoiceTotals(tx, reservationId);
  await recomputeReservationBalance(tx, reservationId);
}
