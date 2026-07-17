import { z } from "zod";
import { BOOKING_SOURCES, PAYMENT_METHODS, RESERVATION_STATUSES } from "../enums.js";
import {
  MAINTENANCE_CATEGORIES,
  MAINTENANCE_SEVERITIES,
} from "./maintenance.js";

export const STAY_TYPES = ["overnight", "short_stay"] as const;
export type StayType = (typeof STAY_TYPES)[number];

export const reservationCreateSchema = z
  .object({
    guestId: z.string().uuid(),
    rooms: z
      .array(
        z.object({
          roomId: z.string().uuid(),
          ratePerNight: z.coerce.number().positive(),
          soldAsType: z.string().min(1).max(64).optional().nullable(),
          // Extra beds (additional persons over the room's base
          // max_occupancy). extraBedRate is the per-night, per-person
          // fee the client read from the room type's extraPersonRate.
          // Both default 0 (no extra beds). The server re-derives the
          // amount and folds it into the room tariff + GST.
          extraBeds: z.coerce.number().int().min(0).max(10).optional().default(0),
          extraBedRate: z.coerce.number().min(0).optional().default(0),
        }),
      )
      .min(1),
    checkInDate: z.string().date(),
    checkOutDate: z.string().date(),
    // Staff-picked arrival / departure clock times (0023). Planned /
    // display-only — the system still uses the dates for billing and
    // conflict detection. Stored as ISO timestamps with the property
    // timezone baked in by the client. Both optional; missing => fall
    // back to property policy times.
    plannedCheckInAt: z.string().datetime({ offset: true }).optional(),
    plannedCheckOutAt: z.string().datetime({ offset: true }).optional(),
    // Day-use vs night-based booking. For short_stay:
    //   - checkInDate == checkOutDate
    //   - durationHours is required (3..23.5, in 0.5 steps)
    //   - ratePerNight on each room is interpreted as the FLAT price for the
    //     chosen duration (the client computes it from the room type's
    //     short_stay_bands, or pro-rates the custom hours).
    stayType: z.enum(STAY_TYPES).optional().default("overnight"),
    durationHours: z.coerce.number().min(1).max(23.5).optional(),
    // Optional human label persisted on the reservation's specialRequests
    // companion field — for documents like "Day use · 6 hours".
    shortStayLabel: z.string().max(64).optional(),
    numAdults: z.coerce.number().int().min(1).default(1),
    numChildren: z.coerce.number().int().min(0).default(0),
    advancePaid: z.coerce.number().min(0).default(0),
    advancePaymentMethod: z.enum(PAYMENT_METHODS).optional(),
    specialRequests: z.string().max(1000).optional().nullable(),
    bookingSource: z.enum(BOOKING_SOURCES).optional().default("walkin"),
    creditNotes: z.string().max(500).optional().nullable(),
    // Wallet credit to apply as a discount on this booking. Capped server-side
    // at min(guest wallet balance, reservation grand total).
    useWalletCredit: z.coerce.number().min(0).optional().default(0),
    // OTP code, when the create flow uses the "verify first, then create"
    // pattern. The server looks up the most recent un-consumed
    // checkin-purpose OTP for this guest, checks the code, marks it
    // consumed inside the same transaction as the reservation insert, then
    // proceeds. Omitting this rejects the create unless skipOtp is set.
    otpCode: z.string().min(4).max(8).optional(),
    // Explicit opt-out of OTP verification for this booking. Staff toggle
    // this off on the New Reservation form when the guest can't receive a
    // code (no phone/OTP failure). Requires this to be an intentional flag
    // rather than a silently-absent otpCode so a client can't bypass OTP by
    // just not sending it.
    skipOtp: z.boolean().optional().default(false),
    // Co-guests (migration 0020). Additional adults whose KYC was
    // captured at booking. At least one is expected when numAdults >= 2,
    // but the desk may record every accompanying adult for larger groups.
    // Each id must be a real Guest row; the booker can't be among them.
    // Capped generously to bound the insert without limiting real groups.
    coGuestIds: z.array(z.string().uuid()).max(20).optional().default([]),
  })
  .superRefine((d, ctx) => {
    if (d.stayType === "short_stay") {
      if (d.checkInDate !== d.checkOutDate) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["checkOutDate"],
          message: "short_stay must have check_out_date == check_in_date",
        });
      }
      if (d.durationHours === undefined || d.durationHours <= 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["durationHours"],
          message: "durationHours is required for short_stay",
        });
      }
    } else if (new Date(d.checkOutDate) <= new Date(d.checkInDate)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["checkOutDate"],
        message: "check_out_date must be after check_in_date",
      });
    }
    // Co-guest is OPTIONAL for 2+ adults. If staff captures the second
    // occupant's KYC at booking we store it; if not, the booking still
    // goes through. Front-desk policy decides when to collect it.
    // Booker can't also be listed as a co-guest.
    if (d.coGuestIds?.some((id) => id === d.guestId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["coGuestIds"],
        message: "Booker can't also be a co-guest",
      });
    }
  });

export const reservationListQuerySchema = z.object({
  status: z.enum(RESERVATION_STATUSES).optional(),
  date: z.string().optional(),
  q: z.string().trim().min(1).max(100).optional(),
  date_from: z.string().date().optional(),
  date_to: z.string().date().optional(),
  // Filter by a specific room or floor. Both look at the reservation's
  // reservation_rooms join — a reservation that spans multiple rooms
  // matches if ANY of its rooms satisfies the filter.
  room_id: z.string().uuid().optional(),
  floor: z.coerce.number().int().min(0).max(99).optional(),
  // Complimentary bookings are hidden from the default list — they only
  // show up under Reports → Complimentary. Pass include_complimentary=true
  // to override (admin tooling, audits, etc).
  include_complimentary: z
    .union([z.literal("true"), z.literal("false")])
    .optional()
    .transform((v) => v === "true"),
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(25),
});

export const checkInSchema = z.object({
  advancePayment: z.coerce.number().min(0).optional(),
  paymentMethod: z.enum(PAYMENT_METHODS).optional(),
});

export const checkOutSchema = z.object({
  finalPayment: z.coerce.number().min(0).optional(),
  paymentMethod: z.enum(PAYMENT_METHODS).optional(),
  paymentNotes: z.string().max(500).optional(),
  refundMode: z.enum(["cash", "credit"]).optional(),
  refundNote: z.string().max(500).optional(),
  // How to bill the remaining un-invoiced rooms. Default 'per_room' issues
  // one invoice per still-open room (each guest can take their own GST
  // invoice). 'combined' rolls every remaining room + reservation-wide
  // charges into a single invoice — the legacy behaviour, kept as an
  // opt-in for groups who want one consolidated bill.
  invoiceMode: z.enum(["per_room", "combined"]).optional().default("per_room"),
});

// Mark a confirmed reservation as no-show. Standard hotel policy: the
// advance (if any) is forfeit — it stays on the books as revenue and
// is not refunded. Note is required so the audit log explains the
// decision (e.g. "no contact after 9pm deadline").
export const noShowSchema = z.object({
  note: z.string().min(1).max(500),
});

// Refund destinations supported by the cancel-reservation flow.
//   - cash / upi / card / bank_transfer: hand the money back to the
//     guest, recorded as a single negative payment row whose
//     paymentMethod matches the chosen destination (so reports break
//     down by channel).
//   - credit: move the refundable amount into the guest's wallet as
//     a credit_issued ledger entry. No payment row is created.
// Backward-compat: omitting the field defaults to "cash".
export const REFUND_MODES = [
  "cash",
  "upi",
  "card",
  "bank_transfer",
  "credit",
] as const;
export type RefundMode = (typeof REFUND_MODES)[number];

export const cancelSchema = z.object({
  cancellationReason: z.string().min(1).max(500),
  // What to do with the advance paid by the guest. Required only when
  // an advance was actually collected — server enforces.
  refundMode: z.enum(REFUND_MODES).optional(),
  // Optional cancellation fee withheld from the advance — late-cancel
  // penalty, no-show conversion, admin charge, etc. Recorded as revenue
  // against the cancelled reservation. The refundable amount is
  // (advance_paid - cancellationFee), clamped at 0.
  cancellationFee: z.number().nonnegative().optional().default(0),
});

// Convert a reservation's invoice layout between per-room and
// combined. Voids the live invoice(s), reissues with the new shape,
// and reattaches every non-voided payment to the new invoice(s) so
// the books reconcile without manual intervention. Used when staff
// realises mid-stay that the original choice was wrong (e.g. corp
// guest wants one combined bill after rooms were already issued
// per-room).
export const convertInvoicesSchema = z.object({
  mode: z.enum(["combined", "per_room"]),
});

// Reclassify an existing reservation as complimentary after the fact.
// Reason is required so the audit log + complimentary report stay useful;
// approver is the optional human name of who authorized the comp (owner,
// manager-on-duty, etc).
export const makeComplimentarySchema = z.object({
  reason: z.string().min(1).max(500),
  approver: z.string().max(120).optional().nullable(),
});

export const swapRoomSchema = z.object({
  newRoomId: z.string().uuid(),
});

// Mid-stay room swap. Closes the current reservation_rooms row at
// `effectiveDate` and inserts a new row pointing at `toRoomId` for the
// remainder of the stay. Charges, rate, GST, advance — none of it moves;
// only the physical room (and its housekeeping state).
//
// - fromReservationRoomId: the reservation_rooms.id currently holding the
//   room being vacated (so we can target the right row on a multi-room
//   booking).
// - effectiveDate: the date from which the guest occupies the new room.
//   Must lie strictly inside the current segment's effective window.
// - markOldRoomStatus: what to set the vacated room's status to. Defaults
//   to "maintenance" because that's the most common reason for a mid-stay
//   swap. "dirty" if the room just needs cleaning before re-let.
export const swapRoomSegmentSchema = z.object({
  fromReservationRoomId: z.string().uuid(),
  toRoomId: z.string().uuid(),
  // Required for overnight bookings; ignored for short_stay (day-use)
  // where the swap is in-place on the single calendar day.
  effectiveDate: z.string().date().optional(),
  reason: z.string().min(1).max(500),
  markOldRoomStatus: z
    .enum(["maintenance", "dirty", "available"])
    .optional()
    .default("maintenance"),
  // Optional: override the per-night rate when swapping to a different
  // room category (e.g. AC -> Deluxe). Applied to the new segment row
  // for segmented swaps, or to the re-pointed row for in-place swaps.
  // When omitted, the existing rate is preserved (legacy behaviour).
  // The reservation's subtotal/GST/grand_total/balance recompute when
  // the new rate differs from the old.
  newRate: z.number().nonnegative().optional(),
  // When the old room is being sent to maintenance, the swap modal
  // gathers the same inputs as Flag Issue and the server files a
  // maintenance_issues row in the same transaction. Without this
  // a swap-to-maintenance only flips room.status — no issue is
  // logged, so the Maintenance page never sees it.
  //
  // Server enforcement: required when markOldRoomStatus = "maintenance",
  // ignored otherwise. Validation is enforced in the route so we keep
  // this object optional at the schema level (so dirty/available swaps
  // don't need to send it).
  maintenanceIssue: z
    .object({
      category: z.enum(MAINTENANCE_CATEGORIES),
      severity: z.enum(MAINTENANCE_SEVERITIES),
      title: z.string().min(3).max(200),
      description: z.string().min(3).max(2000),
      costEstimate: z.coerce.number().nonnegative(),
    })
    .optional(),
});

export const additionalChargeSchema = z.object({
  description: z.string().min(1).max(200),
  quantity: z.coerce.number().int().min(1).default(1),
  rate: z.coerce.number().positive(),
  gstRate: z.coerce.number().min(0).max(100).default(18),
  // Per-room attribution (migration 0018). When null/omitted, the
  // charge is reservation-wide and lands on whichever invoice covers
  // the last remaining rooms. When set to a room's id, the charge is
  // billed only on that room's per-room invoice.
  roomId: z.string().uuid().nullable().optional(),
});

export const paymentSchema = z.object({
  invoiceId: z.string().uuid(),
  amount: z.coerce.number().positive(),
  paymentMethod: z.enum(PAYMENT_METHODS),
  notes: z.string().max(500).optional(),
});

export const voidInvoiceSchema = z.object({
  reason: z.string().min(1).max(500),
});

export const availabilityQuerySchema = z
  .object({
    check_in: z.string().date(),
    check_out: z.string().date(),
    // "1" → date-conflicted rooms are returned too, flagged with their
    // conflicting reservation, so pickers can render them disabled
    // instead of hiding them. Off by default — legacy callers treat
    // every returned room as selectable.
    include_conflicts: z.enum(["1"]).optional(),
  })
  // Postgres collapses daterange(X, X, '[)') to an empty range that
  // overlaps nothing — silently returning "all rooms available". For
  // day-use bookings, callers must widen to [d, d+1) so the
  // short_stay branch in availability.ts actually fires.
  .refine((d) => d.check_out > d.check_in, {
    message: "check_out must be strictly after check_in (use [d, d+1) for day-use)",
    path: ["check_out"],
  });

export const extendReservationSchema = z.object({
  newCheckOutDate: z.string().date(),
  ratePerNight: z.coerce.number().positive().optional(),
});

// Partial-room extend. Splits the reservation: the picked roomIds move
// to a brand-new reservation with the extended check-out date; the
// remaining rooms stay on the original reservation with the original
// dates. Use this when only SOME of the rooms on a multi-room booking
// want to stay longer. For the all-rooms case, call the standard
// extendReservationSchema endpoint.
export const extendSplitSchema = z.object({
  newCheckOutDate: z.string().date(),
  roomIds: z.array(z.string().uuid()).min(1),
  ratePerNight: z.coerce.number().positive().optional(),
});

// Extension query: which of the reservation's rooms are free for the
// extension window, and which alternative rooms could take a blocked
// room's guest for the new night(s).
export const extendOptionsQuerySchema = z.object({
  newCheckOutDate: z.string().date(),
});

// Continuation booking: the guest stays past the current check-out but
// in a DIFFERENT room (their room is booked by someone else for the new
// night(s)). Creates a fresh reservation [oldCheckOut, newCheckOut) for
// the same guest — no detail re-entry. OTP-gated: the guest confirms
// via a code sent to their phone/email (see /otp/send).
export const extendContinueSchema = z.object({
  newCheckOutDate: z.string().date(),
  moves: z
    .array(
      z.object({
        fromRoomId: z.string().uuid(),
        toRoomId: z.string().uuid(),
        ratePerNight: z.coerce.number().positive().optional(),
      }),
    )
    .min(1),
  otpCode: z.string().min(4).max(8),
});

export const lateCheckoutSchema = z.object({
  hours: z.coerce.number().positive().max(24),
  fee: z.coerce.number().min(0).default(0),
  notes: z.string().max(500).optional().nullable(),
});

export const addRoomSchema = z.object({
  roomId: z.string().uuid(),
  ratePerNight: z.coerce.number().positive(),
  soldAsType: z.string().min(1).max(64).optional().nullable(),
  startDate: z.string().date().optional(),
});

export const editRoomRateSchema = z.object({
  ratePerNight: z.coerce.number().positive(),
});

export const editChargeSchema = z.object({
  description: z.string().min(1).max(200).optional(),
  quantity: z.coerce.number().int().min(1).optional(),
  rate: z.coerce.number().positive().optional(),
  gstRate: z.coerce.number().min(0).max(100).optional(),
});

export const editDatesSchema = z
  .object({
    checkInDate: z.string().date(),
    checkOutDate: z.string().date(),
  })
  .refine((d) => new Date(d.checkOutDate) > new Date(d.checkInDate), {
    message: "check_out_date must be after check_in_date",
    path: ["checkOutDate"],
  });

// Editable surface for an already-issued invoice. Mirrors the receipt-edit
// pattern: a single PATCH lets staff fix anything they need on the bill.
//
// IMPORTANT: this is in-place mutation of a tax invoice. The server keeps a
// full audit-log entry of every edit (action: "invoice_edited") so the
// before/after is recoverable from the activity_log table for compliance
// review. The invoice_number is intentionally NOT editable.
export const editInvoiceSchema = z.object({
  issueDate: z.string().date().optional(),
  notes: z.string().max(1000).optional().nullable(),
  // Printed guest details. These are snapshots on the invoice itself; the
  // guests table is left alone.
  guestName: z.string().min(1).max(200).optional(),
  guestAddress: z.string().max(500).optional().nullable(),
  guestGstin: z.string().max(20).optional().nullable(),
  // Stay window. These edit the underlying RESERVATION's check-in /
  // check-out dates (the invoice doesn't store them itself). Provided so
  // the invoice editor can correct a wrong stay date without forcing the
  // user to leave the modal.
  checkInDate: z.string().date().optional(),
  checkOutDate: z.string().date().optional(),
  // If provided, the entire line-item list is REPLACED with the given
  // array. Server recomputes subtotal / cgst / sgst / grandTotal /
  // balance_due / status from these rows. Omitting this key leaves line
  // items untouched.
  lineItems: z
    .array(
      z.object({
        description: z.string().min(1).max(500),
        sacCode: z.string().max(20),
        quantity: z.number().int().min(1),
        rate: z.coerce.number().min(0),
        gstRate: z.coerce.number().min(0).max(100),
        itemType: z.enum(["room_charge", "additional_charge"]),
      }),
    )
    .optional(),
});

export const editPaymentSchema = z.object({
  paymentDate: z.string().datetime().optional(),
  paymentMethod: z.enum(PAYMENT_METHODS).optional(),
  notes: z.string().max(500).optional().nullable(),
});

export const voidPaymentSchema = z.object({
  reason: z.string().min(1).max(500),
});

export type ReservationCreateInput = z.infer<typeof reservationCreateSchema>;
export type CheckInInput = z.infer<typeof checkInSchema>;
export type CheckOutInput = z.infer<typeof checkOutSchema>;
export type AdditionalChargeInput = z.infer<typeof additionalChargeSchema>;
export type PaymentInput = z.infer<typeof paymentSchema>;
