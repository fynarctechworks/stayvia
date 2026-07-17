import { editInvoiceSchema } from "@hoteldesk/shared";
import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Router } from "express";
import { db } from "../db/client.js";
import { guests } from "../db/schema/guests.js";
import { invoiceLineItems, invoices, payments } from "../db/schema/invoices.js";
import { profiles } from "../db/schema/profiles.js";
import { reservationRooms, reservations } from "../db/schema/reservations.js";
import { rooms } from "../db/schema/rooms.js";
import { logActivity } from "../lib/activity.js";
import { loadGuestExtra } from "../lib/guestExtra.js";
import { propertyDayEnd, propertyDayStart } from "../lib/propertyTime.js";
import { renderInvoicePdf } from "../lib/pdf.js";
import { recomputeReservationBalance } from "../lib/reservationBalance.js";
import { invalidateDashboard } from "../lib/redis.js";
import { getSettings } from "../lib/settings.js";
import { fail, list, ok } from "../lib/response.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";
import { resolveInvoiceId } from "../middleware/resolveInvoice.js";
import { validate } from "../middleware/validate.js";

const router = Router();

// Accept either the UUID or SLDT-INV-NNNN on every :id route. The
// PDF preview URL building on the frontend uses the human number so
// links can be shared without leaking UUIDs.
router.param("id", resolveInvoiceId as never);

router.get("/", requireAuth, requirePermission("view_invoices"), async (req, res) => {
  const { status, date_from, date_to, scope, q } = req.query as Record<
    string,
    string | undefined
  >;
  const page = Math.max(1, Number(req.query.page ?? 1));
  const per_page = Math.min(100, Math.max(1, Number(req.query.per_page ?? 25)));

  const conditions = [];
  // Invoices belonging to complimentary reservations are hidden from
  // the Invoices page — they live only in the Complimentary report.
  conditions.push(
    sql`NOT EXISTS (
      SELECT 1 FROM ${reservations} rc
      WHERE rc.id = ${invoices.reservationId}
        AND rc.booking_source = 'complimentary')`,
  );
  if (status) conditions.push(eq(invoices.status, status as never));
  if (date_from) conditions.push(gte(invoices.createdAt, propertyDayStart(date_from)));
  if (date_to) conditions.push(lte(invoices.createdAt, propertyDayEnd(date_to)));
  if (scope) conditions.push(eq(invoices.scope, scope as never));
  if (q && q.trim()) {
    // Match invoice number, billed-to guest name, or guest GSTIN. The
    // reservation number is fetched via a sub-query so the search hits
    // common front-desk shorthand like "RES-0042" too.
    const needle = `%${q.trim()}%`;
    conditions.push(
      sql`(
        ${invoices.invoiceNumber} ILIKE ${needle}
        OR ${invoices.guestName} ILIKE ${needle}
        OR COALESCE(${invoices.guestGstin}, '') ILIKE ${needle}
        OR EXISTS (
          SELECT 1 FROM ${reservations} r2
          WHERE r2.id = ${invoices.reservationId}
            AND r2.reservation_number ILIKE ${needle}
        )
      )`,
    );
  }

  const where = conditions.length ? and(...conditions) : undefined;
  const [rows, total] = await Promise.all([
    db
      .select({
        // Pull the reservation number alongside so the UI can show it
        // without a per-row round-trip.
        id: invoices.id,
        invoiceNumber: invoices.invoiceNumber,
        reservationId: invoices.reservationId,
        reservationNumber: reservations.reservationNumber,
        guestId: invoices.guestId,
        guestName: invoices.guestName,
        guestGstin: invoices.guestGstin,
        subtotal: invoices.subtotal,
        grandTotal: invoices.grandTotal,
        totalPaid: invoices.totalPaid,
        balanceDue: invoices.balanceDue,
        status: invoices.status,
        scope: invoices.scope,
        scopeRoomIds: invoices.scopeRoomIds,
        createdAt: invoices.createdAt,
      })
      .from(invoices)
      .leftJoin(reservations, eq(reservations.id, invoices.reservationId))
      .where(where)
      .orderBy(desc(invoices.createdAt))
      .limit(per_page)
      .offset((page - 1) * per_page),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(invoices)
      .leftJoin(reservations, eq(reservations.id, invoices.reservationId))
      .where(where),
  ]);

  return list(res, rows, { total: total[0]?.count ?? 0, page, per_page });
});

// Totals across ALL invoices matching the filters — not just the current
// page. Mirrors the filter logic in `GET /` exactly so the summary tiles
// on the Reports → Invoices tab stay accurate as staff paginate.
router.get("/summary", requireAuth, requirePermission("view_invoices"), async (req, res) => {
  const { status, date_from, date_to, scope, q } = req.query as Record<
    string,
    string | undefined
  >;

  const conditions = [];
  // Comp invoices are hidden from the Invoices page (see GET / above).
  conditions.push(
    sql`NOT EXISTS (
      SELECT 1 FROM ${reservations} rc
      WHERE rc.id = ${invoices.reservationId}
        AND rc.booking_source = 'complimentary')`,
  );
  if (status) conditions.push(eq(invoices.status, status as never));
  if (date_from) conditions.push(gte(invoices.createdAt, propertyDayStart(date_from)));
  if (date_to) conditions.push(lte(invoices.createdAt, propertyDayEnd(date_to)));
  if (scope) conditions.push(eq(invoices.scope, scope as never));
  if (q && q.trim()) {
    const needle = `%${q.trim()}%`;
    conditions.push(
      sql`(
        ${invoices.invoiceNumber} ILIKE ${needle}
        OR ${invoices.guestName} ILIKE ${needle}
        OR COALESCE(${invoices.guestGstin}, '') ILIKE ${needle}
        OR EXISTS (
          SELECT 1 FROM ${reservations} r2
          WHERE r2.id = ${invoices.reservationId}
            AND r2.reservation_number ILIKE ${needle}
        )
      )`,
    );
  }

  const where = conditions.length ? and(...conditions) : undefined;
  // Voided invoices are excluded from EVERY money column (gross/paid/
  // wallet/owing) so the identity holds: gross = paid + walletCredit
  // + owing. Without the voided guard on `paid`, a refunded-then-voided
  // invoice would inflate Collected and break the math (which is what
  // produced the "Collected > Gross Billed" bug). Row count keeps voided
  // in so staff still see them on the page.
  const [agg] = await db
    .select({
      count: sql<number>`count(*)::int`,
      countVoided: sql<number>`COALESCE(SUM(CASE WHEN ${invoices.status} = 'voided' THEN 1 ELSE 0 END), 0)::int`,
      gross: sql<string>`COALESCE(SUM(CASE WHEN ${invoices.status} = 'voided' THEN 0 ELSE ${invoices.grandTotal} END), 0)::text`,
      paid: sql<string>`COALESCE(SUM(CASE WHEN ${invoices.status} = 'voided' THEN 0 ELSE ${invoices.totalPaid} END), 0)::text`,
      walletCredit: sql<string>`COALESCE(SUM(CASE WHEN ${invoices.status} = 'voided' THEN 0 ELSE ${invoices.walletCreditApplied} END), 0)::text`,
      owing: sql<string>`COALESCE(SUM(CASE WHEN ${invoices.status} = 'voided' THEN 0 ELSE ${invoices.balanceDue} END), 0)::text`,
    })
    .from(invoices)
    .leftJoin(reservations, eq(reservations.id, invoices.reservationId))
    .where(where);

  return ok(res, {
    count: agg?.count ?? 0,
    countVoided: agg?.countVoided ?? 0,
    gross: agg?.gross ?? "0",
    paid: agg?.paid ?? "0",
    walletCredit: agg?.walletCredit ?? "0",
    owing: agg?.owing ?? "0",
  });
});

// Full-detail export. Returns every invoice matching the filters
// (no pagination) joined with its reservation, primary guest, rooms,
// line items, and payments — flattened so the UI can drop it straight
// into a CSV. CA-grade detail: every field that ends up on the printed
// invoice is here, plus audit fields (issued-by, voided-by, reissue
// chain) that aren't on the bill but matter for reconciliation.
router.get("/export", requireAuth, requirePermission("view_invoices"), async (req, res) => {
  try {
  const { status, date_from, date_to, scope, q } = req.query as Record<
    string,
    string | undefined
  >;

  const conditions = [];
  // Comp invoices are hidden from the export too (see GET / above).
  conditions.push(
    sql`NOT EXISTS (
      SELECT 1 FROM ${reservations} rc
      WHERE rc.id = ${invoices.reservationId}
        AND rc.booking_source = 'complimentary')`,
  );
  if (status) conditions.push(eq(invoices.status, status as never));
  if (date_from) conditions.push(gte(invoices.createdAt, propertyDayStart(date_from)));
  if (date_to) conditions.push(lte(invoices.createdAt, propertyDayEnd(date_to)));
  if (scope) conditions.push(eq(invoices.scope, scope as never));
  if (q && q.trim()) {
    const needle = `%${q.trim()}%`;
    conditions.push(
      sql`(
        ${invoices.invoiceNumber} ILIKE ${needle}
        OR ${invoices.guestName} ILIKE ${needle}
        OR COALESCE(${invoices.guestGstin}, '') ILIKE ${needle}
        OR EXISTS (
          SELECT 1 FROM ${reservations} r2
          WHERE r2.id = ${invoices.reservationId}
            AND r2.reservation_number ILIKE ${needle}
        )
      )`,
    );
  }

  const where = conditions.length ? and(...conditions) : undefined;

  // Self-join twice on profiles — once for the staff member who issued
  // the invoice, once for the one who voided it (if applicable). Drizzle's
  // `alias()` lets us reference the same table twice in one query.
  const issuer = alias(profiles, "issuer");
  const voider = alias(profiles, "voider");

  // Pull invoices + reservation + guest + issuer/voider in one query.
  // 5000-row safety cap — at one invoice per night per room for a
  // small property, that's many years of history. If the property
  // grows past this, the CSV should be paginated server-side via
  // streaming, but we're nowhere near that scale.
  const baseRows = await db
    .select({
      id: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      issueDate: invoices.issueDate,
      createdAt: invoices.createdAt,
      updatedAt: invoices.updatedAt,
      status: invoices.status,
      scope: invoices.scope,
      scopeRoomIds: invoices.scopeRoomIds,
      reissuedFrom: invoices.reissuedFrom,
      notes: invoices.notes,
      voidedReason: invoices.voidedReason,
      hotelName: invoices.hotelName,
      hotelAddress: invoices.hotelAddress,
      hotelGstin: invoices.hotelGstin,
      billedToName: invoices.guestName,
      billedToAddress: invoices.guestAddress,
      billedToGstin: invoices.guestGstin,
      subtotal: invoices.subtotal,
      cgstRate: invoices.cgstRate,
      cgstAmount: invoices.cgstAmount,
      sgstRate: invoices.sgstRate,
      sgstAmount: invoices.sgstAmount,
      grandTotal: invoices.grandTotal,
      walletCreditApplied: invoices.walletCreditApplied,
      totalPaid: invoices.totalPaid,
      balanceDue: invoices.balanceDue,
      reservationId: invoices.reservationId,
      reservationNumber: reservations.reservationNumber,
      checkInDate: reservations.checkInDate,
      checkOutDate: reservations.checkOutDate,
      numNights: reservations.numNights,
      stayType: reservations.stayType,
      durationHours: reservations.durationHours,
      numAdults: reservations.numAdults,
      numChildren: reservations.numChildren,
      bookingSource: reservations.bookingSource,
      guestId: guests.id,
      guestName: guests.fullName,
      guestPhone: guests.phone,
      guestEmail: guests.email,
      guestGender: guests.gender,
      guestNationality: guests.nationality,
      guestAddress: guests.address,
      guestCity: guests.city,
      guestState: guests.state,
      guestIdProofType: guests.idProofType,
      guestIdProofLast4: guests.idProofLast4,
      issuedByName: issuer.fullName,
      issuedByEmail: issuer.email,
      voidedByName: voider.fullName,
    })
    .from(invoices)
    .leftJoin(reservations, eq(reservations.id, invoices.reservationId))
    .leftJoin(guests, eq(guests.id, invoices.guestId))
    .leftJoin(issuer, eq(issuer.id, invoices.issuedBy))
    .leftJoin(voider, eq(voider.id, invoices.voidedBy))
    .where(where)
    .orderBy(desc(invoices.createdAt))
    .limit(5000);

  const invoiceIds = baseRows.map((r) => r.id);
  const reservationIds = Array.from(
    new Set(
      baseRows
        .map((r) => r.reservationId)
        .filter((id): id is string => !!id),
    ),
  );

  // Line items, payments, and rooms in three separate queries — cheaper
  // than a Cartesian product join. We then group them in JS by parent id.
  const [lineItemRows, paymentRows, roomRows] = await Promise.all([
    invoiceIds.length
      ? db
          .select()
          .from(invoiceLineItems)
          .where(inArray(invoiceLineItems.invoiceId, invoiceIds))
      : Promise.resolve([] as Array<typeof invoiceLineItems.$inferSelect>),
    invoiceIds.length
      ? db
          .select({
            invoiceId: payments.invoiceId,
            receiptNumber: payments.receiptNumber,
            amount: payments.amount,
            method: payments.paymentMethod,
            status: payments.status,
            paymentDate: payments.paymentDate,
            voided: payments.voided,
            notes: payments.notes,
          })
          .from(payments)
          .where(
            and(
              inArray(payments.invoiceId, invoiceIds),
              eq(payments.voided, false),
            ),
          )
          .orderBy(desc(payments.paymentDate))
      : Promise.resolve([] as Array<{
          invoiceId: string | null;
          receiptNumber: string | null;
          amount: string;
          method: string;
          status: string;
          paymentDate: Date;
          voided: boolean;
          notes: string | null;
        }>),
    reservationIds.length
      ? db
          .select({
            reservationId: reservationRooms.reservationId,
            roomNumber: rooms.roomNumber,
            roomType: rooms.roomType,
            floor: rooms.floor,
            roomId: rooms.id,
          })
          .from(reservationRooms)
          .innerJoin(rooms, eq(rooms.id, reservationRooms.roomId))
          .where(inArray(reservationRooms.reservationId, reservationIds))
      : Promise.resolve([] as Array<{
          reservationId: string;
          roomNumber: string;
          roomType: string;
          floor: number;
          roomId: string;
        }>),
  ]);

  // Bucket lookups for the merge below.
  const linesByInvoice = new Map<string, typeof lineItemRows>();
  for (const li of lineItemRows) {
    const arr = linesByInvoice.get(li.invoiceId) ?? [];
    arr.push(li);
    linesByInvoice.set(li.invoiceId, arr);
  }
  const paysByInvoice = new Map<string, typeof paymentRows>();
  for (const p of paymentRows) {
    if (!p.invoiceId) continue;
    const arr = paysByInvoice.get(p.invoiceId) ?? [];
    arr.push(p);
    paysByInvoice.set(p.invoiceId, arr);
  }
  const roomsByReservation = new Map<string, typeof roomRows>();
  for (const rm of roomRows) {
    const arr = roomsByReservation.get(rm.reservationId) ?? [];
    arr.push(rm);
    roomsByReservation.set(rm.reservationId, arr);
  }

  // Flatten — one row per invoice with aggregated child data inlined.
  // Multi-value fields (room numbers, line items, payments) are joined
  // with " | " so Excel keeps them in a single cell.
  const flat = baseRows.map((r) => {
    const myLines = linesByInvoice.get(r.id) ?? [];
    const myPays = paysByInvoice.get(r.id) ?? [];
    const myRoomsAll = r.reservationId
      ? (roomsByReservation.get(r.reservationId) ?? [])
      : [];

    // For per-room invoices, narrow to the rooms in scope. Combined
    // invoices cover every room on the reservation.
    const inScopeRoomIds = new Set(r.scopeRoomIds ?? []);
    const myRooms =
      r.scope === "room" && inScopeRoomIds.size > 0
        ? myRoomsAll.filter((rm) => inScopeRoomIds.has(rm.roomId))
        : myRoomsAll;

    const roomCharges = myLines
      .filter((li) => li.itemType === "room_charge")
      .reduce((s, li) => s + Number(li.amount), 0);
    const addlCharges = myLines
      .filter((li) => li.itemType === "additional_charge")
      .reduce((s, li) => s + Number(li.amount), 0);

    const lineSummary = myLines
      .map(
        (li) =>
          `${li.description} (qty ${li.quantity} @ ${li.rate}, ${li.gstRate}% GST = ${li.amount})`,
      )
      .join(" | ");

    const paymentSummary = myPays
      .map(
        (p) =>
          `${p.receiptNumber ?? "—"} ${p.method} ${p.amount} on ${new Date(p.paymentDate).toISOString().slice(0, 10)}`,
      )
      .join(" | ");
    const methods = Array.from(new Set(myPays.map((p) => p.method))).join(", ");
    const lastPay = myPays[0]; // already ordered desc

    return {
      // --- Identity
      invoice_number: r.invoiceNumber,
      invoice_id: r.id,
      status: r.status,
      scope: r.scope,
      reissued_from: r.reissuedFrom ?? "",
      issue_date: r.issueDate ?? "",
      created_at: r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt,
      updated_at: r.updatedAt instanceof Date ? r.updatedAt.toISOString() : r.updatedAt,

      // --- Reservation
      reservation_number: r.reservationNumber ?? "",
      check_in_date: r.checkInDate ?? "",
      check_out_date: r.checkOutDate ?? "",
      num_nights: r.numNights ?? 0,
      stay_type: r.stayType ?? "",
      duration_hours: r.durationHours ?? "",
      num_adults: r.numAdults ?? 0,
      num_children: r.numChildren ?? 0,
      booking_source: r.bookingSource ?? "",

      // --- Rooms on this invoice
      room_numbers: myRooms.map((rm) => rm.roomNumber).join(", "),
      room_types: Array.from(new Set(myRooms.map((rm) => rm.roomType))).join(", "),
      room_count: myRooms.length,

      // --- Bill-to (frozen on invoice)
      billed_to_name: r.billedToName,
      billed_to_address: r.billedToAddress ?? "",
      billed_to_gstin: r.billedToGstin ?? "",

      // --- Primary guest (live record)
      guest_name: r.guestName ?? "",
      guest_phone: r.guestPhone ?? "",
      guest_email: r.guestEmail ?? "",
      guest_gender: r.guestGender ?? "",
      guest_nationality: r.guestNationality ?? "",
      guest_address: r.guestAddress ?? "",
      guest_city: r.guestCity ?? "",
      guest_state: r.guestState ?? "",
      guest_id_proof_type: r.guestIdProofType ?? "",
      // Last 4 digits only — IDs are encrypted at rest for DPDP compliance.
      // Staff with the right permission can decrypt via the guest profile.
      guest_id_proof_last4: r.guestIdProofLast4 ? `XXXX${r.guestIdProofLast4}` : "",

      // --- Hotel
      hotel_name: r.hotelName,
      hotel_address: r.hotelAddress,
      hotel_gstin: r.hotelGstin,

      // --- Money
      subtotal: r.subtotal,
      cgst_rate: r.cgstRate,
      cgst_amount: r.cgstAmount,
      sgst_rate: r.sgstRate,
      sgst_amount: r.sgstAmount,
      total_gst: (Number(r.cgstAmount) + Number(r.sgstAmount)).toFixed(2),
      grand_total: r.grandTotal,
      wallet_credit_applied: r.walletCreditApplied,
      total_paid: r.totalPaid,
      balance_due: r.balanceDue,

      // --- Line items
      line_items_count: myLines.length,
      room_charges_total: roomCharges.toFixed(2),
      additional_charges_total: addlCharges.toFixed(2),
      line_items_summary: lineSummary,

      // --- Payments
      payments_count: myPays.length,
      payment_methods: methods,
      last_payment_date: lastPay
        ? new Date(lastPay.paymentDate).toISOString()
        : "",
      last_payment_amount: lastPay ? lastPay.amount : "",
      payments_summary: paymentSummary,

      // --- Audit
      issued_by_name: r.issuedByName ?? "",
      issued_by_email: r.issuedByEmail ?? "",
      voided_by_name: r.voidedByName ?? "",
      voided_reason: r.voidedReason ?? "",
      notes: r.notes ?? "",
    };
  });

  return ok(res, { rows: flat, count: flat.length });
  } catch (err) {
    // Log the actual cause server-side, surface a generic error to the
    // client. Without this catch, a bad query was crashing the whole
    // API process (uncaught promise rejection took out nodemon).
    req.log?.error({ err }, "invoice export failed");
    return fail(res, 500, "EXPORT_FAILED", "Could not build invoice export");
  }
});

router.get("/:id", requireAuth, requirePermission("view_invoices"), async (req, res) => {
  const id = req.params.id!;
  const inv = await db.select().from(invoices).where(eq(invoices.id, id)).limit(1);
  if (!inv.length) return fail(res, 404, "NOT_FOUND", "Invoice not found");
  const [items, pays, [resRow]] = await Promise.all([
    db.select().from(invoiceLineItems).where(eq(invoiceLineItems.invoiceId, id)),
    db.select().from(payments).where(eq(payments.invoiceId, id)).orderBy(desc(payments.paymentDate)),
    db.select().from(reservations).where(eq(reservations.id, inv[0]!.reservationId)).limit(1),
  ]);
  return ok(res, {
    ...inv[0],
    lineItems: items,
    payments: pays,
    // Surface the reservation's stay dates so the invoice editor can
    // display + modify them without a separate fetch.
    checkInDate: resRow?.checkInDate ?? null,
    checkOutDate: resRow?.checkOutDate ?? null,
    numNights: resRow ? Number(resRow.numNights) : null,
  });
});

router.get("/:id/pdf", requireAuth, requirePermission("view_invoices"), async (req, res) => {
  const id = req.params.id!;
  const inv = await db.select().from(invoices).where(eq(invoices.id, id)).limit(1);
  if (!inv.length) return fail(res, 404, "NOT_FOUND", "Invoice not found");
  const [items, pays, [resRow]] = await Promise.all([
    db.select().from(invoiceLineItems).where(eq(invoiceLineItems.invoiceId, id)),
    db.select().from(payments).where(eq(payments.invoiceId, id)),
    db.select().from(reservations).where(eq(reservations.id, inv[0]!.reservationId)).limit(1),
  ]);
  const settings = await getSettings();
  const companionCollections = await collectCompanionCollections(inv[0]!.reservationId, id);
  const guestExtra = await loadGuestExtra(inv[0]!.reservationId);
  const pdf = await renderInvoicePdf({
    invoice: inv[0]!,
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
          // 0023 — pass staff-chosen planned times so the invoice's
          // Stay block prints the promised window instead of the
          // generic hotel policy.
          plannedCheckInAt: resRow.plannedCheckInAt
            ? resRow.plannedCheckInAt.toISOString()
            : null,
          plannedCheckOutAt: resRow.plannedCheckOutAt
            ? resRow.plannedCheckOutAt.toISOString()
            : null,
        }
      : undefined,
    guestExtra,
    companionCollections,
  });
  const inline = req.query.disposition === "inline";
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `${inline ? "inline" : "attachment"}; filename="${inv[0]!.invoiceNumber}.pdf"`,
  );
  return res.send(pdf);
});

// ---- Room-wise bill splits (money/paperwork split) --------------------
// A combined tax invoice is the single money/GST record for the stay.
// These endpoints render PRESENTATION-ONLY per-room bills from it, for
// guests who want a room-by-room breakdown (e.g. a company splitting
// cost). They create no DB rows, no new invoice numbers, no GST — they
// just re-cut the parent invoice's line items by room.

// Which rooms can this invoice be split into? Derived from its
// room_charge line items (each names "Room <number> - …").
router.get(
  "/:id/room-bill-options",
  requireAuth,
  requirePermission("view_invoices"),
  async (req, res) => {
    const id = req.params.id!;
    const inv = await db.select().from(invoices).where(eq(invoices.id, id)).limit(1);
    if (!inv.length) return fail(res, 404, "NOT_FOUND", "Invoice not found");
    const items = await db
      .select()
      .from(invoiceLineItems)
      .where(eq(invoiceLineItems.invoiceId, id));
    const roomNumbers = Array.from(
      new Set(
        items
          .map((li) => li.description.match(/^Room (\S+)/i)?.[1])
          .filter((n): n is string => !!n),
      ),
    );
    return ok(res, {
      invoiceNumber: inv[0]!.invoiceNumber,
      roomNumbers,
      // Splitting only makes sense for a multi-room bill.
      splittable: roomNumbers.length >= 2,
    });
  },
);

// Render ONE room's presentation bill from the parent invoice.
router.get(
  "/:id/room-bill/:roomNumber/pdf",
  requireAuth,
  requirePermission("view_invoices"),
  async (req, res) => {
    const id = req.params.id!;
    const roomNumber = req.params.roomNumber!;
    const inv = await db.select().from(invoices).where(eq(invoices.id, id)).limit(1);
    if (!inv.length) return fail(res, 404, "NOT_FOUND", "Invoice not found");
    const invoice = inv[0]!;

    const [allItems, [resRow]] = await Promise.all([
      db.select().from(invoiceLineItems).where(eq(invoiceLineItems.invoiceId, id)),
      db.select().from(reservations).where(eq(reservations.id, invoice.reservationId)).limit(1),
    ]);

    // This room's lines = its room_charge line(s). Reservation-wide
    // additional charges (no room in the description) stay on the parent
    // invoice only — we don't arbitrarily assign shared charges to one
    // room's split.
    const roomItems = allItems.filter((li) => {
      const m = li.description.match(/^Room (\S+)/i);
      return m?.[1] === roomNumber;
    });
    if (roomItems.length === 0) {
      return fail(
        res,
        404,
        "ROOM_NOT_ON_INVOICE",
        `Room ${roomNumber} has no charges on ${invoice.invoiceNumber}.`,
      );
    }

    // Recompute this room's totals from its own lines. GST split CGST/SGST
    // half-and-half, mirroring how the parent invoice was built.
    const subtotal = +roomItems.reduce((s, li) => s + Number(li.amount), 0).toFixed(2);
    const totalGst = +roomItems.reduce((s, li) => s + Number(li.gstAmount), 0).toFixed(2);
    const cgst = +(totalGst / 2).toFixed(2);
    const sgst = +(totalGst - cgst).toFixed(2);
    const grandTotal = +(subtotal + totalGst).toFixed(2);

    // Synthetic invoice object — same shape the renderer expects, with
    // this room's money. NOT persisted; purely for the PDF.
    const roomInvoice: typeof invoice = {
      ...invoice,
      subtotal: String(subtotal),
      cgstAmount: String(cgst),
      sgstAmount: String(sgst),
      grandTotal: String(grandTotal),
      // A presentation split shows no payment ledger / balance of its
      // own — the money lives on the parent invoice.
      totalPaid: "0.00",
      walletCreditApplied: "0.00",
      balanceDue: "0.00",
    };

    const settings = await getSettings();
    const guestExtra = await loadGuestExtra(invoice.reservationId);
    const pdf = await renderInvoicePdf({
      invoice: roomInvoice,
      lineItems: roomItems,
      payments: [], // no payment table on a split
      settings,
      stay: resRow
        ? {
            checkInDate: resRow.checkInDate,
            checkOutDate: resRow.checkOutDate,
            numNights: Number(resRow.numNights),
            checkedInAt: resRow.checkedInAt ? resRow.checkedInAt.toISOString() : null,
            plannedCheckInAt: resRow.plannedCheckInAt
              ? resRow.plannedCheckInAt.toISOString()
              : null,
            plannedCheckOutAt: resRow.plannedCheckOutAt
              ? resRow.plannedCheckOutAt.toISOString()
              : null,
          }
        : undefined,
      guestExtra,
      roomBill: {
        roomLabel: `Room ${roomNumber}`,
        parentInvoiceNumber: invoice.invoiceNumber,
      },
    });
    const inline = req.query.disposition === "inline";
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `${inline ? "inline" : "attachment"}; filename="${invoice.invoiceNumber}-Room-${roomNumber}.pdf"`,
    );
    return res.send(pdf);
  },
);

// Looks up other bookings that were settled at the same desk visit as
// this reservation's check-out. The "Collect previous balance" flow
// records payments with notes = "Collected at check-out of <thisResId>".
// Those payments may EITHER target an existing invoice (older paid-off
// stay) OR a pre-invoice reservation (active stay not checked out yet).
// We join via the payment's reservationId (always present) and LEFT JOIN
// invoices so pre-invoice rows aren't filtered out. The footer shows the
// invoice number when one exists, otherwise the reservation number.
async function collectCompanionCollections(
  reservationId: string,
  thisInvoiceId: string,
): Promise<
  { invoiceNumber: string | null; reservationNumber: string; amount: string }[]
> {
  // We accept two marker formats:
  //   - "Collected at check-out of SLDT-RES-XXXX" (new — human-readable)
  //   - "Collected at check-out of <uuid>"       (legacy — old payments)
  // Look up the reservation number so we can match the new format.
  const [thisRes] = await db
    .select({ reservationNumber: reservations.reservationNumber })
    .from(reservations)
    .where(eq(reservations.id, reservationId))
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
        eq(payments.voided, false),
        newMarker
          ? sql`${payments.notes} IN (${legacyMarker}, ${newMarker})`
          : eq(payments.notes, legacyMarker),
        // Belt-and-braces: skip rows accidentally pointing at this same invoice.
        sql`(${invoices.id} IS NULL OR ${invoices.id} <> ${thisInvoiceId})`,
      ),
    );
  // Sum per source-reservation in case multiple FIFO slices landed on the
  // same target. Keying by reservationId (not invoiceId) so pre-invoice
  // rows group correctly.
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

// In-place edit of an issued invoice. Lets staff fix anything on the bill
// without spawning a new invoice number — like the receipt edit, but for
// the invoice. Voided invoices are still rejected (nothing to edit).
//
// The full before/after is captured in activity_log so a CA can reconstruct
// the original state from the audit trail.
router.patch(
  "/:id",
  requireAuth,
  requirePermission("reissue_invoices"),
  validate(editInvoiceSchema),
  async (req, res) => {
    const id = req.params.id!;
    const input = req.body as {
      issueDate?: string;
      notes?: string | null;
      guestName?: string;
      guestAddress?: string | null;
      guestGstin?: string | null;
      checkInDate?: string;
      checkOutDate?: string;
      lineItems?: Array<{
        description: string;
        sacCode: string;
        quantity: number;
        rate: number;
        gstRate: number;
        itemType: "room_charge" | "additional_charge";
      }>;
    };

    const inv = await db.select().from(invoices).where(eq(invoices.id, id)).limit(1);
    if (!inv.length) return fail(res, 404, "NOT_FOUND", "Invoice not found");
    if (inv[0]!.status === "voided") {
      return fail(res, 400, "VOIDED", "Invoice is voided");
    }
    // Paid invoices are immutable. Phase 1 promise: once balance_due
    // hits zero and the invoice flips to status='paid', the document
    // is locked. To correct a paid invoice, staff must Void → Reissue,
    // which produces a brand-new invoice number with a clean audit
    // trail and leaves the original payment record intact.
    //
    // The narrow exception is the `notes` field. Internal notes can
    // still be appended (e.g. "Customer queried on 12-May, resolved
    // 13-May") since they don't change the financial position. Every
    // other key is rejected.
    if (inv[0]!.status === "paid") {
      const onlyNotes =
        Object.keys(req.body ?? {}).length > 0 &&
        Object.keys(req.body ?? {}).every((k) => k === "notes");
      if (!onlyNotes) {
        return fail(
          res,
          409,
          "INVOICE_LOCKED",
          "Paid invoices are immutable. Void & reissue to correct it.",
        );
      }
    }

    const original = inv[0]!;
    const beforeSnapshot = {
      subtotal: original.subtotal,
      cgstAmount: original.cgstAmount,
      sgstAmount: original.sgstAmount,
      grandTotal: original.grandTotal,
      balanceDue: original.balanceDue,
      status: original.status,
      notes: original.notes,
      guestName: original.guestName,
      guestAddress: original.guestAddress,
      guestGstin: original.guestGstin,
      issueDate: original.issueDate,
    };

    const updated = await db.transaction(async (tx) => {
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (input.issueDate !== undefined) patch.issueDate = input.issueDate;
      if (input.notes !== undefined) patch.notes = input.notes;
      if (input.guestName !== undefined) patch.guestName = input.guestName;
      if (input.guestAddress !== undefined) patch.guestAddress = input.guestAddress;
      if (input.guestGstin !== undefined) patch.guestGstin = input.guestGstin;

      // Replace line items + recompute totals when provided.
      if (input.lineItems) {
        // Delete old line items first. Cascade isn't enough — we want to
        // be explicit about the replacement.
        await tx.delete(invoiceLineItems).where(eq(invoiceLineItems.invoiceId, id));

        let subtotal = 0;
        let totalCgst = 0;
        let totalSgst = 0;
        const newRows = input.lineItems.map((li) => {
          const amount = +(li.rate * li.quantity).toFixed(2);
          // CGST + SGST split equally from the line's GST rate. Same model
          // as initial invoice creation.
          const gstAmount = +(amount * (li.gstRate / 100)).toFixed(2);
          const halfGst = +(gstAmount / 2).toFixed(2);
          subtotal += amount;
          totalCgst += halfGst;
          totalSgst += halfGst;
          return {
            invoiceId: id,
            description: li.description,
            sacCode: li.sacCode,
            quantity: li.quantity,
            rate: String(li.rate),
            amount: String(amount),
            gstRate: String(li.gstRate),
            gstAmount: String(gstAmount),
            itemType: li.itemType,
          };
        });
        if (newRows.length) {
          await tx.insert(invoiceLineItems).values(newRows);
        }
        const grandTotal = +(subtotal + totalCgst + totalSgst).toFixed(2);
        // Use the original cgst/sgst RATE (most lines share one). If the
        // line items disagree we just store the effective totals; rate
        // columns become a "headline" reference.
        const headlineGstRate =
          input.lineItems.length > 0 ? input.lineItems[0]!.gstRate : Number(original.cgstRate) * 2;
        const halfHeadline = +(headlineGstRate / 2).toFixed(2);

        // Re-derive balance + status from the new total against existing
        // payments and wallet credit.
        const carriedPaid = Number(original.totalPaid);
        const carriedWalletCredit = Number(original.walletCreditApplied);
        const balanceDue = +(grandTotal - carriedPaid - carriedWalletCredit).toFixed(2);
        const status =
          balanceDue <= 0.009
            ? "paid"
            : carriedPaid + carriedWalletCredit > 0
              ? "partial"
              : "issued";

        patch.subtotal = String(subtotal.toFixed(2));
        patch.cgstRate = String(halfHeadline);
        patch.cgstAmount = String(totalCgst.toFixed(2));
        patch.sgstRate = String(halfHeadline);
        patch.sgstAmount = String(totalSgst.toFixed(2));
        patch.grandTotal = String(grandTotal);
        patch.balanceDue = String(balanceDue);
        patch.status = status;

        // Keep the reservation's balance_due in sync. Recompute from
        // facts so multi-invoice bookings don't lose other invoices'
        // debt when only one invoice was edited.
        await recomputeReservationBalance(tx, original.reservationId);
      }

      // Stay window edits live on the reservation, not the invoice. The
      // invoice PDF reads them from the reservation when rendering.
      // NOTE: `num_nights` is a Postgres GENERATED column derived from
      // check_in_date and check_out_date — we must NOT try to set it,
      // or Postgres errors with 428C9.
      if (input.checkInDate !== undefined || input.checkOutDate !== undefined) {
        const [resRow] = await tx
          .select()
          .from(reservations)
          .where(eq(reservations.id, original.reservationId))
          .limit(1);
        if (resRow) {
          const newIn = (input.checkInDate ?? resRow.checkInDate) as string;
          const newOut = (input.checkOutDate ?? resRow.checkOutDate) as string;
          if (newIn >= newOut) {
            throw new Error("Check-out date must be after check-in date");
          }
        }
        const resPatch: Record<string, unknown> = { updatedAt: new Date() };
        if (input.checkInDate !== undefined) resPatch.checkInDate = input.checkInDate;
        if (input.checkOutDate !== undefined) resPatch.checkOutDate = input.checkOutDate;
        await tx
          .update(reservations)
          .set(resPatch)
          .where(eq(reservations.id, original.reservationId));
      }

      const [row] = await tx.update(invoices).set(patch).where(eq(invoices.id, id)).returning();
      return row!;
    });

    const afterSnapshot = {
      subtotal: updated.subtotal,
      cgstAmount: updated.cgstAmount,
      sgstAmount: updated.sgstAmount,
      grandTotal: updated.grandTotal,
      balanceDue: updated.balanceDue,
      status: updated.status,
      notes: updated.notes,
      guestName: updated.guestName,
      guestAddress: updated.guestAddress,
      guestGstin: updated.guestGstin,
      issueDate: updated.issueDate,
    };

    await logActivity({
      action: "invoice_edited",
      entityType: "invoice",
      entityId: id,
      description: `${updated.invoiceNumber} edited (₹${beforeSnapshot.grandTotal} → ₹${afterSnapshot.grandTotal})`,
      performedBy: req.user!.id,
      ipAddress: req.ip,
      metadata: {
        before: beforeSnapshot,
        after: afterSnapshot,
        lineItemsReplaced: !!input.lineItems,
      },
    });
    await invalidateDashboard();
    return ok(res, updated);
  },
);


export default router;
