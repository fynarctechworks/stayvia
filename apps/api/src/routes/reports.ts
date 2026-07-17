import { endOfMonth, format, parseISO, startOfMonth } from "date-fns";
import { propertyDayEnd, propertyDayStart } from "../lib/propertyTime.js";
import { and, desc, eq, gte, inArray, lte, ne, sql } from "drizzle-orm";
import { Router } from "express";
import { db } from "../db/client.js";
import { expenses } from "../db/schema/expenses.js";
import { guests } from "../db/schema/guests.js";
import { invoices, payments } from "../db/schema/invoices.js";
import { reservationRooms, reservations } from "../db/schema/reservations.js";
import { rooms } from "../db/schema/rooms.js";
import { env } from "../config/env.js";
import { logActivity } from "../lib/activity.js";
import { messaging } from "../lib/messaging.js";
import { fail, ok } from "../lib/response.js";
import { getSettings } from "../lib/settings.js";
import { renderTemplate } from "../lib/templates.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";

const router = Router();

// Date params are property-local calendar dates. `to` is inclusive of
// its WHOLE day — the old parseISO gave midnight for both ends, so a
// single-day window ("Today") excluded everything after 00:00.
// fromStr/toStr are the raw yyyy-MM-dd strings for ::date casts in SQL
// (formatting the Date back would shift a day on a non-IST server).
function rangeDefaults(req: { query: Record<string, string | undefined> }) {
  const fromStr = req.query.date_from ?? format(startOfMonth(new Date()), "yyyy-MM-dd");
  const toStr = req.query.date_to ?? format(endOfMonth(new Date()), "yyyy-MM-dd");
  return {
    from: propertyDayStart(fromStr),
    to: propertyDayEnd(toStr),
    fromStr,
    toStr,
  };
}

router.get("/occupancy", requireAuth, requirePermission("view_reports"), async (req, res) => {
  const { from, to, fromStr, toStr } = rangeDefaults(req as never);
  const totalRooms = (await db.select({ c: sql<number>`count(*)::int` }).from(rooms))[0]!.c;

  const rows = await db.execute<{ day: string; occupied: number }>(sql`
    SELECT gs::date::text as day,
      (SELECT count(*)::int FROM ${reservationRooms} rr
       INNER JOIN ${reservations} r ON r.id = rr.reservation_id
       WHERE r.check_in_date <= gs AND r.check_out_date > gs
       AND r.status IN ('checked_in','checked_out','confirmed')
       AND r.booking_source <> 'complimentary') as occupied
    FROM generate_series(${fromStr}::date, ${toStr}::date, '1 day') gs
  `);

  const daily = rows.map((r) => ({
    day: r.day,
    occupied: r.occupied,
    total: totalRooms,
    percentage: totalRooms ? Math.round((r.occupied / totalRooms) * 100) : 0,
  }));

  const avg = daily.length
    ? Math.round(daily.reduce((a, d) => a + d.percentage, 0) / daily.length)
    : 0;

  return ok(res, { from, to, totalRooms, avgOccupancy: avg, daily });
});

// Day book: one row per calendar day with everything the owner asks
// for at close-of-day — which rooms were occupied (and by whom, at
// what nightly price), how much money came in, how much went out as
// expenses, and the net. Also returns the per-room-night detail rows
// so the UI can offer a detailed CSV export.
router.get("/daily-ledger", requireAuth, requirePermission("view_reports"), async (req, res) => {
  const { from, to, fromStr, toStr } = rangeDefaults(req as never);

  // One row per occupied room-night. Half-open [check_in, check_out)
  // matches the billing convention (checkout day isn't a sold night);
  // day-use stays collapse to their single day. Swap segments narrow a
  // row to effective_from/effective_to like everywhere else.
  const nights = await db.execute<{
    day: string;
    room_number: string;
    rate: string;
    guest_name: string;
    reservation_number: string;
    booking_source: string | null;
  }>(sql`
    SELECT gs::date::text AS day,
           ro.room_number,
           rr.rate_per_night::text AS rate,
           g.full_name AS guest_name,
           r.reservation_number,
           r.booking_source
    FROM generate_series(${fromStr}::date, ${toStr}::date, '1 day') gs
    JOIN ${reservations} r
      ON r.status IN ('checked_in','checked_out','confirmed')
     AND (
       (r.stay_type = 'overnight' AND r.check_in_date <= gs AND r.check_out_date > gs)
       OR (r.stay_type = 'short_stay' AND r.check_in_date = gs)
     )
    JOIN ${reservationRooms} rr
      ON rr.reservation_id = r.id
     AND rr.status <> 'cancelled'
     AND (rr.effective_from IS NULL OR rr.effective_from <= gs)
     AND (rr.effective_to IS NULL OR rr.effective_to > gs)
    JOIN ${rooms} ro ON ro.id = rr.room_id
    JOIN ${guests} g ON g.id = r.guest_id
    ORDER BY gs, ro.room_number
  `);

  // Bucket payments by the property-local (IST) calendar day — plain
  // DATE() groups in the DB's timezone (UTC), which shoves anything
  // paid between 00:00 and 05:30 IST onto the previous day's row.
  const collectedRows = await db.execute<{ day: string; total: string }>(sql`
    SELECT DATE(p.payment_date AT TIME ZONE 'Asia/Kolkata')::text AS day,
           COALESCE(SUM(p.amount),0)::text AS total
    FROM ${payments} p
    WHERE p.payment_date >= ${from.toISOString()} AND p.payment_date <= ${to.toISOString()}
      AND p.voided = false AND p.status = 'received'
    GROUP BY DATE(p.payment_date AT TIME ZONE 'Asia/Kolkata')
  `);

  const expenseRows = await db
    .select({
      day: sql<string>`${expenses.expenseDate}::text`,
      total: sql<string>`COALESCE(SUM(${expenses.amount}),0)::text`,
    })
    .from(expenses)
    .where(and(gte(expenses.expenseDate, fromStr), lte(expenses.expenseDate, toStr)))
    .groupBy(expenses.expenseDate);

  const collectedByDay = new Map(collectedRows.map((r) => [r.day, Number(r.total)]));
  const expensesByDay = new Map(expenseRows.map((r) => [r.day, Number(r.total)]));

  // Assemble every day in the range (including empty ones — a day
  // with zero rooms but an expense entry still belongs in the book).
  const detailByDay = new Map<string, (typeof nights)[number][]>();
  for (const n of nights) {
    if (!detailByDay.has(n.day)) detailByDay.set(n.day, []);
    detailByDay.get(n.day)!.push(n);
  }
  // Pure string/local-date iteration — `new Date("yyyy-MM-dd")` parses
  // as UTC midnight, and re-formatting that in a server timezone west
  // of UTC yields the PREVIOUS day, so every key would miss the
  // Postgres ::date keys. parseISO gives local midnight, which
  // round-trips through format() losslessly in any timezone.
  const days: string[] = [];
  for (let d = parseISO(fromStr); format(d, "yyyy-MM-dd") <= toStr; d.setDate(d.getDate() + 1)) {
    days.push(format(d, "yyyy-MM-dd"));
  }

  const daily = days.map((day) => {
    const detail = detailByDay.get(day) ?? [];
    const roomCharges = +detail.reduce((s, n) => s + Number(n.rate), 0).toFixed(2);
    const collected = collectedByDay.get(day) ?? 0;
    const spent = expensesByDay.get(day) ?? 0;
    return {
      day,
      roomsOccupied: detail.length,
      roomNumbers: detail.map((n) => n.room_number).join(", "),
      roomCharges,
      collected,
      expenses: spent,
      net: +(collected - spent).toFixed(2),
      rooms: detail.map((n) => ({
        roomNumber: n.room_number,
        guestName: n.guest_name,
        reservationNumber: n.reservation_number,
        rate: Number(n.rate),
        complimentary: n.booking_source === "complimentary",
      })),
    };
  });

  const totals = {
    roomNights: daily.reduce((s, d) => s + d.roomsOccupied, 0),
    roomCharges: +daily.reduce((s, d) => s + d.roomCharges, 0).toFixed(2),
    collected: +daily.reduce((s, d) => s + d.collected, 0).toFixed(2),
    expenses: +daily.reduce((s, d) => s + d.expenses, 0).toFixed(2),
    net: +daily.reduce((s, d) => s + d.net, 0).toFixed(2),
  };

  return ok(res, { from: fromStr, to: toStr, daily, totals });
});

router.get("/revenue", requireAuth, requirePermission("view_reports"), async (req, res) => {
  const { from, to } = rangeDefaults(req as never);

  // Real revenue = received (not pending), not voided, not complimentary.
  //   - Pending = staff recorded a promise of payment ("unpaid"); not cash yet.
  //   - Voided = reversed for accounting.
  //   - Complimentary = owner-comp bookings; tracked in their own report.
  // The daily aggregate joins to reservations so it can apply the same
  // booking-source filter the per-type breakdowns use.
  const daily = await db.execute<{ day: string; total: string; count: number }>(sql`
    SELECT DATE(p.payment_date AT TIME ZONE 'Asia/Kolkata')::text as day,
      COALESCE(SUM(p.amount),0)::text as total,
      COUNT(*)::int as count
    FROM ${payments} p
    INNER JOIN ${reservations} r ON r.id = p.reservation_id
    WHERE p.payment_date >= ${from.toISOString()} AND p.payment_date <= ${to.toISOString()}
      AND p.voided = false
      AND p.status = 'received'
      AND r.booking_source <> 'complimentary'
    GROUP BY DATE(p.payment_date AT TIME ZONE 'Asia/Kolkata')
    ORDER BY day
  `);

  const totalRevenue = daily.reduce((a, d) => a + Number(d.total), 0);

  const byType = await db
    .select({
      roomType: rooms.roomType,
      total: sql<string>`COALESCE(SUM(${payments.amount}),0)::text`,
    })
    .from(payments)
    .innerJoin(reservations, eq(reservations.id, payments.reservationId))
    .innerJoin(reservationRooms, eq(reservationRooms.reservationId, reservations.id))
    .innerJoin(rooms, eq(rooms.id, reservationRooms.roomId))
    .where(
      and(
        gte(payments.paymentDate, from),
        lte(payments.paymentDate, to),
        eq(payments.voided, false),
        eq(payments.status, "received"),
        sql`${reservations.bookingSource} <> 'complimentary'`,
      ),
    )
    .groupBy(rooms.roomType);

  // Day-use vs overnight split. Drives the "Booking types" summary block
  // on the Reports page so the owner can see how much short-stay revenue
  // the property is generating without slicing per-room manually.
  const byStayType = await db
    .select({
      stayType: reservations.stayType,
      bookings: sql<number>`count(distinct ${reservations.id})::int`,
      total: sql<string>`COALESCE(SUM(${payments.amount}),0)::text`,
    })
    .from(payments)
    .innerJoin(reservations, eq(reservations.id, payments.reservationId))
    .where(
      and(
        gte(payments.paymentDate, from),
        lte(payments.paymentDate, to),
        eq(payments.voided, false),
        eq(payments.status, "received"),
        sql`${reservations.bookingSource} <> 'complimentary'`,
      ),
    )
    .groupBy(reservations.stayType);

  return ok(res, { from, to, totalRevenue, daily, byRoomType: byType, byStayType });
});

router.get("/collections", requireAuth, requirePermission("view_reports"), async (req, res) => {
  const { from, to } = rangeDefaults(req as never);
  // Exclude complimentary-reservation payments from the by-method
  // breakdown. They're shown in the Complimentary report instead.
  const byMethod = await db
    .select({
      method: payments.paymentMethod,
      count: sql<number>`count(*)::int`,
      total: sql<string>`COALESCE(SUM(${payments.amount}),0)::text`,
    })
    .from(payments)
    .innerJoin(reservations, eq(reservations.id, payments.reservationId))
    .where(
      and(
        gte(payments.paymentDate, from),
        lte(payments.paymentDate, to),
        eq(payments.voided, false),
        eq(payments.status, "received"),
        sql`${reservations.bookingSource} <> 'complimentary'`,
      ),
    )
    .groupBy(payments.paymentMethod);

  // Full payments list — keep voided + pending visible so staff can see
  // what was voided/promised, but exclude complimentary-reservation rows
  // entirely (they live in their own report).
  const rows = await db
    .select()
    .from(payments)
    .innerJoin(reservations, eq(reservations.id, payments.reservationId))
    .where(
      and(
        gte(payments.paymentDate, from),
        lte(payments.paymentDate, to),
        sql`${reservations.bookingSource} <> 'complimentary'`,
      ),
    )
    .orderBy(desc(payments.paymentDate))
    .limit(500);

  return ok(res, { from, to, byMethod, payments: rows.map((r) => r.payments) });
});

router.get("/gst-summary", requireAuth, requirePermission("view_reports"), async (req, res) => {
  // Accept any of:
  //   ?month=YYYY-MM             — single calendar month (legacy callers)
  //   ?date_from=YYYY-MM-DD&date_to=YYYY-MM-DD — explicit window (the
  //                                            Reports page uses this when
  //                                            the user picks Week / Year /
  //                                            Custom)
  //   neither                    — defaults to the current month
  // The response keeps the legacy `month` field as a human label so the
  // GST tab's section header doesn't break for month-based callers.
  const { month, date_from, date_to } = req.query as {
    month?: string;
    date_from?: string;
    date_to?: string;
  };

  let from: Date;
  let to: Date;
  let label: string;
  if (date_from && date_to) {
    // Property-local (IST) day bounds, date_to inclusive of its whole day.
    from = propertyDayStart(date_from);
    to = propertyDayEnd(date_to);
    label = `${format(parseISO(date_from), "dd MMM yyyy")} → ${format(parseISO(date_to), "dd MMM yyyy")}`;
  } else {
    const anchor = month ? parseISO(`${month}-01`) : new Date();
    from = startOfMonth(anchor);
    to = endOfMonth(anchor);
    label = format(anchor, "yyyy-MM");
  }

  // GST summary excludes invoices tied to complimentary reservations.
  // A comped booking is not a taxable sale from a management standpoint,
  // so its CGST/SGST shouldn't appear in the GST filing rollup.
  //
  // Group by document_type AND status so credit notes (negative tax
  // reversals) are a visible line, not silently netted into the
  // "issued" bucket. The period's net output tax = invoices − credit
  // notes, which is what gets filed.
  const rows = await db
    .select({
      documentType: invoices.documentType,
      status: invoices.status,
      subtotal: sql<string>`COALESCE(SUM(${invoices.subtotal}),0)::text`,
      cgst: sql<string>`COALESCE(SUM(${invoices.cgstAmount}),0)::text`,
      sgst: sql<string>`COALESCE(SUM(${invoices.sgstAmount}),0)::text`,
      total: sql<string>`COALESCE(SUM(${invoices.grandTotal}),0)::text`,
      count: sql<number>`count(*)::int`,
    })
    .from(invoices)
    .innerJoin(reservations, eq(reservations.id, invoices.reservationId))
    .where(
      and(
        gte(invoices.createdAt, from),
        lte(invoices.createdAt, to),
        ne(invoices.status, "voided"),
        sql`${reservations.bookingSource} <> 'complimentary'`,
      ),
    )
    .groupBy(invoices.documentType, invoices.status);

  // Split the rows into ordinary invoices (by status, as before) and a
  // single credit-note rollup so the UI can render both without
  // re-deriving the document type.
  const byStatus = rows
    .filter((r) => r.documentType !== "credit_note")
    .map(({ status, subtotal, cgst, sgst, total, count }) => ({
      status,
      subtotal,
      cgst,
      sgst,
      total,
      count,
    }));
  const cnRows = rows.filter((r) => r.documentType === "credit_note");
  const creditNotes = {
    count: cnRows.reduce((s, r) => s + r.count, 0),
    // Amounts are already negative in the DB; surface their magnitude so
    // the UI can show "− ₹X" cleanly.
    subtotal: cnRows.reduce((s, r) => s + Number(r.subtotal), 0).toFixed(2),
    cgst: cnRows.reduce((s, r) => s + Number(r.cgst), 0).toFixed(2),
    sgst: cnRows.reduce((s, r) => s + Number(r.sgst), 0).toFixed(2),
    total: cnRows.reduce((s, r) => s + Number(r.total), 0).toFixed(2),
  };

  return ok(res, { month: label, from, to, byStatus, creditNotes });
});

router.get("/outstanding", requireAuth, requirePermission("view_revenue"), async (_req, res) => {
  // Complimentary reservations are not chased — they were comped, there
  // is no debt. All three sub-queries below filter them out.
  // 1. Invoices that still have a balance.
  const rows = await db
    .select({
      invoiceId: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      reservationId: invoices.reservationId,
      reservationNumber: reservations.reservationNumber,
      guestId: invoices.guestId,
      guestName: guests.fullName,
      guestPhone: guests.phone,
      grandTotal: invoices.grandTotal,
      totalPaid: invoices.totalPaid,
      balanceDue: invoices.balanceDue,
      status: invoices.status,
      issuedAt: invoices.createdAt,
      checkedOutAt: reservations.checkedOutAt,
    })
    .from(invoices)
    .innerJoin(guests, eq(guests.id, invoices.guestId))
    .innerJoin(reservations, eq(reservations.id, invoices.reservationId))
    .where(
      and(
        ne(invoices.status, "voided"),
        ne(invoices.status, "paid"),
        sql`${reservations.bookingSource} <> 'complimentary'`,
        // Skip invoices whose parent reservation is fully settled. This
        // happens on multi-invoice bookings (per-room + combined, or
        // swap-leg + main stay) where one invoice is paid in isolation
        // but a sibling invoice on the same reservation looks unpaid
        // — actual money the property is owed is the reservation-level
        // balance, which is the single source of truth.
        sql`${reservations.balanceDue}::numeric > 0.009`,
      ),
    )
    .orderBy(desc(invoices.createdAt));

  // 2. Active reservations (confirmed / checked-in) that DON'T have an
  //    invoice yet but have a non-zero balance — these would be missed by
  //    the invoice-only query above. Examples: a guest who paid an advance
  //    but is still checked in; a confirmed booking with no advance.
  const preInvoiceRows = await db
    .select({
      reservationId: reservations.id,
      reservationNumber: reservations.reservationNumber,
      guestId: reservations.guestId,
      guestName: guests.fullName,
      guestPhone: guests.phone,
      grandTotal: reservations.grandTotal,
      advancePaid: reservations.advancePaid,
      balanceDue: reservations.balanceDue,
      status: reservations.status,
      checkInDate: reservations.checkInDate,
      checkOutDate: reservations.checkOutDate,
      createdAt: reservations.createdAt,
    })
    .from(reservations)
    .innerJoin(guests, eq(guests.id, reservations.guestId))
    .leftJoin(invoices, eq(invoices.reservationId, reservations.id))
    .where(
      and(
        inArray(reservations.status, ["confirmed", "checked_in"]),
        sql`${invoices.id} IS NULL`,
        sql`${reservations.balanceDue}::numeric > 0.009`,
        sql`${reservations.bookingSource} <> 'complimentary'`,
      ),
    )
    .orderBy(desc(reservations.createdAt));

  // Pending (unpaid-method) payments — separate stream for visibility
  const pendingPayments = await db
    .select({
      paymentId: payments.id,
      invoiceId: payments.invoiceId,
      reservationId: payments.reservationId,
      reservationNumber: reservations.reservationNumber,
      guestId: reservations.guestId,
      guestName: guests.fullName,
      guestPhone: guests.phone,
      amount: payments.amount,
      notes: payments.notes,
      promisedAt: payments.createdAt,
    })
    .from(payments)
    .innerJoin(reservations, eq(reservations.id, payments.reservationId))
    .innerJoin(guests, eq(guests.id, reservations.guestId))
    .where(
      and(
        eq(payments.status, "pending"),
        eq(payments.voided, false),
        sql`${reservations.bookingSource} <> 'complimentary'`,
      ),
    )
    .orderBy(desc(payments.createdAt));

  // Guest-level totals — combine invoice-based and pre-invoice balances.
  const byGuest = new Map<
    string,
    { guestId: string; guestName: string; guestPhone: string; balance: number; oldest: Date }
  >();
  function addToGuest(
    r: {
      guestId: string;
      guestName: string;
      guestPhone: string;
    },
    balance: number,
    when: Date,
  ) {
    if (balance <= 0.009) return;
    const cur = byGuest.get(r.guestId);
    if (cur) {
      cur.balance += balance;
      if (when < cur.oldest) cur.oldest = when;
    } else {
      byGuest.set(r.guestId, {
        guestId: r.guestId,
        guestName: r.guestName,
        guestPhone: r.guestPhone,
        balance,
        oldest: when,
      });
    }
  }
  // Aggregate by RESERVATION (not by invoice) so multi-invoice bookings
  // don't double-count. A reservation contributes its own balanceDue
  // exactly once, regardless of how many invoices hang off it. The
  // oldest invoice's issued-at is kept as the "ageing" anchor when
  // available, otherwise the reservation's createdAt.
  //
  // We also need the reservation's authoritative balance_due — the
  // single source of truth — instead of summing per-invoice balances
  // which can drift on multi-invoice bookings. Pull it inline.
  const reservationBalances = await db
    .select({
      id: reservations.id,
      balanceDue: reservations.balanceDue,
    })
    .from(reservations)
    .where(sql`${reservations.balanceDue}::numeric > 0.009`);
  const resBalanceMap = new Map(
    reservationBalances.map((r) => [r.id, Number(r.balanceDue)]),
  );

  const seenReservations = new Set<string>();
  for (const r of rows) {
    if (seenReservations.has(r.reservationId)) continue;
    seenReservations.add(r.reservationId);
    const bal = resBalanceMap.get(r.reservationId) ?? Number(r.balanceDue);
    addToGuest(r, bal, new Date(r.issuedAt));
  }
  for (const r of preInvoiceRows) {
    if (seenReservations.has(r.reservationId)) continue;
    seenReservations.add(r.reservationId);
    addToGuest(r, Number(r.balanceDue), new Date(r.createdAt));
  }

  return ok(res, {
    invoices: rows,
    preInvoice: preInvoiceRows,
    pendingPayments,
    byGuest: Array.from(byGuest.values()).sort((a, b) => b.balance - a.balance),
    totalOutstanding: Array.from(byGuest.values()).reduce((s, g) => s + g.balance, 0),
  });
});

router.get("/room-performance", requireAuth, requirePermission("view_reports"), async (req, res) => {
  const { from, to } = rangeDefaults(req as never);
  // Complimentary reservations are filtered out of every aggregate — they
  // shouldn't inflate per-room booking counts or revenue.
  const notComp = sql`${reservations.bookingSource} <> 'complimentary'`;
  const rows = await db
    .select({
      roomId: rooms.id,
      roomNumber: rooms.roomNumber,
      roomType: rooms.roomType,
      baseRate: rooms.baseRate,
      bookings: sql<number>`count(distinct ${reservations.id}) filter (where ${notComp})::int`,
      // Split booking counts so a manager can see which rooms are being
      // used for day-use vs traditional overnight.
      overnightBookings: sql<number>`count(distinct ${reservations.id}) filter (where ${reservations.stayType} = 'overnight' AND ${notComp})::int`,
      shortStayBookings: sql<number>`count(distinct ${reservations.id}) filter (where ${reservations.stayType} = 'short_stay' AND ${notComp})::int`,
      revenue: sql<string>`COALESCE(SUM(${payments.amount}) filter (where ${payments.voided} = false AND ${payments.status} = 'received' AND ${notComp}),0)::text`,
    })
    .from(rooms)
    .leftJoin(reservationRooms, eq(reservationRooms.roomId, rooms.id))
    .leftJoin(reservations, eq(reservations.id, reservationRooms.reservationId))
    .leftJoin(
      payments,
      and(
        eq(payments.reservationId, reservations.id),
        gte(payments.paymentDate, from),
        lte(payments.paymentDate, to),
      ),
    )
    .groupBy(rooms.id)
    .orderBy(rooms.roomNumber);
  return ok(res, rows);
});

router.post("/outstanding/remind/:guestId", requireAuth, requirePermission("send_reminders"), async (req, res) => {
  const guestId = req.params.guestId!;
  const [g] = await db.select().from(guests).where(eq(guests.id, guestId)).limit(1);
  if (!g) return fail(res, 404, "NOT_FOUND", "Guest not found");
  if (!g.phone) return fail(res, 400, "NO_PHONE", "Guest has no phone number");

  // Sum the guest's outstanding reservation-level balances. Reservation
  // balanceDue is the single source of truth (recompute helper keeps
  // it in sync with payments); summing per-invoice balanceDue on a
  // multi-invoice booking would over-count if attribution has drifted.
  const resBalances = await db
    .select({ balanceDue: reservations.balanceDue })
    .from(reservations)
    .where(
      and(
        eq(reservations.guestId, guestId),
        sql`${reservations.balanceDue}::numeric > 0.009`,
        sql`${reservations.bookingSource} <> 'complimentary'`,
      ),
    );
  const balance = resBalances.reduce((sum, r) => sum + Number(r.balanceDue), 0);
  if (balance <= 0.009) {
    return fail(res, 400, "NO_BALANCE", "Guest has no outstanding balance");
  }

  const settings = await getSettings();
  const t = await renderTemplate("payment_reminder_guest_sms", {
    hotel: env.HOTEL_DISPLAY_NAME,
    hotel_phone: settings.hotelPhone ?? "",
    guest_name: g.fullName,
    guest_phone: g.phone,
    balance: balance.toFixed(2),
  });
  if (!t.enabled) return fail(res, 400, "TEMPLATE_DISABLED", "Reminder template is disabled");

  const result = await messaging.sendSms({ to: g.phone, text: t.body });
  if (!result.ok) return fail(res, 502, "SEND_FAILED", result.error ?? "Send failed");

  await logActivity({
    action: "payment_reminder_sent",
    entityType: "guest",
    entityId: guestId,
    description: `Payment reminder sent to ${g.fullName} (₹${balance.toFixed(2)})`,
    performedBy: req.user!.id,
    ipAddress: req.ip,
  });
  return ok(res, {
    sent: true,
    queued: false,
    balance,
    provider: result.provider,
    messageId: result.id ?? null,
    to: g.phone,
  });
});

router.get("/credit-bookings", requireAuth, requirePermission("view_reports"), async (req, res) => {
  const { from, to } = rangeDefaults(req as never);
  const rows = await db
    .select({
      id: reservations.id,
      reservationNumber: reservations.reservationNumber,
      guestName: guests.fullName,
      guestPhone: guests.phone,
      bookingSource: reservations.bookingSource,
      checkInDate: reservations.checkInDate,
      checkOutDate: reservations.checkOutDate,
      numNights: reservations.numNights,
      grandTotal: reservations.grandTotal,
      balanceDue: reservations.balanceDue,
      status: reservations.status,
      creditNotes: reservations.creditNotes,
      createdAt: reservations.createdAt,
      // Sum of received, non-voided payments on this reservation. For
      // comped bookings this often > 0 — staff collected money before the
      // booking was reclassified to complimentary. The report surfaces it
      // so the owner sees both the "comped value" and "money already in
      // the till" for the same row.
      totalPaid: sql<string>`COALESCE((
        SELECT SUM(${payments.amount})
        FROM ${payments}
        WHERE ${payments.reservationId} = ${reservations.id}
          AND ${payments.voided} = false
          AND ${payments.status} = 'received'
      ), 0)::text`,
    })
    .from(reservations)
    .innerJoin(guests, eq(guests.id, reservations.guestId))
    .where(
      and(
        eq(reservations.bookingSource, "complimentary"),
        gte(reservations.createdAt, from),
        lte(reservations.createdAt, to),
      ),
    )
    .orderBy(desc(reservations.createdAt));

  const totals = rows.reduce(
    (acc, r) => {
      acc.count += 1;
      acc.grandTotal += Number(r.grandTotal);
      acc.balanceDue += Number(r.balanceDue);
      acc.totalPaid += Number(r.totalPaid);
      if (r.bookingSource === "complimentary") acc.complimentary += Number(r.grandTotal);
      return acc;
    },
    { count: 0, grandTotal: 0, balanceDue: 0, totalPaid: 0, complimentary: 0 },
  );

  return ok(res, { from, to, totals, rows });
});

router.get("/guests", requireAuth, requirePermission("view_reports"), async (req, res) => {
  const { from, to } = rangeDefaults(req as never);
  // Stays count includes comps (a stay happened, even if comped). Revenue
  // excludes comp-booking payments — those live in the Complimentary
  // report so the guest's "real revenue" isn't inflated.
  const rows = await db
    .select({
      guestId: guests.id,
      fullName: guests.fullName,
      phone: guests.phone,
      stays: sql<number>`count(distinct ${reservations.id})::int`,
      revenue: sql<string>`COALESCE(SUM(${payments.amount}) filter (where ${payments.voided} = false AND ${payments.status} = 'received' AND ${reservations.bookingSource} <> 'complimentary'),0)::text`,
    })
    .from(guests)
    .leftJoin(reservations, eq(reservations.guestId, guests.id))
    .leftJoin(
      payments,
      and(
        eq(payments.reservationId, reservations.id),
        gte(payments.paymentDate, from),
        lte(payments.paymentDate, to),
      ),
    )
    .groupBy(guests.id)
    .orderBy(sql`count(distinct ${reservations.id}) DESC`)
    .limit(100);
  return ok(res, rows);
});

// ----------------------------------------------------------------------
// Phase 2 — Pace report
// ----------------------------------------------------------------------
// For each stay date in the requested window, how many room-nights were
// on the books as of N days before that stay-date? Plotting these
// curves over time tells revenue managers whether the property is
// pacing ahead or behind a comparable past period.
//
// We compute "on the books at lead-time D for stay-date S" as: count of
// reservation_rooms rows where the parent reservation was CREATED on or
// before (S - D days) AND the stay range contains S AND the reservation
// status was an active one.
//
// Output:
//   { stay_dates: ["2026-06-01", ...],
//     curves: { "0": [12,13,...], "7": [...], "14": [...], "30": [...] } }
router.get("/pace", requireAuth, requirePermission("view_reports"), async (req, res) => {
  const { fromStr, toStr } = rangeDefaults(req as never);
  const leads = [0, 7, 14, 30];

  const rows = await db.execute<{ stay_date: string; lead: number; nights: number }>(sql`
    WITH stay_days AS (
      SELECT generate_series(${fromStr}::date, ${toStr}::date, interval '1 day')::date AS d
    ),
    leads(l) AS (VALUES (0), (7), (14), (30))
    SELECT
      to_char(sd.d, 'YYYY-MM-DD') AS stay_date,
      l.l AS lead,
      COALESCE((
        SELECT COUNT(*)::int
        FROM reservation_rooms rr
        JOIN reservations r ON r.id = rr.reservation_id
        WHERE r.status IN ('confirmed','checked_in','checked_out','hold','pending_payment')
          AND r.booking_source <> 'complimentary'
          AND r.created_at::date <= (sd.d - (l.l || ' days')::interval)::date
          AND daterange(r.check_in_date, GREATEST(r.check_out_date, r.check_in_date + 1), '[)') @> sd.d
      ), 0) AS nights
    FROM stay_days sd CROSS JOIN leads l
    ORDER BY sd.d, l.l
  `);

  const stayDates: string[] = [];
  const curves: Record<string, number[]> = {};
  for (const l of leads) curves[String(l)] = [];
  // Reconstruct from the flat list.
  const seen = new Set<string>();
  for (const r of rows as unknown as { stay_date: string; lead: number; nights: number }[]) {
    if (!seen.has(r.stay_date)) {
      stayDates.push(r.stay_date);
      seen.add(r.stay_date);
    }
    curves[String(r.lead)]!.push(Number(r.nights));
  }
  return ok(res, { stay_dates: stayDates, curves });
});

// ----------------------------------------------------------------------
// Phase 2 — Pickup report
// ----------------------------------------------------------------------
// Day-over-day change in room-nights on the books for each stay-date.
// Differs from pace in that this is about RECENT booking velocity, not
// historical comparison. For each day in the window, how many net
// room-nights (added minus cancelled) hit the books during the previous
// N days?
//
// Output:
//   { window_days: 7,
//     rows: [{ stay_date, picked_up_last_7d, picked_up_last_30d }, ...] }
router.get("/pickup", requireAuth, requirePermission("view_reports"), async (req, res) => {
  const { fromStr, toStr } = rangeDefaults(req as never);

  const rows = await db.execute<{ stay_date: string; pu7: number; pu30: number }>(sql`
    WITH stay_days AS (
      SELECT generate_series(${fromStr}::date, ${toStr}::date, interval '1 day')::date AS d
    )
    SELECT
      to_char(sd.d, 'YYYY-MM-DD') AS stay_date,
      COALESCE((
        SELECT COUNT(*)::int
        FROM reservation_rooms rr
        JOIN reservations r ON r.id = rr.reservation_id
        WHERE r.status IN ('confirmed','checked_in','checked_out','hold','pending_payment')
          AND r.booking_source <> 'complimentary'
          AND r.created_at >= (sd.d - interval '7 days')
          AND r.created_at < sd.d
          AND daterange(r.check_in_date, GREATEST(r.check_out_date, r.check_in_date + 1), '[)') @> sd.d
      ), 0) AS pu7,
      COALESCE((
        SELECT COUNT(*)::int
        FROM reservation_rooms rr
        JOIN reservations r ON r.id = rr.reservation_id
        WHERE r.status IN ('confirmed','checked_in','checked_out','hold','pending_payment')
          AND r.booking_source <> 'complimentary'
          AND r.created_at >= (sd.d - interval '30 days')
          AND r.created_at < sd.d
          AND daterange(r.check_in_date, GREATEST(r.check_out_date, r.check_in_date + 1), '[)') @> sd.d
      ), 0) AS pu30
    FROM stay_days sd
    ORDER BY sd.d
  `);

  return ok(res, {
    rows: (rows as unknown as { stay_date: string; pu7: number; pu30: number }[]).map(
      (r) => ({
        stay_date: r.stay_date,
        picked_up_last_7d: Number(r.pu7),
        picked_up_last_30d: Number(r.pu30),
      }),
    ),
  });
});

export default router;
