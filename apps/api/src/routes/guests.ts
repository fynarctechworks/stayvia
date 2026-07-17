import {
  followUpCreateSchema,
  followUpUpdateSchema,
  guestCreateSchema,
  guestDuplicateQuerySchema,
  guestListQuerySchema,
  guestNoteCreateSchema,
  guestTagsSchema,
  guestUpdateSchema,
} from "@hoteldesk/shared";
import { and, asc, desc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { db } from "../db/client.js";
import {
  guestFollowUps,
  guestNotes,
  guestPhoneHistory,
  guests,
} from "../db/schema/guests.js";
import { reservationCoGuests, reservations, reservationRooms } from "../db/schema/reservations.js";
import { rooms } from "../db/schema/rooms.js";
import { invoices, payments } from "../db/schema/invoices.js";
import { logActivity } from "../lib/activity.js";
import { logger } from "../lib/logger.js";
import { encrypt, last4 } from "../lib/crypto.js";
// Static import — ledger.ts pulls only db/schema, no cycle. Dynamic import()
// fails inside the pkg-bundled sidecar (crashed the guest-detail endpoint).
import { getGuestBalance } from "../lib/ledger.js";
import {
  mergeTagsForRead,
  sanitizeTagsForWrite,
} from "../lib/guestTags.js";
import { normalisePhone } from "../lib/phone.js";
import { resolveCurrentPropertyId } from "../lib/currentProperty.js";
import { fail, list, ok } from "../lib/response.js";
import {
  deleteKycFile,
  signedKycUrl,
  storageFolderLabel,
  uploadKycPhoto,
  validateKycFile,
} from "../lib/storage.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";
import { resolveGuestId } from "../middleware/resolveGuest.js";
import { validate } from "../middleware/validate.js";

// Multer config for KYC uploads. We reject anything that isn't an image at
// the multipart layer so junk (executables, archives, SVG, PDF) never even
// hits the disk buffer. Real validation happens server-side in
// storage.ts via Sharp re-encoding — this is just the cheap first filter.
const ALLOWED_UPLOAD_MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 3, fields: 5 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_UPLOAD_MIMES.has(file.mimetype)) {
      cb(new Error("Only JPEG, PNG, or WEBP images are accepted"));
      return;
    }
    cb(null, true);
  },
});

const router = Router();

// Resolve :id to a UUID before every handler — accepts either the
// UUID or a phone number, so navigation can build URLs like
// /guests/9876543210 instead of leaking UUIDs.
router.param("id", resolveGuestId as never);

// Mask the ID proof for non-admin views. Only the last 4 digits leak out
// so staff can still verify a guest at the desk without seeing the full
// number. Admins get the unmasked row.
const maskId = (l4: string) => `••••${l4}`;

function maskGuest<T extends { idProofNumberEncrypted: string; idProofLast4: string }>(
  guest: T,
  role: string,
) {
  if (role === "admin") return guest;
  const { idProofNumberEncrypted: _e, ...rest } = guest;
  void _e; // intentionally dropped from the response
  return { ...rest, idProofMasked: maskId(guest.idProofLast4) };
}

router.get(
  "/",
  requireAuth,
  requirePermission("view_guests"),
  validate(guestListQuerySchema, "query"),
  async (req, res) => {
    const { search, tag, has_followup, page, per_page } = req.query as unknown as {
      search?: string;
      tag?: string;
      has_followup?: "true" | "false";
      page: number;
      per_page: number;
    };
    const offset = (page - 1) * per_page;

    const conditions = [];
    if (search) {
      conditions.push(
        or(
          ilike(guests.fullName, `%${search}%`),
          ilike(guests.phone, `%${search}%`),
          ilike(guests.idProofLast4, `%${search}%`),
          ilike(guests.email, `%${search}%`),
          ilike(guests.companyName, `%${search}%`),
        )!,
      );
    }
    if (tag) {
      conditions.push(sql`${tag} = ANY(${guests.tags})`);
    }
    if (has_followup === "true") {
      conditions.push(
        sql`EXISTS (SELECT 1 FROM ${guestFollowUps} f WHERE f.guest_id = ${guests.id} AND f.status = 'pending')`,
      );
    }
    const where = conditions.length ? and(...conditions) : undefined;

    const [rows, totalRows] = await Promise.all([
      db
        .select()
        .from(guests)
        .where(where)
        .orderBy(desc(guests.createdAt))
        .limit(per_page)
        .offset(offset),
      db.select({ count: sql<number>`count(*)::int` }).from(guests).where(where),
    ]);

    // Per-guest stay count + lifetime spend, batched in one round-trip
    // (vs N round-trips for per-row queries). Same scoping logic as
    // GET /:id stats — only completed, non-comp stays count for the
    // tag thresholds. Returns 0/0 for guests with no stays.
    const guestIds = rows.map((r) => r.id);
    const aggMap = new Map<string, { completed: number; spent: number }>();
    if (guestIds.length > 0) {
      const aggRows = await db.execute<{
        guest_id: string;
        completed: number;
        spent: string;
      }>(sql`
        SELECT
          g.id AS guest_id,
          COUNT(DISTINCT r.id) FILTER (WHERE r.status = 'checked_out' AND r.booking_source <> 'complimentary')::int AS completed,
          COALESCE(SUM(CASE WHEN p.voided = false AND p.status = 'received' AND r.booking_source <> 'complimentary' THEN p.amount::numeric ELSE 0 END), 0)::text AS spent
        FROM ${guests} g
        LEFT JOIN ${reservations} r ON r.guest_id = g.id
        LEFT JOIN ${payments} p ON p.reservation_id = r.id
        WHERE g.id = ANY(${sql.raw(`ARRAY[${guestIds.map((id) => `'${id}'::uuid`).join(",")}]`)})
        GROUP BY g.id
      `);
      for (const a of aggRows) {
        aggMap.set(a.guest_id, {
          completed: a.completed,
          spent: Number(a.spent),
        });
      }
    }

    // Resolve signed photo URLs in parallel so the guest search dropdown
    // can render thumbnails. Rows without a guestPhoto get null. URLs are
    // short-lived (5 min) — fine for the list view.
    const photoUrls = await Promise.all(
      rows.map((r) => (r.guestPhoto ? signedKycUrl(r.guestPhoto) : Promise.resolve(null))),
    );

    const masked = rows.map((r, i) => {
      const agg = aggMap.get(r.id) ?? { completed: 0, spent: 0 };
      const computedTags = mergeTagsForRead(r.tags as string[] | null, {
        createdAt: r.createdAt,
        isBlacklisted: r.isBlacklisted,
        gstin: r.gstin,
        completedStays: agg.completed,
        totalSpent: agg.spent,
      });
      return {
        ...maskGuest(r, req.user!.role),
        tags: computedTags,
        photoUrl: photoUrls[i] ?? null,
      };
    });
    return list(res, masked, { total: totalRows[0]?.count ?? 0, page, per_page });
  },
);

router.get(
  "/check-duplicate",
  requireAuth,
  requirePermission("view_guests"),
  validate(guestDuplicateQuerySchema, "query"),
  async (req, res) => {
    const { phone, email, id_type, id_number } = req.query as {
      phone?: string;
      email?: string;
      id_type?: import("@hoteldesk/shared").IdProofType;
      id_number?: string;
    };
    if (!phone && !email && !id_number) {
      return ok(res, { duplicate: false, matches: [], reasons: [] });
    }

    // Build one OR condition per field so we can tell the caller WHICH
    // identifier matched on each row (phone vs email vs ID). This lets
    // the form show "Use existing guest" suggestions next to whichever
    // field the staff is typing into.
    const conditions = [];
    if (phone) conditions.push(eq(guests.phone, normalisePhone(phone)));
    if (email && email.trim() !== "") {
      conditions.push(sql`LOWER(${guests.email}) = LOWER(${email.trim()})`);
    }
    if (id_number) {
      const last4 = id_number.slice(-4);
      // Pair ID number with its type — a 4-digit suffix shared across
      // an Aadhaar and a Passport isn't the same person.
      if (id_type) {
        conditions.push(
          and(
            eq(guests.idProofType, id_type),
            eq(guests.idProofLast4, last4),
          )!,
        );
      } else {
        conditions.push(eq(guests.idProofLast4, last4));
      }
    }
    if (conditions.length === 0) {
      return ok(res, { duplicate: false, matches: [], reasons: [] });
    }

    const rows = await db
      .select({
        id: guests.id,
        fullName: guests.fullName,
        phone: guests.phone,
        email: guests.email,
        idProofType: guests.idProofType,
        idProofLast4: guests.idProofLast4,
      })
      .from(guests)
      .where(or(...conditions))
      .limit(5);

    // Annotate each match with WHY it matched so the UI can render
    // "Phone already used by …" vs "Email already used by …".
    const matches = rows.map((r) => {
      const reasons: ("phone" | "email" | "id")[] = [];
      if (phone && r.phone === normalisePhone(phone)) reasons.push("phone");
      if (
        email &&
        r.email &&
        r.email.trim().toLowerCase() === email.trim().toLowerCase()
      ) {
        reasons.push("email");
      }
      if (
        id_number &&
        r.idProofLast4 === id_number.slice(-4) &&
        (!id_type || r.idProofType === id_type)
      ) {
        reasons.push("id");
      }
      return { ...r, reasons };
    });

    return ok(res, {
      duplicate: matches.length > 0,
      matches,
      reasons: Array.from(new Set(matches.flatMap((m) => m.reasons))),
    });
  },
);

// Outstanding balance owed by this guest across all their previous bookings.
// Combines:
//   (a) unpaid/partial invoices (issued, not voided, balance_due > 0)
//   (b) confirmed/checked-in reservations with a non-zero balance that
//       haven't had an invoice issued yet (e.g. advance paid but stay
//       still in progress)
// Returns a small summary so the New Reservation form can show a banner
// without making a second round-trip. `mostRecent` is for the "previous
// booking" deep-link.
router.get(
  "/:id/outstanding",
  requireAuth,
  requirePermission("view_guests"),
  async (req, res) => {
    const id = req.params.id!;
    const exists = await db.select({ id: guests.id }).from(guests).where(eq(guests.id, id)).limit(1);
    if (!exists.length) return fail(res, 404, "NOT_FOUND", "Guest not found");

    // Complimentary reservations don't appear as "owed" anywhere — they
    // were comped, so there is no debt to chase. Filter in all three
    // sub-queries that feed the outstanding banner.
    const [invoiceRows, preInvoiceRows, pendingPayments] = await Promise.all([
      db
        .select({
          invoiceId: invoices.id,
          invoiceNumber: invoices.invoiceNumber,
          reservationId: invoices.reservationId,
          reservationNumber: reservations.reservationNumber,
          balanceDue: invoices.balanceDue,
          issuedAt: invoices.createdAt,
        })
        .from(invoices)
        .innerJoin(reservations, eq(reservations.id, invoices.reservationId))
        .where(
          and(
            eq(invoices.guestId, id),
            sql`${invoices.status} NOT IN ('voided','paid')`,
            sql`${invoices.balanceDue}::numeric > 0.009`,
            sql`${reservations.bookingSource} <> 'complimentary'`,
            // Don't list invoice rows whose parent reservation is fully
            // settled. Happens on multi-invoice bookings where one
            // invoice looks unpaid in isolation but a sibling invoice
            // on the same reservation absorbed the payments.
            sql`${reservations.balanceDue}::numeric > 0.009`,
          ),
        )
        .orderBy(desc(invoices.createdAt)),
      // Reservations the guest is on that have a non-zero balance but no
      // invoice yet. We exclude cancelled/no_show so we don't nag about
      // bookings that were never going to be paid for.
      db
        .select({
          reservationId: reservations.id,
          reservationNumber: reservations.reservationNumber,
          balanceDue: reservations.balanceDue,
          createdAt: reservations.createdAt,
          status: reservations.status,
        })
        .from(reservations)
        .leftJoin(invoices, eq(invoices.reservationId, reservations.id))
        .where(
          and(
            eq(reservations.guestId, id),
            inArray(reservations.status, ["confirmed", "checked_in"]),
            sql`${invoices.id} IS NULL`,
            sql`${reservations.balanceDue}::numeric > 0.009`,
            sql`${reservations.bookingSource} <> 'complimentary'`,
          ),
        )
        .orderBy(desc(reservations.createdAt)),
      // Pending payment promises ("guest will pay in cash later"). These
      // attach to a reservation but might double-count what the invoice
      // already says, so we surface them as a separate count for context
      // but DON'T add their amount to the total.
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(payments)
        .innerJoin(reservations, eq(reservations.id, payments.reservationId))
        .where(
          and(
            eq(reservations.guestId, id),
            eq(payments.status, "pending"),
            eq(payments.voided, false),
            sql`${reservations.bookingSource} <> 'complimentary'`,
          ),
        ),
    ]);

    // Total = sum of reservation-level balances (the single source of
    // truth), one entry per reservation. Summing per-invoice balances
    // would double-count multi-invoice bookings whenever attribution
    // is split across siblings.
    const reservationIds = new Set<string>();
    for (const r of invoiceRows) reservationIds.add(r.reservationId);
    for (const r of preInvoiceRows) reservationIds.add(r.reservationId);
    let total = 0;
    if (reservationIds.size > 0) {
      const balRows = await db
        .select({
          id: reservations.id,
          balanceDue: reservations.balanceDue,
        })
        .from(reservations)
        .where(inArray(reservations.id, Array.from(reservationIds)));
      total = +balRows
        .reduce((s, r) => s + Number(r.balanceDue), 0)
        .toFixed(2);
    }

    // Most-recent unpaid item — used by the UI for the "Open previous
    // reservation" deep-link in the banner.
    let mostRecent:
      | {
          reservationId: string;
          reservationNumber: string;
          invoiceNumber: string | null;
          balanceDue: number;
          date: string;
        }
      | null = null;
    if (invoiceRows.length) {
      const r = invoiceRows[0]!;
      mostRecent = {
        reservationId: r.reservationId,
        reservationNumber: r.reservationNumber,
        invoiceNumber: r.invoiceNumber,
        balanceDue: Number(r.balanceDue),
        date: r.issuedAt.toISOString(),
      };
    } else if (preInvoiceRows.length) {
      const r = preInvoiceRows[0]!;
      mostRecent = {
        reservationId: r.reservationId,
        reservationNumber: r.reservationNumber,
        invoiceNumber: null,
        balanceDue: Number(r.balanceDue),
        date: r.createdAt.toISOString(),
      };
    }

    return ok(res, {
      total,
      count: invoiceRows.length + preInvoiceRows.length,
      pendingPromiseCount: pendingPayments[0]?.count ?? 0,
      mostRecent,
      // Per-invoice breakdown used by checkout flow to collect previous
      // unpaid balances in FIFO order (oldest issued first).
      invoices: invoiceRows
        .map((r) => ({
          invoiceId: r.invoiceId,
          invoiceNumber: r.invoiceNumber,
          reservationId: r.reservationId,
          reservationNumber: r.reservationNumber,
          balanceDue: Number(r.balanceDue),
          issuedAt: r.issuedAt.toISOString(),
        }))
        .sort((a, b) => a.issuedAt.localeCompare(b.issuedAt)),
      // Reservations that have a balance but haven't been invoiced yet
      // (still checked_in or confirmed). The checkout modal lets staff
      // collect these via POST /reservations/:id/payments (records an
      // advance).
      preInvoiceReservations: preInvoiceRows
        .map((r) => ({
          reservationId: r.reservationId,
          reservationNumber: r.reservationNumber,
          balanceDue: Number(r.balanceDue),
          createdAt: r.createdAt.toISOString(),
        }))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    });
  },
);

// Full stay history for the guest profile's "Stays" tab. Returns every
// reservation the guest is on (booker or per-room occupant), newest first,
// with each booking's rooms attached. Drives the inline list of rooms +
// dates + status shown on the guest page.
router.get(
  "/:id/reservations",
  requireAuth,
  requirePermission("view_guests"),
  async (req, res) => {
    const id = req.params.id!;
    const exists = await db
      .select({ id: guests.id })
      .from(guests)
      .where(eq(guests.id, id))
      .limit(1);
    if (!exists.length) return fail(res, 404, "NOT_FOUND", "Guest not found");

    // Reservations where this guest is either the booker OR a per-room
    // occupant OR a co-guest (migration 0020). A Set keeps the result
    // deduplicated even when the guest plays more than one role on the
    // same booking.
    const bookerIds = await db
      .select({ id: reservations.id })
      .from(reservations)
      .where(eq(reservations.guestId, id));
    const occupantIds = await db
      .select({ id: reservationRooms.reservationId })
      .from(reservationRooms)
      .where(eq(reservationRooms.guestId, id));
    const coGuestIds = await db
      .select({ id: reservationCoGuests.reservationId })
      .from(reservationCoGuests)
      .where(eq(reservationCoGuests.guestId, id));
    const allIds = Array.from(
      new Set([
        ...bookerIds.map((r) => r.id),
        ...occupantIds.map((r) => r.id),
        ...coGuestIds.map((r) => r.id),
      ]),
    );
    if (allIds.length === 0) return ok(res, []);

    const resvRows = await db
      .select({
        id: reservations.id,
        reservationNumber: reservations.reservationNumber,
        status: reservations.status,
        bookingSource: reservations.bookingSource,
        stayType: reservations.stayType,
        checkInDate: reservations.checkInDate,
        checkOutDate: reservations.checkOutDate,
        numNights: reservations.numNights,
        grandTotal: reservations.grandTotal,
        balanceDue: reservations.balanceDue,
        guestId: reservations.guestId,
        createdAt: reservations.createdAt,
      })
      .from(reservations)
      .where(inArray(reservations.id, allIds))
      .orderBy(desc(reservations.checkInDate), desc(reservations.createdAt));

    const roomRows = await db
      .select({
        id: reservationRooms.id,
        reservationId: reservationRooms.reservationId,
        roomNumber: rooms.roomNumber,
        roomType: rooms.roomType,
        soldAsType: reservationRooms.soldAsType,
        ratePerNight: reservationRooms.ratePerNight,
        guestId: reservationRooms.guestId,
        status: reservationRooms.status,
      })
      .from(reservationRooms)
      .innerJoin(rooms, eq(rooms.id, reservationRooms.roomId))
      .where(inArray(reservationRooms.reservationId, allIds));

    const roomsByRes = new Map<string, typeof roomRows>();
    for (const r of roomRows) {
      const arr = roomsByRes.get(r.reservationId) ?? [];
      arr.push(r);
      roomsByRes.set(r.reservationId, arr);
    }

    return ok(
      res,
      resvRows.map((r) => ({
        ...r,
        // Role this guest played on the booking — useful for the UI to
        // label "You were the booker" vs "Stayed in Room 202".
        role: r.guestId === id ? "booker" : "occupant",
        rooms: (roomsByRes.get(r.id) ?? []).map((rm) => ({
          id: rm.id,
          roomNumber: rm.roomNumber,
          roomType: rm.roomType,
          soldAsType: rm.soldAsType,
          ratePerNight: rm.ratePerNight,
          status: rm.status,
          isThisGuest: rm.guestId === id,
        })),
      })),
    );
  },
);

router.get(
  "/:id",
  requireAuth,
  requirePermission("view_guests"),
  async (req, res) => {
    const id = req.params.id!;
    const found = await db.select().from(guests).where(eq(guests.id, id)).limit(1);
    if (!found.length) return fail(res, 404, "NOT_FOUND", "Guest not found");

    const [resStats, paidStats] = await Promise.all([
      // Stats span every reservation the guest is on:
      //   - booker        (reservations.guest_id = :id)
      //   - per-room occupant (reservation_rooms.guest_id = :id)
      //   - co-guest      (reservation_co_guests.guest_id = :id, migration 0020)
      // DISTINCT keeps a single reservation from being counted multiple
      // times when the guest plays more than one role on it.
      db.execute<{
        total: number;
        completed: number;
        upcoming: number;
        inHouse: number;
        cancelled: number;
        firstStay: string | null;
        lastStay: string | null;
        firstBooking: string | null;
      }>(sql`
        WITH guest_resv AS (
          SELECT DISTINCT r.id, r.status, r.check_in_date, r.check_out_date
          FROM ${reservations} r
          LEFT JOIN ${reservationRooms} rr ON rr.reservation_id = r.id
          LEFT JOIN ${reservationCoGuests} cg ON cg.reservation_id = r.id
          WHERE r.guest_id = ${id}
             OR rr.guest_id = ${id}
             OR cg.guest_id = ${id}
        )
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE status = 'checked_out')::int AS completed,
          COUNT(*) FILTER (WHERE status = 'confirmed')::int AS upcoming,
          COUNT(*) FILTER (WHERE status = 'checked_in')::int "inHouse",
          COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
          MIN(check_in_date) FILTER (WHERE status = 'checked_out') "firstStay",
          MAX(check_out_date) FILTER (WHERE status = 'checked_out') "lastStay",
          MIN(check_in_date) "firstBooking"
        FROM guest_resv
      `),
      // Total paid + balance due across the whole guest history.
      //
      // Both values are pulled from the single source of truth:
      //   - total_paid: SUM of non-voided, received payments
      //   - balance_due: SUM of reservations.balance_due (kept honest
      //     by the recompute helper on every money-event path)
      //
      // The old code derived the per-reservation balance from "latest
      // invoice's balance or the reservation's running number", which
      // was non-deterministic for per-room invoices with identical
      // created_at and over-counted multi-invoice bookings. Reservation
      // balanceDue is authoritative and avoids both bugs.
      //
      // Complimentary reservations are excluded — their money is
      // tracked in the Complimentary report, not lifetime spend.
      db.execute<{ total_paid: string; balance_due: string }>(sql`
        WITH guest_reservations AS (
          SELECT r.id, r.status, r.balance_due
          FROM ${reservations} r
          WHERE r.guest_id = ${id}
            AND r.booking_source <> 'complimentary'
        ),
        paid AS (
          SELECT COALESCE(SUM(p.amount::numeric), 0) AS total
          FROM ${payments} p
          INNER JOIN guest_reservations gr ON gr.id = p.reservation_id
          WHERE p.voided = false AND p.status = 'received'
        ),
        balances AS (
          SELECT COALESCE(SUM(
            CASE
              WHEN gr.status = 'cancelled' THEN 0
              ELSE gr.balance_due::numeric
            END
          ), 0) AS total
          FROM guest_reservations gr
        )
        SELECT
          (SELECT total FROM paid)::text AS total_paid,
          (SELECT total FROM balances)::text AS balance_due
      `),
    ]);

    const photoUrl = found[0]!.guestPhoto ? await signedKycUrl(found[0]!.guestPhoto) : null;
    const walletBalance = await getGuestBalance(id);

    const completedStays = resStats[0]?.completed ?? 0;
    const totalSpent = Number(
      (paidStats as unknown as { total_paid: string }[])[0]?.total_paid ?? 0,
    );
    // Recompute the lifecycle tags from the freshly-computed numbers
    // (0026 auto-tagging). Stored tags are merged in for the manual
    // custom additions; the system slots are overwritten on every
    // read so they can never drift from the underlying counts.
    const computedTags = mergeTagsForRead(found[0]!.tags as string[] | null, {
      createdAt: found[0]!.createdAt,
      isBlacklisted: found[0]!.isBlacklisted,
      gstin: found[0]!.gstin,
      completedStays,
      totalSpent,
    });

    return ok(res, {
      ...maskGuest(found[0]!, req.user!.role),
      tags: computedTags,
      photoUrl,
      walletBalance,
      stats: {
        totalStays: resStats[0]?.total ?? 0,
        completedStays,
        upcomingStays: resStats[0]?.upcoming ?? 0,
        inHouseStays: resStats[0]?.inHouse ?? 0,
        cancelledStays: resStats[0]?.cancelled ?? 0,
        firstStay: resStats[0]?.firstStay ?? null,
        lastStay: resStats[0]?.lastStay ?? null,
        firstBooking: resStats[0]?.firstBooking ?? null,
        totalSpent,
        balanceDue: Number(
          (paidStats as unknown as { balance_due: string }[])[0]?.balance_due ?? 0,
        ),
      },
    });
  },
);

router.post(
  "/",
  requireAuth,
  requirePermission("view_guests"),
  validate(guestCreateSchema),
  async (req, res) => {
    const input = req.body;
    // Normalise so "(987) 654-3210" and "9876543210" don't both
    // register as distinct guests. The duplicate check has to use the
    // same shape we'll store.
    const phone = normalisePhone(input.phone);
    const normalisedEmail =
      input.email && input.email.trim() !== ""
        ? input.email.trim().toLowerCase()
        : null;
    const idLast4 = last4(input.idProofNumber);

    // Triple uniqueness check. Phone, email, and (id_type + id_last4)
    // each identify one human; sharing any of them across two guest
    // rows is almost always a data-quality bug. We check all three in
    // a single query so staff can see all the collisions in one go,
    // and pick the existing guest instead of creating a duplicate.
    const dupConditions = [eq(guests.phone, phone)];
    if (normalisedEmail) {
      dupConditions.push(
        sql`LOWER(${guests.email}) = ${normalisedEmail}`,
      );
    }
    dupConditions.push(
      and(
        eq(guests.idProofType, input.idProofType),
        eq(guests.idProofLast4, idLast4),
      )!,
    );
    const dups = await db
      .select({
        id: guests.id,
        fullName: guests.fullName,
        phone: guests.phone,
        email: guests.email,
        idProofType: guests.idProofType,
        idProofLast4: guests.idProofLast4,
      })
      .from(guests)
      .where(or(...dupConditions))
      .limit(3);
    if (dups.length) {
      const reasons: ("phone" | "email" | "id")[] = [];
      for (const d of dups) {
        if (d.phone === phone) reasons.push("phone");
        if (
          normalisedEmail &&
          d.email &&
          d.email.trim().toLowerCase() === normalisedEmail
        ) {
          reasons.push("email");
        }
        if (
          d.idProofType === input.idProofType &&
          d.idProofLast4 === idLast4
        ) {
          reasons.push("id");
        }
      }
      const uniqueReasons = Array.from(new Set(reasons));
      const code =
        uniqueReasons.length === 1
          ? uniqueReasons[0] === "phone"
            ? "DUPLICATE_PHONE"
            : uniqueReasons[0] === "email"
              ? "DUPLICATE_EMAIL"
              : "DUPLICATE_ID"
          : "DUPLICATE_GUEST";
      const fieldList = uniqueReasons
        .map((r) => (r === "id" ? "ID number" : r))
        .join(" / ");
      return fail(
        res,
        409,
        code,
        `A guest with the same ${fieldList} already exists. Use the existing profile instead.`,
        { matches: dups, reasons: uniqueReasons },
      );
    }

    const propertyId = await resolveCurrentPropertyId(req);
    // Insert the guest + their first phone-history row atomically so
    // we can never have a guest without an open history row. (The
    // 0022 backfill seeds existing guests; this keeps new ones
    // consistent going forward.)
    //
    // The pre-flight collision check above runs OUTSIDE the tx, so a
    // race between two near-simultaneous creates can theoretically
    // slip a duplicate past it. The DB unique indexes (0030) are the
    // final guard — we catch 23505 here and turn it into the same
    // 409 the pre-flight would have returned, with the right code.
    let created: typeof guests.$inferSelect | null = null;
    try {
      created = await db.transaction(async (tx) => {
        const [row] = await tx
          .insert(guests)
          .values({
            propertyId,
            fullName: input.fullName,
            phone,
            email: input.email || null,
            gender: input.gender,
            idProofType: input.idProofType,
            idProofNumberEncrypted: encrypt(input.idProofNumber),
            idProofLast4: last4(input.idProofNumber),
            address: input.address || null,
            city: input.city || null,
            state: input.state || null,
            nationality: input.nationality || "Indian",
            dateOfBirth: input.dateOfBirth || null,
            companyName: input.companyName || null,
            gstin: input.gstin || null,
            notes: input.notes || null,
          })
          .returning();
        await tx.insert(guestPhoneHistory).values({
          guestId: row!.id,
          phone,
          // valid_from defaults to now() at the DB level; valid_to NULL
          // marks it as the currently-active phone.
        });
        return row!;
      });
    } catch (err) {
      const code = (err as { code?: string })?.code;
      const constraint = (err as { constraint?: string })?.constraint ?? "";
      if (code === "23505") {
        const isEmail = constraint.includes("email");
        const isId = constraint.includes("idproof");
        return fail(
          res,
          409,
          isEmail
            ? "DUPLICATE_EMAIL"
            : isId
              ? "DUPLICATE_ID"
              : "DUPLICATE_PHONE",
          isEmail
            ? "Email already registered to another guest"
            : isId
              ? "ID number already registered to another guest"
              : "Phone already registered to another guest",
        );
      }
      throw err;
    }

    await logActivity({
      action: "guest_created",
      entityType: "guest",
      entityId: created!.id,
      description: `Guest ${created!.fullName} added`,
      performedBy: req.user!.id,
      ipAddress: req.ip,
    });
    return ok(res, maskGuest(created!, req.user!.role), 201);
  },
);

router.put(
  "/:id",
  requireAuth,
  requirePermission("view_guests"),
  validate(guestUpdateSchema),
  async (req, res) => {
    const id = req.params.id!;
    const input = req.body;
    const update: Record<string, unknown> = { updatedAt: new Date() };
    // If the caller is changing the phone, normalise it the same way
    // we do for create + the resolver. We compare against the existing
    // row to decide whether to write a history transition.
    let nextPhone: string | undefined;
    if (typeof input.phone === "string") {
      nextPhone = normalisePhone(input.phone);
      update.phone = nextPhone;
    }
    for (const [k, v] of Object.entries(input)) {
      if (v === undefined) continue;
      if (k === "phone") continue; // already handled above
      if (k === "idProofNumber" && typeof v === "string") {
        update.idProofNumberEncrypted = encrypt(v);
        update.idProofLast4 = last4(v);
      } else {
        update[k] = v;
      }
    }

    // Wrap update + history transition in a transaction so we never
    // end up with the guest on a new number but no open history row
    // (or two open rows). The transition only fires when the phone
    // actually changes — re-saving the same phone is a no-op.
    //
    // The collision check lives INSIDE the transaction so two
    // concurrent updates to the same new phone can't both pass
    // pre-flight. We use a sentinel string (`__phone_collision__`)
    // returned from the transaction to communicate the 409 without
    // throwing — throwing inside a tx rolls back, which is what we
    // want, but it'd also bubble as a generic 500 unless caught
    // separately. The Postgres unique-index error is still caught
    // outside as a belt-and-braces fallback.
    const TX_NOT_FOUND = "__not_found__" as const;
    const TX_COLLISION = "__phone_collision__" as const;
    // Pre-compute the candidate values we'll check for collisions so
    // the in-tx probe stays simple. Empty strings are treated as null
    // (no email).
    const nextEmail =
      typeof input.email === "string" && input.email.trim() !== ""
        ? input.email.trim().toLowerCase()
        : input.email === null
          ? null
          : undefined;
    const nextIdType =
      typeof input.idProofType === "string"
        ? (input.idProofType as import("@hoteldesk/shared").IdProofType)
        : undefined;
    const nextIdLast4 =
      typeof input.idProofNumber === "string"
        ? last4(input.idProofNumber)
        : undefined;

    let updated: typeof guests.$inferSelect | null = null;
    let collisionReason: "phone" | "email" | "id" | null = null;
    try {
      const result = await db.transaction(async (tx) => {
        const [before] = await tx
          .select({
            phone: guests.phone,
            email: guests.email,
            idProofType: guests.idProofType,
            idProofLast4: guests.idProofLast4,
          })
          .from(guests)
          .where(eq(guests.id, id))
          .limit(1);
        if (!before) return TX_NOT_FOUND;

        if (nextPhone && nextPhone !== before.phone) {
          const collision = await tx
            .select({ id: guests.id })
            .from(guests)
            .where(eq(guests.phone, nextPhone))
            .limit(1);
          if (collision.length && collision[0]!.id !== id) {
            collisionReason = "phone";
            return TX_COLLISION;
          }
        }

        // Email collision — only check when the caller actually wrote
        // a non-empty email AND it differs from what's stored.
        if (
          nextEmail &&
          (before.email ?? "").trim().toLowerCase() !== nextEmail
        ) {
          const collision = await tx
            .select({ id: guests.id })
            .from(guests)
            .where(sql`LOWER(${guests.email}) = ${nextEmail}`)
            .limit(1);
          if (collision.length && collision[0]!.id !== id) {
            collisionReason = "email";
            return TX_COLLISION;
          }
        }

        // ID collision — when either ID type or number changed,
        // re-probe against the (type, last4) pair.
        const effIdType = nextIdType ?? before.idProofType;
        const effIdLast4 = nextIdLast4 ?? before.idProofLast4;
        const idChanged =
          (nextIdType !== undefined && nextIdType !== before.idProofType) ||
          (nextIdLast4 !== undefined && nextIdLast4 !== before.idProofLast4);
        if (idChanged && effIdLast4) {
          const collision = await tx
            .select({ id: guests.id })
            .from(guests)
            .where(
              and(
                eq(guests.idProofType, effIdType),
                eq(guests.idProofLast4, effIdLast4),
              ),
            )
            .limit(1);
          if (collision.length && collision[0]!.id !== id) {
            collisionReason = "id";
            return TX_COLLISION;
          }
        }

        const [row] = await tx
          .update(guests)
          .set(update)
          .where(eq(guests.id, id))
          .returning();

        if (nextPhone && nextPhone !== before.phone) {
          // Close the currently-active history row (if any), then
          // open a new one for the new number. valid_to defaults to
          // NULL on INSERT — only the close needs an explicit
          // timestamp.
          await tx
            .update(guestPhoneHistory)
            .set({ validTo: new Date() })
            .where(
              and(
                eq(guestPhoneHistory.guestId, id),
                isNull(guestPhoneHistory.validTo),
              ),
            );
          await tx.insert(guestPhoneHistory).values({
            guestId: id,
            phone: nextPhone,
          });
        }
        return row;
      });

      if (result === TX_NOT_FOUND)
        return fail(res, 404, "NOT_FOUND", "Guest not found");
      if (result === TX_COLLISION) {
        const code =
          collisionReason === "email"
            ? "DUPLICATE_EMAIL"
            : collisionReason === "id"
              ? "DUPLICATE_ID"
              : "DUPLICATE_PHONE";
        const fieldWord =
          collisionReason === "email"
            ? "Email"
            : collisionReason === "id"
              ? "ID number"
              : "Phone";
        return fail(
          res,
          409,
          code,
          `${fieldWord} already registered to another guest`,
        );
      }
      updated = result ?? null;
    } catch (err) {
      // Belt-and-braces: if any unique index on guests catches a
      // collision we somehow missed (e.g. an INSERT racing in between
      // the SELECT and UPDATE inside the transaction), turn it into a
      // clean 409. Constraint name disambiguates which identifier
      // collided so the message stays accurate.
      const code = (err as { code?: string })?.code;
      const constraint = (err as { constraint?: string })?.constraint ?? "";
      if (code === "23505") {
        const isEmail = constraint.includes("email");
        const isId = constraint.includes("idproof");
        return fail(
          res,
          409,
          isEmail
            ? "DUPLICATE_EMAIL"
            : isId
              ? "DUPLICATE_ID"
              : "DUPLICATE_PHONE",
          isEmail
            ? "Email already registered to another guest"
            : isId
              ? "ID number already registered to another guest"
              : "Phone already registered to another guest",
        );
      }
      throw err;
    }

    if (!updated) return fail(res, 404, "NOT_FOUND", "Guest not found");

    await logActivity({
      action: "guest_updated",
      entityType: "guest",
      entityId: id,
      description: `Guest ${updated.fullName} updated`,
      performedBy: req.user!.id,
      ipAddress: req.ip,
    });
    return ok(res, maskGuest(updated, req.user!.role));
  },
);

router.post(
  "/:id/kyc",
  requireAuth,
  requirePermission("view_guests"),
  upload.fields([
    { name: "front", maxCount: 1 },
    { name: "back", maxCount: 1 },
    { name: "photo", maxCount: 1 },
  ]),
  async (req, res) => {
    const id = req.params.id!;
    const existing = await db.select().from(guests).where(eq(guests.id, id)).limit(1);
    if (!existing.length) return fail(res, 404, "NOT_FOUND", "Guest not found");

    const files = req.files as Record<string, Express.Multer.File[]> | undefined;
    const front = files?.front?.[0];
    const back = files?.back?.[0];
    const photo = files?.photo?.[0];
    if (!front && !existing[0]!.idProofPhotoFront) {
      return fail(res, 400, "FRONT_REQUIRED", "Front of ID proof is required");
    }
    if (!photo && !existing[0]!.guestPhoto) {
      return fail(res, 400, "PHOTO_REQUIRED", "Customer photo is required");
    }
    if (!front && !back && !photo) {
      return fail(res, 400, "NO_FILE", "No file provided");
    }

    if (front) {
      const frontErr = validateKycFile(front);
      if (frontErr) return fail(res, 400, "INVALID_FILE", frontErr);
    }
    if (back) {
      const backErr = validateKycFile(back);
      if (backErr) return fail(res, 400, "INVALID_FILE", backErr);
    }
    if (photo) {
      const photoErr = validateKycFile(photo);
      if (photoErr) return fail(res, 400, "INVALID_FILE", photoErr);
    }

    // Files land in a name+phone folder ("Ajay-9347868290") so an operator
    // browsing the storage drive can tell whose documents these are.
    const folder = storageFolderLabel(
      existing[0]!.fullName,
      existing[0]!.phone?.replace(/\D/g, "") || id.slice(0, 8),
    );
    const frontPath = front ? await uploadKycPhoto(folder, "front", front) : null;
    const backPath = back ? await uploadKycPhoto(folder, "back", back) : null;
    const photoPath = photo ? await uploadKycPhoto(folder, "photo", photo) : null;

    const [updated] = await db
      .update(guests)
      .set({
        idProofPhotoFront: frontPath ?? existing[0]!.idProofPhotoFront,
        idProofPhotoBack: backPath ?? existing[0]!.idProofPhotoBack,
        guestPhoto: photoPath ?? existing[0]!.guestPhoto,
        kycVerifiedAt: new Date(),
        kycVerifiedBy: req.user!.id,
        updatedAt: new Date(),
      })
      .where(eq(guests.id, id))
      .returning();

    await logActivity({
      action: "kyc_uploaded",
      entityType: "guest",
      entityId: id,
      description: `KYC documents uploaded for ${updated!.fullName}`,
      performedBy: req.user!.id,
      ipAddress: req.ip,
    });

    return ok(res, {
      kycVerifiedAt: updated!.kycVerifiedAt,
      idProofPhotoFront: updated!.idProofPhotoFront,
      idProofPhotoBack: updated!.idProofPhotoBack,
      guestPhoto: updated!.guestPhoto,
    });
  },
);

router.get(
  "/:id/kyc",
  requireAuth,
  requirePermission("view_guests"),
  async (req, res) => {
    const id = req.params.id!;
    const found = await db.select().from(guests).where(eq(guests.id, id)).limit(1);
    if (!found.length) return fail(res, 404, "NOT_FOUND", "Guest not found");
    const g = found[0]!;
    const [frontUrl, backUrl, photoUrl] = await Promise.all([
      g.idProofPhotoFront ? signedKycUrl(g.idProofPhotoFront) : null,
      g.idProofPhotoBack ? signedKycUrl(g.idProofPhotoBack) : null,
      g.guestPhoto ? signedKycUrl(g.guestPhoto) : null,
    ]);
    return ok(res, {
      verified: g.kycVerifiedAt !== null && !!g.guestPhoto,
      kycVerifiedAt: g.kycVerifiedAt,
      frontUrl,
      backUrl,
      photoUrl,
    });
  },
);

// Delete a single KYC file (photo, front, or back). Sets the column to
// NULL and removes the file from the storage bucket. Used when staff
// accidentally uploaded the wrong document and wants to clear it
// without immediately replacing it.
router.delete(
  "/:id/kyc/:field",
  requireAuth,
  requirePermission("view_guests"),
  async (req, res) => {
    const { id, field } = req.params as { id: string; field: string };
    const columnMap: Record<string, "guestPhoto" | "idProofPhotoFront" | "idProofPhotoBack"> = {
      photo: "guestPhoto",
      front: "idProofPhotoFront",
      back: "idProofPhotoBack",
    };
    const col = columnMap[field];
    if (!col) return fail(res, 400, "INVALID_FIELD", "field must be photo, front, or back");

    const [g] = await db.select().from(guests).where(eq(guests.id, id)).limit(1);
    if (!g) return fail(res, 404, "NOT_FOUND", "Guest not found");

    const storagePath = g[col];
    if (!storagePath) return ok(res, { deleted: false });

    await deleteKycFile(storagePath);
    await db
      .update(guests)
      .set({ [col]: null, updatedAt: new Date() })
      .where(eq(guests.id, id));

    await logActivity({
      action: "kyc_deleted",
      entityType: "guest",
      entityId: id,
      description: `Deleted KYC ${field} for ${g.fullName}`,
      performedBy: req.user!.id,
      ipAddress: req.ip,
    });

    return ok(res, { deleted: true });
  },
);

router.patch(
  "/:id/tags",
  requireAuth,
  requirePermission("view_guests"),
  validate(guestTagsSchema),
  async (req, res) => {
    const id = req.params.id!;
    const { tags } = req.body as { tags: string[] };
    // Strip any system-managed tags ("First Time", "Repeat", "VIP",
    // "High Value", "Corporate", "Blacklist") — those are computed
    // from the underlying numbers on every read, so admin can't pin
    // or remove them. Whatever's left is the manual custom tags.
    const onlyManual = sanitizeTagsForWrite(tags);
    const normalized = Array.from(
      new Set(onlyManual.map((t) => t.trim().toLowerCase()).filter(Boolean)),
    );
    const [updated] = await db
      .update(guests)
      .set({ tags: normalized, updatedAt: new Date() })
      .where(eq(guests.id, id))
      .returning();
    if (!updated) return fail(res, 404, "NOT_FOUND", "Guest not found");

    await logActivity({
      action: "guest_tags_updated",
      entityType: "guest",
      entityId: id,
      description: `Tags: ${normalized.join(", ") || "(none)"}`,
      performedBy: req.user!.id,
      ipAddress: req.ip,
    });
    return ok(res, { tags: normalized });
  },
);

// Toggle the VIP flag. VIP is a soft commercial label — it highlights
// the guest row in reservations + sends an internal notification to
// front-desk when the guest creates a new booking. No financial impact.
const vipSchema = z.object({ isVip: z.boolean() });
router.patch(
  "/:id/vip",
  requireAuth,
  requirePermission("edit_guests"),
  validate(vipSchema),
  async (req, res) => {
    const id = req.params.id!;
    const { isVip } = req.body as z.infer<typeof vipSchema>;
    const [updated] = await db
      .update(guests)
      .set({ isVip, updatedAt: new Date() })
      .where(eq(guests.id, id))
      .returning();
    if (!updated) return fail(res, 404, "NOT_FOUND", "Guest not found");
    await logActivity({
      action: isVip ? "guest_vip_set" : "guest_vip_cleared",
      entityType: "guest",
      entityId: id,
      description: `${updated.fullName} ${isVip ? "marked VIP" : "VIP cleared"}`,
      performedBy: req.user!.id,
      ipAddress: req.ip,
    });
    return ok(res, { isVip: updated.isVip });
  },
);

// Blacklist a guest. Blocks all future reservation creates for them.
// Requires manage_settings (admin/manager) — this is a heavy action that
// will refuse business at the front desk. Reason is mandatory so the
// audit log captures the why.
const blacklistSchema = z.discriminatedUnion("isBlacklisted", [
  z.object({ isBlacklisted: z.literal(true), reason: z.string().min(3).max(500) }),
  z.object({ isBlacklisted: z.literal(false) }),
]);
router.patch(
  "/:id/blacklist",
  requireAuth,
  requirePermission("manage_settings"),
  validate(blacklistSchema),
  async (req, res) => {
    const id = req.params.id!;
    const input = req.body as z.infer<typeof blacklistSchema>;
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (input.isBlacklisted) {
      patch.isBlacklisted = true;
      patch.blacklistReason = input.reason;
      patch.blacklistedAt = new Date();
      patch.blacklistedBy = req.user!.id;
    } else {
      patch.isBlacklisted = false;
      patch.blacklistReason = null;
      patch.blacklistedAt = null;
      patch.blacklistedBy = null;
    }
    const [updated] = await db
      .update(guests)
      .set(patch)
      .where(eq(guests.id, id))
      .returning();
    if (!updated) return fail(res, 404, "NOT_FOUND", "Guest not found");
    await logActivity({
      action: input.isBlacklisted ? "guest_blacklisted" : "guest_unblacklisted",
      entityType: "guest",
      entityId: id,
      description: input.isBlacklisted
        ? `${updated.fullName} blacklisted: ${input.reason}`
        : `${updated.fullName} removed from blacklist`,
      performedBy: req.user!.id,
      ipAddress: req.ip,
    });
    return ok(res, {
      isBlacklisted: updated.isBlacklisted,
      blacklistReason: updated.blacklistReason,
    });
  },
);

// Free-form preferences. We accept any jsonb but soft-validate the
// known keys so the UI can render structured pickers. Unknown keys
// pass through unchanged.
const preferencesSchema = z.object({
  preferences: z
    .object({
      smoking: z.boolean().optional(),
      floor: z.enum(["low", "mid", "high"]).optional(),
      pillow: z.enum(["soft", "firm"]).optional(),
      wakeup_time: z
        .string()
        .regex(/^([01]?\d|2[0-3]):[0-5]\d$/)
        .optional(),
      dietary: z.array(z.string().min(1).max(40)).max(10).optional(),
    })
    .catchall(z.unknown()),
});
router.patch(
  "/:id/preferences",
  requireAuth,
  requirePermission("edit_guests"),
  validate(preferencesSchema),
  async (req, res) => {
    const id = req.params.id!;
    const { preferences } = req.body as z.infer<typeof preferencesSchema>;
    const [updated] = await db
      .update(guests)
      .set({ preferences, updatedAt: new Date() })
      .where(eq(guests.id, id))
      .returning();
    if (!updated) return fail(res, 404, "NOT_FOUND", "Guest not found");
    await logActivity({
      action: "guest_preferences_updated",
      entityType: "guest",
      entityId: id,
      description: `Preferences updated for ${updated.fullName}`,
      performedBy: req.user!.id,
      ipAddress: req.ip,
      metadata: { preferences },
    });
    return ok(res, { preferences: updated.preferences });
  },
);

// DPDP-aligned consent capture. Records WHEN consent was given and via
// which channel. Setting `granted: false` revokes consent (clears the
// timestamp) so marketing dispatch helpers stop sending.
const consentSchema = z.object({
  granted: z.boolean(),
  channel: z.enum(["whatsapp", "sms", "email", "in_person"]).optional(),
});
router.patch(
  "/:id/consent",
  requireAuth,
  requirePermission("edit_guests"),
  validate(consentSchema),
  async (req, res) => {
    const id = req.params.id!;
    const { granted, channel } = req.body as z.infer<typeof consentSchema>;
    const [updated] = await db
      .update(guests)
      .set({
        marketingConsentAt: granted ? new Date() : null,
        marketingConsentChannel: granted ? channel ?? "in_person" : null,
        updatedAt: new Date(),
      })
      .where(eq(guests.id, id))
      .returning();
    if (!updated) return fail(res, 404, "NOT_FOUND", "Guest not found");
    await logActivity({
      action: granted ? "guest_consent_granted" : "guest_consent_revoked",
      entityType: "guest",
      entityId: id,
      description: granted
        ? `Marketing consent granted via ${channel ?? "in_person"}`
        : "Marketing consent revoked",
      performedBy: req.user!.id,
      ipAddress: req.ip,
    });
    return ok(res, {
      marketingConsentAt: updated.marketingConsentAt,
      marketingConsentChannel: updated.marketingConsentChannel,
    });
  },
);

router.get(
  "/:id/notes",
  requireAuth,
  requirePermission("view_guests"),
  async (req, res) => {
    const id = req.params.id!;
    const rows = await db
      .select()
      .from(guestNotes)
      .where(eq(guestNotes.guestId, id))
      .orderBy(desc(guestNotes.createdAt));
    return ok(res, rows);
  },
);

router.post(
  "/:id/notes",
  requireAuth,
  requirePermission("view_guests"),
  validate(guestNoteCreateSchema),
  async (req, res) => {
    const id = req.params.id!;
    const { body } = req.body as { body: string };
    const guestExists = await db.select({ id: guests.id }).from(guests).where(eq(guests.id, id)).limit(1);
    if (!guestExists.length) return fail(res, 404, "NOT_FOUND", "Guest not found");

    const [created] = await db
      .insert(guestNotes)
      .values({ guestId: id, body, authorId: req.user!.id })
      .returning();
    return ok(res, created, 201);
  },
);

router.get(
  "/:id/follow-ups",
  requireAuth,
  requirePermission("view_guests"),
  async (req, res) => {
    const id = req.params.id!;
    const rows = await db
      .select()
      .from(guestFollowUps)
      .where(eq(guestFollowUps.guestId, id))
      .orderBy(asc(guestFollowUps.dueDate));
    return ok(res, rows);
  },
);

router.post(
  "/:id/follow-ups",
  requireAuth,
  requirePermission("view_guests"),
  validate(followUpCreateSchema),
  async (req, res) => {
    const id = req.params.id!;
    const input = req.body as { task: string; dueDate: string; assignedTo?: string | null };
    const guestExists = await db.select({ id: guests.id }).from(guests).where(eq(guests.id, id)).limit(1);
    if (!guestExists.length) return fail(res, 404, "NOT_FOUND", "Guest not found");

    const [created] = await db
      .insert(guestFollowUps)
      .values({
        guestId: id,
        task: input.task,
        dueDate: input.dueDate,
        assignedTo: input.assignedTo ?? null,
        createdBy: req.user!.id,
      })
      .returning();

    await logActivity({
      action: "followup_created",
      entityType: "guest",
      entityId: id,
      description: `Follow-up: ${input.task} (due ${input.dueDate})`,
      performedBy: req.user!.id,
      ipAddress: req.ip,
    });
    return ok(res, created, 201);
  },
);

router.patch(
  "/:id/follow-ups/:followUpId",
  requireAuth,
  requirePermission("view_guests"),
  validate(followUpUpdateSchema),
  async (req, res) => {
    const { followUpId } = req.params as { followUpId: string };
    const input = req.body as {
      status?: "pending" | "done" | "cancelled";
      task?: string;
      dueDate?: string;
      assignedTo?: string | null;
    };
    const patch: Record<string, unknown> = {};
    if (input.status !== undefined) {
      patch.status = input.status;
      patch.completedAt = input.status === "done" ? new Date() : null;
    }
    if (input.task !== undefined) patch.task = input.task;
    if (input.dueDate !== undefined) patch.dueDate = input.dueDate;
    if (input.assignedTo !== undefined) patch.assignedTo = input.assignedTo;

    const [updated] = await db
      .update(guestFollowUps)
      .set(patch)
      .where(eq(guestFollowUps.id, followUpId))
      .returning();
    if (!updated) return fail(res, 404, "NOT_FOUND", "Follow-up not found");
    return ok(res, updated);
  },
);

router.get(
  "/follow-ups/due",
  requireAuth,
  requirePermission("view_guests"),
  async (req, res) => {
    const days = Math.min(30, Math.max(0, Number((req.query as { days?: string }).days ?? 7)));
    const rows = await db
      .select({
        id: guestFollowUps.id,
        guestId: guestFollowUps.guestId,
        guestName: guests.fullName,
        guestPhone: guests.phone,
        task: guestFollowUps.task,
        dueDate: guestFollowUps.dueDate,
        status: guestFollowUps.status,
        assignedTo: guestFollowUps.assignedTo,
      })
      .from(guestFollowUps)
      .innerJoin(guests, eq(guests.id, guestFollowUps.guestId))
      .where(
        and(
          eq(guestFollowUps.status, "pending"),
          sql`${guestFollowUps.dueDate} <= (CURRENT_DATE + ${days}::int)`,
        ),
      )
      .orderBy(asc(guestFollowUps.dueDate));
    return ok(res, rows);
  },
);

// Cleanup for an abandoned booking. The new-reservation flow creates the
// guest BEFORE the OTP step (OTP is anchored on a guestId), so if staff
// close the OTP modal without confirming, the guest row would otherwise
// linger as an orphan with no reservation. This endpoint removes exactly
// that orphan — and ONLY that.
//
// Two hard guards make it impossible to touch an established record:
//   1. Zero reservation links (booker / occupant / co-guest). Same check
//      the real delete uses.
//   2. Created within the last 30 minutes. An old guest can never be
//      swept by an abandoned booking.
// It runs under view_reservations (the same permission as creating a
// reservation) so front-desk staff who can book can also undo their own
// abandoned booking without holding delete_guests.
router.post(
  "/:id/abandon-cleanup",
  requireAuth,
  requirePermission("view_reservations"),
  async (req, res) => {
    const id = req.params.id!;

    const [g] = await db.select().from(guests).where(eq(guests.id, id)).limit(1);
    if (!g) return ok(res, { deleted: false, reason: "not_found" });

    // Guard 2: never sweep a guest that's been on file for a while.
    const ageMs = Date.now() - new Date(g.createdAt).getTime();
    if (ageMs > 30 * 60 * 1000) {
      return ok(res, { deleted: false, reason: "too_old" });
    }

    // Guard 1: any reservation link means this guest belongs to a real
    // booking — leave it alone.
    const [bookerCount, occupantCount, coGuestCount] = await Promise.all([
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(reservations)
        .where(eq(reservations.guestId, id)),
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(reservationRooms)
        .where(eq(reservationRooms.guestId, id)),
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(reservationCoGuests)
        .where(eq(reservationCoGuests.guestId, id)),
    ]);
    if (
      (bookerCount[0]?.n ?? 0) +
        (occupantCount[0]?.n ?? 0) +
        (coGuestCount[0]?.n ?? 0) >
      0
    ) {
      return ok(res, { deleted: false, reason: "has_stays" });
    }

    await db.transaction(async (tx) => {
      await tx.delete(guestPhoneHistory).where(eq(guestPhoneHistory.guestId, id));
      await tx.delete(guests).where(eq(guests.id, id));
    });

    // Best-effort KYC cleanup — storage failures must not fail the request.
    const kycPaths = [g.guestPhoto, g.idProofPhotoFront, g.idProofPhotoBack].filter(
      (p): p is string => !!p,
    );
    for (const p of kycPaths) {
      try {
        await deleteKycFile(p);
      } catch (err) {
        logger.warn({ err, path: p }, "kyc cleanup failed during abandon-cleanup");
      }
    }

    logger.info({ guestId: id }, "abandoned-booking guest swept");
    return ok(res, { deleted: true });
  },
);

router.delete("/:id", requireAuth, requirePermission("delete_guests"), async (req, res) => {
  const id = req.params.id!;

  // Refuse the delete if the guest has any stay history. A guest tied
  // to a reservation (as booker, per-room occupant, or co-guest) is an
  // accounting record we mustn't lose — staff should void / cancel the
  // bookings first, or just keep the guest. Returns 409 with the count
  // so the UI can explain the block.
  const [bookerCount, occupantCount, coGuestCount] = await Promise.all([
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(reservations)
      .where(eq(reservations.guestId, id)),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(reservationRooms)
      .where(eq(reservationRooms.guestId, id)),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(reservationCoGuests)
      .where(eq(reservationCoGuests.guestId, id)),
  ]);
  const totalStays =
    (bookerCount[0]?.n ?? 0) +
    (occupantCount[0]?.n ?? 0) +
    (coGuestCount[0]?.n ?? 0);
  if (totalStays > 0) {
    return fail(
      res,
      409,
      "HAS_STAYS",
      `Cannot delete: guest is on ${totalStays} reservation${totalStays === 1 ? "" : "s"}. Cancel or void those first.`,
      {
        bookerCount: bookerCount[0]?.n ?? 0,
        occupantCount: occupantCount[0]?.n ?? 0,
        coGuestCount: coGuestCount[0]?.n ?? 0,
      },
    );
  }

  // Pull the row up front so we can (a) clean up KYC files from
  // storage and (b) log the name in activity after the row is gone.
  const [existing] = await db
    .select()
    .from(guests)
    .where(eq(guests.id, id))
    .limit(1);
  if (!existing) return fail(res, 404, "NOT_FOUND", "Guest not found");

  // Delete the row + dependent phone history in one tx. The phone
  // history FK has ON DELETE CASCADE in the schema, but explicit
  // delete keeps the intent visible and survives schema drift.
  await db.transaction(async (tx) => {
    await tx
      .delete(guestPhoneHistory)
      .where(eq(guestPhoneHistory.guestId, id));
    await tx.delete(guests).where(eq(guests.id, id));
  });

  // Best-effort KYC cleanup — storage failures shouldn't roll back
  // the DB delete (the row is the source of truth; an orphaned
  // file is recoverable, an orphaned row isn't).
  const kycPaths = [
    existing.guestPhoto,
    existing.idProofPhotoFront,
    existing.idProofPhotoBack,
  ].filter((p): p is string => !!p);
  for (const p of kycPaths) {
    try {
      await deleteKycFile(p);
    } catch (err) {
      logger.warn({ err, path: p }, "kyc cleanup failed during guest delete");
    }
  }

  await logActivity({
    action: "guest_deleted",
    entityType: "guest",
    entityId: id,
    description: `Guest ${existing.fullName} deleted`,
    performedBy: req.user!.id,
    ipAddress: req.ip,
  });
  return ok(res, { deleted: true });
});

export default router;
