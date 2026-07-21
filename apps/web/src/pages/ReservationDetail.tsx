import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { differenceInCalendarDays, format } from "date-fns";
import {
  AlertTriangle,
  BedDouble,
  CalendarPlus,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  Clock,
  CreditCard,
  Eye,
  FileDown,
  Gift,
  Pencil,
  Plus,
  Snowflake,
  SprayCan,
  Tv,
  Wifi,
  ShieldAlert,
  ShieldCheck,
  Lock,
  Trash2,
  Undo2,
  UserRoundPlus,
  XCircle,
} from "@/lib/micons";
import {
  MAINTENANCE_CATEGORIES,
  MAINTENANCE_CATEGORY_LABELS,
  MAINTENANCE_SEVERITIES,
  MAINTENANCE_SEVERITY_LABELS,
  type MaintenanceCategory,
  type MaintenanceSeverity,
} from "@stayvia/shared";
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useAuth } from "@/auth/AuthContext";
import { CheckInReceiptModal, type CheckInReceiptData } from "@/components/CheckInReceiptModal";
import { EarlyCheckInModal } from "@/components/EarlyCheckInModal";
import { EditInvoiceModal } from "@/components/EditInvoiceModal";
import { useDialog } from "@/components/Dialog";
import { KycModal } from "@/components/KycModal";
import { PdfPreviewModal } from "@/components/PdfPreviewModal";
import { Loader } from "@/components/Loader";
import { OtpModal } from "@/components/OtpModal";
import { RoomActionPopover } from "@/components/RoomActionPopover";
import { StatusBadge } from "@/components/StatusBadge";
import { useToast } from "@/components/Toast";
import { ApiError, api, newIdempotencyKey } from "@/lib/api";
import { invalidateReservationData } from "@/lib/invalidate";
import { inr } from "@/lib/utils";

// Hotel-clock instants must carry the property offset. Without it the
// browser parses "2026-07-20T11:00:00" in ITS OWN timezone, so a manager
// viewing from Dubai (UTC+4) saw overdue badges and late-checkout times
// disagree with the server (which builds the same value with +05:30) by the
// difference between the two zones.
const IST_OFFSET = "+05:30";

interface Detail {
  id: string;
  reservationNumber: string;
  guestId: string;
  checkInDate: string;
  checkOutDate: string;
  numNights?: number;
  // Day-use bookings: stayType='short_stay' + durationHours holds the
  // booked block length. effective check-out = checkedInAt + durationHours.
  stayType?: "overnight" | "short_stay";
  durationHours?: string | null;
  numAdults: number;
  numChildren: number;
  status: string;
  // Booking source. Drives the Make Complimentary button (hidden when
  // already 'complimentary') and the booking-source pill on the page.
  bookingSource?: "walkin" | "phone_whatsapp" | "complimentary";
  checkedInAt: string | null;
  // Actual check-out timestamp — set when staff completes checkout.
  // The dates card prefers this over plannedCheckOutAt / policy
  // default once it's available.
  checkedOutAt?: string | null;
  // 0023 — staff-chosen arrival / departure clock times. Planned/
  // display-only; NULL falls back to hotel policy.
  plannedCheckInAt?: string | null;
  plannedCheckOutAt?: string | null;
  // Set on the first /extend to the then-current checkOutDate. Present =
  // the stay was extended; drives the "Extended" room-row chip.
  originalCheckOutDate?: string | null;
  specialRequests: string | null;
  subtotal: string;
  grandTotal: string;
  advancePaid: string;
  balanceDue: string;
  gstRate: string;
  gstAmount: string;
  // "exclusive" → stored ratePerNight is net, GST added on top.
  // "inclusive" → stored ratePerNight already contains GST.
  gstMode?: "exclusive" | "inclusive";
  hotelCheckInTime: string;
  hotelCheckOutTime: string;
  // Extra hours granted via Late Checkout, shifting the effective
  // check-out moment forward. Numeric in DB; serialised as a decimal
  // string. Used by the "X min late" warning so a grant of 2 hours
  // doesn't show the room as overdue 2 hours too early.
  lateCheckoutHours?: string;
  guest: {
    id: string;
    fullName: string;
    phone: string;
    kycVerifiedAt: string | null;
    idProofPhotoFront: string | null;
    idProofType: string | null;
    idProofLast4: string | null;
    gstin: string | null;
    photoUrl: string | null;
  };
  // Migration 0020 — additional adults whose KYC was captured at booking.
  coGuests?: {
    id: string;
    position: number;
    guest: {
      id: string;
      fullName: string;
      phone: string;
      gender: string | null;
      idProofType: string | null;
      idProofLast4: string | null;
      guestPhoto: string | null;
    };
  }[];
  rooms: {
    id: string;
    roomNumber: string;
    roomType: string;
    soldAsType: string | null;
    // Pre-rendered by the API. See lib/roomTypeLabel.ts on the server.
    displayType: string;
    ratePerNight: string;
    hasAc?: boolean;
    hasTv?: boolean;
    hasWifi?: boolean;
    status?: string;
    // Per-room (migration 0017). Used to know whether a room already has
    // its own invoice — drives the per_room/combined choice at checkout.
    roomInvoiceId?: string | null;
    roomStatus?: "confirmed" | "checked_in" | "checked_out" | "cancelled";
    reservationRoomId?: string;
    // Per-room segment columns (0019 mid-stay swap). NULL on either
    // bound means the row covers the whole stay (unsegmented).
    effectiveFrom?: string | null;
    effectiveTo?: string | null;
    swapId?: string | null;
    swapReason?: string | null;
    // 0037 — chain of every in-place swap hop on this row,
    // oldest-first. The UI renders one virtual closed-leg row per
    // entry above the active row. Empty for unswapped rows; one
    // entry for single swaps; N for chains like 202 -> 201 -> 301.
    swapHistory?: {
      id: string;
      fromRoom: {
        id: string;
        roomNumber: string;
        roomType: string;
        displayType: string;
        hasAc: boolean;
        hasTv: boolean;
        hasWifi: boolean;
      } | null;
      toRoomNumber: string | null;
      reason: string;
      ratePerNight: string;
      createdAt: string;
    }[];
    // 0036 backwards-compat field — most recent hop.
    swappedFromRoom?: {
      id: string;
      roomNumber: string;
      roomType: string;
      displayType: string;
      hasAc: boolean;
      hasTv: boolean;
      hasWifi: boolean;
    } | null;
    // Same-day re-let pending: a walk-in is currently in this room
    // and due to check out before this reservation's check-in date.
    reletPending?: {
      reservationId: string;
      reservationNumber: string;
      guestName: string;
      checkOutDate: string;
    } | null;
  }[];
  additionalCharges: {
    id: string;
    description: string;
    amount: string;
    gstRate: string;
    createdAt: string;
    // Rows written by Extend Stay are system-owned (migration 0012): they
    // carry only the rate delta, so the UI must not offer a bare delete.
    source?: "manual" | "stay_extension";
  }[];
  invoice: {
    id: string;
    invoiceNumber: string;
    status: string;
    grandTotal: string;
    balanceDue: string;
  } | null;
  // Migration 0017 — full list of invoices for this reservation. A
  // multi-room booking may have many: per-room invoices + a combined
  // invoice for the booker. The legacy `invoice` field above is just
  // invoices[0] for backwards compatibility.
  invoices?: {
    id: string;
    invoiceNumber: string;
    status: string;
    grandTotal: string;
    balanceDue: string;
    scope?: "combined" | "room" | "partial";
    scopeRoomIds?: string[] | null;
    guestName: string;
  }[];
  payments: {
    id: string;
    amount: string;
    paymentMethod: string;
    status?: string;
    paymentDate: string;
    notes: string | null;
    receiptNumber: string | null;
    voided?: boolean;
    createdAt: string;
  }[];
  // Wallet credit activity tied to this reservation (e.g. the
  // "Refund as credit" entry produced by cancel-as-credit). Merged
  // into Payment History on the UI so cancellation-as-credit shows
  // a clear row instead of vanishing.
  walletLedger?: {
    id: string;
    entryType: "credit_issued" | "credit_used";
    amount: string;
    note: string | null;
    createdAt: string;
  }[];
}

export default function ReservationDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { can } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const qc = useQueryClient();
  const dialog = useDialog();
  const [err, setErr] = useState<string | null>(null);

  const [showCharge, setShowCharge] = useState(false);
  // When the staff opens "Add Charge" from the overdue → checkout flow,
  // we want to: (a) pre-fill the description + GST as a late fee, and
  // (b) jump straight into the checkout modal once the charge saves.
  // Both bits live in this combined state object.
  const [lateFeeFlow, setLateFeeFlow] = useState<null | {
    description: string;
    gstRate: number;
    titleOverride: string;
  }>(null);
  const [showPay, setShowPay] = useState(false);
  const [showCheckout, setShowCheckout] = useState(false);
  const [showKyc, setShowKyc] = useState(false);
  const [showExtend, setShowExtend] = useState(false);
  const [showLate, setShowLate] = useState(false);
  const [showAddRoom, setShowAddRoom] = useState(false);
  const [showOtp, setShowOtp] = useState(false);
  const [showCancel, setShowCancel] = useState(false);
  const [showCombinedInvoice, setShowCombinedInvoice] = useState(false);
  // Toggle for showing reversed documents (credit notes + the paid
  // invoices they reverse). Hidden by default to keep the list clean.
  const [showReversed, setShowReversed] = useState(false);
  // After issuing a combined invoice without collecting payment in the
  // same shot, we surface a "Collect now?" prompt pre-filled with the new
  // invoice's balance. Null = no prompt active.
  const [postIssuePay, setPostIssuePay] = useState<{
    invoiceId: string;
    invoiceNumber: string;
    balanceDue: number;
  } | null>(null);
  const [showCheckInReceipt, setShowCheckInReceipt] = useState(false);
  // When set, opens the on-screen slip for a specific payment (booking advance
  // or any later payment). Independent from the check-in receipt auto-popup.
  const [slipPaymentId, setSlipPaymentId] = useState<string | null>(null);
  const [showEarlyCheckIn, setShowEarlyCheckIn] = useState(false);
  const [showInvoiceEdit, setShowInvoiceEdit] = useState(false);
  const [showMakeComp, setShowMakeComp] = useState(false);
  const [pdfPreview, setPdfPreview] = useState<{ url: string; title: string; filename: string } | null>(null);
  const { toast } = useToast();

  const { data, isLoading } = useQuery({
    queryKey: ["reservation", id],
    queryFn: () => api.get<Detail>(`/reservations/${id}`),
    enabled: !!id,
  });

  const settingsQ = useQuery({
    queryKey: ["settings-public"],
    queryFn: () =>
      api.get<{
        hotelName: string;
        hotelAddress: string;
        hotelPhone: string;
        ownerPhone: string | null;
        hotelGstin: string;
        hotelLogoUrl: string | null;
        checkInTime: string | null;
        checkOutTime: string | null;
        otpRequiredForCheckin: boolean;
        hideComplimentary?: boolean;
      }>("/settings/public"),
    staleTime: 5 * 60 * 1000,
  });

  // Property-wide OTP policy. Defaults to on until settings load so we never
  // silently skip verification on a slow network.
  const otpEnabled = settingsQ.data?.otpRequiredForCheckin ?? true;
  // Complimentary feature switch: hiding OFF means the hotel isn't using
  // the discreet comp flow, so the Make Complimentary action disappears.
  // Defaults off (matches the new-hotel default) until settings load.
  const compFeatureOn = settingsQ.data?.hideComplimentary ?? false;

  function invalidate() {
    invalidateReservationData(qc, { reservationId: id, guestId: data?.guestId });
  }

  // Deep-link from CheckoutAlerts: visiting /reservations/:id?action=checkout
  // auto-opens the check-out modal as soon as the reservation has loaded
  // and is in a checkable state. We strip the param immediately so a page
  // reload doesn't keep reopening the modal.
  useEffect(() => {
    if (searchParams.get("action") !== "checkout") return;
    if (!data) return;
    if (data.status === "checked_in") {
      setShowCheckout(true);
    }
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("action");
        return next;
      },
      { replace: true },
    );
  }, [data, searchParams, setSearchParams]);

  async function handleStartCheckIn() {
    setErr(null);
    const today = format(new Date(), "yyyy-MM-dd");
    if (r && r.checkInDate > today) {
      // Two-step flow: open the EarlyCheckInModal which shows the financial
      // impact (old vs new totals) and only commits the date shift after the
      // user confirms a second time. When that finishes, we continue to OTP
      // (or straight to check-in when OTP is disabled — see the modal's
      // onConfirmed handler below).
      setShowEarlyCheckIn(true);
      return;
    }
    // OTP policy off for this property: skip the verify modal and check in
    // directly. The server /check-in gate reads the same setting, so with
    // OTP off it won't demand a consumed OTP row. We still ask for an
    // explicit confirmation since the guest's identity won't be verified.
    if (!otpEnabled) {
      const ok = await dialog.confirm({
        title: "Check in without OTP?",
        message:
          "OTP verification is turned off, so the guest's identity won't be confirmed with a code. Check in this guest now?",
        okLabel: "Check in",
        cancelLabel: "Cancel",
      });
      if (ok) checkIn.mutate();
      return;
    }
    setShowOtp(true);
  }

  const checkIn = useMutation({
    mutationFn: () => api.post(`/reservations/${id}/check-in`),
    onMutate: async () => {
      await qc.cancelQueries({ queryKey: ["reservation", id] });
      const prev = qc.getQueryData(["reservation", id]);
      qc.setQueryData(["reservation", id], (old: unknown) => {
        if (!old || typeof old !== "object") return old;
        return { ...(old as Record<string, unknown>), status: "checked_in", checkedInAt: new Date().toISOString() };
      });
      return { prev };
    },
    onError: (e: Error, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(["reservation", id], ctx.prev);
      if (e instanceof ApiError && e.code === "EARLY_CHECK_IN") {
        // Pre-check should normally catch this; if it slips through (e.g. day
        // rollover between page load and submit), point the user to retry —
        // handleStartCheckIn will re-prompt + run the early-check-in flow.
        setErr(`${e.message} Click "Verify & Check In" again to confirm early check-in.`);
        return;
      }
      setErr(e.message);
    },
    onSuccess: () => {
      toast("Guest checked in", "success");
      setShowCheckInReceipt(true);
    },
    onSettled: () => {
      invalidate();
      qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });

  const cancel = useMutation({
    mutationFn: (input: {
      cancellationReason: string;
      refundMode: "cash" | "upi" | "card" | "bank_transfer" | "credit";
      cancellationFee: number;
    }) => api.post(`/reservations/${id}/cancel`, input),
    onSuccess: invalidate,
    onError: (e: Error) => setErr(e.message),
  });

  // No-show: guest never arrived. Advance is forfeit (kept as revenue,
  // not refunded). Rooms release immediately. Distinct from Cancel so
  // reports can separate true cancellations from no-shows.
  // Rolls the dates, num_nights, the marker and the rate-delta charge back
  // together. Deleting the charge alone used to look like an undo but left the
  // stay extended and billed at the old room rate.
  const undoExtension = useMutation({
    mutationFn: () => api.post(`/reservations/${r!.id}/undo-extension`),
    onSuccess: () => {
      invalidate();
      toast("Extension undone", "success");
    },
    onError: (e: Error) => toast(e.message, "error"),
  });

  const noShow = useMutation({
    mutationFn: (note: string) =>
      api.post<{ forfeitedAdvance: number }>(`/reservations/${id}/no-show`, {
        note,
      }),
    onSuccess: (resp) => {
      invalidate();
      toast(
        resp.forfeitedAdvance > 0
          ? `Marked no-show. ₹${resp.forfeitedAdvance.toFixed(2)} advance forfeited.`
          : "Marked no-show.",
        "success",
      );
    },
    onError: (e: Error) => setErr(e.message),
  });

  // Reclassifies the booking as complimentary. Existing payments are left
  // alone — see API route for the rationale. The Complimentary report
  // shows the gap between billed and already-paid.
  const makeComp = useMutation({
    mutationFn: (vars: { reason: string; approver?: string }) =>
      api.post(`/reservations/${id}/make-complimentary`, vars),
    onSuccess: () => {
      invalidate();
      toast("Booking marked as complimentary", "success");
    },
    onError: (e: Error) => setErr(e.message),
  });

  function previewInvoice(invoiceId: string, invoiceNumber: string) {
    // Prefer the SLDT-INV-NNNN handle so the network request shows up
    // in DevTools with a readable URL. The API resolves either form.
    setPdfPreview({
      url: `${import.meta.env.VITE_API_URL}/invoices/${invoiceNumber}/pdf`,
      title: `Invoice · ${invoiceNumber}`,
      filename: `${invoiceNumber}.pdf`,
    });
  }

  // Open a room-wise SPLIT of a tax invoice — a presentation-only PDF
  // for the customer's reference. No money/GST of its own; the parent
  // invoice is the tax document.
  function previewRoomBill(
    invoiceNumber: string,
    invoiceId: string,
    roomNumber: string,
  ) {
    setPdfPreview({
      url: `${import.meta.env.VITE_API_URL}/invoices/${invoiceId}/room-bill/${roomNumber}/pdf`,
      title: `${invoiceNumber} · Room ${roomNumber}`,
      filename: `${invoiceNumber}-Room-${roomNumber}.pdf`,
    });
  }

  function previewReceipt(paymentId: string, receiptNumber: string | null) {
    const handle = receiptNumber ?? paymentId;
    setPdfPreview({
      url: `${import.meta.env.VITE_API_URL}/payments/${handle}/receipt`,
      title: `Receipt · ${receiptNumber ?? paymentId.slice(0, 8)}`,
      filename: `${receiptNumber ?? "receipt-" + paymentId.slice(0, 8)}.pdf`,
    });
  }

  if (isLoading) return <Loader size="lg" />;
  if (!data) return <div>Not found</div>;

  const r = data;
  const rooms = data.rooms;
  const charges = data.additionalCharges;
  const invoice = data.invoice;

  // Rooms the guest is still in.
  //
  // A mid-stay swap leaves a row for the VACATED room too, bounded to end at
  // the swap date, while the live row runs to the reservation's checkout
  // (NULL bounds = unsegmented, always live). That closed leg must keep
  // appearing in the Rooms table and on the invoice — the guest really did
  // sleep there and those nights are billable — but it must never be offered
  // as somewhere to act NOW. Listing it turned a one-room stay into "2 of 2
  // rooms" in the Extend and Add Charge pickers, and a charge attributed to a
  // room the guest has left lands on a row nothing will invoice.
  const liveRooms = rooms.filter(
    (rm) => !rm.effectiveTo || rm.effectiveTo >= r.checkOutDate,
  );

  // Spells out exactly what Undo Extension will change, with real figures,
  // so nobody confirms a money-affecting rollback from a vague prompt.
  const undoExtensionSummary = (() => {
    if (!r.originalCheckOutDate) return null;
    const fmtDay = (d: string) => format(new Date(d), "dd MMM yyyy");
    const nightsNow = Number(r.numNights ?? 0);
    const nightsAfter = Math.max(
      0,
      differenceInCalendarDays(
        new Date(r.originalCheckOutDate),
        new Date(r.checkInDate),
      ),
    );
    const dropped = Math.max(0, nightsNow - nightsAfter);
    // Charges the server will delete (source = "stay_extension").
    const extCharges = charges.filter((c) => c.source === "stay_extension");
    const extTotal = extCharges.reduce((sum, c) => sum + Number(c.amount), 0);

    // JSX, not a string: the dialog renders `message` as a ReactNode in a
    // plain div, so newlines in a string would collapse into one paragraph.
    const Row = ({ label, children }: { label: string; children: ReactNode }) => (
      <div className="flex items-baseline gap-3 py-1">
        <span className="w-20 shrink-0 text-[11px] uppercase tracking-wider text-textSecondary">
          {label}
        </span>
        <span className="text-sm text-textPrimary">{children}</span>
      </div>
    );
    return (
      <div className="mt-1">
        <div className="rounded-sm border border-borderc bg-bg px-3 py-2">
          <Row label="Check-out">
            <span className="line-through text-textSecondary">
              {fmtDay(r.checkOutDate)}
            </span>
            <span className="mx-2 text-textSecondary">→</span>
            <strong>{fmtDay(r.originalCheckOutDate)}</strong>
          </Row>
          <Row label="Nights">
            <span className="line-through text-textSecondary">{nightsNow}</span>
            <span className="mx-2 text-textSecondary">→</span>
            <strong>{nightsAfter}</strong>
            {dropped > 0 && (
              <span className="ml-2 text-danger text-xs">
                {dropped} night{dropped === 1 ? "" : "s"} no longer billed
              </span>
            )}
          </Row>
          {extCharges.length > 0 && (
            <Row label="Removed">
              {extCharges.length} extension rate charge
              {extCharges.length === 1 ? "" : "s"}
              <span className="ml-2 font-mono text-danger">
                −{inr(extTotal)}
              </span>
            </Row>
          )}
        </div>
        <div className="text-xs text-textSecondary mt-2">
          The bill is recalculated from the restored dates. Payments already
          collected are <strong>not</strong> touched — if that leaves the guest
          overpaid, it shows as a balance to refund.
        </div>
      </div>
    );
  })();

  // Uninvoiced rooms grouped into billing units, matching how the server
  // issues per-room invoices: legs of one swap chain share a swapId and go on
  // a SINGLE invoice, because a guest who changed rooms is one occupant.
  // Anything unswapped is its own group.
  const uninvoicedOccupancies = (() => {
    const byKey = new Map<string, typeof rooms>();
    for (const rm of rooms) {
      if (rm.roomInvoiceId) continue;
      const key = rm.swapId ?? rm.id;
      const existing = byKey.get(key);
      if (existing) existing.push(rm);
      else byKey.set(key, [rm]);
    }
    return [...byKey.values()];
  })();
  const payments = data.payments;
  const guest = data.guest;
  const nights = r.numNights ?? Math.max(
    1,
    Math.round(
      (new Date(r.checkOutDate).getTime() - new Date(r.checkInDate).getTime()) /
        (1000 * 60 * 60 * 24),
    ),
  );
  const isShortStay = r.stayType === "short_stay";
  const durationHours = Number(r.durationHours ?? 0);
  // For day-use bookings the actual exit datetime is checkedInAt + duration.
  // If the guest isn't checked in yet, anchor to checkInDate + hotelCheckInTime.
  const shortStayCheckoutAt = (() => {
    if (!isShortStay) return null;
    const startMs = r.checkedInAt
      ? new Date(r.checkedInAt).getTime()
      : (() => {
          const [hh, mm] = (r.hotelCheckInTime ?? "12:00").split(":");
          return new Date(
            `${r.checkInDate}T${(hh ?? "12").padStart(2, "0")}:${(mm ?? "00").padStart(2, "0")}:00${IST_OFFSET}`,
          ).getTime();
        })();
    return new Date(startMs + Math.round(durationHours * 3600 * 1000));
  })();
  // "Paid so far" is the money actually received (advancePaid), NOT
  // grandTotal − balanceDue: balanceDue is clamped at 0, so on an
  // overpayment (e.g. paid for a pricier room, then swapped to a cheaper
  // one) the old formula understated what the guest paid and hid the
  // surplus. When advancePaid > grandTotal the difference is an
  // overpayment owed back to the guest.
  const paidSoFar = Number(r.advancePaid ?? 0);
  const totalPaid = paidSoFar.toFixed(2);
  const overpaid = +(paidSoFar - Number(r.grandTotal)).toFixed(2);
  const kycVerified = !!guest?.kycVerifiedAt && !!guest?.idProofPhotoFront;
  const canCheckIn = r.status === "confirmed" && kycVerified;
  const canCheckOut = r.status === "checked_in";
  const canCancel = r.status === "confirmed" || r.status === "checked_in";

  const overdueDays = (() => {
    if (r.status !== "checked_in") return 0;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const out = new Date(r.checkOutDate + `T00:00:00${IST_OFFSET}`);
    const diff = Math.floor((today.getTime() - out.getTime()) / 86400000);
    return Math.max(0, diff);
  })();

  // Minute-granularity overdue check. Covers two cases the day-only
  // overdueDays misses:
  //   - day-use (short_stay): check-in == check-out date, "overdue"
  //     means we're past checkInAt + durationHours.
  //   - overnight: we're past checkOutDate + hotelCheckOutTime, plus
  //     any granted lateCheckoutHours.
  // Returns 0 when not overdue. Updates on every render so navigating
  // away and back picks up the current clock — good enough; nothing
  // depends on a per-minute refresh.
  const minutesOverdue = (() => {
    if (r.status !== "checked_in") return 0;
    const isShortStay = r.stayType === "short_stay";
    let effectiveOut: Date;
    if (isShortStay) {
      const checkedInAt = r.checkedInAt ? new Date(r.checkedInAt) : null;
      const durationH = Number(r.durationHours ?? 0);
      if (!checkedInAt || !durationH) return 0;
      effectiveOut = new Date(checkedInAt.getTime() + durationH * 3600_000);
    } else {
      const [hh = "11", mm = "00"] = (r.hotelCheckOutTime ?? "11:00").split(":");
      effectiveOut = new Date(
        `${r.checkOutDate}T${hh.padStart(2, "0")}:${mm.padStart(2, "0")}:00${IST_OFFSET}`,
      );
    }
    const grantHours = Number(r.lateCheckoutHours ?? 0);
    if (grantHours > 0) {
      effectiveOut = new Date(effectiveOut.getTime() + grantHours * 3600_000);
    }
    const diffMs = Date.now() - effectiveOut.getTime();
    return diffMs > 0 ? Math.floor(diffMs / 60_000) : 0;
  })();

  // Granted late checkout, surfaced on the Dates card: the base departure
  // time (planned > day-use exit > hotel default) shifted by the granted
  // hours. Hidden once the guest actually checked out.
  const lateGrantHours = Number(r.lateCheckoutHours ?? 0);
  const lateOutDisplay = (() => {
    if (lateGrantHours <= 0 || r.checkedOutAt) return null;
    const base = r.plannedCheckOutAt
      ? new Date(r.plannedCheckOutAt)
      : shortStayCheckoutAt ??
        (() => {
          const [hh = "11", mm = "00"] = (r.hotelCheckOutTime ?? "11:00").split(":");
          return new Date(
            `${r.checkOutDate}T${hh.padStart(2, "0")}:${mm.padStart(2, "0")}:00${IST_OFFSET}`,
          );
        })();
    return new Date(base.getTime() + lateGrantHours * 3600_000);
  })();

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <button onClick={() => navigate(-1)} className="btn-secondary !h-9 !px-2">
          <ChevronLeft className="w-4 h-4" />
        </button>
        <h1 className="text-2xl font-bold text-navy font-mono">{r.reservationNumber}</h1>
        <StatusBadge status={r.status} />
        {overdueDays > 0 && (
          <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-sm bg-danger/10 text-danger text-[11px] font-bold uppercase tracking-wider">
            Overdue · {overdueDays}d
          </span>
        )}
        {/* Corrective action, not part of the day-to-day flow — it lives in
            the header rather than the action bar so it doesn't sit among the
            buttons staff press on every stay. Only rendered for a booking
            that HAS been extended; reverts to the originally-booked checkout,
            since original_check_out_date is stamped once and never
            overwritten (so this undoes every extend, not just the last). */}
        {(r.status === "checked_in" || r.status === "confirmed") &&
          r.originalCheckOutDate &&
          !invoice &&
          can("extend_stay") && (
            <button
              className="ml-auto btn-secondary inline-flex items-center gap-2 !h-9"
              disabled={undoExtension.isPending}
              onClick={async () => {
                const ok = await dialog.confirm({
                  title: "Undo stay extension?",
                  message: undoExtensionSummary,
                  okLabel: "Undo extension",
                  cancelLabel: "Keep the extension",
                  tone: "danger",
                });
                if (ok) undoExtension.mutate();
              }}
            >
              <Undo2 className="w-4 h-4" />
              {undoExtension.isPending ? "Undoing…" : "Undo Extension"}
            </button>
          )}
      </div>

      {overdueDays > 0 && (
        <div className="card border-danger/40 bg-danger/5 flex items-start gap-3">
          <div className="text-danger text-lg leading-none mt-0.5">⚠</div>
          <div className="flex-1">
            <div className="font-semibold text-danger">
              Stay was scheduled to end {format(new Date(r.checkOutDate), "dd MMM yyyy")} -{" "}
              {overdueDays} day{overdueDays === 1 ? "" : "s"} ago.
            </div>
            <div className="text-xs text-textSecondary mt-0.5">
              Check the guest out now, extend the stay, or add a late charge.
            </div>
          </div>
        </div>
      )}

      {/* Likely no-show banner — confirmed booking whose check-in date
          is in the past OR today + past hotel check-in time. Staff
          should either verify (check-in if guest just arrived late)
          or click Mark No-show. */}
      {r.status === "confirmed" && (() => {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const ci = new Date(r.checkInDate);
        ci.setHours(0, 0, 0, 0);
        const daysLate = Math.floor((today.getTime() - ci.getTime()) / 86400000);
        if (daysLate < 1) return null;
        return (
          <div className="card border-danger/40 bg-danger/5 flex items-start gap-3">
            <div className="text-danger text-lg leading-none mt-0.5">⚠</div>
            <div className="flex-1">
              <div className="font-semibold text-danger">
                Guest hasn't arrived - booking was for{" "}
                {format(new Date(r.checkInDate), "dd MMM yyyy")}{" "}
                ({daysLate} day{daysLate === 1 ? "" : "s"} ago).
              </div>
              <div className="text-xs text-textSecondary mt-0.5">
                If they just walked in late, hit <strong>Verify &amp; Check In</strong>.
                If they're not coming, use <strong>Mark No-show</strong> to forfeit
                the advance and release the room.
              </div>
            </div>
          </div>
        );
      })()}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="card">
          <div className="label">Guest</div>
          <div className="flex items-start gap-3">
            {guest?.photoUrl && (
              <img
                src={guest.photoUrl}
                alt=""
                className="w-14 h-16 object-cover rounded border border-borderc shrink-0"
              />
            )}
            <div className="min-w-0">
              <button
                onClick={() => guest?.phone && navigate(`/guests/${guest.phone}`)}
                className="font-semibold text-navy hover:underline text-left"
              >
                {guest?.fullName}
              </button>
              <div className="text-sm text-textSecondary">{guest?.phone}</div>
              <div className="text-xs text-textSecondary mt-1">
                {r.numAdults} adult{r.numAdults === 1 ? "" : "s"}
                {r.numChildren > 0 && `, ${r.numChildren} child${r.numChildren === 1 ? "" : "ren"}`}
              </div>
            </div>
          </div>
          {/* Co-guests (migration 0020). Additional adults whose KYC
              was captured at booking. Shown only when present. */}
          {r.coGuests && r.coGuests.length > 0 && (
            <div className="mt-3 pt-3 border-t border-borderc space-y-1.5">
              <div className="text-[11px] uppercase tracking-wider text-textSecondary font-semibold">
                Also occupying
              </div>
              {r.coGuests.map((cg) => (
                <div key={cg.id} className="text-sm flex items-center justify-between gap-2">
                  <button
                    onClick={() => navigate(`/guests/${cg.guest.phone}`)}
                    className="text-navy hover:underline text-left truncate"
                  >
                    {cg.guest.fullName}
                  </button>
                  <span className="font-mono text-xs text-textSecondary shrink-0">
                    {cg.guest.phone}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="card">
          <div className="label">Dates</div>
          <div className="text-sm">
            <div>
              <strong>In:</strong>{" "}
              {format(
                r.plannedCheckInAt
                  ? new Date(r.plannedCheckInAt)
                  : r.checkedInAt
                    ? new Date(r.checkedInAt)
                    : new Date(r.checkInDate),
                "dd MMM yyyy",
              )}{" "}
              <span className="text-textSecondary">
                ·{" "}
                {/* Priority: the staff-entered check-in time (0023) wins so
                    the header reflects what was set. Falls back to the actual
                    checked-in stamp, then hotel policy. */}
                {r.plannedCheckInAt
                  ? format(new Date(r.plannedCheckInAt), "h:mm a")
                  : r.checkedInAt
                    ? format(new Date(r.checkedInAt), "h:mm a")
                    : formatTime(r.hotelCheckInTime)}
              </span>
              {/* "actual" badge only when there's no staff-entered time and
                  we're showing the real arrival stamp. */}
              {r.checkedInAt && !r.plannedCheckInAt && (
                <span className="ml-1.5 inline-flex items-center gap-1 text-[10px] uppercase tracking-wider text-success font-semibold">
                  · actual
                </span>
              )}
            </div>
            <div>
              <strong>Out:</strong>{" "}
              {format(
                // Priority: staff-entered checkout time (0023) wins so the
                // header reflects what was set > short-stay computed exit >
                // actual checked-out stamp > hotel policy default.
                r.plannedCheckOutAt
                  ? new Date(r.plannedCheckOutAt)
                  : shortStayCheckoutAt ??
                      (r.checkedOutAt
                        ? new Date(r.checkedOutAt)
                        : new Date(r.checkOutDate)),
                "dd MMM yyyy",
              )}{" "}
              <span className="text-textSecondary">
                ·{" "}
                {r.plannedCheckOutAt
                  ? format(new Date(r.plannedCheckOutAt), "h:mm a")
                  : shortStayCheckoutAt
                    ? format(shortStayCheckoutAt, "h:mm a")
                    : r.checkedOutAt
                      ? format(new Date(r.checkedOutAt), "h:mm a")
                      : formatTime(r.hotelCheckOutTime)}
              </span>
              {r.checkedOutAt && !r.plannedCheckOutAt && (
                <span className="ml-1.5 inline-flex items-center gap-1 text-[10px] uppercase tracking-wider text-success font-semibold">
                  · actual
                </span>
              )}
              {lateOutDisplay && (
                <span className="ml-1.5 inline-flex items-center gap-1 text-[10px] uppercase tracking-wider text-warning font-semibold">
                  · +{lateGrantHours}h late · till {format(lateOutDisplay, "h:mm a")}
                </span>
              )}
            </div>
            <div className="text-textSecondary text-xs mt-1">
              {isShortStay
                ? `Day use · ${durationHours} hour${durationHours === 1 ? "" : "s"}`
                : `${nights} night${nights === 1 ? "" : "s"}`}
            </div>
            {/* "This stay was extended" belongs on the Dates card, because the
                per-room ORIGINAL/EXTENDED breakdown below is deliberately
                suppressed for swap-segmented rows (those rows already show
                their own windows and subtotals, so repeating the split there
                would double-count). On a swapped booking that left the
                extension completely invisible — the only hint was the Undo
                Extension button. This states it once, for every shape of
                stay, without touching the billing breakdown.
                original_check_out_date is stamped on the FIRST extend and
                never overwritten, so this correctly spans several extends. */}
            {r.originalCheckOutDate && !isShortStay && (
              <div
                className="mt-1.5 inline-flex items-center gap-1.5 rounded-sm bg-warning/10 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-[#B45309]"
                title={`Originally booked to ${format(new Date(r.originalCheckOutDate), "dd MMM yyyy")}. Extended to ${format(new Date(r.checkOutDate), "dd MMM yyyy")}.`}
              >
                <CalendarPlus className="w-3 h-3" />
                Extended
                <span className="font-normal normal-case tracking-normal text-textSecondary">
                  {format(new Date(r.originalCheckOutDate), "dd MMM")} →{" "}
                  {format(new Date(r.checkOutDate), "dd MMM")}
                  {(() => {
                    const added = differenceInCalendarDays(
                      new Date(r.checkOutDate),
                      new Date(r.originalCheckOutDate),
                    );
                    return added > 0
                      ? ` · +${added} night${added === 1 ? "" : "s"}`
                      : "";
                  })()}
                </span>
              </div>
            )}
          </div>
        </div>
        <div className="card">
          <div className="label">{overpaid > 0.009 ? "Overpaid" : "Balance"}</div>
          <div
            className={`text-2xl font-bold font-mono ${overpaid > 0.009 ? "text-warning" : "text-navy"}`}
          >
            {overpaid > 0.009 ? inr(overpaid) : inr(r.balanceDue)}
          </div>
          <div className="text-xs text-textSecondary">
            of {inr(r.grandTotal)} · paid {inr(totalPaid)}
          </div>
          {overpaid > 0.009 && (
            <div className="text-xs text-warning font-medium mt-1">
              Guest overpaid - refund or credit due
            </div>
          )}
        </div>
      </div>

      {r.specialRequests && (
        <div className="card bg-warning/5 border-warning/30">
          <div className="label mb-1">Special Requests</div>
          <div className="text-sm">{r.specialRequests}</div>
        </div>
      )}

      <div
        className={`card flex items-center justify-between ${
          kycVerified ? "bg-success/5 border-success/30" : "bg-danger/5 border-danger/40"
        }`}
      >
        <div className="flex items-center gap-3">
          {kycVerified ? (
            <ShieldCheck className="w-6 h-6 text-success" />
          ) : (
            <ShieldAlert className="w-6 h-6 text-danger" />
          )}
          <div>
            <div className="font-semibold text-navy">
              KYC {kycVerified ? "Verified" : "Required"}
            </div>
            <div className="text-xs text-textSecondary">
              {kycVerified
                ? `${guest?.idProofType?.toUpperCase() ?? "ID"} ending ••••${guest?.idProofLast4 ?? ""}`
                : "Upload guest ID proof photo before check-in (Form C / Foreigners Order compliance)."}
            </div>
          </div>
        </div>
        <button className="btn-secondary" onClick={() => setShowKyc(true)}>
          {kycVerified ? "View / Replace" : "Upload Documents"}
        </button>
      </div>

      <div className="flex flex-wrap gap-2">
        {r.status === "confirmed" && can("check_in") && (
          <button
            className="btn-primary"
            onClick={handleStartCheckIn}
            disabled={!canCheckIn || checkIn.isPending}
            title={!kycVerified ? "Upload KYC documents first" : undefined}
          >
            {checkIn.isPending
              ? "Checking in…"
              : otpEnabled
                ? "Verify & Check In"
                : "Check In"}
          </button>
        )}
        {canCheckOut && can("check_out") && (
          <button
            className="btn-primary"
            onClick={() => {
              // Go straight to checkout. If the stay is overdue, the checkout
              // modal surfaces an optional late-fee field there — the fee is
              // applied only on Complete Check-out, never saved separately.
              setShowCheckout(true);
            }}
          >
            Check Out & Generate Invoice
          </button>
        )}
        {canCheckOut && (
          <button
            className="btn-secondary inline-flex items-center gap-2"
            onClick={() =>
              setPdfPreview({
                url: `${import.meta.env.VITE_API_URL}/reservations/${r.id}/invoice-preview`,
                title: `Invoice Preview · ${r.reservationNumber}`,
                filename: `${r.reservationNumber}-preview.pdf`,
              })
            }
          >
            <FileDown className="w-4 h-4" /> Preview Invoice
          </button>
        )}
        {(r.status === "checked_in" || r.status === "confirmed") && can("add_charge") && (
          <button className="btn-secondary inline-flex items-center gap-2" onClick={() => setShowCharge(true)}>
            <Plus className="w-4 h-4" /> Add Charge
          </button>
        )}
        {(r.status === "checked_in" || r.status === "confirmed") && can("extend_stay") && (
          <button className="btn-secondary inline-flex items-center gap-2" onClick={() => setShowExtend(true)}>
            <CalendarPlus className="w-4 h-4" /> Extend Stay
          </button>
        )}
        {(r.status === "checked_in" || r.status === "confirmed") && can("manage_rooms_on_stay") && (
          <button className="btn-secondary inline-flex items-center gap-2" onClick={() => setShowAddRoom(true)}>
            <BedDouble className="w-4 h-4" /> Add Room
          </button>
        )}
        {/* Separate booking for the SAME guest — jumps to New Reservation
            with the guest preselected, so their KYC on file is reused and
            the new stay gets its own bill/invoice lifecycle. */}
        {can("create_reservations") && (
        <button
          className="btn-secondary inline-flex items-center gap-2"
          onClick={() => navigate(`/reservations/new?mode=walkin&guestId=${r.guestId}`)}
        >
          <UserRoundPlus className="w-4 h-4" /> New Booking (Same Guest)
        </button>
        )}
        {r.status === "checked_in" && can("extend_stay") && (
          <button className="btn-secondary inline-flex items-center gap-2" onClick={() => setShowLate(true)}>
            <Clock className="w-4 h-4" /> Grant Late Checkout
          </button>
        )}
        {Number(r.balanceDue) > 0.009 && r.status !== "cancelled" && can("record_payments") && (
          <button className="btn-secondary inline-flex items-center gap-2" onClick={() => setShowPay(true)}>
            <CreditCard className="w-4 h-4" /> Record Payment
          </button>
        )}
        {/* Make Complimentary — available on confirmed / checked_in /
            checked_out reservations that aren't already comped. Pure
            reclassification: the booking is removed from every revenue
            surface and appears only in Reports → Complimentary. No
            invoice/payment changes. Cancelled bookings are excluded. */}
        {["confirmed", "checked_in", "checked_out"].includes(r.status)
          && r.bookingSource !== "complimentary"
          && compFeatureOn && can("edit_reservations") && (
          <button
            className="btn-secondary inline-flex items-center gap-2"
            onClick={() => setShowMakeComp(true)}
            title="Move this booking into the Complimentary section"
          >
            <Gift className="w-4 h-4" /> Make Complimentary
          </button>
        )}
        {r.status === "confirmed" && can("cancel_reservations") && (
          <button
            className="btn-secondary inline-flex items-center gap-2"
            onClick={async () => {
              const advance = Number(r.advancePaid ?? 0);
              const advanceLine =
                advance > 0
                  ? ` The ₹${advance.toFixed(2)} advance will be FORFEITED (kept as revenue, not refunded).`
                  : "";
              const reason = await dialog.prompt({
                title: "Mark as no-show",
                message: `Guest didn't arrive for their booking.${advanceLine} This releases the room and closes the reservation. Add a short note for the record.`,
                placeholder: "e.g. No contact after 9pm cutoff; phone unreachable",
                okLabel: "Mark no-show",
                cancelLabel: "Not yet",
                tone: "danger",
                required: true,
                multiline: true,
              });
              if (reason) noShow.mutate(reason);
            }}
          >
            <AlertTriangle className="w-4 h-4" /> Mark No-show
          </button>
        )}
        {canCancel && can("cancel_reservations") && (
          <button
            className="btn-danger inline-flex items-center gap-2"
            onClick={() => setShowCancel(true)}
          >
            <XCircle className="w-4 h-4" /> Cancel
          </button>
        )}
      </div>

      {err && <div className="card bg-danger/5 border-danger text-danger text-sm">{err}</div>}

      <div className="card p-0">
        <div className="px-4 py-3 border-b"><strong>Rooms</strong></div>
        <table className="table-base">
          <thead>
            <tr>
              <th>Room #</th>
              <th>Type</th>
              <th className="tabular-nums">Rate/night</th>
              <th className="tabular-nums">Subtotal ({nights}n)</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rooms.map((room) => {
              // Swap chain context. Rows that share a swap_id are
              // sibling segments of the same swap event. Sort them by
              // effective_from to figure out who's the predecessor
              // and who's the successor — so each row can show
              // "Swapped to Room X" or "Swapped from Room X" instead
              // of a vague "Swapped" pill, and we can hide write
              // actions on closed legs.
              let swapSiblingNumber: string | null = null;
              let swapDirection: "to" | "from" | null = null;
              let swapSiblingRate: string | null = null;
              if (room.swapId) {
                const siblings = rooms
                  .filter((rr) => rr.swapId === room.swapId)
                  .slice()
                  .sort((a, b) =>
                    String(a.effectiveFrom ?? r.checkInDate) <
                    String(b.effectiveFrom ?? r.checkInDate)
                      ? -1
                      : 1,
                  );
                const idx = siblings.findIndex((s) => s.id === room.id);
                if (idx >= 0 && siblings.length > 1) {
                  // Last in the chain = current/active leg ("swapped
                  // from" its predecessor). Anything earlier = closed
                  // leg ("swapped to" its successor).
                  if (idx === siblings.length - 1) {
                    swapDirection = "from";
                    swapSiblingNumber = siblings[idx - 1]!.roomNumber;
                    swapSiblingRate = siblings[idx - 1]!.ratePerNight;
                  } else {
                    swapDirection = "to";
                    swapSiblingNumber = siblings[idx + 1]!.roomNumber;
                    swapSiblingRate = siblings[idx + 1]!.ratePerNight;
                  }
                }
              }
              // 0037: full in-place swap chain. For a chain like
              // 202 -> 201 -> 301 we render two closed-leg rows above
              // the active 301 row, each showing where that hop went
              // next. Segmented swaps already have real sibling rows
              // in `rooms`, so we skip the virtual rows in that case.
              const virtualHistory =
                !swapSiblingNumber && (room.swapHistory ?? []).length > 0
                  ? room.swapHistory ?? []
                  : [];
              // A room added mid-stay via Add Room is segmented (it has its own
              // effective window) but is NOT a swap — no swapId, no swapped-from
              // link, no swap history. The row must not be read as a swap: the
              // timeline badge would fall back to a bare "Swapped" pill and the
              // breakdown would mislabel its nights "Stay Extension" just
              // because they fall after the original checkout.
              const isSwapRow =
                !!room.swapId ||
                !!room.swappedFromRoom ||
                (room.swapHistory ?? []).length > 0;
              const isAddedRoom =
                !isSwapRow && !!(room.effectiveFrom || room.effectiveTo);
              return (
                <Fragment key={room.id}>
                  {virtualHistory.map((hop) =>
                    hop.fromRoom ? (
                      <SwapClosedLegRow
                        key={hop.id}
                        fromRoom={hop.fromRoom}
                        toRoomNumber={hop.toRoomNumber ?? room.roomNumber}
                        reason={hop.reason}
                        reservationCheckIn={r.checkInDate}
                        reservationCheckOut={r.checkOutDate}
                        nights={nights}
                      />
                    ) : null,
                  )}
                  <RoomRow
                    reservationId={r.id}
                    room={room}
                    reservationCheckIn={r.checkInDate}
                    reservationCheckOut={r.checkOutDate}
                    isShortStay={r.stayType === "short_stay"}
                    isSingleNight={r.stayType !== "short_stay" && nights <= 1}
                    nights={nights}
                    swapSiblingNumber={swapSiblingNumber}
                    swapDirection={swapDirection}
                    swapSiblingRate={swapSiblingRate}
                    isAddedRoom={isAddedRoom}
                    onSaved={invalidate}
                  />
                  {/* Extended-stay breakdown, per room, against THAT room's
                      own window.
                      Previously this rendered only under the first room and
                      only when the row was unsegmented — so on a swapped
                      booking the extension became invisible in this table
                      entirely. Splitting per room fixes that without
                      double-counting: each row's nights are clamped to its own
                      [effective_from, effective_to), so the segment rows and
                      these sub-rows describe the same nights once.
                      Rendered for EVERY room of an extended booking, so the
                      table always attributes each room's nights to either the
                      original booking or the extension. A room lying wholly on
                      one side simply yields a single row (the other portion is
                      0n and ExtensionBreakdownRows skips it). */}
                  {r.originalCheckOutDate && r.stayType !== "short_stay" && (
                      <ExtensionBreakdownRows
                        windowFrom={room.effectiveFrom ?? r.checkInDate}
                        windowTo={room.effectiveTo ?? r.checkOutDate}
                        originalCheckOut={r.originalCheckOutDate}
                        ratePerNight={room.ratePerNight}
                        displayType={
                          room.displayType ?? room.roomType.replace(/_/g, " ")
                        }
                        mode={isAddedRoom ? "added" : "split"}
                      />
                    )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {charges.length > 0 && (
        <div className="card p-0">
          <div className="px-4 py-3 border-b"><strong>Additional Charges</strong></div>
          <table className="table-base">
            <thead>
              <tr>
                <th>Description</th>
                <th className="tabular-nums">GST%</th>
                <th>Added</th>
                <th className="tabular-nums">Amount</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {charges.map((c) => (
                <ChargeRow
                  key={c.id}
                  reservationId={r.id}
                  charge={c}
                  gstMode={r.gstMode ?? "exclusive"}
                  // Charge mutations are permission-gated (cash-skim vector):
                  // edit needs edit_reservations, delete needs delete_charge
                  // (deliberately absent from the front-desk role).
                  canEdit={!invoice && can("edit_reservations")}
                  // Extension charges are deliberately NOT deletable here:
                  // they hold only the rate delta, so removing one leaves
                  // the stay extended but billed at the old room rate. Undo
                  // Extension rolls the dates and the charge back together.
                  canDelete={
                    !invoice &&
                    can("delete_charge") &&
                    c.source !== "stay_extension"
                  }
                  onSaved={invalidate}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Invoices list. Per-room (0017) means a multi-room booking can
          have several. Single-invoice view falls back to the legacy
          single-card layout; multi-invoice uses a row-per-invoice
          card with scope and guest visible. */}
      {(data.invoices ?? (invoice ? [invoice] : [])).length > 0 && (
        <div className="card p-0">
          <div className="px-4 py-3 border-b flex items-center justify-between">
            <strong>
              Invoices (
              {(() => {
                const docs = (data.invoices ?? (invoice ? [invoice] : [])).filter(
                  Boolean,
                ) as Array<{
                  id: string;
                  status?: string;
                  documentType?: string;
                  creditNoteFor?: string | null;
                }>;
                const reversed = new Set<string>();
                for (const d of docs) {
                  if (d.documentType === "credit_note") {
                    reversed.add(d.id);
                    if (d.creditNoteFor) reversed.add(d.creditNoteFor);
                  }
                  if (d.status === "voided") reversed.add(d.id);
                }
                return docs.filter((d) => !reversed.has(d.id)).length;
              })()}
              )
            </strong>
            <div className="flex items-center gap-2">
              {(() => {
                const liveInvs = (data.invoices ?? []).filter(
                  (i) =>
                    i &&
                    (i as { status: string }).status !== "voided" &&
                    (i as { documentType?: string }).documentType !== "credit_note",
                ) as Array<{
                  id: string;
                  status: string;
                  scope?: "combined" | "room" | "partial";
                  scopeRoomIds?: string[] | null;
                }>;
                // A room is "billed" only when it points at a LIVE
                // invoice — a link to a voided invoice does not count.
                const liveInvoiceIds = new Set(liveInvs.map((i) => i.id));
                const billableRooms = (data.rooms ?? []).filter(
                  (rm) => (rm as { roomStatus?: string }).roomStatus !== "cancelled",
                );
                const uninvoicedRooms = billableRooms.filter((rm) => {
                  const link = (rm as { roomInvoiceId?: string | null }).roomInvoiceId;
                  return !link || !liveInvoiceIds.has(link);
                });
                return (
                  <>
                    {/* Combined-invoice GENERATOR — only when 2+ rooms
                        still have no live invoice. Per-room paperwork is
                        produced as presentation-only splits of this one
                        combined tax invoice (see the row's "Per-room
                        bills" buttons), so there is no separate per-room
                        invoice to create and no "reissue" step. */}
                    {uninvoicedRooms.length >= 2 && (
                      <button
                        className="btn-secondary !h-8 text-xs inline-flex items-center gap-1"
                        onClick={() => setShowCombinedInvoice(true)}
                      >
                        + Combined Invoice
                      </button>
                    )}
                  </>
                );
              })()}
            </div>
          </div>
          {(() => {
            const allDocs = (data.invoices ?? (invoice ? [invoice] : [])).filter(
              Boolean,
            ) as Array<{
              id: string;
              status?: string;
              documentType?: string;
              creditNoteFor?: string | null;
            }>;
            // Reversed set = every credit note + the original invoice it
            // reverses + VOIDED invoices (e.g. per-room bills superseded by
            // a combined invoice). These collapse behind a toggle so the
            // everyday view only shows live, in-effect documents — the
            // voided paperwork stays reachable for the GST audit trail.
            const reversedIds = new Set<string>();
            for (const d of allDocs) {
              if (d.documentType === "credit_note") {
                reversedIds.add(d.id);
                if (d.creditNoteFor) reversedIds.add(d.creditNoteFor);
              }
              if (d.status === "voided") reversedIds.add(d.id);
            }
            const activeDocs = allDocs.filter((d) => !reversedIds.has(d.id));
            const reversedDocs = allDocs.filter((d) => reversedIds.has(d.id));
            const renderInvoiceRow = (inv: (typeof allDocs)[number]) => {
              // The legacy `invoice` object is narrower than the new
              // `invoices` array entries; widen here to a shared shape.
              const richInv = inv as {
                id: string;
                invoiceNumber: string;
                status: string;
                grandTotal: string;
                balanceDue: string;
                documentType?: string;
                scope?: "combined" | "room" | "partial";
                scopeRoomIds?: string[] | null;
                guestName?: string;
              };
              const isCreditNote = richInv.documentType === "credit_note";
              const scope = richInv.scope ?? "combined";
              const scopeRoomIds = richInv.scopeRoomIds ?? null;
              const scopedRooms = scopeRoomIds
                ? (data.rooms ?? []).filter((rm) =>
                    scopeRoomIds.includes((rm as { id: string }).id),
                  )
                : null;
              // The "Per room" vs "Combined" badge is only meaningful on
              // multi-room bookings — it tells staff whether each room has
              // its own bill or one bill covers them all. On a single-room
              // reservation the distinction doesn't exist and the legacy
              // scope='combined' default would otherwise mislabel a plain
              // one-room invoice as COMBINED.
              const totalRoomsOnRes = (data.rooms ?? []).length;
              const showScopeBadge = totalRoomsOnRes > 1;
              return (
                <li key={inv.id} className="px-4 py-3 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-mono font-bold text-navy">{richInv.invoiceNumber}</span>
                      {isCreditNote ? (
                        <span className="text-[10px] uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded border bg-danger/10 text-danger border-danger/30">
                          Credit note
                        </span>
                      ) : (
                        <StatusBadge status={richInv.status} />
                      )}
                      {showScopeBadge && !isCreditNote && (
                        <span
                          className={`text-[10px] uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded border ${scope === "room" ? "bg-brand-soft text-brand-dark border-brand-dark/30" : "bg-accentBlue/10 text-accentBlue border-accentBlue/30"}`}
                        >
                          {scope === "room" ? "Per room" : "Combined"}
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-textSecondary mt-0.5">
                      Grand Total{" "}
                      <span className="font-mono text-brand-dark">{inr(richInv.grandTotal)}</span>
                      {Number(richInv.balanceDue) > 0.009 && (
                        <span className="ml-2">
                          · Balance{" "}
                          <span className="font-mono text-danger">{inr(richInv.balanceDue)}</span>
                        </span>
                      )}
                      {richInv.guestName && (
                        <span className="ml-2">· billed to {richInv.guestName}</span>
                      )}
                      {scopedRooms && scopedRooms.length > 0 && (
                        <span className="ml-2">
                          · room{scopedRooms.length === 1 ? "" : "s"}{" "}
                          {scopedRooms.map((rm) => (rm as { roomNumber: string }).roomNumber).join(", ")}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-1.5 shrink-0">
                    <div className="flex gap-2">
                      {Number(richInv.balanceDue) > 0.009 && richInv.status !== "voided" && (
                        <button
                          className="btn-primary !h-8 text-xs inline-flex items-center gap-1"
                          onClick={() =>
                            setPostIssuePay({
                              invoiceId: richInv.id,
                              invoiceNumber: richInv.invoiceNumber,
                              balanceDue: Number(richInv.balanceDue),
                            })
                          }
                        >
                          <CreditCard className="w-3.5 h-3.5" /> Collect {inr(richInv.balanceDue)}
                        </button>
                      )}
                      <button
                        className="btn-secondary !h-8 text-xs inline-flex items-center gap-1"
                        onClick={() => previewInvoice(richInv.id, richInv.invoiceNumber)}
                      >
                        <FileDown className="w-3.5 h-3.5" /> Preview
                      </button>
                    </div>
                    {/* Per-room bills — presentation-only splits of this
                        tax invoice, one PDF per room. For customer
                        reference (e.g. a company splitting cost); no new
                        invoice, no money. Only on a combined bill of 2+
                        rooms, and never on credit notes. */}
                    {!isCreditNote &&
                      scope !== "room" &&
                      scopedRooms &&
                      scopedRooms.length >= 2 && (
                        <div className="flex items-center gap-1 flex-wrap justify-end">
                          <span className="text-[10px] text-textSecondary">
                            Per-room bills:
                          </span>
                          {scopedRooms.map((rm) => {
                            const num = (rm as { roomNumber: string }).roomNumber;
                            return (
                              <button
                                key={num}
                                onClick={() =>
                                  previewRoomBill(richInv.invoiceNumber, richInv.id, num)
                                }
                                className="text-[10px] font-mono font-semibold px-1.5 py-0.5 rounded-sm border border-borderc text-brand-dark hover:border-brand hover:bg-brand-soft/40"
                                title={`Room ${num} bill (split of ${richInv.invoiceNumber})`}
                              >
                                {num}
                              </button>
                            );
                          })}
                        </div>
                      )}
                  </div>
                </li>
              );
            };
            return (
              <>
                <ul className="divide-y divide-borderc">
                  {activeDocs.map(renderInvoiceRow)}
                </ul>
                {reversedDocs.length > 0 && (
                  <div className="border-t border-borderc">
                    <button
                      onClick={() => setShowReversed((v) => !v)}
                      className="w-full px-4 py-2 text-left text-xs text-textSecondary hover:bg-bg flex items-center gap-1.5"
                    >
                      <ChevronDown
                        className={`w-3.5 h-3.5 transition-transform ${showReversed ? "rotate-180" : ""}`}
                      />
                      {showReversed ? "Hide" : "Show"} reversed ({reversedDocs.length})
                      <span className="text-[10px] text-textSecondary/70">
                        - paid invoices replaced via credit note, kept for GST
                      </span>
                    </button>
                    {showReversed && (
                      <ul className="divide-y divide-borderc bg-bg/30">
                        {reversedDocs.map(renderInvoiceRow)}
                      </ul>
                    )}
                  </div>
                )}
              </>
            );
          })()}
        </div>
      )}

      {(payments.length > 0 || (r.walletLedger?.length ?? 0) > 0) && (
        <div className="card p-0">
          <div className="px-4 py-3 border-b"><strong>Payment History</strong></div>
          <table className="table-base">
            <thead>
              <tr>
                <th>Date</th>
                <th>Method</th>
                <th>Notes</th>
                <th className="tabular-nums">Amount</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {(() => {
                // Merge wallet-ledger rows tied to this reservation
                // into Payment History as virtual rows so the
                // cancel-as-credit flow leaves a visible trail. They
                // render through PaymentRow with method="wallet" and
                // no receipt number (no PDF — the cash receipt path
                // doesn't apply). credit_issued = money out of the
                // property to the guest's wallet → negative amount;
                // credit_used = money in from the wallet → positive.
                const virtualWalletRows = (r.walletLedger ?? []).map(
                  (entry) => ({
                    id: `wallet-${entry.id}`,
                    amount:
                      entry.entryType === "credit_issued"
                        ? `-${entry.amount}`
                        : entry.amount,
                    paymentMethod: "wallet",
                    status: "received",
                    paymentDate: entry.createdAt,
                    notes:
                      entry.note ??
                      (entry.entryType === "credit_issued"
                        ? "Issued as wallet credit"
                        : "Applied wallet credit"),
                    receiptNumber: null,
                    voided: false,
                    createdAt: entry.createdAt,
                  }),
                );
                const merged = [...payments, ...virtualWalletRows].sort(
                  (a, b) =>
                    b.paymentDate.localeCompare(a.paymentDate),
                );
                return collapsePaymentsForDisplay(merged).map((row) => (
                  <PaymentRow
                    key={row.id}
                    payment={row}
                    onSaved={invalidate}
                    onPrintReceipt={() => previewReceipt(row.id, row.receiptNumber)}
                  />
                ));
              })()}
            </tbody>
          </table>
        </div>
      )}

      {showCharge && (
        <ChargeModal
          reservationId={r.id}
          // Live rooms only — a charge attributed to a room the guest has
          // already swapped out of sits on a closed leg.
          rooms={liveRooms.map((rm) => ({
            id: rm.id,
            roomNumber: rm.roomNumber,
            invoiced: !!rm.roomInvoiceId,
          }))}
          minutesOverdue={minutesOverdue}
          initialDescription={lateFeeFlow?.description}
          initialGstRate={lateFeeFlow?.gstRate}
          titleOverride={lateFeeFlow?.titleOverride}
          onClose={() => {
            setShowCharge(false);
            setLateFeeFlow(null);
          }}
          onSaved={() => {
            setShowCharge(false);
            invalidate();
            // If this Add Charge was invoked from the overdue → checkout
            // flow, advance to the Check Out modal as soon as the fee
            // is saved. Cancelling the Charge modal does NOT auto-open
            // checkout (staff explicitly bailed).
            if (lateFeeFlow) {
              setLateFeeFlow(null);
              setShowCheckout(true);
            }
          }}
        />
      )}
      {showPay && (
        <PaymentModal
          reservationId={r.id}
          balance={Number(r.balanceDue)}
          onClose={() => setShowPay(false)}
          onSaved={() => {
            setShowPay(false);
            invalidate();
          }}
        />
      )}
      {showCheckout && (
        <CheckoutModal
          reservationId={r.id}
          reservationNumber={r.reservationNumber}
          guestId={r.guestId}
          balance={Number(r.balanceDue)}
          subtotal={Number(r.subtotal)}
          totalGst={Number(r.gstAmount)}
          grandTotal={Number(r.grandTotal)}
          totalPaid={Number(totalPaid)}
          // Counts OCCUPANCIES, not rows. A segmented swap leaves a row for
          // the vacated room too, so counting rows made a one-room swapped
          // stay look like two rooms — which flipped the checkout into
          // per-room invoicing and offered the Combine toggle for a single
          // guest. The API groups swap legs onto one invoice (they share
          // swap_id); this mirrors that grouping so the UI and the bill agree.
          remainingRoomCount={uninvoicedOccupancies.length}
          remainingRooms={uninvoicedOccupancies.map((g) => ({
            // Whole chain, so the desk sees "101 → 102" rather than a room
            // the guest already left.
            roomNumber: g.map((rm) => rm.roomNumber).join(" → "),
            occupantName: null,
          }))}
          alreadyInvoicedRooms={r.rooms
            .filter((rm) => rm.roomInvoiceId)
            .map((rm) => {
              const inv = r.invoices?.find((i) => i.id === rm.roomInvoiceId);
              return {
                roomNumber: rm.roomNumber,
                invoiceNumber: inv?.invoiceNumber ?? "-",
              };
            })}
          additionalCharges={charges.map((c) => ({
            description: c.description,
            amount: Number(c.amount),
          }))}
          overdueLabel={
            overdueDays > 0
              ? `${overdueDays} day${overdueDays === 1 ? "" : "s"} past scheduled out`
              : minutesOverdue > 0
                ? `${minutesOverdue} min past check-out time`
                : null
          }
          onClose={() => setShowCheckout(false)}
          onDone={() => {
            setShowCheckout(false);
            invalidate();
          }}
        />
      )}
      {showKyc && (
        <KycModal
          guestId={r.guestId}
          onClose={() => setShowKyc(false)}
          onUploaded={() => {
            invalidate();
          }}
        />
      )}
      <OtpModal
        reservationId={r.id}
        open={showOtp}
        onClose={() => setShowOtp(false)}
        onVerified={() => {
          setShowOtp(false);
          checkIn.mutate();
        }}
      />

      {showEarlyCheckIn && (
        <EarlyCheckInModal
          reservationId={r.id}
          reservationNumber={r.reservationNumber}
          onClose={() => setShowEarlyCheckIn(false)}
          onConfirmed={() => {
            setShowEarlyCheckIn(false);
            toast("Booking dates shifted for early check-in", "success");
            invalidate();
            // Continue into the OTP step, or straight to check-in when OTP
            // is disabled for this property.
            if (otpEnabled) setShowOtp(true);
            else checkIn.mutate();
          }}
        />
      )}

      {showMakeComp && (
        <MakeCompModal
          reservationNumber={r.reservationNumber}
          grandTotal={r.grandTotal}
          totalPaid={totalPaid}
          pending={makeComp.isPending}
          onClose={() => setShowMakeComp(false)}
          onSubmit={(vars) => {
            makeComp.mutate(vars, {
              onSuccess: () => setShowMakeComp(false),
            });
          }}
        />
      )}

      {showInvoiceEdit && invoice && (
        <EditInvoiceModal
          invoiceId={invoice.id}
          onClose={() => setShowInvoiceEdit(false)}
          onSaved={() => {
            invalidate();
            toast("Invoice updated", "success");
          }}
        />
      )}

      {showCheckInReceipt && settingsQ.data && (
        <CheckInReceiptModal
          data={
            {
              reservationNumber: r.reservationNumber,
              bookingSource: r.bookingSource,
              checkInDate: r.checkInDate,
              checkOutDate: r.checkOutDate,
              checkedInAt: r.checkedInAt,
              numNights: nights,
              stayType: r.stayType,
              durationHours: durationHours || null,
              numAdults: r.numAdults,
              numChildren: r.numChildren,
              guest: {
                fullName: r.guest.fullName,
                phone: r.guest.phone,
                gender: (r.guest as { gender?: string | null }).gender,
                idProofType: r.guest.idProofType,
                idProofLast4: r.guest.idProofLast4,
                gstin: r.guest.gstin,
                photoUrl: r.guest.photoUrl,
              },
              coGuests: r.coGuests?.map((cg) => ({
                fullName: cg.guest.fullName,
                phone: cg.guest.phone,
                gender: cg.guest.gender,
                idProofType: cg.guest.idProofType,
                idProofLast4: cg.guest.idProofLast4,
              })),
              rooms: r.rooms.map((rm) => ({
                roomNumber: rm.roomNumber,
                roomType: rm.roomType,
                soldAsType: rm.soldAsType ?? null,
                displayType: rm.displayType,
                ratePerNight: rm.ratePerNight,
              })),
              subtotal: r.subtotal,
              gstRate: r.gstRate,
              gstAmount: r.gstAmount ?? "",
              grandTotal: r.grandTotal,
              advancePaid: r.advancePaid,
              balanceDue: r.balanceDue,
              latestPayment:
                r.payments.length > 0
                  ? {
                      id: r.payments[r.payments.length - 1]!.id,
                      amount: r.payments[r.payments.length - 1]!.amount,
                      paymentMethod: r.payments[r.payments.length - 1]!.paymentMethod,
                      receiptNumber: r.payments[r.payments.length - 1]!.receiptNumber,
                      paymentDate: r.payments[r.payments.length - 1]!.paymentDate,
                    }
                  : null,
              allPayments: r.payments.map((p) => ({
                amount: p.amount,
                paymentDate: p.paymentDate,
                voided: p.voided,
                status: p.status,
              })),
              hotel: {
                name: settingsQ.data.hotelName,
                address: settingsQ.data.hotelAddress,
                phone: settingsQ.data.hotelPhone,
                ownerPhone: settingsQ.data.ownerPhone,
                gstin: settingsQ.data.hotelGstin,
                logoUrl: settingsQ.data.hotelLogoUrl ?? "/logo.png",
                checkInTime: settingsQ.data.checkInTime,
                checkOutTime: settingsQ.data.checkOutTime,
              },
            } satisfies CheckInReceiptData
          }
          onClose={() => setShowCheckInReceipt(false)}
        />
      )}

      {slipPaymentId && settingsQ.data && (() => {
        const pay = r.payments.find((p) => p.id === slipPaymentId);
        if (!pay) return null;
        // If this slip is being viewed before check-in, label it as the
        // booking-advance variant; once checked in, it's effectively a
        // check-in receipt for whichever payment row the user clicked.
        const variant = r.status === "confirmed" ? "booking_advance" : "checkin";
        return (
          <CheckInReceiptModal
            variant={variant}
            data={
              {
                reservationNumber: r.reservationNumber,
                checkInDate: r.checkInDate,
                checkOutDate: r.checkOutDate,
                checkedInAt: r.checkedInAt,
                numNights: nights,
                stayType: r.stayType,
                durationHours: durationHours || null,
                numAdults: r.numAdults,
                numChildren: r.numChildren,
                guest: {
                  fullName: r.guest.fullName,
                  phone: r.guest.phone,
                  gender: (r.guest as { gender?: string | null }).gender,
                  idProofType: r.guest.idProofType,
                  idProofLast4: r.guest.idProofLast4,
                  gstin: r.guest.gstin,
                  photoUrl: r.guest.photoUrl,
                },
                coGuests: r.coGuests?.map((cg) => ({
                  fullName: cg.guest.fullName,
                  phone: cg.guest.phone,
                  gender: cg.guest.gender,
                  idProofType: cg.guest.idProofType,
                  idProofLast4: cg.guest.idProofLast4,
                })),
                rooms: r.rooms.map((rm) => ({
                  roomNumber: rm.roomNumber,
                  roomType: rm.roomType,
                  ratePerNight: rm.ratePerNight,
                })),
                subtotal: r.subtotal,
                gstRate: r.gstRate,
                gstAmount: r.gstAmount ?? "",
                grandTotal: r.grandTotal,
                advancePaid: r.advancePaid,
                balanceDue: r.balanceDue,
                latestPayment: {
                  id: pay.id,
                  amount: pay.amount,
                  paymentMethod: pay.paymentMethod,
                  receiptNumber: pay.receiptNumber,
                  paymentDate: pay.paymentDate,
                },
                allPayments: r.payments.map((p) => ({
                  amount: p.amount,
                  paymentDate: p.paymentDate,
                  voided: p.voided,
                  status: p.status,
                })),
                hotel: {
                  name: settingsQ.data.hotelName,
                  address: settingsQ.data.hotelAddress,
                  phone: settingsQ.data.hotelPhone,
                  ownerPhone: settingsQ.data.ownerPhone,
                  gstin: settingsQ.data.hotelGstin,
                  logoUrl: settingsQ.data.hotelLogoUrl ?? "/logo.png",
                  checkInTime: settingsQ.data.checkInTime,
                  checkOutTime: settingsQ.data.checkOutTime,
                },
              } satisfies CheckInReceiptData
            }
            onClose={() => setSlipPaymentId(null)}
          />
        );
      })()}


      {showExtend && (
        <ExtendModal
          reservationId={r.id}
          currentCheckOut={r.checkOutDate}
          currentRate={rooms[0]?.ratePerNight ?? "0"}
          // Only rooms the guest is actually still in. After a mid-stay swap
          // the booking keeps a row for the vacated room too, bounded to end
          // at the swap date — offering it here listed "2 of 2 rooms" for a
          // one-room stay and, if left ticked, made the server re-block a
          // sellable room and double the extension rate delta. A closed leg
          // is any row ending before the reservation's own checkout; the live
          // leg ends exactly at it (NULL = unsegmented, always live).
          rooms={liveRooms.map((rm) => ({
            id: rm.id,
            roomNumber: rm.roomNumber,
            invoiced: !!rm.roomInvoiceId,
            status: rm.roomStatus,
          }))}
          minutesOverdue={minutesOverdue}
          onClose={() => setShowExtend(false)}
          onSaved={() => {
            setShowExtend(false);
            invalidate();
          }}
          onSplit={(created) => {
            setShowExtend(false);
            invalidate();
            toast(
              `Split off ${created.reservationNumber} - opening it now`,
              "success",
            );
            navigate(`/reservations/${created.reservationNumber}`);
          }}
        />
      )}
      {showLate && (
        <LateCheckoutModal
          reservationId={r.id}
          onClose={() => setShowLate(false)}
          onSaved={() => {
            setShowLate(false);
            invalidate();
          }}
        />
      )}
      {showCancel && (
        <CancelReservationModal
          reservationNumber={r.reservationNumber}
          advancePaid={Number(r.advancePaid ?? 0)}
          isSubmitting={cancel.isPending}
          onClose={() => setShowCancel(false)}
          onConfirm={(input) => {
            cancel.mutate(input, {
              onSuccess: () => setShowCancel(false),
            });
          }}
        />
      )}
      {showAddRoom && (
        <AddRoomModal
          reservationId={r.id}
          checkInDate={r.checkInDate}
          checkOutDate={r.checkOutDate}
          stayType={r.stayType ?? "overnight"}
          existingRoomIds={rooms.map((rm) => rm.id)}
          minutesOverdue={minutesOverdue}
          onClose={() => setShowAddRoom(false)}
          onSaved={() => {
            setShowAddRoom(false);
            invalidate();
          }}
        />
      )}
      {showCombinedInvoice && (
        <CombinedInvoiceModal
          reservationId={r.id}
          uninvoicedRooms={(r.rooms ?? [])
            .filter((rm) => !rm.roomInvoiceId)
            .map((rm) => ({
              id: rm.id,
              roomNumber: rm.roomNumber,
              displayType: rm.displayType,
              ratePerNight: rm.ratePerNight,
            }))}
          nights={Number(r.numNights ?? 1)}
          gstRate={Number(r.gstRate)}
          gstMode={r.gstMode ?? "exclusive"}
          stayType={r.stayType ?? "overnight"}
          onClose={() => setShowCombinedInvoice(false)}
          onIssued={(inv, meta) => {
            setShowCombinedInvoice(false);
            invalidate();
            // Only chain into Record Payment when the user explicitly
            // ticked "Collect payment" AND the resulting invoice is
            // short of the bill (Partial). The other balance-due path
            // — issuing without collecting — is intentional, so we stay
            // quiet; the per-invoice Collect button in the list is the
            // way to collect later.
            const owed = Number(inv.balanceDue);
            if (meta.collectIntended && owed > 0.009) {
              setPostIssuePay({
                invoiceId: inv.id,
                invoiceNumber: inv.invoiceNumber,
                balanceDue: owed,
              });
            }
          }}
        />
      )}
      {postIssuePay && (
        <PaymentModal
          reservationId={r.id}
          balance={postIssuePay.balanceDue}
          invoiceId={postIssuePay.invoiceId}
          invoiceNumber={postIssuePay.invoiceNumber}
          onClose={() => setPostIssuePay(null)}
          onSaved={() => {
            setPostIssuePay(null);
            invalidate();
          }}
        />
      )}
      <PdfPreviewModal
        open={!!pdfPreview}
        url={pdfPreview?.url ?? null}
        title={pdfPreview?.title ?? ""}
        filename={pdfPreview?.filename ?? "document.pdf"}
        onClose={() => setPdfPreview(null)}
      />
    </div>
  );
}

// Group split-receipt slices for display only.
//
// Why: multi-room bookings produce one "per-room share" receipt per
// invoice plus optional spillover splits from a single advance. To
// staff/guests that reads as "five receipts for one payment" — very
// confusing. The DB intentionally keeps the slices distinct (each
// row attaches to a single invoice) but the Payment History UI
// should present the original collection event as ONE row.
//
// Grouping key: minute-truncated payment_date + method + a "family"
// label derived from the note. All slices created in the same
// transaction share these. Voided rows and one-off rows (no family
// label) pass through untouched.
type RawPayment = {
  id: string;
  amount: string;
  paymentMethod: string;
  status?: string;
  paymentDate: string;
  notes: string | null;
  receiptNumber: string | null;
  voided?: boolean;
  createdAt: string;
};

function paymentFamilyLabel(notes: string | null): string | null {
  if (!notes) return null;
  const trimmed = notes.trim();
  if (trimmed.startsWith("Advance at booking")) return "Advance at booking";
  if (trimmed.startsWith("Advance at check-in")) return "Advance at check-in";
  if (trimmed.startsWith("Per-room share of check-out collection")) {
    return "Collected at check-out";
  }
  if (trimmed.startsWith("Collected at check-out of")) {
    // Cross-reservation collection — strip the "(Room X)" suffix and
    // the " · part Y/Z" trailer so siblings collapse.
    return trimmed.replace(/\s*·\s*part \d+\/\d+.*$/, "").replace(/\s*\(Room [^)]+\)/, "");
  }
  // Both spellings: legacy rows in the DB carry the em-dash version.
  if (
    trimmed.startsWith("Booking — no advance collected") ||
    trimmed.startsWith("Booking - no advance collected")
  ) {
    return "Booking - no advance collected";
  }
  return null;
}

function collapsePaymentsForDisplay(raws: RawPayment[]): RawPayment[] {
  const out: RawPayment[] = [];
  // groupKey -> index into out
  const groupIdx = new Map<string, number>();
  for (const p of raws) {
    const family = paymentFamilyLabel(p.notes);
    // Voided rows + pending rows + rows without a recognised family
    // are passed through one-to-one so void actions / "mark received"
    // buttons keep working on the right underlying row.
    if (p.voided || p.status === "pending" || !family) {
      out.push(p);
      continue;
    }
    // Truncate to the minute so micro-second differences between
    // sibling inserts in the same transaction still collapse.
    const minute = p.paymentDate.slice(0, 16);
    const key = `${family}|${minute}|${p.paymentMethod}`;
    const existingIdx = groupIdx.get(key);
    if (existingIdx === undefined) {
      // First slice of this group. Drive the displayed row from this
      // payment but replace the noisy notes with the clean family
      // label.
      out.push({ ...p, notes: family });
      groupIdx.set(key, out.length - 1);
    } else {
      // Subsequent slice: sum into the displayed row's amount. Drop
      // the receipt number on the merged row because it now represents
      // multiple receipts — clicking "Preview" still opens the first
      // slice's PDF, which is the original receipt.
      const head = out[existingIdx]!;
      const merged = +(Number(head.amount) + Number(p.amount)).toFixed(2);
      out[existingIdx] = { ...head, amount: String(merged) };
    }
  }
  return out;
}

// Virtual closed-leg row for in-place swaps. The DB doesn't keep a
// separate row for the original room on a 1-night or day-use swap
// (the row is re-pointed in place), so this is purely display: a
// read-only summary that mirrors how segmented swaps look in the UI.
// No action buttons because there's no underlying reservation_rooms
// row to act on.
function SwapClosedLegRow(props: {
  fromRoom: {
    roomNumber: string;
    displayType: string;
    hasAc: boolean;
    hasTv: boolean;
    hasWifi: boolean;
  };
  toRoomNumber: string;
  reason: string | null;
  reservationCheckIn: string;
  reservationCheckOut: string;
  nights: number;
}) {
  const segLabel =
    props.nights === 0
      ? "Same-day swap"
      : `${format(new Date(props.reservationCheckIn), "dd MMM")} → ${format(
          new Date(props.reservationCheckIn),
          "dd MMM",
        )} · 0n`;
  const hasAnyAmenity =
    props.fromRoom.hasAc || props.fromRoom.hasTv || props.fromRoom.hasWifi;
  return (
    <tr className="bg-bg/40">
      <td className="font-mono">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-textSecondary">{props.fromRoom.roomNumber}</span>
        </div>
        <div className="mt-1 flex items-center gap-1.5 flex-wrap">
          <span className="text-[9px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded border bg-textSecondary/10 text-textSecondary border-textSecondary/30">
            Swapped to Room {props.toRoomNumber}
          </span>
          <span className="text-[11px] text-textSecondary font-mono">{segLabel}</span>
          {props.reason && (
            <span className="text-[11px] text-textSecondary italic">
              · {props.reason}
            </span>
          )}
        </div>
        {hasAnyAmenity && (
          <div className="flex flex-wrap gap-1 mt-1 opacity-60">
            {props.fromRoom.hasAc && (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm text-[10px] font-semibold bg-accentBlue/15 text-accentBlue">
                <Snowflake className="w-2.5 h-2.5" /> AC
              </span>
            )}
            {props.fromRoom.hasTv && (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm text-[10px] font-semibold bg-gray-200 text-textSecondary">
                <Tv className="w-2.5 h-2.5" /> TV
              </span>
            )}
            {props.fromRoom.hasWifi && (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm text-[10px] font-semibold bg-gray-200 text-textSecondary">
                <Wifi className="w-2.5 h-2.5" /> Wi-Fi
              </span>
            )}
          </div>
        )}
      </td>
      <td className="capitalize text-textSecondary">{props.fromRoom.displayType}</td>
      <td className="font-mono tabular-nums text-textSecondary">-</td>
      <td className="font-mono tabular-nums text-textSecondary">-</td>
      <td className="text-right">
        <span className="text-[10px] uppercase tracking-wider font-semibold px-2 py-0.5 rounded-sm bg-textSecondary/10 text-textSecondary">
          closed
        </span>
      </td>
    </tr>
  );
}

// Extended-stay breakdown. When a reservation's check-out was pushed out
// past its first-booked date, the flat "2n" subtotal hides that it's really
// two segments. These two indented sub-rows split it into the original
// booking and the extension, each with its own nights × rate = subtotal —
// the desk reads the extension as a first-class line, not buried in a total.
// Rendered once, under the first room row (mirrors SwapClosedLegRow's shape).
// Splits ONE room's nights either side of the originally-booked checkout.
//
// The window is the room's own [effective_from, effective_to) when the row is
// swap-segmented, else the reservation's dates. Clamping to that window is
// what makes this safe on a swapped booking: the reservation-level split would
// re-count nights the segment rows already show. A room lying wholly on one
// side of the original checkout simply yields one row (the other is 0n and is
// not rendered).
function ExtensionBreakdownRows(props: {
  windowFrom: string;
  windowTo: string;
  originalCheckOut: string;
  ratePerNight: string;
  displayType: string;
  // "added" = the room was booked mid-stay via Add Room, not part of the
  // original booking and not the checkout extension. Its whole window is one
  // "Added room" row — splitting it at the original checkout would mislabel it
  // "Stay Extension" just because its dates happen to fall after that date.
  mode?: "split" | "added";
}) {
  const dayMs = 24 * 60 * 60 * 1000;
  const rate = Number(props.ratePerNight);
  const nightsBetween = (from: string, to: string) =>
    Math.max(0, Math.round((new Date(to).getTime() - new Date(from).getTime()) / dayMs));
  // yyyy-MM-dd compares correctly as a string, so no Date round-trip needed.
  const earlier = (a: string, b: string) => (a < b ? a : b);
  const later = (a: string, b: string) => (a > b ? a : b);

  // Portion of THIS room's window before the original checkout...
  const origFrom = props.windowFrom;
  const origTo = earlier(props.windowTo, props.originalCheckOut);
  // ...and the portion after it.
  const extFrom = later(props.windowFrom, props.originalCheckOut);
  const extTo = props.windowTo;

  const origNights = nightsBetween(origFrom, origTo);
  const extNights = nightsBetween(extFrom, extTo);

  const seg = (
    label: string,
    from: string,
    to: string,
    n: number,
    badge: { text: string; cls: string },
  ) => (
    <tr className="bg-bg/40">
      <td className="font-mono">
        <div className="mt-0.5 flex items-center gap-1.5 flex-wrap pl-3">
          <span className="text-textSecondary">↳</span>
          <span
            className={`text-[9px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded border ${badge.cls}`}
          >
            {badge.text}
          </span>
          <span className="text-[11px] text-textSecondary font-mono">
            {format(new Date(from), "dd MMM")} → {format(new Date(to), "dd MMM")} · {n}n
          </span>
        </div>
      </td>
      <td className="capitalize text-textSecondary text-xs">{label}</td>
      <td className="font-mono tabular-nums text-textSecondary text-xs">{inr(rate)}</td>
      <td className="font-mono tabular-nums text-textSecondary text-xs">{inr(rate * n)}</td>
      <td></td>
    </tr>
  );

  if (props.mode === "added") {
    const n = nightsBetween(props.windowFrom, props.windowTo);
    return n > 0
      ? seg("Added room", props.windowFrom, props.windowTo, n, {
          text: "Added",
          cls: "bg-brand-soft text-brand-dark border-brand-dark/30",
        })
      : null;
  }

  return (
    <>
      {origNights > 0 &&
        seg("Original booking", origFrom, origTo, origNights, {
          text: "Original",
          cls: "bg-textSecondary/10 text-textSecondary border-textSecondary/30",
        })}
      {extNights > 0 &&
        seg("Stay extension", extFrom, extTo, extNights, {
          text: "Extended",
          cls: "bg-accentBlue/10 text-accentBlue border-accentBlue/30",
        })}
    </>
  );
}

function RoomRow(props: {
  reservationId: string;
  room: {
    id: string;
    roomNumber: string;
    roomType: string;
    soldAsType?: string | null;
    displayType?: string;
    ratePerNight: string;
    // PHYSICAL room status (dirty/clean/inspected/...).
    status?: string;
    // NEW (migration 0017): per-room reservation state +
    // occupant. The reservation detail uses these to expose per-
    // room check-out and per-room invoicing.
    reservationRoomId?: string;
    roomStatus?: "confirmed" | "checked_in" | "checked_out" | "cancelled";
    roomInvoiceId?: string | null;
    occupant?: { id: string; fullName: string; phone: string; isBooker: boolean } | null;
    hasAc?: boolean;
    hasTv?: boolean;
    hasWifi?: boolean;
    // Per-row segment columns (0019 mid-stay swap).
    effectiveFrom?: string | null;
    effectiveTo?: string | null;
    swapId?: string | null;
    swapReason?: string | null;
    // 0037 — full in-place swap chain.
    swapHistory?: {
      id: string;
      fromRoom: {
        id: string;
        roomNumber: string;
        roomType: string;
        displayType: string;
        hasAc: boolean;
        hasTv: boolean;
        hasWifi: boolean;
      } | null;
      toRoomNumber: string | null;
      reason: string;
      ratePerNight: string;
      createdAt: string;
    }[];
    // 0036 backwards-compat.
    swappedFromRoom?: {
      id: string;
      roomNumber: string;
      roomType: string;
      displayType: string;
      hasAc: boolean;
      hasTv: boolean;
      hasWifi: boolean;
    } | null;
    // Same-day re-let pending (server-computed). Surface a banner so
    // staff knows a walk-in is in the room right now.
    reletPending?: {
      reservationId: string;
      reservationNumber: string;
      guestName: string;
      checkOutDate: string;
    } | null;
  };
  // Reservation-level window — used as the fallback bound when the row's
  // effective_from / effective_to are NULL, and so the swap modal can
  // constrain the effective date picker.
  reservationCheckIn: string;
  reservationCheckOut: string;
  // Day-use bookings swap in-place (no segmentation, no effective date)
  // because they cover a single calendar day.
  isShortStay: boolean;
  // 1-night overnight stays also swap in-place — there's no meaningful
  // sub-range to segment when the segment is exactly one night long.
  isSingleNight: boolean;
  nights: number;
  // Swap chain context, computed by the parent so each row can label
  // itself "Swapped to/from Room X" and we can suppress write actions
  // on closed legs.
  swapSiblingNumber?: string | null;
  swapDirection?: "to" | "from" | null;
  // The sibling segment's per-night rate — lets the active leg show a
  // "₹1,700 → ₹1,500/night" tag when a swap changed the price.
  swapSiblingRate?: string | null;
  // True when this segmented row is a mid-stay ADDED room, not a swap leg.
  // Drives an "Added" timeline badge instead of the swap pill.
  isAddedRoom?: boolean;
  onSaved: () => void;
}) {
  const rate = Number(props.room.ratePerNight);
  const { can } = useAuth();
  const [showRoomCheckout, setShowRoomCheckout] = useState(false);
  const [showSwap, setShowSwap] = useState(false);

  // Effective window for this row. Falls back to the parent reservation
  // window when the row is unsegmented (legacy / never swapped).
  const segFrom = props.room.effectiveFrom ?? props.reservationCheckIn;
  const segTo = props.room.effectiveTo ?? props.reservationCheckOut;
  const isSegmented = !!(props.room.effectiveFrom || props.room.effectiveTo);
  // Closed leg of a swap = an earlier segment in the same swap chain.
  // The guest is no longer in this room (they moved to the sibling).
  // We surface this as a status pill instead of "checked in", and we
  // suppress every write action (Check Out, Issue Invoice, Swap)
  // because there's nothing to act on here — the room is history.
  const isClosedSwapLeg = props.swapDirection === "to";
  // Per-row nights honour the segment window when the row was created
  // by a mid-stay swap (0019). Without this, both halves of a swap
  // would multiply the rate by the parent's total nights and the
  // subtotal column would visually double-bill staff (matches the
  // same fix in invoiceBuilder + invoice preview).
  const rowNights = isSegmented
    ? Math.max(
        1,
        Math.round(
          (new Date(segTo).getTime() - new Date(segFrom).getTime()) /
            (24 * 60 * 60 * 1000),
        ),
      )
    : props.nights;

  // Per-room status pill colours. Maps the new reservation-room
  // statuses to badge styles (different from physical room status).
  const roomStatusBadge: Record<string, string> = {
    confirmed: "bg-brand-soft text-brand-dark border-brand-dark/30",
    checked_in: "bg-success/15 text-success border-success/30",
    checked_out: "bg-bg text-textSecondary border-borderc",
    cancelled: "bg-danger/10 text-danger border-danger/30 line-through",
  };

  const status = props.room.status;
  const isHousekeeping =
    status === "dirty" || status === "maintenance" || status === "available";

  const statusBadge =
    status && status !== "occupied" && status !== "reserved"
      ? {
          dirty: "bg-warning/15 text-warning border-warning/30",
          available: "bg-success/10 text-success border-success/30",
          maintenance: "bg-danger/10 text-danger border-danger/30",
        }[status as "dirty" | "available" | "maintenance"]
      : null;

  const hasAnyAmenity =
    props.room.hasAc !== undefined ||
    props.room.hasTv !== undefined ||
    props.room.hasWifi !== undefined;

  return (
    <>
    <tr>
      <td className="font-mono">
        <div className="flex items-center gap-2 flex-wrap">
          {props.room.roomNumber}
          {/* Per-room (0017) reservation state pill. Distinct from
              the physical-room status pill below; e.g. a room can be
              checked_out AND dirty at the same time.
              Hidden on the closed leg of a swap because the guest is
              no longer in this room — the "Swapped to Room X" pill
              below already tells the story, and showing "CHECKED IN"
              on a vacated room confuses staff. */}
          {props.room.roomStatus && !isClosedSwapLeg && (
            <span
              className={`text-[9px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded border ${roomStatusBadge[props.room.roomStatus]}`}
            >
              {props.room.roomStatus.replace("_", " ")}
            </span>
          )}
          {/* Physical-room status pill (AVAILABLE / DIRTY / MAINTENANCE…).
              Skipped when the reservation_room state already tells the
              full story: a cancelled / checked_out row doesn't benefit
              from also showing the room's housekeeping status — that
              info belongs on the Housekeeping board, not the booking
              page. Keeps the row clean. */}
          {statusBadge &&
            !isClosedSwapLeg &&
            props.room.roomStatus !== "cancelled" &&
            props.room.roomStatus !== "checked_out" && (
              <span className={`text-[9px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded border ${statusBadge}`}>
                {status}
              </span>
            )}
        </div>
        {/* Per-room (0017) occupant line. Hidden when this room is
            occupied by the booker (the common case for single-guest
            bookings); shown when a multi-room reservation has been
            split into different occupants. */}
        {props.room.occupant && !props.room.occupant.isBooker && (
          <div className="text-[11px] text-textSecondary mt-1">
            <span className="font-medium text-brand-dark">{props.room.occupant.fullName}</span>
            {props.room.occupant.phone && (
              <span className="font-mono ml-1">· {props.room.occupant.phone}</span>
            )}
          </div>
        )}
        {/* In-place swap audit. Shows on the active row of an in-place
            swap chain (no real segmented siblings exist for these).
            Prefers the new history table (0037) so multi-hop chains
            show the immediately-prior room; falls back to the legacy
            single-slot field (0036) when no history is present. */}
        {(() => {
          if (isSegmented) return null;
          const lastHop =
            props.room.swapHistory && props.room.swapHistory.length > 0
              ? props.room.swapHistory[props.room.swapHistory.length - 1]
              : null;
          const prevRoomNumber =
            lastHop?.fromRoom?.roomNumber ??
            props.room.swappedFromRoom?.roomNumber ??
            null;
          if (!prevRoomNumber) return null;
          // Reason describes what happened to the LEAVING room
          // ("Maintenance"), so it belongs only on the closed leg.
          // Showing it on the active row read as if the active room
          // itself were under maintenance — confusing for staff.
          return (
            <div className="mt-1 flex items-center gap-1.5 flex-wrap">
              <span className="text-[9px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded border bg-accentBlue/10 text-accentBlue border-accentBlue/30">
                Swapped from Room {prevRoomNumber}
              </span>
            </div>
          );
        })()}
        {/* Added-room timeline. A room booked mid-stay via Add Room is
            segmented but is NOT a swap — it must not borrow the swap pill,
            which fell back to a bare "Swapped" here because there is no
            sibling leg to name. */}
        {isSegmented && props.isAddedRoom && (
          <div className="mt-1 flex items-center gap-1.5 flex-wrap">
            <span className="text-[9px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded border bg-brand-soft text-brand-dark border-brand-dark/30">
              Added mid-stay
            </span>
            <span className="text-[11px] text-textSecondary font-mono">
              {format(new Date(segFrom), "dd MMM")} →{" "}
              {format(new Date(segTo), "dd MMM")} · {rowNights}n
            </span>
          </div>
        )}
        {/* Segment timeline (0019). Shows the swap direction so staff
            instantly read the row's role — "Swapped TO Room 205" on
            the closed leg, "Swapped FROM Room 203" on the active leg.
            Falls back to a plain "Swapped" pill when the sibling
            isn't on the response (e.g. data races, legacy rows). */}
        {isSegmented && !props.isAddedRoom && (
          <div className="mt-1 flex items-center gap-1.5 flex-wrap">
            <span
              className={`text-[9px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded border ${
                props.swapDirection === "to"
                  ? "bg-textSecondary/10 text-textSecondary border-textSecondary/30"
                  : "bg-accentBlue/10 text-accentBlue border-accentBlue/30"
              }`}
            >
              {props.swapDirection === "to" && props.swapSiblingNumber
                ? `Swapped to Room ${props.swapSiblingNumber}`
                : props.swapDirection === "from" && props.swapSiblingNumber
                  ? `Swapped from Room ${props.swapSiblingNumber}`
                  : "Swapped"}
            </span>
            <span className="text-[11px] text-textSecondary font-mono">
              {format(new Date(segFrom), "dd MMM")} →{" "}
              {format(new Date(segTo), "dd MMM")} · {rowNights}n
            </span>
            {/* The swap reason describes what happened to the LEAVING
                room (e.g. "Maintenance"). Showing it on the new room's
                row makes 205 read as if 205 itself were broken — it's
                not, 203 is. So we only render the reason on the closed
                leg ("Swapped to ..."). */}
            {props.room.swapReason && props.swapDirection === "to" && (
              <span className="text-[11px] text-textSecondary italic">
                · {props.room.swapReason}
              </span>
            )}
            {/* Rate change from the swap — shown on the ACTIVE leg only
                (that's the row the guest is paying on now). */}
            {props.swapDirection === "from" &&
              props.swapSiblingRate &&
              Math.abs(Number(props.swapSiblingRate) - Number(props.room.ratePerNight)) > 0.009 && (
                <span className="text-[11px] font-semibold text-warning">
                  · {inr(Number(props.swapSiblingRate))} → {inr(Number(props.room.ratePerNight))}
                  /night (
                  {Number(props.room.ratePerNight) < Number(props.swapSiblingRate) ? "-" : "+"}
                  {inr(Math.abs(Number(props.room.ratePerNight) - Number(props.swapSiblingRate)))})
                </span>
              )}
          </div>
        )}
        {hasAnyAmenity && (
          <div className="flex flex-wrap gap-1 mt-1">
            {props.room.hasAc ? (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm text-[10px] font-semibold bg-accentBlue/15 text-accentBlue">
                <Snowflake className="w-2.5 h-2.5" /> AC
              </span>
            ) : (
              <span className="inline-flex items-center px-1.5 py-0.5 rounded-sm text-[10px] font-semibold bg-gray-200 text-textSecondary">
                Non-AC
              </span>
            )}
            {props.room.hasTv && (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm text-[10px] font-semibold bg-brand-soft text-brand-dark">
                <Tv className="w-2.5 h-2.5" /> TV
              </span>
            )}
            {props.room.hasWifi && (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm text-[10px] font-semibold bg-success/15 text-success">
                <Wifi className="w-2.5 h-2.5" /> Wi-Fi
              </span>
            )}
          </div>
        )}
        {props.room.reletPending && (
          <div className="mt-2 inline-flex items-start gap-1.5 px-2 py-1 rounded-sm bg-warning/10 border border-warning/40 text-[10px] text-warning leading-snug max-w-full">
            <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" />
            <span>
              <strong>Re-let pending</strong> ·{" "}
              {props.room.reletPending.guestName} (
              {props.room.reletPending.reservationNumber}) checks out by{" "}
              {props.room.reletPending.checkOutDate} before this guest arrives.
            </span>
          </div>
        )}
      </td>
      <td className="capitalize">
        {props.room.displayType ?? props.room.roomType.replace(/_/g, " ")}
      </td>
      <td className="font-mono tabular-nums">
        {inr(props.room.ratePerNight)}
      </td>
      <td className="font-mono tabular-nums">{inr(rate * rowNights)}</td>
      <td className="text-right">
        {isClosedSwapLeg ? (
          // Closed leg of a swap. No actions — the row is historical,
          // the guest moved to the sibling room. Showing Check Out /
          // Swap / Issue Invoice here would let staff act on a vacated
          // segment, which is meaningless and confusing. We keep the
          // row visible (for billing transparency) but render it
          // read-only.
          <span
            className="text-[10px] font-mono text-textSecondary px-1.5 py-0.5 rounded bg-textSecondary/10 border border-textSecondary/20"
            title={`Vacated on ${format(new Date(segTo), "dd MMM yyyy")} - guest moved to Room ${props.swapSiblingNumber}`}
          >
            closed
          </span>
        ) : (
          <>
            <div className="inline-flex gap-1 items-center">
              {/* Hide the housekeeping Status changer once the room is
                  checked out (or cancelled) from this reservation's
                  perspective. A finished room's clean/dirty/available state
                  is managed from the Rooms / Housekeeping pages — letting
                  staff flip it back to "Available" from a closed booking
                  created a confusing "un-check-out" path. */}
              {isHousekeeping &&
                status &&
                props.room.roomStatus !== "checked_out" &&
                props.room.roomStatus !== "cancelled" && (
                  <RoomActionPopover
                    roomId={props.room.id}
                    roomNumber={props.room.roomNumber}
                    status={status as "dirty" | "available" | "maintenance"}
                    onChanged={props.onSaved}
                    invalidateKeys={[["reservation"], ["dashboard"]]}
                    trigger={
                      <span
                        className="inline-block !h-7 !px-2 text-xs font-medium rounded-sm border border-borderc bg-surface hover:bg-bg cursor-pointer leading-[1.5rem] capitalize"
                        title="Change room status"
                      >
                        Status…
                      </span>
                    }
                  />
                )}
              {props.room.roomStatus === "checked_in" && !props.room.roomInvoiceId && can("manage_rooms_on_stay") && (
                <button
                  className="btn-secondary !h-7 !px-2 text-xs"
                  onClick={() => setShowSwap(true)}
                  title={
                    props.isShortStay
                      ? "Move this guest to a different room (same day)"
                      : "Move this guest to a different room"
                  }
                >
                  Swap
                </button>
              )}
              {props.room.roomStatus === "checked_in" && can("check_out") && (
                <button
                  className="btn-secondary !h-7 !px-2 text-xs"
                  onClick={() => setShowRoomCheckout(true)}
                  title="Check this guest out & collect payment"
                >
                  Check Out
                </button>
              )}
              {/* No "Issue Invoice" here by design: invoices are generated
                  by the payment/checkout flows (per-room Check Out or the
                  reservation-level Check Out & Generate Invoice), never
                  ahead of payment. The API's invoices.scope='room' path is
                  still driven from the checkout flow below. */}
              {props.room.roomInvoiceId && (
                <span
                  className="text-[10px] font-mono text-success px-1.5 py-0.5 rounded bg-success/10 border border-success/30"
                  title="A per-room invoice exists for this room - see Invoices section"
                >
                  invoiced
                </span>
              )}
            </div>
          </>
        )}
      </td>
    </tr>
    {showRoomCheckout && (
      <PerRoomCheckoutModal
        reservationId={props.reservationId}
        roomId={props.room.id}
        roomNumber={props.room.roomNumber}
        occupantName={
          props.room.occupant && !props.room.occupant.isBooker
            ? props.room.occupant.fullName
            : null
        }
        onClose={() => setShowRoomCheckout(false)}
        onDone={() => {
          setShowRoomCheckout(false);
          props.onSaved();
        }}
      />
    )}
    {showSwap && props.room.reservationRoomId && (
      <SwapRoomModal
        reservationId={props.reservationId}
        fromReservationRoomId={props.room.reservationRoomId}
        fromRoomNumber={props.room.roomNumber}
        segmentFrom={segFrom}
        segmentTo={segTo}
        // "In-place" = no effective-date segmentation. Day-use stays
        // are one calendar day; 1-night overnight stays have nothing
        // meaningful to split. Both swap the room_id outright.
        isShortStay={props.isShortStay}
        inPlace={props.isShortStay || props.isSingleNight}
        onClose={() => setShowSwap(false)}
        onDone={() => {
          setShowSwap(false);
          props.onSaved();
        }}
      />
    )}
    </>
  );
}

function SwapRoomModal(props: {
  reservationId: string;
  fromReservationRoomId: string;
  fromRoomNumber: string;
  segmentFrom: string;
  segmentTo: string;
  // Drives copy ("day use" vs "stay"). The actual no-segmentation
  // path is controlled by `inPlace`.
  isShortStay: boolean;
  // True when the swap should NOT create a new segment — used for
  // day-use bookings (single calendar day) and 1-night overnight
  // stays (no meaningful sub-range). The API ignores effectiveDate
  // for short_stay; for 1-night overnight we omit it here and let
  // the existing in-place path apply.
  inPlace: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  // Effective date must lie strictly inside the segment. (Overnight only.)
  // Default to "tomorrow inside the segment" — most swaps are
  // "starting tonight / next check-in".
  const minEffective = (() => {
    const d = new Date(props.segmentFrom);
    d.setDate(d.getDate() + 1);
    return d.toISOString().slice(0, 10);
  })();
  const maxEffective = (() => {
    const d = new Date(props.segmentTo);
    d.setDate(d.getDate() - 1);
    return d.toISOString().slice(0, 10);
  })();
  // Local (desk) calendar date, not UTC — toISOString() is 5h30 behind IST,
  // so a night-audit-hour swap (00:00–05:30) would misclassify the day.
  const today = format(new Date(), "yyyy-MM-dd");
  const defaultEffective =
    today >= minEffective && today <= maxEffective ? today : minEffective;

  // Swapping on (or before) the segment's first night means no nights have
  // been slept in this room yet — there's nothing to split, so the WHOLE
  // segment moves to the new room (in-place), exactly like a 1-night stay.
  // Without this, a day-of-check-in swap was forced to segment at tomorrow:
  // the ledger kept the guest in the old room tonight while the desk had
  // physically moved them, and both rooms lit up OCCUPIED on the dashboard.
  const moveWholeStay = props.inPlace || today <= props.segmentFrom;

  const [effectiveDate, setEffectiveDate] = useState(defaultEffective);
  const [toRoomId, setToRoomId] = useState<string | null>(null);
  // Default empty — the Reason field is only visible (and required)
  // when the chosen status is Needs Cleaning or Available. For
  // Maintenance the issue Title takes its place, so prefilling the old
  // "Maintenance" default would leak into the cleaning/available paths
  // when staff flipped the status pill without re-typing the field.
  const [reason, setReason] = useState("");
  // Default to Needs Cleaning: most swaps are guest preference / upgrades,
  // and the vacated room just needs housekeeping turnover. Maintenance is an
  // explicit choice (it demands a filed issue and sidelines the room), and
  // defaulting to it pushed staff into typing junk issue details to get past
  // the required fields.
  const [markOldRoomStatus, setMarkOldRoomStatus] = useState<
    "maintenance" | "dirty" | "available"
  >("dirty");
  // Rate override. Defaults to the target room's base rate the moment
  // a room is picked; staff can edit it (e.g. "honour the original
  // rate" or "renegotiate due to category bump"). Empty string means
  // "use the existing rate from the closed segment — send no override".
  const [rateOverride, setRateOverride] = useState<string>("");
  // Issue inputs — only shown when markOldRoomStatus = "maintenance".
  // Same fields as the standalone Flag Issue modal so swapping a room
  // out to maintenance files a proper issue in the same click.
  const [issueCategory, setIssueCategory] =
    useState<MaintenanceCategory>("ac_hvac");
  const [issueSeverity, setIssueSeverity] =
    useState<MaintenanceSeverity>("normal");
  const [issueTitle, setIssueTitle] = useState("");
  const [issueDescription, setIssueDescription] = useState("");
  const [issueCostEstimate, setIssueCostEstimate] = useState("");
  const [err, setErr] = useState<string | null>(null);

  // Availability probe window:
  //   - day-use: single calendar day [segmentFrom, segmentFrom + 1)
  //   - in-place overnight (1-night stay): full segment [segmentFrom, segmentTo)
  //   - segmented overnight (multi-night): [effectiveDate, segmentTo)
  const probeIn = props.isShortStay
    ? props.segmentFrom
    : moveWholeStay
      ? props.segmentFrom
      : effectiveDate;
  const probeOut = props.isShortStay
    ? new Date(new Date(props.segmentFrom).getTime() + 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10)
    : props.segmentTo;

  type AvailRoom = {
    id: string;
    roomNumber: string;
    roomType: string;
    floor?: number;
    baseRate: string;
    status?: string;
  };
  const avail = useQuery({
    queryKey: ["availability", probeIn, probeOut],
    queryFn: () =>
      api.get<AvailRoom[]>("/rooms/availability", {
        check_in: probeIn,
        check_out: probeOut,
      }),
    enabled: probeIn < probeOut,
  });

  const qc = useQueryClient();
  // Dirty rooms stay in the availability result (a checked-out room a guest
  // could still move into). Same gate as the New Reservation and Add Room
  // pickers: a dirty room can't be selected until it's marked clean, so a
  // guest is never assigned an unturned room.
  const markClean = useMutation({
    mutationFn: (roomId: string) =>
      api.patch(`/rooms/${roomId}/status`, { status: "available", reason: "Cleaned for room swap" }),
    onSuccess: (_data, roomId) => {
      qc.setQueryData<AvailRoom[]>(["availability", probeIn, probeOut], (cur) =>
        cur?.map((r) => (r.id === roomId ? { ...r, status: "available" } : r)) ?? cur,
      );
      qc.invalidateQueries({ queryKey: ["rooms"] });
    },
  });

  const swap = useMutation({
    mutationFn: () => {
      const parsedRate = rateOverride.trim() === "" ? null : Number(rateOverride);
      const includeNewRate =
        parsedRate !== null &&
        Number.isFinite(parsedRate) &&
        parsedRate >= 0;
      const parsedCost =
        issueCostEstimate.trim() === "" ? NaN : Number(issueCostEstimate);
      const maintenancePayload =
        markOldRoomStatus === "maintenance"
          ? {
              maintenanceIssue: {
                category: issueCategory,
                severity: issueSeverity,
                title: issueTitle.trim(),
                description: issueDescription.trim(),
                costEstimate: Number.isFinite(parsedCost) ? parsedCost : 0,
              },
            }
          : {};
      // Reason field is hidden when the chosen status is Maintenance —
      // the issue Title takes its place on the swap pill, so staff
      // doesn't have to type a near-duplicate sentence. For dirty /
      // available swaps we keep the typed reason as-is.
      const effectiveReason =
        markOldRoomStatus === "maintenance"
          ? issueTitle.trim() || "Maintenance"
          : reason;
      return api.post(`/reservations/${props.reservationId}/swap-room-segment`, {
        fromReservationRoomId: props.fromReservationRoomId,
        toRoomId,
        // effectiveDate is only meaningful when we're creating a new
        // segment. Whole-stay moves (short_stay, 1-night overnight, or a
        // swap on/before the first night) omit it; the server treats
        // those as full-row replacements.
        ...(moveWholeStay ? {} : { effectiveDate }),
        reason: effectiveReason,
        markOldRoomStatus,
        // Only send newRate when staff filled something in. Empty
        // field = preserve the existing rate (legacy behaviour).
        ...(includeNewRate ? { newRate: parsedRate } : {}),
        ...maintenancePayload,
      });
    },
    onSuccess: props.onDone,
    onError: (e: Error) => setErr(e.message),
  });

  const remainingNights = moveWholeStay
    ? props.isShortStay
      ? 1 // day-use is one calendar day
      : differenceInCalendarDays(new Date(props.segmentTo), new Date(props.segmentFrom))
    : differenceInCalendarDays(new Date(props.segmentTo), new Date(effectiveDate));

  // Group by floor for readability — mirrors NewReservation + AddRoomModal.
  const grouped = (() => {
    const rooms = avail.data ?? [];
    const byFloor = new Map<number | "?", AvailRoom[]>();
    for (const rm of rooms) {
      const key = rm.floor ?? "?";
      const list = byFloor.get(key) ?? [];
      list.push(rm);
      byFloor.set(key, list);
    }
    return Array.from(byFloor.entries()).sort(([a], [b]) => {
      if (a === "?") return 1;
      if (b === "?") return -1;
      return (a as number) - (b as number);
    });
  })();

  return (
    <ModalShell
      title={`Swap Room ${props.fromRoomNumber}`}
      onClose={props.onClose}
      size="lg"
    >
      <div className="space-y-4">
        <div className="text-sm text-textSecondary">
          {props.isShortStay ? (
            <>
              Day-use guest in room <strong>{props.fromRoomNumber}</strong>.
              Pick the new room. The rate auto-fills to the new room's base
              rate - edit it if needed.
            </>
          ) : moveWholeStay ? (
            <>
              Guest in room <strong>{props.fromRoomNumber}</strong> (
              {format(new Date(props.segmentFrom), "dd MMM")} →{" "}
              {format(new Date(props.segmentTo), "dd MMM")}). The whole stay
              moves to the new room now. Pick the new room. The rate
              auto-fills to the new room's base rate - edit it if needed.
            </>
          ) : (
            <>
              Current room <strong>{props.fromRoomNumber}</strong> is occupied
              from{" "}
              <strong>{format(new Date(props.segmentFrom), "dd MMM")}</strong>{" "}
              to <strong>{format(new Date(props.segmentTo), "dd MMM")}</strong>.
              Pick the date the guest moves and the new room. The rate
              auto-fills to the new room's base rate - edit it if needed.
            </>
          )}
        </div>

        <div
          className={moveWholeStay ? "" : "grid grid-cols-1 sm:grid-cols-2 gap-3"}
        >
          {!moveWholeStay && (
            <div>
              <label className="label block mb-1">
                Effective date <span className="text-danger">*</span>
              </label>
              <input
                className="input"
                type="date"
                min={minEffective}
                max={maxEffective}
                value={effectiveDate}
                onChange={(e) => setEffectiveDate(e.target.value)}
              />
              <div className="text-[11px] text-textSecondary mt-1">
                {remainingNights > 0
                  ? `${remainingNights} night${remainingNights === 1 ? "" : "s"} in the new room`
                  : "Pick a date inside the stay window"}
              </div>
            </div>
          )}
          {/* Reason is the swap-event label that surfaces on the
              swap pill in reservation history ("Swapped to Room 304 ·
              <reason>"). When the chosen status is Maintenance we hide
              this field entirely — the issue Title below replaces it
              (auto-piped to the swap_reason at submit time). For dirty
              / available swaps the field stays visible and required. */}
          {markOldRoomStatus !== "maintenance" && (
            <div>
              <label className="label block mb-1">
                Reason <span className="text-danger">*</span>
              </label>
              <input
                className="input"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. guest request, deep clean"
              />
            </div>
          )}
        </div>

        <div>
          <label className="label block mb-1">
            Mark room {props.fromRoomNumber} as
          </label>
          <div className="flex gap-2 flex-wrap">
            {(["maintenance", "dirty", "available"] as const).map((s) => (
              <label
                key={s}
                className={`px-3 h-9 inline-flex items-center gap-2 rounded-sm border cursor-pointer text-sm capitalize ${
                  markOldRoomStatus === s
                    ? "border-brand-dark bg-brand-soft text-brand-dark font-semibold"
                    : "border-borderc text-textSecondary hover:border-brand-dark/40"
                }`}
              >
                <input
                  type="radio"
                  className="sr-only"
                  checked={markOldRoomStatus === s}
                  onChange={() => setMarkOldRoomStatus(s)}
                />
                {s === "dirty" ? "Needs Cleaning" : s}
              </label>
            ))}
          </div>
        </div>

        {/* When the old room is being sent to maintenance, gather the
            same details we'd ask in the standalone Flag Issue modal so
            the issue lands on the Maintenance page immediately. Hidden
            for dirty / available because those don't open a ticket. */}
        {markOldRoomStatus === "maintenance" && (
          <div className="rounded-sm border-2 border-warning/30 bg-warning/5 p-3 space-y-3">
            <div className="text-xs font-semibold uppercase tracking-wider text-[#B45309]">
              Issue details for Room {props.fromRoomNumber}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label block mb-1">
                  Category <span className="text-danger">*</span>
                </label>
                <select
                  className="input"
                  value={issueCategory}
                  onChange={(e) =>
                    setIssueCategory(e.target.value as MaintenanceCategory)
                  }
                >
                  {MAINTENANCE_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {MAINTENANCE_CATEGORY_LABELS[c]}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label block mb-1">
                  Severity <span className="text-danger">*</span>
                </label>
                <select
                  className="input"
                  value={issueSeverity}
                  onChange={(e) =>
                    setIssueSeverity(e.target.value as MaintenanceSeverity)
                  }
                >
                  {MAINTENANCE_SEVERITIES.map((s) => (
                    <option key={s} value={s}>
                      {MAINTENANCE_SEVERITY_LABELS[s]}
                    </option>
                  ))}
                </select>
              </div>
              <div className="col-span-2">
                <label className="label block mb-1">
                  Title <span className="text-danger">*</span>
                </label>
                <input
                  className="input"
                  placeholder="Short summary - e.g. AC not cooling"
                  value={issueTitle}
                  onChange={(e) => setIssueTitle(e.target.value)}
                  maxLength={200}
                />
              </div>
              <div className="col-span-2">
                <label className="label block mb-1">
                  Description <span className="text-danger">*</span>
                </label>
                <textarea
                  className="input min-h-[72px]"
                  placeholder="Details that help the technician - when noticed, what was tried, etc."
                  value={issueDescription}
                  onChange={(e) => setIssueDescription(e.target.value)}
                  maxLength={2000}
                />
              </div>
              <div className="col-span-2">
                <label className="label block mb-1">
                  Estimated cost (₹) <span className="text-danger">*</span>
                </label>
                <input
                  className="input"
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="Owner needs a budget figure; enter 0 if no spend expected"
                  value={issueCostEstimate}
                  onChange={(e) => setIssueCostEstimate(e.target.value)}
                />
              </div>
            </div>
          </div>
        )}

        <div>
          <div className="label mb-1">
            Move to room <span className="text-danger">*</span>
          </div>
          {avail.isLoading && (
            <div className="text-sm text-textSecondary">Loading available rooms…</div>
          )}
          {avail.isError && (
            <div className="text-sm text-danger">
              Couldn't load availability: {(avail.error as Error).message}
            </div>
          )}
          {!avail.isLoading && (avail.data?.length ?? 0) === 0 && (
            <div className="text-sm text-textSecondary">
              {props.isShortStay
                ? `No rooms available on ${format(new Date(probeIn), "dd MMM")}.`
                : `No rooms available for ${format(new Date(probeIn), "dd MMM")} → ${format(new Date(props.segmentTo), "dd MMM")}.`}
            </div>
          )}
          {grouped.map(([floor, rooms]) => (
            <div key={String(floor)} className="mt-3">
              <div className="text-base font-bold text-brand-dark tracking-wide mb-2 pb-1 border-b border-borderc/60">
                {floor === "?" ? "Other" : `Floor ${floor}`}
                <span className="ml-2 text-xs font-semibold text-textSecondary uppercase tracking-wider">
                  · {rooms.length} room{rooms.length === 1 ? "" : "s"}
                </span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
                {rooms.map((rm) => {
                  const active = toRoomId === rm.id;
                  const isDirty = rm.status === "dirty";
                  const cleanInFlight =
                    markClean.isPending && markClean.variables === rm.id;
                  // Pick a room: set it as the target and auto-fill its base
                  // rate (one click for the common case; editable before
                  // confirming).
                  const select = () => {
                    setToRoomId(rm.id);
                    setRateOverride(String(Number(rm.baseRate).toFixed(0)));
                  };
                  return (
                    <div
                      key={rm.id}
                      className={`p-2.5 rounded-sm border-2 text-left transition-colors ${
                        active
                          ? "border-brand-dark bg-brand-soft"
                          : isDirty
                            ? "border-warning/50 bg-warning/5"
                            : "border-borderc hover:border-brand-dark hover:bg-bg"
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => {
                          // A dirty room must be cleaned first — block the
                          // plain tap and let the "Mark clean & select"
                          // affordance below do the assignment.
                          if (isDirty && !active) return;
                          select();
                        }}
                        className="text-left w-full"
                        aria-disabled={isDirty && !active}
                      >
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="font-mono font-bold text-brand-dark text-sm leading-tight">
                            {rm.roomNumber}
                          </span>
                          {isDirty && (
                            <span className="inline-flex items-center gap-0.5 px-1 py-0.5 rounded-sm text-[9px] font-semibold bg-warning/15 text-warning">
                              <SprayCan className="w-2.5 h-2.5" /> DIRTY
                            </span>
                          )}
                        </div>
                        <div className="text-[11px] text-textSecondary capitalize truncate mt-0.5">
                          {rm.roomType}
                        </div>
                        <div className="text-[11px] text-textSecondary font-mono mt-1">
                          ₹{Number(rm.baseRate).toFixed(0)}/n
                        </div>
                      </button>
                      {isDirty && !active && (
                        <button
                          type="button"
                          disabled={cleanInFlight}
                          onClick={(e) => {
                            e.stopPropagation();
                            markClean.mutate(rm.id, { onSuccess: () => select() });
                          }}
                          className="mt-2 w-full inline-flex items-center justify-center gap-1 px-1.5 h-7 rounded-sm border border-warning/50 text-warning hover:bg-warning/10 text-[11px] font-semibold disabled:opacity-50"
                        >
                          <SprayCan className="w-3 h-3" />
                          {cleanInFlight ? "Cleaning…" : "Mark clean & select"}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        {/* Rate per room — mirrors AddRoomModal's layout. Auto-fills
            to the new room's base rate the moment one is picked.
            Staff can override; submitting with an empty field keeps
            the existing rate (legacy behaviour). */}
        {toRoomId && (() => {
          const picked = avail.data?.find((rm) => rm.id === toRoomId);
          if (!picked) return null;
          const rate = Number(rateOverride || 0);
          const lineTotal = remainingNights > 0 ? rate * remainingNights : 0;
          return (
            <div className="border border-borderc rounded p-3 bg-bg/40 space-y-2">
              <div className="text-xs font-semibold uppercase tracking-wider text-textSecondary">
                Rate per room
              </div>
              <div className="flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="font-mono font-bold text-brand-dark text-sm">
                    {picked.roomNumber}
                  </div>
                  <div className="text-[11px] text-textSecondary capitalize truncate">
                    {picked.roomType}
                    {picked.floor !== undefined && (
                      <span> · Floor {picked.floor}</span>
                    )}
                    <span> · base ₹{Number(picked.baseRate).toFixed(0)}/n</span>
                  </div>
                </div>
                <div className="w-32">
                  <input
                    className="input"
                    type="number"
                    min={0}
                    step="0.01"
                    value={rateOverride}
                    placeholder="0"
                    onChange={(e) => setRateOverride(e.target.value)}
                  />
                </div>
                <div className="w-24 text-right text-xs font-mono text-textPrimary">
                  {remainingNights > 0 ? `= ₹${lineTotal.toFixed(2)}` : ""}
                </div>
              </div>
              {remainingNights > 0 && (
                <div className="text-[11px] text-textSecondary">
                  Applies to {remainingNights} night{remainingNights === 1 ? "" : "s"}
                  {moveWholeStay ? " (the whole stay)" : " in the new room"}.
                </div>
              )}
            </div>
          );
        })()}

        {err && (
          <div className="text-sm text-danger bg-danger/5 border border-danger/30 rounded p-2">
            {err}
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-1">
          <button className="btn-secondary" onClick={props.onClose}>
            Cancel
          </button>
          <button
            className="btn-primary"
            disabled={(() => {
              if (!toRoomId) return true;
              if (swap.isPending || remainingNights <= 0) return true;
              if (markOldRoomStatus === "maintenance") {
                // Reason field hidden — issue Title takes its place.
                if (issueTitle.trim().length < 3) return true;
                if (issueDescription.trim().length < 3) return true;
                const cost = Number(issueCostEstimate);
                if (issueCostEstimate.trim() === "") return true;
                if (!Number.isFinite(cost) || cost < 0) return true;
              } else {
                if (!reason.trim()) return true;
              }
              return false;
            })()}
            onClick={() => swap.mutate()}
          >
            {swap.isPending ? "Swapping…" : "Confirm Swap"}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

function ChargeRow(props: {
  reservationId: string;
  charge: {
    id: string;
    description: string;
    amount: string;
    gstRate: string;
    createdAt: string;
    quantity?: number;
    rate?: string;
    // "stay_extension" rows are written by Extend Stay and hold only the
    // rate delta — deleting one under-bills the stay without undoing it.
    source?: "manual" | "stay_extension";
  };
  // Reservation's GST mode. In inclusive mode the stored `amount` is
  // NET (recalc adds GST on top to reach the gross the guest agreed
  // to), so we display gross here. In exclusive mode `amount` is
  // already what the guest pays for this line, so we display as-is.
  gstMode: "exclusive" | "inclusive";
  canEdit: boolean;
  canDelete: boolean;
  onSaved: () => void;
}) {
  const dialog = useDialog();
  const [editing, setEditing] = useState(false);
  const [description, setDescription] = useState(props.charge.description);
  const netAmount = Number(props.charge.amount);
  const gstRateNum = Number(props.charge.gstRate);
  // Reconstruct gross for inclusive-mode rows; exclusive stores gross.
  const grossAmount =
    props.gstMode === "inclusive"
      ? +(netAmount * (1 + gstRateNum / 100)).toFixed(2)
      : netAmount;
  // Stay-extension rows store the per-night DELTA so the math sums
  // cleanly with the room line that already bills the added night(s)
  // at the original rate. For display we surface the FULL new-night
  // cost the guest agreed to (parsed from the description), since
  // "₹500 delta" reads as confusing on a bill. The stored row is
  // never mutated.
  const extensionDisplay = (() => {
    const desc = props.charge.description;
    if (!/stay extension/i.test(desc)) return null;
    const nightsMatch = /(\d+)\s*(?:nights?|n)\b/i.exec(desc);
    if (!nightsMatch) return null;
    const nights = Number(nightsMatch[1]);
    // Two description formats:
    //   - new: "(₹1500 → ₹2000)" — take the right side
    //   - legacy: "@ ₹2000.00/night" — take the value after @
    const arrow = /₹?\d[\d,.]*\s*(?:→|->)\s*₹?(\d[\d,.]*)/.exec(desc);
    const atRate = /@\s*₹?(\d[\d,.]*)\s*\/\s*(?:night|n)\b/i.exec(desc);
    const raw = arrow?.[1] ?? atRate?.[1];
    if (!raw) return null;
    const newRate = Number(raw.replace(/,/g, ""));
    if (!nights || !newRate) return null;
    return +(nights * newRate).toFixed(2);
  })();
  const displayAmount = extensionDisplay ?? grossAmount;
  // The edit input stays in the SAME basis as the display: gross under
  // inclusive mode, net under exclusive. On save we convert back to
  // net before POSTing — see the save mutation below.
  const [amount, setAmount] = useState(displayAmount);
  const save = useMutation({
    mutationFn: () => {
      // Convert the displayed value (gross under inclusive) back to
      // the net basis the server stores. Exclusive mode is already net.
      const netRate =
        props.gstMode === "inclusive"
          ? +(amount / (1 + gstRateNum / 100)).toFixed(2)
          : amount;
      return api.patch(`/reservations/${props.reservationId}/charges/${props.charge.id}`, {
        description,
        quantity: 1,
        rate: netRate,
      });
    },
    onSuccess: () => {
      setEditing(false);
      props.onSaved();
    },
  });
  const del = useMutation({
    mutationFn: () =>
      api.del(`/reservations/${props.reservationId}/charges/${props.charge.id}`),
    onSuccess: props.onSaved,
  });
  return (
    <tr>
      <td>
        {editing ? (
          <input
            className="input !h-8 !py-0"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        ) : (
          props.charge.description
        )}
      </td>
      <td className="tabular-nums">{props.charge.gstRate}%</td>
      <td className="text-xs text-textSecondary">
        {format(new Date(props.charge.createdAt), "dd MMM HH:mm")}
      </td>
      <td className="font-mono tabular-nums">
        {editing ? (
          <input
            className="input !h-8 !py-0 w-24"
            type="number"
            min={0}
            step="0.01"
            value={amount === 0 ? "" : amount}
            onChange={(e) => {
              const v = e.target.value;
              setAmount(v === "" ? 0 : Number(v));
            }}
          />
        ) : (
          inr(displayAmount)
        )}
      </td>
      <td className="text-right">
        {/* Explain the missing delete button rather than leaving a blank gap —
            staff previously deleted this row expecting it to undo the
            extension, and instead silently under-billed the stay. */}
        {props.charge.source === "stay_extension" && !editing && (
          <span
            className="mr-1 inline-flex items-center gap-1 text-[10px] uppercase tracking-wider text-textSecondary"
            title="Part of the stay extension. Use Undo Extension to roll back the dates and this charge together — deleting it alone would leave the stay extended but billed at the old room rate."
          >
            <Lock className="w-3 h-3" />
            Extension
          </span>
        )}
        {(props.canEdit || props.canDelete) && !editing && (
          <div className="inline-flex gap-1">
            {props.canEdit && (
              <button
                className="btn-secondary !h-7 !px-2"
                onClick={() => setEditing(true)}
                title="Edit"
              >
                <Pencil className="w-3.5 h-3.5" />
              </button>
            )}
            {props.canDelete && (
              <button
                className="btn-secondary !h-7 !px-2 text-danger"
                onClick={async () => {
                  const ok = await dialog.confirm({
                    title: "Delete charge",
                    message: `Remove "${props.charge.description}" from this reservation?`,
                    okLabel: "Delete",
                    tone: "danger",
                  });
                  if (ok) del.mutate();
                }}
                title="Delete"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        )}
        {editing && (
          <div className="inline-flex gap-1">
            <button
              className="btn-secondary !h-7 !px-2 text-xs"
              onClick={() => {
                setDescription(props.charge.description);
                setAmount(displayAmount);
                setEditing(false);
              }}
            >
              Cancel
            </button>
            <button
              className="btn-primary !h-7 !px-2 text-xs"
              disabled={save.isPending || amount <= 0 || !description.trim()}
              onClick={() => save.mutate()}
            >
              {save.isPending ? "…" : "Save"}
            </button>
          </div>
        )}
      </td>
    </tr>
  );
}

function PaymentRow(props: {
  payment: {
    id: string;
    amount: string;
    paymentMethod: string;
    status?: string;
    paymentDate: string;
    notes: string | null;
    receiptNumber: string | null;
    voided?: boolean;
    createdAt: string;
  };
  onSaved: () => void;
  onPrintReceipt: () => void;
}) {
  const dialog = useDialog();
  const { toast } = useToast();
  const isPending = props.payment.status === "pending";

  const markReceived = useMutation({
    mutationFn: (chosenMethod: string) =>
      api.post(`/payments/${props.payment.id}/mark-received`, { paymentMethod: chosenMethod }),
    onSuccess: props.onSaved,
    onError: (e: Error) => toast(e.message, "error"),
  });

  if (props.payment.voided) {
    return (
      <tr className="opacity-50">
        <td className="line-through">{format(new Date(props.payment.paymentDate), "dd MMM yyyy HH:mm")}</td>
        <td className="capitalize line-through">{props.payment.paymentMethod.replace("_", " ")}</td>
        <td className="text-xs text-danger">VOIDED</td>
        <td className="font-mono tabular-nums line-through">{inr(props.payment.amount)}</td>
        <td></td>
      </tr>
    );
  }

  return (
    <tr>
      <td>{format(new Date(props.payment.paymentDate), "dd MMM yyyy HH:mm")}</td>
      <td className="capitalize">
        <div className="flex items-center gap-2">
          <span>{props.payment.paymentMethod.replace("_", " ")}</span>
          {isPending && (
            <span className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded font-bold bg-warning/20 text-warning">
              Pending
            </span>
          )}
        </div>
      </td>
      <td className="font-mono text-xs">
        <div>
          {props.payment.receiptNumber && (
            <div className="text-[10px] text-navy">{props.payment.receiptNumber}</div>
          )}
          <div className="text-textSecondary">{props.payment.notes ?? ""}</div>
        </div>
      </td>
      <td className="font-mono tabular-nums">{inr(props.payment.amount)}</td>
      <td className="text-right">
        <div className="inline-flex gap-1">
            {isPending && (
              <button
                className="!h-7 !px-2 text-xs font-semibold rounded-sm bg-success text-white border-2 border-success hover:opacity-90 inline-flex items-center gap-1"
                onClick={async () => {
                  const chosen = await dialog.prompt({
                    title: "Mark payment received",
                    message: `Confirm collection of ${inr(props.payment.amount)}.`,
                    okLabel: "Mark received",
                    tone: "success",
                    required: true,
                    defaultValue: "cash",
                    options: [
                      { value: "cash", label: "Cash" },
                      { value: "upi", label: "UPI" },
                      { value: "card", label: "Card" },
                      { value: "bank_transfer", label: "Bank transfer" },
                    ],
                  });
                  if (chosen) markReceived.mutate(chosen);
                }}
                disabled={markReceived.isPending}
                title="Mark as received"
              >
                Mark Received
              </button>
            )}
            {/* Receipt eye only for real payment rows. Synthetic
                wallet-ledger rows (merged from guest_ledger so the
                cancel-as-credit flow is visible) have no PDF — they're
                accounting entries, not receipts. */}
            {props.payment.receiptNumber && (
              <button
                className="btn-secondary !h-7 !px-2"
                onClick={props.onPrintReceipt}
                title={`Preview receipt ${props.payment.receiptNumber ?? ""}`}
              >
                <Eye className="w-3.5 h-3.5" />
              </button>
            )}
            {/* Per-payment edit and void removed by product decision —
                receipts are an immutable financial trail. To correct
                an error, void the original by cancelling the
                reservation (which auto-voids its payments) and
                re-record. */}
          </div>
      </td>
    </tr>
  );
}

function AddRoomModal(props: {
  reservationId: string;
  checkInDate: string;
  checkOutDate: string;
  stayType: "overnight" | "short_stay";
  existingRoomIds: string[];
  minutesOverdue?: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  // The DESK's calendar day, not UTC. toISOString() is 5h30 behind IST, so
  // during the night-audit window (00:00-05:30) it returns YESTERDAY — the
  // mid-stay add-room defaulted to a back-dated start and billed an extra
  // night, and the picker's `min` allowed it. Matches the swap modal, which
  // already uses format() for exactly this reason.
  const today = format(new Date(), "yyyy-MM-dd");
  const isShortStay = props.stayType === "short_stay";
  // Day-use: start = the booking's single date, no separate start
  // picker. Overnight: default start = max(today, checkInDate) so the
  // mid-stay add only bills the remaining nights.
  const defaultStart = isShortStay
    ? props.checkInDate
    : props.checkInDate > today
      ? props.checkInDate
      : today;
  const [startDate, setStartDate] = useState(defaultStart);
  // Optional early end for the added room — defaults to the parent's
  // check-out, can be pulled in (never pushed past it).
  const [endDate, setEndDate] = useState(props.checkOutDate);
  // Probe window. For day-use we widen to [d, d+1) so the API's
  // daterange overlap check actually fires (a same-day [d, d) range
  // is empty in Postgres and silently matches nothing).
  const probeEnd = isShortStay
    ? new Date(new Date(props.checkInDate).getTime() + 86400000)
        .toISOString()
        .slice(0, 10)
    : endDate;
  // Selected rooms keyed by id → chosen rate per night. Adding/removing a
  // room mutates this map; the rate seeds from the room's base rate but
  // staff can edit each one independently.
  const [picked, setPicked] = useState<Record<string, number>>({});
  const [err, setErr] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  const qc = useQueryClient();
  type AvailRoom = {
    id: string;
    roomNumber: string;
    roomType: string;
    floor?: number;
    baseRate: string;
    status?: "available" | "occupied" | "reserved" | "maintenance" | "dirty";
  };
  const avail = useQuery({
    queryKey: ["availability", startDate, probeEnd],
    queryFn: () =>
      api.get<AvailRoom[]>("/rooms/availability", {
        check_in: startDate,
        check_out: probeEnd,
      }),
    // Overnight needs a strict start < end. Day-use always sends a valid
    // [d, d+1) so the query always runs.
    enabled: isShortStay || startDate < probeEnd,
  });

  // Marks a dirty room available so it can be added to the reservation.
  // Single-step workflow (migration 0034) — dirty → available in one hop.
  const markClean = useMutation({
    mutationFn: (roomId: string) =>
      api.patch(`/rooms/${roomId}/status`, { status: "available", reason: "Re-let mid-stay" }),
    onSuccess: (_data, roomId) => {
      qc.setQueryData<AvailRoom[]>(
        ["availability", startDate, probeEnd],
        (cur) =>
          cur?.map((r) => (r.id === roomId ? { ...r, status: "available" as const } : r)) ?? cur,
      );
      qc.invalidateQueries({ queryKey: ["rooms"] });
    },
  });

  const available = (avail.data ?? []).filter((r) => !props.existingRoomIds.includes(r.id));
  const availableById = new Map(available.map((r) => [r.id, r]));
  const pickedIds = Object.keys(picked);

  // For overnight: count the nights from chosen start to check-out.
  // For day-use: a single flat charge — units stays at 1 so the
  // preview reads "1 × ₹rate" instead of "0 nights × ₹rate".
  const nights = isShortStay
    ? 1
    : Math.max(
        0,
        Math.round(
          (new Date(endDate).getTime() - new Date(startDate).getTime()) / 86400000,
        ),
      );
  const grandPreview = pickedIds.reduce(
    (sum, id) => sum + (picked[id] ?? 0) * nights,
    0,
  );

  const save = useMutation({
    mutationFn: async () => {
      // The /add-room endpoint takes one room at a time. Loop sequentially
      // so a mid-batch failure surfaces with the right room context and
      // doesn't race the server-side availability check.
      setProgress({ done: 0, total: pickedIds.length });
      for (let i = 0; i < pickedIds.length; i++) {
        const id = pickedIds[i]!;
        await api.post(`/reservations/${props.reservationId}/add-room`, {
          roomId: id,
          ratePerNight: picked[id],
          startDate,
          // Only sent when staff pulled it in from the parent's check-out.
          ...(endDate !== props.checkOutDate ? { endDate } : {}),
        });
        setProgress({ done: i + 1, total: pickedIds.length });
      }
    },
    onSuccess: props.onSaved,
    onError: (e: Error) => {
      setErr(e.message);
      setProgress(null);
    },
  });

  const toggleRoom = (rm: { id: string; baseRate: string }) => {
    setPicked((cur) => {
      if (cur[rm.id] !== undefined) {
        const next = { ...cur };
        delete next[rm.id];
        return next;
      }
      return { ...cur, [rm.id]: Number(rm.baseRate) };
    });
  };

  return (
    <ModalShell title="Add Room to Reservation" onClose={props.onClose} size="lg">
      <div className="space-y-4">
        <OverdueWarning minutesOverdue={props.minutesOverdue ?? 0} />
        {isShortStay ? (
          <div className="text-xs text-textSecondary rounded-sm bg-bg/60 border border-borderc px-3 py-2">
            Day-use booking - the added room covers the same date (
            <strong>{format(new Date(props.checkInDate), "dd MMM yyyy")}</strong>) at a
            flat rate. Date pickers don't apply.
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label block mb-1">Start Date</label>
              <input
                className="input"
                type="date"
                min={today < props.checkInDate ? props.checkInDate : today}
                max={props.checkOutDate}
                value={startDate}
                onChange={(e) => {
                  setStartDate(e.target.value);
                  setPicked({});
                }}
              />
            </div>
            <div>
              <label className="label block mb-1">End Date (check-out)</label>
              <input
                className="input"
                type="date"
                min={startDate}
                max={props.checkOutDate}
                value={endDate}
                onChange={(e) => {
                  setEndDate(e.target.value);
                  setPicked({});
                }}
              />
              {endDate < props.checkOutDate && (
                <div className="text-[11px] text-textSecondary mt-1">
                  Room leaves the booking on {format(new Date(endDate), "dd MMM")} - before
                  the stay's check-out.
                </div>
              )}
            </div>
          </div>
        )}

        <div>
          <label className="label block mb-1.5">
            Available Rooms{" "}
            <span className="text-xs font-normal text-textSecondary">
              · tap to add or remove ({pickedIds.length} selected)
            </span>
          </label>
          {avail.isLoading ? (
            <div className="text-sm text-textSecondary py-3">Checking availability…</div>
          ) : available.length === 0 ? (
            <div className="text-sm text-textSecondary py-3">
              No rooms available for this range.
            </div>
          ) : (
            // Group by floor so the picker reads as Floor 1 → Floor 2
            // → ... sections rather than one flat scroll. The API
            // already orders by (floor, roomNumber) so each bucket is
            // already room-number-sorted.
            (() => {
              const byFloor = new Map<number | "?", typeof available>();
              for (const rm of available) {
                const key: number | "?" = rm.floor ?? "?";
                const arr = byFloor.get(key) ?? [];
                arr.push(rm);
                byFloor.set(key, arr);
              }
              const floors = Array.from(byFloor.keys()).sort((a, b) => {
                if (a === "?") return 1;
                if (b === "?") return -1;
                return (a as number) - (b as number);
              });
              return (
                <div className="space-y-3">
                  {floors.map((floor) => (
                    <div key={String(floor)}>
                      <div className="text-base font-bold text-brand-dark tracking-wide mb-2 pb-1 border-b border-borderc/60">
                        {floor === "?" ? "Other" : `Floor ${floor}`}
                        <span className="ml-2 text-xs font-semibold text-textSecondary uppercase tracking-wider">
                          · {byFloor.get(floor)!.length} room
                          {byFloor.get(floor)!.length === 1 ? "" : "s"}
                        </span>
                      </div>
                      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
                        {byFloor.get(floor)!.map((rm) => {
                          const active = picked[rm.id] !== undefined;
                          const isDirty = rm.status === "dirty";
                          const cleanInFlight =
                            markClean.isPending && markClean.variables === rm.id;
                          return (
                            <div
                              key={rm.id}
                              className={`p-2.5 rounded-sm border-2 text-left transition-colors ${
                                active
                                  ? "border-brand-dark bg-brand-soft"
                                  : isDirty
                                    ? "border-warning/50 bg-warning/5"
                                    : "border-borderc hover:border-brand-dark hover:bg-bg"
                              }`}
                            >
                              <button
                                type="button"
                                onClick={() => {
                                  if (isDirty && !active) return;
                                  toggleRoom(rm);
                                }}
                                className="text-left w-full"
                                aria-disabled={isDirty && !active}
                              >
                                <div className="flex items-center gap-1.5 flex-wrap">
                                  <span className="font-mono font-bold text-brand-dark text-sm leading-tight">
                                    {rm.roomNumber}
                                  </span>
                                  {isDirty && (
                                    <span className="inline-flex items-center gap-0.5 px-1 py-0.5 rounded-sm text-[9px] font-semibold bg-warning/15 text-warning">
                                      <SprayCan className="w-2.5 h-2.5" /> DIRTY
                                    </span>
                                  )}
                                </div>
                                <div className="text-[11px] capitalize text-textSecondary mt-0.5 truncate">
                                  {rm.roomType}
                                </div>
                                <div className="text-xs font-mono text-textPrimary mt-1">
                                  ₹{Number(rm.baseRate).toFixed(0)}/n
                                </div>
                              </button>
                              {isDirty && !active && (
                                <button
                                  type="button"
                                  disabled={cleanInFlight}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    markClean.mutate(rm.id, {
                                      onSuccess: () => toggleRoom(rm),
                                    });
                                  }}
                                  className="mt-2 w-full inline-flex items-center justify-center gap-1 px-1.5 h-7 rounded-sm border border-warning/50 text-warning hover:bg-warning/10 text-[11px] font-semibold disabled:opacity-50"
                                >
                                  <SprayCan className="w-3 h-3" />
                                  {cleanInFlight ? "Cleaning…" : "Mark clean & select"}
                                </button>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              );
            })()
          )}
        </div>

        {pickedIds.length > 0 && (
          <div className="border border-borderc rounded p-3 bg-bg/40 space-y-2">
            <div className="text-xs font-semibold uppercase tracking-wider text-textSecondary">
              Rate per room
            </div>
            {pickedIds.map((id) => {
              const rm = availableById.get(id);
              if (!rm) return null;
              const rate = picked[id] ?? 0;
              return (
                <div key={id} className="flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="font-mono font-bold text-brand-dark text-sm">
                      {rm.roomNumber}
                    </div>
                    <div className="text-[11px] text-textSecondary capitalize truncate">
                      {rm.roomType}
                      {rm.floor !== undefined && (
                        <span> · Floor {rm.floor}</span>
                      )}
                      <span> · base ₹{Number(rm.baseRate).toFixed(0)}/n</span>
                    </div>
                  </div>
                  <div className="w-32">
                    <input
                      className="input"
                      type="number"
                      min={0}
                      step="0.01"
                      value={rate || ""}
                      placeholder="0"
                      onChange={(e) =>
                        setPicked((cur) => ({ ...cur, [id]: Number(e.target.value) }))
                      }
                    />
                  </div>
                  <div className="w-24 text-right text-xs font-mono text-textPrimary">
                    {nights > 0 ? `= ₹${(rate * nights).toFixed(2)}` : ""}
                  </div>
                </div>
              );
            })}
            {nights > 0 && (
              <div className="flex justify-between border-t border-borderc pt-2 mt-2 text-sm">
                <strong>
                  {pickedIds.length} room{pickedIds.length === 1 ? "" : "s"}
                  {isShortStay
                    ? " · day-use"
                    : ` × ${nights} night${nights === 1 ? "" : "s"}`}
                </strong>
                <strong className="font-mono">₹{grandPreview.toFixed(2)}</strong>
              </div>
            )}
            <div className="text-[11px] text-textSecondary">
              GST is applied on top at invoice time using the property's room GST rate (same as
              every other room on this reservation).
            </div>
          </div>
        )}

        {err && <div className="text-danger text-sm">{err}</div>}
        {progress && progress.total > 0 && save.isPending && (
          <div className="text-xs text-textSecondary">
            Adding room {progress.done + 1} of {progress.total}…
          </div>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <button
            className="px-4 h-9 text-sm font-semibold rounded-sm border-2 border-borderc text-textSecondary hover:border-textSecondary hover:text-textPrimary transition-colors"
            onClick={props.onClose}
          >
            Cancel
          </button>
          <button
            className="px-4 h-9 text-sm font-semibold rounded-sm bg-brand-dark text-cream border-2 border-brand-dark hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
            disabled={
              pickedIds.length === 0 ||
              pickedIds.some((id) => (picked[id] ?? 0) <= 0) ||
              save.isPending
            }
            onClick={() => {
              setErr(null);
              save.mutate();
            }}
          >
            {save.isPending
              ? "Adding…"
              : pickedIds.length > 1
                ? `Add ${pickedIds.length} Rooms`
                : "Add Room"}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

function ExtendModal(props: {
  reservationId: string;
  currentCheckOut: string;
  currentRate: string;
  rooms: {
    id: string;
    roomNumber: string;
    invoiced: boolean;
    status?: "confirmed" | "checked_in" | "checked_out" | "cancelled";
  }[];
  minutesOverdue?: number;
  onClose: () => void;
  // Called for the all-rooms extend path. Just invalidates and closes.
  onSaved: () => void;
  // Called for the subset (split) path. Receives the new reservation
  // info so the parent can show a toast / offer to navigate.
  onSplit?: (newReservation: { id: string; reservationNumber: string }) => void;
}) {
  const minDate = new Date(new Date(props.currentCheckOut).getTime() + 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const [newCheckOutDate, setNewCheckOutDate] = useState(minDate);
  const [overrideRate, setOverrideRate] = useState(false);
  const [ratePerNight, setRatePerNight] = useState(Number(props.currentRate));
  const [err, setErr] = useState<string | null>(null);

  // Per-room availability for the extension window, checked as soon as
  // a date is picked — staff see "booked till …" immediately instead of
  // a 409 after pressing Extend. Also lists free alternative rooms a
  // blocked room's guest can continue in.
  type ExtendOptions = {
    rooms: {
      roomId: string;
      roomNumber: string;
      invoiced: boolean;
      available: boolean;
      conflict: {
        reservationId: string;
        reservationNumber: string;
        guestName: string;
        bookedFrom: string;
        bookedTill: string;
      } | null;
    }[];
    alternatives: {
      id: string;
      roomNumber: string;
      roomType: string;
      baseRate: string;
      status?: string;
    }[];
  };
  const optionsQ = useQuery({
    queryKey: ["extend-options", props.reservationId, newCheckOutDate],
    queryFn: () =>
      api.get<ExtendOptions>(`/reservations/${props.reservationId}/extend-options`, {
        newCheckOutDate,
      }),
    enabled: !!newCheckOutDate && newCheckOutDate > props.currentCheckOut,
  });
  const optByRoom = new Map((optionsQ.data?.rooms ?? []).map((r) => [r.roomId, r]));
  const blockedRooms = (optionsQ.data?.rooms ?? []).filter(
    (r) => !r.available && !r.invoiced,
  );

  // Blocked room → chosen alternative room ("" = staff leaves it; the
  // room simply checks out on the original date).
  const [moves, setMoves] = useState<Record<string, string>>({});
  const moveEntries = Object.entries(moves).filter(([, to]) => to);

  // OTP confirmation for the continuation booking.
  const [otpSent, setOtpSent] = useState<{ target: string; devCode?: string } | null>(null);
  const [otpCode, setOtpCode] = useState("");
  const sendOtp = useMutation({
    mutationFn: () =>
      api.post<{ target: string; devCode?: string }>(`/otp/send`, {
        reservationId: props.reservationId,
        channel: "sms",
      }),
    onSuccess: (d) => {
      setOtpSent(d);
      setErr(null);
    },
    onError: (e: Error) => setErr(e.message),
  });
  const continueKey = useMemo(() => newIdempotencyKey(), []);

  // A different date changes what's blocked — chosen moves and any
  // in-flight OTP no longer apply to it.
  useEffect(() => {
    setMoves({});
    setOtpCode("");
  }, [newCheckOutDate]);

  // Default to all billable rooms picked = behaves like the original
  // "extend all" flow. Untick any to split that subset off into a new
  // reservation with the extended dates.
  const billable = props.rooms.filter(
    (r) => !r.invoiced && r.status !== "cancelled" && r.status !== "checked_out",
  );
  const [pickedRooms, setPickedRooms] = useState<Set<string>>(
    () => new Set(billable.map((r) => r.id)),
  );
  // Blocked rooms can't extend in place — drop them from the picked set
  // as soon as the availability check identifies them. Track WHICH ids
  // we auto-dropped so that when staff picks a different date where the
  // room is free again, we re-pick it. Without the restore, the silent
  // unpick survives the date change and "Extend" would quietly split
  // off a subset instead of extending the whole reservation. Manual
  // unticks are never overridden (they're not in the auto set).
  const autoUnpicked = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!optionsQ.data) return;
    const opts = optionsQ.data.rooms;
    setPickedRooms((prev) => {
      const next = new Set(prev);
      let changed = false;
      for (const r of opts) {
        if (!r.available && next.has(r.roomId)) {
          next.delete(r.roomId);
          autoUnpicked.current.add(r.roomId);
          changed = true;
        } else if (r.available && autoUnpicked.current.has(r.roomId)) {
          next.add(r.roomId);
          autoUnpicked.current.delete(r.roomId);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [optionsQ.data]);
  const isMultiRoom = props.rooms.length > 1;
  const allBillablePicked =
    billable.length > 0 && billable.every((r) => pickedRooms.has(r.id));
  // The in-place /extend endpoint re-checks EVERY assigned room, so it
  // can only be used when nothing on the reservation is blocked and all
  // billable rooms extend together. Any move forces the split path for
  // the in-place rooms.
  const willSplit =
    (isMultiRoom && pickedRooms.size > 0 && !allBillablePicked) ||
    (pickedRooms.size > 0 && moveEntries.length > 0);

  function toggleRoom(roomId: string) {
    setPickedRooms((prev) => {
      const next = new Set(prev);
      if (next.has(roomId)) next.delete(roomId);
      else next.add(roomId);
      return next;
    });
  }

  const save = useMutation({
    mutationFn: async () => {
      let created: { id: string; reservationNumber: string } | null = null;

      // 1. Continuation booking for blocked rooms moved to alternative
      //    rooms — same guest, new reservation for the extension nights,
      //    confirmed by the guest's OTP.
      if (moveEntries.length > 0) {
        const resp = await api.post<{
          created: { id: string; reservationNumber: string };
        }>(
          `/reservations/${props.reservationId}/extend-continue`,
          {
            newCheckOutDate,
            moves: moveEntries.map(([fromRoomId, toRoomId]) => ({
              fromRoomId,
              toRoomId,
              ratePerNight: overrideRate ? ratePerNight : undefined,
            })),
            otpCode,
          },
          { idempotencyKey: continueKey },
        );
        created = resp.created;
      }

      // 2. In-place extension for the rooms that ARE free.
      if (pickedRooms.size > 0) {
        if (willSplit) {
          // Subset: split the reservation. The API creates a new
          // reservation with the picked rooms + extended dates, leaves
          // the source intact with its original dates.
          const resp = await api.post<{
            source: { id: string; reservationNumber: string };
            created: { id: string; reservationNumber: string };
          }>(`/reservations/${props.reservationId}/extend-split`, {
            newCheckOutDate,
            roomIds: Array.from(pickedRooms),
            ratePerNight: overrideRate ? ratePerNight : undefined,
          });
          created = created ?? resp.created;
        } else {
          // All rooms (or single-room reservation): use the original
          // /extend endpoint that bumps the source's check-out in place.
          await api.post(`/reservations/${props.reservationId}/extend`, {
            newCheckOutDate,
            ratePerNight: overrideRate ? ratePerNight : undefined,
          });
        }
      }
      return created;
    },
    onSuccess: (created) => {
      if (created && props.onSplit) {
        props.onSplit(created);
      } else {
        props.onSaved();
      }
    },
    onError: (e: Error) => setErr(e.message),
  });

  return (
    <ModalShell title="Extend Stay" onClose={props.onClose}>
      <div className="space-y-4">
        <OverdueWarning minutesOverdue={props.minutesOverdue ?? 0} />
        <div className="text-sm text-textSecondary">
          Current check-out: <strong>{format(new Date(props.currentCheckOut), "dd MMM yyyy")}</strong>
        </div>
        <div>
          <label className="label block mb-1">New Check-out Date</label>
          <input
            className="input"
            type="date"
            min={minDate}
            value={newCheckOutDate}
            onChange={(e) => setNewCheckOutDate(e.target.value)}
          />
        </div>

        {isMultiRoom && (
          <div>
            <label className="label block mb-1">
              Rooms to extend{" "}
              <span className="text-textSecondary font-normal">
                · {pickedRooms.size} of {props.rooms.length}
              </span>
            </label>
            <div className="border border-borderc rounded-sm divide-y divide-borderc">
              {props.rooms.map((rm) => {
                const isOn = pickedRooms.has(rm.id);
                const opt = optByRoom.get(rm.id);
                const blocked = !!opt && !opt.available;
                const disabled =
                  rm.invoiced ||
                  rm.status === "cancelled" ||
                  rm.status === "checked_out" ||
                  blocked;
                const reason = rm.invoiced
                  ? "already invoiced"
                  : rm.status === "cancelled"
                    ? "cancelled"
                    : rm.status === "checked_out"
                      ? "checked out"
                      : blocked
                        ? `booked till ${format(new Date(opt!.conflict?.bookedTill ?? newCheckOutDate), "dd MMM")}`
                        : optionsQ.data
                          ? "free for the new night(s)"
                          : null;
                return (
                  <label
                    key={rm.id}
                    className={`flex items-center gap-2 px-3 py-2 text-sm ${
                      disabled
                        ? "opacity-50 cursor-not-allowed"
                        : isOn
                          ? "bg-brand-soft/40 cursor-pointer"
                          : "hover:bg-bg cursor-pointer"
                    }`}
                  >
                    <input
                      type="checkbox"
                      className="accent-brand-dark"
                      checked={isOn}
                      disabled={disabled}
                      onChange={() => toggleRoom(rm.id)}
                    />
                    <span className="font-mono font-semibold text-brand-dark">
                      Room {rm.roomNumber}
                    </span>
                    {reason && (
                      <span
                        className={`text-[11px] ml-auto ${
                          blocked
                            ? "text-danger font-semibold"
                            : reason.startsWith("free")
                              ? "text-success"
                              : "text-textSecondary"
                        }`}
                      >
                        {reason}
                      </span>
                    )}
                  </label>
                );
              })}
            </div>
            <div className="text-[11px] text-textSecondary mt-1 leading-tight">
              {willSplit ? (
                <>
                  <span className="font-semibold text-warning">Split:</span> picked
                  rooms move to a NEW reservation with the new check-out date. The
                  un-picked rooms stay on this reservation unchanged.
                </>
              ) : (
                <>All rooms extend together - same reservation, new check-out date.</>
              )}
            </div>
          </div>
        )}

        {blockedRooms.length > 0 && (
          <div className="rounded-sm border border-danger/30 bg-danger/5 p-3 space-y-2">
            <div className="text-xs font-semibold uppercase tracking-wider text-danger">
              {blockedRooms.length === 1
                ? "Room isn't free for the new night(s)"
                : `${blockedRooms.length} rooms aren't free for the new night(s)`}
            </div>
            {blockedRooms.map((b) => (
              <div key={b.roomId} className="space-y-1">
                <div className="text-sm">
                  <span className="font-mono font-semibold text-brand-dark">
                    Room {b.roomNumber}
                  </span>{" "}
                  <span className="text-xs text-textSecondary">
                    booked
                    {b.conflict ? (
                      <>
                        {" "}for <strong>{b.conflict.guestName}</strong> till{" "}
                        <strong>{format(new Date(b.conflict.bookedTill), "dd MMM yyyy")}</strong>{" "}
                        · {b.conflict.reservationNumber}
                      </>
                    ) : null}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-textSecondary shrink-0">Continue in:</span>
                  <select
                    className="input !h-8 text-sm"
                    value={moves[b.roomId] ?? ""}
                    onChange={(e) =>
                      setMoves((m) => ({ ...m, [b.roomId]: e.target.value }))
                    }
                  >
                    <option value="">- don't extend this room -</option>
                    {(optionsQ.data?.alternatives ?? [])
                      // An alternative can only take one guest.
                      .filter(
                        (a) =>
                          moves[b.roomId] === a.id ||
                          !Object.values(moves).includes(a.id),
                      )
                      .map((a) => (
                        <option key={a.id} value={a.id}>
                          Room {a.roomNumber} · {a.roomType.replace(/_/g, " ")} · ₹
                          {Number(a.baseRate).toFixed(0)}/night
                        </option>
                      ))}
                  </select>
                </div>
              </div>
            ))}
            {(optionsQ.data?.alternatives.length ?? 0) === 0 && (
              <div className="text-xs text-danger">
                No alternative rooms are free for those nights.
              </div>
            )}
            <div className="text-[11px] text-textSecondary leading-tight">
              Picking a room books a continuation reservation for the same guest -
              details and KYC carry over, nothing to re-enter. The guest confirms
              with a one-time code.
            </div>
          </div>
        )}

        {moveEntries.length > 0 && (
          <div className="rounded-sm border border-borderc bg-bg/40 p-3 space-y-2">
            <div className="text-xs font-semibold uppercase tracking-wider text-textSecondary">
              Guest confirmation (OTP)
            </div>
            {otpSent ? (
              <>
                <div className="text-xs text-textSecondary">
                  Code sent to <span className="font-mono">{otpSent.target}</span>.
                  {otpSent.devCode && (
                    <>
                      {" "}Dev code: <span className="font-mono font-semibold">{otpSent.devCode}</span>
                    </>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <input
                    className="input !h-9 font-mono tracking-widest"
                    placeholder="Enter code"
                    value={otpCode}
                    maxLength={8}
                    onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, ""))}
                  />
                  <button
                    type="button"
                    className="btn-secondary !h-9 shrink-0"
                    onClick={() => sendOtp.mutate()}
                    disabled={sendOtp.isPending}
                  >
                    {sendOtp.isPending ? "Sending…" : "Resend"}
                  </button>
                </div>
              </>
            ) : (
              <button
                type="button"
                className="btn-secondary"
                onClick={() => sendOtp.mutate()}
                disabled={sendOtp.isPending}
              >
                {sendOtp.isPending ? "Sending…" : "Send OTP to guest"}
              </button>
            )}
          </div>
        )}

        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="overrideRate"
            checked={overrideRate}
            onChange={(e) => setOverrideRate(e.target.checked)}
          />
          <label htmlFor="overrideRate" className="text-sm">
            Set a different rate for the new night(s)
          </label>
        </div>
        {overrideRate && (
          <div>
            <label className="label block mb-1">Rate / night for the extension (₹)</label>
            <input
              className="input"
              type="number"
              min={0}
              step="0.01"
              value={ratePerNight === 0 ? "" : ratePerNight}
              onChange={(e) => {
                const v = e.target.value;
                setRatePerNight(v === "" ? 0 : Number(v));
              }}
            />
            {/* Live preview so staff see exactly what the guest pays for
                the extension. Existing nights are NOT re-priced — only
                the new nights bill at this rate. */}
            {(() => {
              const extraNights = Math.max(
                0,
                Math.round(
                  (new Date(newCheckOutDate).getTime() -
                    new Date(props.currentCheckOut).getTime()) /
                    86400000,
                ),
              );
              if (extraNights <= 0) return null;
              return (
                <p className="text-[11px] text-textSecondary mt-1">
                  {extraNights} new night{extraNights === 1 ? "" : "s"} × ₹
                  {ratePerNight.toFixed(2)} = <strong>₹{(extraNights * ratePerNight).toFixed(2)}</strong>.
                  Existing nights stay at ₹{Number(props.currentRate).toFixed(2)}.
                </p>
              );
            })()}
          </div>
        )}
        {err && <div className="text-danger text-sm">{err}</div>}
        <div className="flex justify-end gap-2">
          <button className="btn-secondary" onClick={props.onClose}>Cancel</button>
          <button
            className="btn-primary"
            disabled={
              !newCheckOutDate ||
              save.isPending ||
              // Nothing to do: no room extends in place, no room moves.
              (pickedRooms.size === 0 && moveEntries.length === 0) ||
              // A move needs the guest's OTP before it can be booked.
              (moveEntries.length > 0 && otpCode.trim().length < 4)
            }
            onClick={() => save.mutate()}
          >
            {save.isPending
              ? moveEntries.length > 0
                ? "Booking…"
                : willSplit
                  ? "Splitting…"
                  : "Extending…"
              : moveEntries.length > 0
                ? pickedRooms.size > 0
                  ? "Extend & book new room"
                  : "Verify code & book new room"
                : willSplit
                  ? `Split ${pickedRooms.size} room${pickedRooms.size === 1 ? "" : "s"} into new reservation`
                  : "Extend"}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

// Cancel-reservation modal. Replaces the old single-prompt dialog with
// a small workflow: reason → optional cancellation fee → refund mode
// (cash or wallet credit). The server computes refundable as
// advance_paid − fee, then either records a negative refund row
// (cash) or issues a credit_issued ledger entry (credit).

function CancelReservationModal(props: {
  reservationNumber: string;
  advancePaid: number;
  isSubmitting: boolean;
  onClose: () => void;
  onConfirm: (input: {
    cancellationReason: string;
    refundMode: "cash" | "upi" | "card" | "bank_transfer" | "credit";
    cancellationFee: number;
  }) => void;
}) {
  const [reason, setReason] = useState("");
  const [feeStr, setFeeStr] = useState("");
  const [refundMode, setRefundMode] = useState<
    "cash" | "upi" | "card" | "bank_transfer" | "credit"
  >("cash");

  const parsedFee = (() => {
    const n = Number(feeStr);
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.min(n, props.advancePaid);
  })();
  const refundable = +(props.advancePaid - parsedFee).toFixed(2);
  const hasAdvance = props.advancePaid > 0.009;
  const canSubmit = reason.trim().length > 0 && !props.isSubmitting;

  return (
    <ModalShell title="Cancel reservation" onClose={props.onClose} size="md">
      <div className="space-y-4">
        <div className="text-sm text-textSecondary">
          <strong className="text-brand-dark">{props.reservationNumber}</strong>{" "}
          will be cancelled. This can't be undone.
        </div>

        <div>
          <label className="label block mb-1">
            Reason <span className="text-danger">*</span>
          </label>
          <textarea
            className="input min-h-[80px]"
            placeholder="e.g. Guest requested, duplicate booking"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={500}
            autoFocus
          />
        </div>

        {hasAdvance && (
          <>
            <div className="rounded-sm border border-borderc bg-bg/40 p-3 space-y-2">
              <div className="text-xs font-semibold uppercase tracking-wider text-textSecondary">
                Advance handling
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-textSecondary">Advance paid</span>
                <span className="font-mono">₹{props.advancePaid.toFixed(2)}</span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-textSecondary">Cancellation fee (withheld)</span>
                <div className="w-32">
                  <input
                    className="input text-right"
                    type="number"
                    min={0}
                    max={props.advancePaid}
                    step="0.01"
                    placeholder="0"
                    value={feeStr}
                    onChange={(e) => setFeeStr(e.target.value)}
                  />
                </div>
              </div>
              <div className="flex items-center justify-between border-t border-borderc pt-2 text-sm">
                <strong>Refundable to guest</strong>
                <strong className="font-mono">₹{refundable.toFixed(2)}</strong>
              </div>
            </div>

            {refundable > 0.009 && (
              <div>
                <label className="label block mb-1">Refund method</label>
                <div className="flex gap-2 flex-wrap">
                  {(
                    [
                      { v: "cash" as const, label: "Cash" },
                      { v: "upi" as const, label: "UPI" },
                      { v: "card" as const, label: "Card" },
                      { v: "bank_transfer" as const, label: "Bank transfer" },
                      { v: "credit" as const, label: "Wallet credit" },
                    ]
                  ).map((opt) => (
                    <label
                      key={opt.v}
                      className={`px-3 h-9 inline-flex items-center gap-2 rounded-sm border cursor-pointer text-sm ${
                        refundMode === opt.v
                          ? "border-brand-dark bg-brand-soft text-brand-dark font-semibold"
                          : "border-borderc text-textSecondary hover:border-brand-dark/40"
                      }`}
                    >
                      <input
                        type="radio"
                        className="sr-only"
                        checked={refundMode === opt.v}
                        onChange={() => setRefundMode(opt.v)}
                      />
                      {opt.label}
                    </label>
                  ))}
                </div>
                <div className="text-[11px] text-textSecondary mt-2">
                  {refundMode === "credit"
                    ? `₹${refundable.toFixed(2)} will be added to the guest's wallet.`
                    : `₹${refundable.toFixed(2)} will be handed back via ${refundMode.replace(/_/g, " ")}.`}
                </div>
              </div>
            )}
          </>
        )}

        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            className="btn-secondary"
            onClick={props.onClose}
            disabled={props.isSubmitting}
          >
            Keep it
          </button>
          <button
            className="btn-danger"
            disabled={!canSubmit}
            onClick={() =>
              props.onConfirm({
                cancellationReason: reason.trim(),
                refundMode,
                cancellationFee: parsedFee,
              })
            }
          >
            {props.isSubmitting ? "Cancelling…" : "Cancel reservation"}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

function LateCheckoutModal(props: {
  reservationId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [hours, setHours] = useState(2);
  const [fee, setFee] = useState(0);
  const [notes, setNotes] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () =>
      api.post(`/reservations/${props.reservationId}/late-checkout`, {
        hours,
        fee,
        notes: notes || undefined,
      }),
    onSuccess: props.onSaved,
    onError: (e: Error) => setErr(e.message),
  });

  return (
    <ModalShell title="Grant Late Checkout" onClose={props.onClose}>
      <div className="space-y-3">
        <div className="text-sm text-textSecondary">
          Grant the guest extra hours past the normal check-out time, with an
          optional agreed fee (added to the bill now). The stay won't show as
          overdue until the granted time passes.
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label block mb-1">Extra Hours</label>
            <input
              className="input"
              type="number"
              min={1}
              max={24}
              step="0.5"
              value={hours === 0 ? "" : hours}
              onChange={(e) => {
                const v = e.target.value;
                setHours(v === "" ? 0 : Number(v));
              }}
              onBlur={() => {
                if (hours < 1) setHours(1);
              }}
            />
          </div>
          <div>
            <label className="label block mb-1">Fee (₹)</label>
            <input
              className="input"
              type="number"
              min={0}
              step="0.01"
              value={fee || ""}
              placeholder="0"
              onChange={(e) => setFee(Number(e.target.value))}
            />
          </div>
        </div>
        <div>
          <label className="label block mb-1">Notes (optional)</label>
          <input
            className="input"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Guest requested late checkout…"
          />
        </div>
        {err && <div className="text-danger text-sm">{err}</div>}
        <div className="flex justify-end gap-2">
          <button className="btn-secondary" onClick={props.onClose}>Cancel</button>
          <button
            className="btn-primary"
            disabled={hours <= 0 || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? "Saving…" : "Add Late Checkout"}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

function ChargeModal(props: {
  reservationId: string;
  rooms: { id: string; roomNumber: string; invoiced: boolean }[];
  minutesOverdue?: number;
  // Pre-fill for "Add late fee" from the checkout flow. Staff can edit
  // before saving; the modal isn't locked.
  initialDescription?: string;
  initialGstRate?: number;
  // Optional title override (e.g. "Add Late-Checkout Fee") for clarity.
  titleOverride?: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [description, setDescription] = useState(props.initialDescription ?? "");
  const [amount, setAmount] = useState(0);
  // Default to 0% so an "extra bed" or one-off charge doesn't silently
  // add 18% GST. Staff picks 5% / 18% only when the line item is
  // actually GST-applicable (restaurant, laundry, etc.).
  const [gstRate, setGstRate] = useState(props.initialGstRate ?? 0);
  // Charge attribution. Empty set = "All rooms / reservation-wide"
  // — the charge will land on the combined invoice (or the booker's
  // share when the reservation is split into per-room invoices). Any
  // non-empty selection scopes the charge to those rooms only; the
  // total amount entered is split evenly across them.
  const [pickedRooms, setPickedRooms] = useState<Set<string>>(new Set());
  const [err, setErr] = useState<string | null>(null);
  // Filter out already-invoiced rooms — staff can't add charges to a
  // bill that's been closed.
  const billableRooms = props.rooms.filter((r) => !r.invoiced);
  const selectedCount = pickedRooms.size;
  const perRoomAmount =
    selectedCount > 0 ? +(amount / selectedCount).toFixed(2) : amount;
  const idempotencyKey = useMemo(() => newIdempotencyKey(), []);
  // Late-checkout fees must be entered on the Check Out screen (applied at
  // Complete Check-out), NOT saved immediately here. Detect the wording and
  // block the save so this form is only used for genuine extras.
  const looksLikeLateFee = /\blate[- ]?check\s*-?\s*out\b|\blate\s*fee\b/i.test(
    description,
  );

  const save = useMutation({
    mutationFn: async () => {
      // Reservation-wide charge: one POST with no roomId.
      if (pickedRooms.size === 0) {
        await api.post(
          `/reservations/${props.reservationId}/charges`,
          { description, quantity: 1, rate: amount, gstRate },
          { idempotencyKey },
        );
        return;
      }
      // Per-room split: one POST per selected room with an equal share.
      // The last room absorbs the rounding remainder so the line items
      // sum exactly to the entered total.
      const ids = Array.from(pickedRooms);
      const baseShare = +(amount / ids.length).toFixed(2);
      let runningTotal = 0;
      for (let i = 0; i < ids.length; i++) {
        const isLast = i === ids.length - 1;
        const share = isLast ? +(amount - runningTotal).toFixed(2) : baseShare;
        runningTotal = +(runningTotal + share).toFixed(2);
        await api.post(
          `/reservations/${props.reservationId}/charges`,
          {
            description:
              ids.length > 1
                ? `${description} (${i + 1} of ${ids.length})`
                : description,
            quantity: 1,
            rate: share,
            gstRate,
            roomId: ids[i]!,
          },
          // Each leg needs its own idempotency key — re-using one key
          // would make the server replay the first response for legs
          // 2..N instead of inserting separate charges. Derived from the
          // modal-scoped base key (NOT freshly minted per call) so that a
          // retry after a mid-loop failure replays the legs that already
          // succeeded instead of double-charging them.
          { idempotencyKey: `${idempotencyKey}-leg-${i}` },
        );
      }
    },
    onSuccess: props.onSaved,
    onError: (e: Error) => setErr(e.message),
  });

  function toggleRoom(roomId: string) {
    setPickedRooms((prev) => {
      const next = new Set(prev);
      if (next.has(roomId)) next.delete(roomId);
      else next.add(roomId);
      return next;
    });
  }

  return (
    <ModalShell title={props.titleOverride ?? "Add Charge"} onClose={props.onClose}>
      <div className="space-y-3">
        <OverdueWarning minutesOverdue={props.minutesOverdue ?? 0} />
        <div>
          <label className="label block mb-1">Description</label>
          <input
            className="input"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Laundry, restaurant, extra bed…"
          />
          {looksLikeLateFee && (
            <div className="text-xs text-warning mt-1 flex items-start gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <span>
                Late-checkout fees aren&apos;t added here - enter the fee on the
                <strong> Check Out</strong> screen, where it&apos;s applied when
                you complete check-out. This form is for other extras.
              </span>
            </div>
          )}
        </div>
        {props.rooms.length > 1 && (
          <div>
            <label className="label block mb-1">
              Attribute to rooms{" "}
              <span className="text-textSecondary font-normal">
                · {selectedCount === 0 ? "all rooms" : `${selectedCount} selected`}
              </span>
            </label>
            <div className="border border-borderc rounded-sm divide-y divide-borderc">
              {props.rooms.map((rm) => {
                const isOn = pickedRooms.has(rm.id);
                return (
                  <label
                    key={rm.id}
                    className={`flex items-center gap-2 px-3 py-2 text-sm cursor-pointer ${
                      rm.invoiced
                        ? "opacity-50 cursor-not-allowed"
                        : isOn
                          ? "bg-brand-soft/40"
                          : "hover:bg-bg"
                    }`}
                  >
                    <input
                      type="checkbox"
                      className="accent-brand-dark"
                      checked={isOn}
                      disabled={rm.invoiced}
                      onChange={() => toggleRoom(rm.id)}
                    />
                    <span className="font-mono font-semibold text-brand-dark">
                      Room {rm.roomNumber}
                    </span>
                    {rm.invoiced && (
                      <span className="text-[11px] text-textSecondary ml-auto">
                        already invoiced
                      </span>
                    )}
                  </label>
                );
              })}
            </div>
            <div className="text-[11px] text-textSecondary mt-1 leading-tight">
              {selectedCount === 0
                ? "No rooms picked - charge lands on whichever invoice covers the last remaining rooms (reservation-wide)."
                : selectedCount === 1
                  ? "Bills only on this room's invoice."
                  : `Total amount will be split evenly across ${selectedCount} rooms (${inr(perRoomAmount)} each).`}
            </div>
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label block mb-1">Amount (₹)</label>
            <input
              className="input"
              type="number"
              min={0}
              step="0.01"
              value={amount || ""}
              placeholder="0"
              onChange={(e) => setAmount(Number(e.target.value))}
            />
          </div>
          <div>
            <label className="label block mb-1">GST %</label>
            <select
              className="input"
              value={gstRate}
              onChange={(e) => setGstRate(Number(e.target.value))}
            >
              <option value={0}>0%</option>
              <option value={5}>5%</option>
              <option value={18}>18%</option>
            </select>
          </div>
        </div>
        {err && <div className="text-danger text-sm">{err}</div>}
        <div className="flex justify-end gap-2">
          <button className="btn-secondary" onClick={props.onClose}>Cancel</button>
          <button
            className="btn-primary"
            disabled={
              !description ||
              amount <= 0 ||
              save.isPending ||
              looksLikeLateFee ||
              // Block submit if every billable room is already invoiced
              // AND no reservation-wide fallback is meaningful (i.e. the
              // user explicitly picked rooms — but their picks are all
              // disabled now). Reservation-wide submit (no picks) is
              // always allowed when the form is otherwise valid.
              (selectedCount > 0 && billableRooms.length === 0)
            }
            onClick={() => save.mutate()}
          >
            {save.isPending
              ? "Saving…"
              : selectedCount > 1
                ? `Add ${selectedCount} charges · ${inr(perRoomAmount)} each`
                : "Add Charge"}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

function PaymentModal(props: {
  reservationId: string;
  balance: number;
  // Optional — when set, the payment is tied to this specific invoice
  // server-side. Used when the caller already knows which invoice they
  // want to collect against (e.g. right after issuing a combined invoice).
  invoiceId?: string;
  invoiceNumber?: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [amount, setAmount] = useState(props.balance);
  const [method, setMethod] = useState<"cash" | "card" | "upi" | "bank_transfer">("cash");
  const [reason, setReason] = useState("");
  const [reference, setReference] = useState("");
  const [err, setErr] = useState<string | null>(null);
  // One key per modal mount: double-click → server replays the first
  // response. Closing and reopening the modal generates a fresh key.
  const idempotencyKey = useMemo(() => newIdempotencyKey(), []);

  // Reason + reference both travel in payments.notes — that's the field
  // every surface already renders (payment history, Collections, receipt
  // and invoice PDFs).
  const composedNotes = [
    reason.trim(),
    reference.trim() ? `Ref: ${reference.trim()}` : "",
  ]
    .filter(Boolean)
    .join(" · ");

  const save = useMutation({
    mutationFn: () =>
      api.post(
        `/reservations/${props.reservationId}/payments`,
        {
          amount,
          paymentMethod: method,
          notes: composedNotes || undefined,
          ...(props.invoiceId ? { invoiceId: props.invoiceId } : {}),
        },
        { idempotencyKey },
      ),
    onSuccess: props.onSaved,
    onError: (e: Error) => setErr(e.message),
  });

  return (
    <ModalShell
      title={
        props.invoiceNumber ? `Record Payment · ${props.invoiceNumber}` : "Record Payment"
      }
      onClose={props.onClose}
    >
      <div className="space-y-3">
        <div>
          <label className="label block mb-1">Amount (₹)</label>
          <input
            className="input"
            type="number"
            min={0}
            step="0.01"
            value={amount || ""}
            placeholder="0"
            onChange={(e) => setAmount(Number(e.target.value))}
          />
          <div className="text-xs text-textSecondary mt-1">Balance due: {inr(props.balance)}</div>
        </div>
        <div>
          <label className="label block mb-1">Method</label>
          <select
            className="input"
            value={method}
            onChange={(e) => setMethod(e.target.value as typeof method)}
          >
            <option value="cash">Cash</option>
            <option value="upi">UPI</option>
            <option value="card">Card</option>
            <option value="bank_transfer">Bank Transfer</option>
          </select>
        </div>
        <div>
          <label className="label block mb-1">Reason (optional)</label>
          <input
            className="input"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. part payment, advance for extra night"
          />
          <div className="text-xs text-textSecondary mt-1">
            Shows in payment history, collections and on the receipt / invoice.
          </div>
        </div>
        <div>
          <label className="label block mb-1">Reference (optional)</label>
          <input
            className="input"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            placeholder="UTR / card last4 / cheque #"
          />
        </div>
        {err && <div className="text-danger text-sm">{err}</div>}
        <div className="flex justify-end gap-2">
          <button className="btn-secondary" onClick={props.onClose}>Cancel</button>
          <button
            className="btn-primary"
            disabled={amount <= 0 || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? "Saving…" : "Record"}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

// Per-room (migration 0017) checkout flow. Lighter than the full
// CheckoutModal (no previous-balance carry-over, no wallet credit, no
// refund handling — those belong on the booker's combined checkout).
// Shows the room's bill, lets staff collect payment, hits the unified
// endpoint that does invoice + payment + checkout in one tx.
function PerRoomCheckoutModal(props: {
  reservationId: string;
  roomId: string;
  roomNumber: string;
  occupantName: string | null;
  onClose: () => void;
  onDone: () => void;
}) {
  // One key per modal mount, shared by every step of this multi-step
  // checkout. Retrying after a partial failure must replay the steps that
  // already succeeded (notably the wallet redemption) rather than repeat them.
  const idempotencyKey = useMemo(() => newIdempotencyKey(), []);

  const quoteQ = useQuery({
    queryKey: ["per-room-checkout-quote", props.reservationId, props.roomId],
    queryFn: () =>
      api.get<{
        subtotal: number;
        gst: number;
        cgst: number;
        sgst: number;
        grandTotal: number;
        // Remaining unpaid amount on the room's invoice (if already
        // bound to one) — what staff actually needs to collect now.
        // For un-invoiced rooms this equals grandTotal - advanceApplied.
        balanceDue: number;
        totalPaid: number;
        // Share of the reservation's un-allocated advance that lands on
        // THIS room's bill when the per-room invoice gets issued.
        // Populated only on the un-invoiced path; 0 for already-invoiced
        // rooms (their advance attribution is already in totalPaid).
        advanceApplied?: number;
        invoiceNumber?: string;
        invoiceScope?: "room" | "combined" | "partial";
        alreadyInvoiced: boolean;
      }>(`/reservations/${props.reservationId}/rooms/${props.roomId}/checkout-quote`),
    staleTime: 0,
  });
  // "Due now" is the remaining balance on the bound invoice — NOT the
  // grand total. A room sitting on a fully-paid combined invoice has
  // due = 0 and the modal lets staff just check out without collecting.
  const due = quoteQ.data?.balanceDue ?? 0;
  // Wallet preview tied to the parent reservation. Per-room checkout still
  // redeems off the same guest wallet — the API caps the redeem at the
  // reservation's remaining balance, which is fine for our use here.
  const walletQ = useQuery({
    queryKey: ["wallet-credit-preview", props.reservationId],
    queryFn: () =>
      api.get<{
        walletBalance: number;
        maxRedeemable: number;
      }>(`/reservations/${props.reservationId}/wallet-credit-preview`),
    staleTime: 0,
  });
  const walletBalance = walletQ.data?.walletBalance ?? 0;
  const [amount, setAmount] = useState<number>(0);
  const [userEdited, setUserEdited] = useState(false);
  const [method, setMethod] = useState<
    "cash" | "upi" | "card" | "bank_transfer" | "unpaid" | "wallet"
  >("cash");
  const [notes, setNotes] = useState("");
  const [err, setErr] = useState<string | null>(null);

  // Prefill the amount with what's still owed and keep tracking the
  // quote until staff edits the field manually. The first render can
  // serve a cached quote from before the latest payment was recorded —
  // locking that in showed a stale (higher) amount and tripped the
  // "over by" warning.
  useEffect(() => {
    if (quoteQ.data && !userEdited && method !== "wallet") {
      setAmount(quoteQ.data.balanceDue);
    }
  }, [quoteQ.data, userEdited, method]);

  // When the user switches to "wallet", cap the amount at the wallet balance
  // (and at the bill total). Switching away leaves the amount alone.
  useEffect(() => {
    if (method === "wallet") {
      setAmount(Math.min(due, walletBalance));
    }
  }, [method, due, walletBalance]);

  const checkOut = useMutation({
    mutationFn: async () => {
      if (method === "wallet") {
        // Redeem wallet against the parent reservation first; that reduces
        // the bill to zero (or close to). Then close the room with a
        // zero-payment check-out so an invoice still gets issued.
        if (amount > 0.009) {
          await api.post(
            `/reservations/${props.reservationId}/apply-wallet-credit`,
            { amount },
            // Modal-scoped key: retrying this multi-step checkout must not
            // redeem the wallet a second time. Safe to share with the other
            // calls in this modal — the server composite includes routeKey.
            { idempotencyKey },
          );
        }
        await api.post(
          `/reservations/${props.reservationId}/rooms/${props.roomId}/check-out`,
          {
            paymentAmount: 0,
            paymentMethod: "unpaid",
            paymentNotes: `Wallet credit ${inr(amount)} applied`,
          },
        );
        return;
      }
      await api.post(`/reservations/${props.reservationId}/rooms/${props.roomId}/check-out`, {
        paymentAmount: amount,
        paymentMethod: method,
        paymentNotes: notes || undefined,
      });
    },
    onSuccess: () => props.onDone(),
    onError: (e: Error) => setErr(e.message),
  });

  return (
    <ModalShell title={`Check out Room ${props.roomNumber}`} onClose={props.onClose}>
      {quoteQ.isLoading || !quoteQ.data ? (
        <div className="text-sm text-textSecondary py-6 text-center">Loading bill…</div>
      ) : (
        <div className="space-y-4">
          <div className="text-sm">
            {quoteQ.data.alreadyInvoiced
              ? quoteQ.data.balanceDue <= 0.009
                ? `This room is already billed on ${quoteQ.data.invoiceNumber ?? "an invoice"} and fully paid. Confirming just releases the room and completes check-out.`
                : `This room is already billed on ${quoteQ.data.invoiceNumber ?? "an invoice"} with ${inr(quoteQ.data.balanceDue)} still owing. Confirming records the remaining payment and checks the room out.`
              : "Confirming will generate this room's tax invoice, record the payment, and check the room out. Other rooms on this reservation are unaffected."}
            {props.occupantName && (
              <> Guest: <strong className="text-brand-dark">{props.occupantName}</strong>.</>
            )}
          </div>
          <div className="border border-borderc rounded p-3 space-y-1 bg-bg/40">
            <div className="flex justify-between text-sm">
              <span className="text-textSecondary">Subtotal (room charges + extras, pre-GST)</span>
              <span className="font-mono">{inr(quoteQ.data.subtotal)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-textSecondary">CGST (Central GST, half of total tax)</span>
              <span className="font-mono">{inr(quoteQ.data.cgst)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-textSecondary">SGST (State GST, half of total tax)</span>
              <span className="font-mono">{inr(quoteQ.data.sgst)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-textSecondary">Total GST</span>
              <span className="font-mono">{inr(quoteQ.data.gst)}</span>
            </div>
            <div className="flex justify-between text-sm border-t border-borderc pt-2 mt-2">
              <span className="text-textSecondary">Grand Total</span>
              <span className="font-mono">{inr(quoteQ.data.grandTotal)}</span>
            </div>
            {quoteQ.data.alreadyInvoiced && quoteQ.data.totalPaid > 0.009 && (
              <div className="flex justify-between text-sm">
                <span className="text-textSecondary">Already paid</span>
                <span className="font-mono">− {inr(quoteQ.data.totalPaid)}</span>
              </div>
            )}
            {!quoteQ.data.alreadyInvoiced &&
              (quoteQ.data.advanceApplied ?? 0) > 0.009 && (
                <div className="flex justify-between text-sm">
                  <span className="text-textSecondary">
                    Advance applied to this room
                  </span>
                  <span className="font-mono">
                    − {inr(quoteQ.data.advanceApplied ?? 0)}
                  </span>
                </div>
              )}
            <div className="flex justify-between border-t border-borderc pt-2 mt-2">
              <strong>{due <= 0.009 ? "Due now" : "Balance due now"}</strong>
              <strong className={`font-mono ${due <= 0.009 ? "text-success" : ""}`}>
                {inr(due)}
              </strong>
            </div>
          </div>
          {due > 0.009 && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label block mb-1">Payment amount (₹)</label>
                  <input
                    className="input"
                    type="number"
                    min={0}
                    step="0.01"
                    value={amount === 0 ? "" : amount}
                    onChange={(e) => {
                      const v = e.target.value;
                      setUserEdited(true);
                      setAmount(v === "" ? 0 : Number(v));
                    }}
                  />
                  {amount < due - 0.009 && (
                    <div className="text-[11px] text-textSecondary mt-1">
                      Short by {inr(due - amount)} - the rest stays on the invoice.
                    </div>
                  )}
                  {amount > due + 0.009 && (
                    <div className="text-[11px] text-warning mt-1">
                      Over by {inr(amount - due)} - please collect only what's due, or use the
                      booker's combined invoice for overpayments / refunds.
                    </div>
                  )}
                </div>
                <div>
                  <label className="label block mb-1">Method</label>
                  <select
                    className="input"
                    value={method}
                    onChange={(e) =>
                      setMethod(
                        e.target.value as
                          | "cash"
                          | "upi"
                          | "card"
                          | "bank_transfer"
                          | "unpaid"
                          | "wallet",
                      )
                    }
                  >
                    <option value="cash">Cash</option>
                    <option value="upi">UPI</option>
                    <option value="card">Card</option>
                    <option value="bank_transfer">Bank transfer</option>
                    <option value="unpaid">Unpaid · collect later</option>
                    <option value="wallet" disabled={walletBalance <= 0.009}>
                      Wallet credit · available {inr(walletBalance)}
                    </option>
                  </select>
                  {method === "wallet" && (
                    <div className="text-[11px] text-textSecondary mt-1">
                      Redeems {inr(amount)} from the guest's wallet. Wallet covers up to{" "}
                      {inr(Math.min(due, walletBalance))} of this bill.
                    </div>
                  )}
                </div>
              </div>
              {(method === "unpaid" || (method !== "wallet" && amount < due - 0.009)) && (
                <div>
                  <label className="label block mb-1">
                    Notes {method === "unpaid" ? "(required)" : "(optional)"}
                  </label>
                  <textarea
                    className="input"
                    rows={2}
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder={
                      method === "unpaid"
                        ? "Why are we letting this guest leave without paying?"
                        : "Reason for short payment"
                    }
                  />
                </div>
              )}
            </>
          )}
          {err && <div className="text-danger text-sm">{err}</div>}
          <div className="flex justify-end gap-2 pt-2">
            <button className="btn-secondary" onClick={props.onClose}>
              Cancel
            </button>
            <button
              className="btn-primary"
              disabled={
                checkOut.isPending ||
                (due > 0.009 && amount <= 0.009) ||
                (method === "wallet" && amount > walletBalance + 0.009)
              }
              onClick={() => {
                setErr(null);
                checkOut.mutate();
              }}
            >
              {checkOut.isPending
                ? "Checking out…"
                : due <= 0.009
                  ? "Check Out"
                  : `Check Out · ${
                      method === "unpaid"
                        ? "mark unpaid"
                        : method === "wallet"
                          ? "redeem " + inr(amount) + " from wallet"
                          : "collect " + inr(amount)
                    }`}
            </button>
          </div>
        </div>
      )}
    </ModalShell>
  );
}

// Double-check before issuing a combined invoice. Lists the exact rooms
// rolling onto the one bill, the rooms already invoiced separately (which
// will NOT be re-billed), and the amount being collected. Renders as a
// nested modal-style overlay on top of the open Checkout modal.
// Issue a combined invoice that pools 2+ un-invoiced rooms into one tax
// bill. The picker lets staff cherry-pick which rooms to combine (default
// is all of them) and optionally settle the bill in the same call by
// providing a payment amount + method. The amount is suggested at the
// live grand total (pre-GST × rooms + GST) but staff can override (short
// payment leaves the invoice partial / issued).
function CombinedInvoiceModal({
  reservationId,
  uninvoicedRooms,
  nights,
  gstRate,
  gstMode,
  stayType,
  onClose,
  onIssued,
}: {
  reservationId: string;
  uninvoicedRooms: {
    id: string;
    roomNumber: string;
    displayType: string;
    ratePerNight: string;
  }[];
  nights: number;
  gstRate: number;
  // "inclusive" → ratePerNight already contains GST; we extract it.
  // "exclusive" → ratePerNight is net; we add GST on top.
  gstMode: "exclusive" | "inclusive";
  stayType: "overnight" | "short_stay";
  onClose: () => void;
  // Called after the server returns the newly-issued invoice. The
  // second arg carries the staff's intent so the parent can decide
  // whether to chain into the Record Payment modal:
  //   collectIntended=true  → user ticked "Collect payment with this
  //                           invoice"; chain only when the invoice
  //                           landed in 'partial' (short payment) so
  //                           staff is reminded about the remainder.
  //   collectIntended=false → user explicitly issued without collecting;
  //                           DO NOT auto-open the payment modal — they
  //                           can use the per-invoice Collect button when
  //                           they're ready.
  onIssued: (
    invoice: {
      id: string;
      invoiceNumber: string;
      grandTotal: string;
      balanceDue: string;
      status: string;
    },
    meta: { collectIntended: boolean },
  ) => void;
}) {
  // Default: every un-invoiced room is selected.
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(uninvoicedRooms.map((r) => r.id)),
  );
  const [collectNow, setCollectNow] = useState(false);
  const [payAmount, setPayAmount] = useState<number>(0);
  const [method, setMethod] = useState<"cash" | "upi" | "card" | "bank_transfer">("cash");
  const [notes, setNotes] = useState("");
  const [err, setErr] = useState<string | null>(null);

  // Client-side estimate of the invoice total. Mirrors the server's
  // calcGstBreakdown logic — the server recomputes the authoritative
  // total before issuing, so this is only a preview.
  //
  //   exclusive: ratePerNight × units IS the net subtotal; GST goes on top.
  //   inclusive: ratePerNight × units is the gross (what the guest pays);
  //              extract the net via gross / (1 + rate/100).
  // For short_stay the stored rate is already the flat price for the stay.
  const units = stayType === "short_stay" ? 1 : Math.max(1, nights);
  const selectedRooms = uninvoicedRooms.filter((r) => selected.has(r.id));
  const grossSelected = selectedRooms.reduce(
    (sum, r) => sum + Number(r.ratePerNight) * units,
    0,
  );
  const subtotalEstimate =
    gstMode === "inclusive"
      ? +(grossSelected / (1 + gstRate / 100)).toFixed(2)
      : +grossSelected.toFixed(2);
  const gstEstimate =
    gstMode === "inclusive"
      ? +(grossSelected - subtotalEstimate).toFixed(2)
      : +(subtotalEstimate * (gstRate / 100)).toFixed(2);
  const grandEstimate = +(subtotalEstimate + gstEstimate).toFixed(2);

  // Sync the suggested payment amount with the grand total whenever the
  // room selection changes — unless staff has manually edited it.
  const [userEdited, setUserEdited] = useState(false);
  useEffect(() => {
    if (!userEdited) setPayAmount(grandEstimate);
  }, [grandEstimate, userEdited]);

  function toggleRoom(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const issue = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = {
        scope: "combined",
        // Send roomIds only when the user narrowed the selection. Omitting
        // it preserves the legacy "all un-invoiced rooms" default.
        ...(selected.size === uninvoicedRooms.length
          ? {}
          : { roomIds: Array.from(selected) }),
      };
      if (collectNow && payAmount > 0.009) {
        body.payment = {
          amount: payAmount,
          paymentMethod: method,
          paymentNotes: notes.trim() || undefined,
        };
      }
      return api.post<{
        id: string;
        invoiceNumber: string;
        grandTotal: string;
        balanceDue: string;
        status: string;
      }>(`/reservations/${reservationId}/invoice`, body);
    },
    onSuccess: (inv) => onIssued(inv, { collectIntended: collectNow }),
    onError: (e: Error) => setErr(e.message),
  });

  const cannotSubmit =
    selected.size === 0 ||
    issue.isPending ||
    (collectNow && payAmount <= 0.009);

  return (
    <ModalShell title="Issue Combined Invoice" onClose={onClose}>
      <div className="space-y-4">
        <div className="text-sm text-textSecondary">
          Pick which un-invoiced rooms to roll into a single tax invoice. Reservation-wide charges
          (extras with no room attached) attach automatically. Rooms already invoiced separately
          aren't shown.
        </div>

        <div>
          <div className="text-[10px] uppercase tracking-wider text-textSecondary font-semibold mb-1.5">
            Rooms to combine ({selected.size} of {uninvoicedRooms.length})
          </div>
          <div className="space-y-1.5 border border-borderc rounded-sm divide-y divide-borderc">
            {uninvoicedRooms.map((rm) => {
              const isOn = selected.has(rm.id);
              const lineTotal = Number(rm.ratePerNight) * units;
              return (
                <label
                  key={rm.id}
                  className={`flex items-center gap-3 px-3 py-2 cursor-pointer transition-colors ${
                    isOn ? "bg-brand-soft/40" : "hover:bg-bg"
                  }`}
                >
                  <input
                    type="checkbox"
                    className="accent-brand-dark"
                    checked={isOn}
                    onChange={() => {
                      toggleRoom(rm.id);
                      setUserEdited(false);
                    }}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="font-mono font-semibold text-brand-dark text-sm">
                      {rm.roomNumber}
                    </div>
                    <div className="text-[11px] text-textSecondary capitalize truncate">
                      {rm.displayType} · ₹{Number(rm.ratePerNight).toFixed(0)}/
                      {stayType === "short_stay" ? "stay" : "n"}
                      {gstMode === "inclusive" ? " incl. GST" : " + GST"}
                      {stayType !== "short_stay" && units > 1 && ` × ${units} nights`}
                    </div>
                  </div>
                  <div className="text-xs font-mono text-textPrimary shrink-0">
                    {inr(lineTotal)}
                  </div>
                </label>
              );
            })}
          </div>
        </div>

        <div className="border border-borderc rounded-sm p-3 bg-bg/40 space-y-1 text-sm">
          <div className="flex justify-between">
            <span className="text-textSecondary">
              Subtotal (pre-GST{gstMode === "inclusive" ? ", extracted from rate" : ""})
            </span>
            <span className="font-mono">{inr(subtotalEstimate)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-textSecondary">
              GST @ {gstRate}%{gstMode === "inclusive" ? " (already in rate)" : " (added on top)"}
            </span>
            <span className="font-mono">{inr(gstEstimate)}</span>
          </div>
          <div className="flex justify-between border-t border-borderc pt-1 mt-1">
            <strong>Estimated total (guest pays)</strong>
            <strong className="font-mono">{inr(grandEstimate)}</strong>
          </div>
          <div className="text-[11px] text-textSecondary mt-1">
            Server recomputes the authoritative total from the selected rooms + any reservation-wide
            charges before issuing.
          </div>
        </div>

        <div className="border border-borderc rounded-sm p-3 space-y-2">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              className="accent-brand-dark"
              checked={collectNow}
              onChange={(e) => setCollectNow(e.target.checked)}
            />
            <span className="text-sm font-medium">Collect payment with this invoice</span>
          </label>
          {collectNow && (
            <div className="grid grid-cols-2 gap-3 pt-1">
              <div>
                <label className="label block mb-1">Amount (₹)</label>
                <input
                  className="input"
                  type="number"
                  min={0}
                  step="0.01"
                  value={payAmount || ""}
                  onChange={(e) => {
                    setPayAmount(Number(e.target.value));
                    setUserEdited(true);
                  }}
                />
                {payAmount > 0.009 && payAmount < grandEstimate - 0.009 && (
                  <div className="text-[11px] text-textSecondary mt-1">
                    Short of estimate - invoice will be marked Partial.
                  </div>
                )}
              </div>
              <div>
                <label className="label block mb-1">Method</label>
                <select
                  className="input"
                  value={method}
                  onChange={(e) => setMethod(e.target.value as typeof method)}
                >
                  <option value="cash">Cash</option>
                  <option value="upi">UPI</option>
                  <option value="card">Card</option>
                  <option value="bank_transfer">Bank transfer</option>
                </select>
              </div>
              <div className="col-span-2">
                <label className="label block mb-1">Notes (optional)</label>
                <input
                  className="input"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Reference, payer name, etc."
                />
              </div>
            </div>
          )}
        </div>

        {err && <div className="text-danger text-sm">{err}</div>}

        <div className="flex justify-end gap-2">
          <button className="btn-secondary" onClick={onClose} disabled={issue.isPending}>
            Cancel
          </button>
          <button
            className="btn-primary"
            disabled={cannotSubmit}
            onClick={() => {
              setErr(null);
              issue.mutate();
            }}
          >
            {issue.isPending
              ? "Issuing…"
              : collectNow && payAmount > 0.009
                ? `Issue & collect ${inr(payAmount)}`
                : `Issue invoice for ${selected.size} room${selected.size === 1 ? "" : "s"}`}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

function InvoiceModeToggle({
  value,
  onChange,
  count,
}: {
  value: boolean;
  onChange: (next: boolean) => void;
  count: number;
}) {
  return (
    <div className="rounded-sm border border-borderc bg-bg/40 p-3 space-y-2">
      <div className="text-xs font-semibold uppercase tracking-wider text-textSecondary">
        Invoice mode · {count} rooms remaining
      </div>
      <label className="flex items-start gap-2 cursor-pointer">
        <input
          type="radio"
          name="invoiceMode"
          checked={value}
          onChange={() => onChange(true)}
          className="mt-1 accent-brand-dark"
        />
        <div className="flex-1 text-sm">
          <div className="font-medium text-textPrimary">
            One combined invoice <span className="text-success text-xs">· default</span>
          </div>
          <div className="text-xs text-textSecondary">
            All rooms + extras on a single tax invoice. You can still print a per-room bill for each
            room from it (for guests splitting the cost) - those are reference copies, not separate
            tax invoices.
          </div>
        </div>
      </label>
      <label className="flex items-start gap-2 cursor-pointer">
        <input
          type="radio"
          name="invoiceMode"
          checked={!value}
          onChange={() => onChange(false)}
          className="mt-1 accent-brand-dark"
        />
        <div className="flex-1 text-sm">
          <div className="font-medium text-textPrimary">One tax invoice per room</div>
          <div className="text-xs text-textSecondary">
            Each room gets its own separate GST invoice. Only needed when each guest requires a
            standalone tax invoice with its own number; payment is split proportionally.
          </div>
        </div>
      </label>
    </div>
  );
}

function CheckoutModal(props: {
  reservationId: string;
  // Human-readable number (e.g. "SLDT-RES-0019") used in payment notes
  // so the Payment History UI on the OTHER reservation reads cleanly
  // instead of showing a raw UUID.
  reservationNumber: string;
  guestId: string;
  balance: number;
  subtotal: number;
  totalGst: number;
  grandTotal: number;
  totalPaid: number;
  // How many rooms still need an invoice. When > 1, the default invoice
  // mode is "per_room" (one tax invoice per room so each guest can claim
  // their own GST). Single-room reservations skip the choice entirely.
  remainingRoomCount: number;
  // The actual rooms that will be billed by this checkout. Used by the
  // "Combine into one invoice" confirm step so staff can verify which
  // rooms (and occupants) roll into the single tax invoice before the
  // money moves.
  remainingRooms: { roomNumber: string; occupantName: string | null }[];
  // Rooms that already have their own invoice (and won't be re-billed).
  // Listed in the confirm step so staff isn't surprised by their absence.
  alreadyInvoicedRooms: { roomNumber: string; invoiceNumber: string }[];
  // Additional charges (late fees, extras) on this reservation, so the
  // checkout summary itemises them instead of burying them in "Subtotal".
  additionalCharges: { description: string; amount: number }[];
  // When the stay is overdue, surface a late-fee field in this modal so the
  // fee is applied AT checkout (not saved via a separate Add Charge press).
  overdueLabel?: string | null;
  suggestedLateFee?: number;
  onClose: () => void;
  onDone: () => void;
}) {
  // Intra-state GST split (same rule used everywhere else in the app).
  const cgst = +(props.totalGst / 2).toFixed(2);
  const sgst = +(props.totalGst - cgst).toFixed(2);
  // Default to ONE combined invoice — the stay's single tax document.
  // Per-room bills print from it as reference copies. Staff can flip to
  // separate per-room tax invoices in the rare case a guest needs a
  // standalone GST invoice with its own number.
  const [combineIntoOne, setCombineIntoOne] = useState(true);
  // Second-gate confirmation for the combined path. Set when the user
  // hits Complete Check-out while invoiceMode === "combined" and there
  // are ≥2 rooms about to roll into one invoice. They must explicitly
  // accept before the API call goes out.
  // Pull the guest's previous unpaid balances so we can offer to collect
  // them in the same visit. Two streams:
  //  - `invoices`        : balances on already-issued invoices
  //  - `preInvoiceReservations`: balances on active reservations that
  //    haven't been checked out yet (no invoice issued)
  // We strip out anything tied to the CURRENT reservation since its bill
  // goes through the /check-out route itself.
  const outstandingQ = useQuery({
    queryKey: ["guest-outstanding", props.guestId],
    queryFn: () =>
      api.get<{
        total: number;
        invoices: {
          invoiceId: string;
          invoiceNumber: string;
          reservationId: string;
          reservationNumber: string;
          balanceDue: number;
          issuedAt: string;
        }[];
        preInvoiceReservations: {
          reservationId: string;
          reservationNumber: string;
          balanceDue: number;
          createdAt: string;
        }[];
      }>(`/guests/${props.guestId}/outstanding`),
    staleTime: 30_000,
  });
  // Unified list. Each item carries enough info for the POST to know
  // which endpoint to hit: invoiceId is set when it's a real invoice,
  // null when it's a pre-invoice reservation. Both go through
  // POST /reservations/:reservationId/payments which handles both cases.
  type PreviousItem = {
    kind: "invoice" | "pre_invoice";
    label: string; // "SLDT-INV-0007" or "SLDT-RES-0014 (no invoice yet)"
    reservationId: string;
    reservationNumber: string;
    invoiceId: string | null;
    invoiceNumber: string | null;
    balanceDue: number;
    sortKey: string; // for FIFO oldest-first
  };
  const previousItems: PreviousItem[] = [
    ...(outstandingQ.data?.invoices ?? []).map<PreviousItem>((i) => ({
      kind: "invoice",
      label: i.invoiceNumber,
      reservationId: i.reservationId,
      reservationNumber: i.reservationNumber,
      invoiceId: i.invoiceId,
      invoiceNumber: i.invoiceNumber,
      balanceDue: i.balanceDue,
      sortKey: i.issuedAt,
    })),
    ...(outstandingQ.data?.preInvoiceReservations ?? []).map<PreviousItem>((r) => ({
      kind: "pre_invoice",
      label: r.reservationNumber,
      reservationId: r.reservationId,
      reservationNumber: r.reservationNumber,
      invoiceId: null,
      invoiceNumber: null,
      balanceDue: r.balanceDue,
      sortKey: r.createdAt,
    })),
  ]
    .filter((i) => i.reservationId !== props.reservationId)
    .sort((a, b) => a.sortKey.localeCompare(b.sortKey));
  const previousTotal = +previousItems.reduce((s, i) => s + i.balanceDue, 0).toFixed(2);
  const hasPrevious = previousTotal > 0.009;

  const [collectPrevious, setCollectPrevious] = useState(false);
  const previousToCollect = hasPrevious && collectPrevious ? previousTotal : 0;
  // Optional late-checkout fee, entered HERE and applied only when the staff
  // completes check-out — not saved on a separate button press.
  const [lateFee, setLateFee] = useState<number>(props.suggestedLateFee ?? 0);
  const lateFeeAmount = +Math.max(0, lateFee || 0).toFixed(2);
  const suggestedTotal = +(
    Math.max(0, props.balance) + previousToCollect + lateFeeAmount
  ).toFixed(2);

  // Guest wallet balance — drives the "Wallet credit" Method option. Loaded
  // once when the modal mounts; the parent reservation's apply-wallet-credit
  // preview endpoint already returns walletBalance for us.
  const walletQ = useQuery({
    queryKey: ["wallet-credit-preview", props.reservationId],
    queryFn: () =>
      api.get<{
        walletBalance: number;
        maxRedeemable: number;
      }>(`/reservations/${props.reservationId}/wallet-credit-preview`),
    staleTime: 0,
  });
  const walletBalance = walletQ.data?.walletBalance ?? 0;

  const [finalAmount, setFinalAmount] = useState(suggestedTotal);
  const [method, setMethod] = useState<
    "cash" | "card" | "upi" | "bank_transfer" | "unpaid" | "wallet"
  >("cash");
  const [paymentNotes, setPaymentNotes] = useState("");
  // Deliberately no preselection — refunding as wallet credit vs cash is
  // the staff's call, never a silent default. If a refund turns out to be
  // due and nothing is picked, the API rejects with REFUND_MODE_REQUIRED
  // and the error surfaces in this modal.
  const [refundMode, setRefundMode] = useState<"cash" | "credit" | "">("");
  const [refundNote, setRefundNote] = useState("");
  const [err, setErr] = useState<string | null>(null);

  // Keep the Final Payment auto-suggestion in sync with the checkbox until
  // the staff manually edits it. We detect "manual edit" by whether the
  // amount differs from the last suggested value.
  const [userEdited, setUserEdited] = useState(false);
  useEffect(() => {
    if (!userEdited) setFinalAmount(suggestedTotal);
  }, [suggestedTotal, userEdited]);

  const isUnpaid = method === "unpaid";
  const isWallet = method === "wallet";
  const balanceRemaining = props.balance > 0.009;
  const mightOverpay = props.balance <= 0.009 && !hasPrevious;
  // Guest already paid more than the (possibly recomputed-downward) bill —
  // e.g. paid for a pricier room, then swapped to a cheaper one. balanceDue
  // is clamped at 0 so it hides this; detect it from paid vs. grand total.
  const alreadyOverpaid = +(props.totalPaid - props.grandTotal).toFixed(2);
  const hasOverpayment = alreadyOverpaid > 0.009;
  // The current bill's collectable target INCLUDES the pending late fee —
  // that fee is added to this reservation just before checkout, so the final
  // payment must be allowed to cover it. Without this, appliedToCurrent
  // clamps to the pre-fee balance and the late fee is billed but never
  // collected (invoice left PARTIAL).
  const currentBillTarget = Math.max(0, props.balance + lateFeeAmount);
  // Wallet redemption is capped at the current bill's remaining balance —
  // the API enforces the same rule, but reflecting it in the UI keeps the
  // amount field truthful. Wallet does NOT cover previous-balance items.
  const walletRedeemCap = Math.min(currentBillTarget, walletBalance);
  useEffect(() => {
    if (isWallet) {
      setFinalAmount(+walletRedeemCap.toFixed(2));
      setUserEdited(true);
    }
  }, [isWallet, walletRedeemCap]);

  // Split the entered amount between current and previous bills.
  // Rule (decided with the user): apply to CURRENT first, then FIFO oldest
  // previous invoices.
  const appliedToCurrent = Math.min(finalAmount, currentBillTarget);
  const remainderForPrevious = Math.max(0, +(finalAmount - appliedToCurrent).toFixed(2));

  // Disable submit if:
  //  - This bill has a balance AND no amount entered.
  //  - This bill has a balance AND method is "unpaid" but no reason note.
  //  - Staff turned on "Collect previous" but picked the unpaid method —
  //    a previous payment can't be recorded as unpaid; that money is
  //    real cash coming in. Surfaced as an inline warning below.
  //  - Wallet method but amount exceeds the wallet balance.
  const collectingPreviousWithUnpaid =
    hasPrevious && collectPrevious && isUnpaid && remainderForPrevious > 0.009;
  const submitDisabled =
    (balanceRemaining && (finalAmount <= 0.009 || (isUnpaid && paymentNotes.trim() === ""))) ||
    collectingPreviousWithUnpaid ||
    (isWallet && finalAmount > walletBalance + 0.009);

  // One key per modal mount. Every call below derives from it, so retrying
  // a checkout that failed partway replays the steps that already landed
  // instead of repeating them. Minting keys inside mutationFn (as this used
  // to) defeated the server's idempotency entirely: the late-fee POST is
  // step 1 of a multi-step mutation whose later steps can legitimately fail
  // (e.g. REFUND_MODE_REQUIRED), and the modal stays open with the button
  // re-enabled — so pressing it again billed the fee a second time.
  const idempotencyKey = useMemo(() => newIdempotencyKey(), []);

  const act = useMutation({
    mutationFn: async () => {
      // If the staff entered a late-checkout fee, add it as a charge FIRST
      // (so it lands on the invoice), then proceed with checkout. This is
      // why the fee applies "at check-out", not on a separate button press.
      if (lateFeeAmount > 0.009) {
        await api.post(
          `/reservations/${props.reservationId}/charges`,
          {
            description: props.overdueLabel
              ? `Late checkout fee (${props.overdueLabel})`
              : "Late checkout fee",
            // The charges endpoint bills quantity × rate — send them, not
            // `amount` (which the schema doesn't accept → "Rate must be a
            // number").
            quantity: 1,
            rate: lateFeeAmount,
            gstRate: 0,
          },
          { idempotencyKey: `${idempotencyKey}-latefee` },
        );
      }

      // Wallet method: redeem first via the dedicated endpoint, then close
      // the stay with a zero-cash payment. The server reduces the
      // reservation balance inside apply-wallet-credit so the subsequent
      // /check-out sees the right amount due.
      // Default to ONE combined invoice (the stay's single tax document;
      // per-room bills print from it). Staff can switch to separate
      // per-room tax invoices for the rare standalone-invoice case.
      const invoiceMode =
        props.remainingRoomCount > 1 && !combineIntoOne ? "per_room" : "combined";

      if (isWallet) {
        if (finalAmount > 0.009) {
          await api.post(
            `/reservations/${props.reservationId}/apply-wallet-credit`,
            { amount: finalAmount },
            { idempotencyKey: `${idempotencyKey}-wallet` },
          );
        }
        const body: Record<string, unknown> = { invoiceMode };
        if (refundMode) body.refundMode = refundMode;
        if (refundNote.trim()) body.refundNote = refundNote.trim();
        await api.post(`/reservations/${props.reservationId}/check-out`, body);
        return;
      }

      // Step 1: check this reservation out. Only the portion that lands
      // against the current bill goes through here.
      const body: Record<string, unknown> = { invoiceMode };
      if (balanceRemaining && appliedToCurrent > 0) {
        body.finalPayment = appliedToCurrent;
        body.paymentMethod = method;
        if (isUnpaid) body.paymentNotes = paymentNotes;
      }
      if (refundMode) body.refundMode = refundMode;
      if (refundNote.trim()) body.refundNote = refundNote.trim();
      await api.post(`/reservations/${props.reservationId}/check-out`, body);

      // Step 2: FIFO-distribute any remainder across the previous unpaid
      // items (real invoices + pre-invoice reservations). Both types are
      // posted through POST /reservations/:resId/payments — the server
      // attaches to the invoice if one exists, otherwise it bumps the
      // reservation's advancePaid. Each post gets its own idempotency
      // key so retries don't double-record.
      if (remainderForPrevious > 0.009 && !isUnpaid) {
        let left = remainderForPrevious;
        for (const item of previousItems) {
          if (left <= 0.009) break;
          const slice = Math.min(left, item.balanceDue);
          await api.post(
            `/reservations/${item.reservationId}/payments`,
            {
              amount: slice,
              paymentMethod: method,
              // Human-readable marker. Server scans the notes for this
              // prefix when rendering the companion-footer block on the
              // source reservation's invoice/receipt PDFs. See
              // collectCompanionCollections in routes/invoices.ts.
              notes: `Collected at check-out of ${props.reservationNumber}`,
            },
            // Keyed by the target reservation: unique per previous bill (each
            // needs its own payment row), and stable across retries so a
            // failure partway through the loop replays the slices already
            // collected instead of taking the money twice.
            { idempotencyKey: `${idempotencyKey}-prev-${item.reservationId}` },
          );
          left = +(left - slice).toFixed(2);
        }
      }
    },
    onSuccess: props.onDone,
    onError: (e: Error) => setErr(e.message),
  });

  // Compact "nothing to collect" branch: balance is fully paid AND no
  // previous unpaid bookings. Skip the payment/method form entirely — the
  // only meaningful action is to close the stay and (rarely) handle an
  // overpay refund if charges were recomputed downward at check-out.
  const fullyPaidAlready = !balanceRemaining && !hasPrevious;

  if (fullyPaidAlready) {
    return (
      <ModalShell title="Check Out & Generate Invoice" onClose={props.onClose}>
        <div className="space-y-4">
          {hasOverpayment ? (
            <div className="rounded-sm border-2 border-warning/40 bg-warning/5 p-4 flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-warning mt-0.5 shrink-0" />
              <div>
                <div className="font-semibold text-warning">
                  Guest overpaid ₹{alreadyOverpaid.toFixed(2)}
                </div>
                <div className="text-sm text-textPrimary mt-1">
                  Paid ₹{props.totalPaid.toFixed(2)} against a ₹{props.grandTotal.toFixed(2)}{" "}
                  bill. Choose how to return the difference before completing check-out.
                </div>
              </div>
            </div>
          ) : (
            <div className="rounded-sm border-2 border-success/40 bg-success/5 p-4 flex items-start gap-3">
              <CheckCircle2 className="w-5 h-5 text-success mt-0.5 shrink-0" />
              <div>
                <div className="font-semibold text-success">Bill fully paid</div>
                <div className="text-sm text-textPrimary mt-1">
                  Nothing to collect. Closing the stay will{" "}
                  {props.remainingRoomCount > 1 && !combineIntoOne
                    ? `issue ${props.remainingRoomCount} per-room invoices`
                    : "generate the final invoice"}
                  , release the room
                  {props.remainingRoomCount > 1 ? "s" : ""}, and complete check-out.
                </div>
              </div>
            </div>
          )}

          {/* Refund method — explicit choice, never pre-selected. */}
          {hasOverpayment && (
            <div>
              <div className="label mb-1">Refund ₹{alreadyOverpaid.toFixed(2)} via</div>
              <div className="grid grid-cols-2 gap-2">
                {([
                  { v: "cash", label: "Cash" },
                  { v: "credit", label: "Wallet credit" },
                ] as const).map((opt) => (
                  <button
                    key={opt.v}
                    type="button"
                    onClick={() => setRefundMode(opt.v)}
                    className={`border rounded-sm px-3 py-2 text-sm transition-colors ${
                      refundMode === opt.v
                        ? "border-brand bg-brand-soft text-brand-dark font-semibold"
                        : "border-borderc hover:border-brand/40"
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              {refundMode && (
                <div className="text-xs text-textSecondary mt-1">
                  {refundMode === "credit"
                    ? `₹${alreadyOverpaid.toFixed(2)} will be added to the guest's wallet.`
                    : `₹${alreadyOverpaid.toFixed(2)} will be handed back in cash.`}
                </div>
              )}
              <input
                className="input mt-2"
                placeholder="Refund note (optional)"
                value={refundNote}
                onChange={(e) => setRefundNote(e.target.value)}
              />
            </div>
          )}

          {props.remainingRoomCount > 1 && <InvoiceModeToggle value={combineIntoOne} onChange={setCombineIntoOne} count={props.remainingRoomCount} />}

          {err && <div className="text-danger text-sm">{err}</div>}
          <div className="flex justify-end gap-2">
            <button className="btn-secondary" onClick={props.onClose}>
              Cancel
            </button>
            <button
              className="btn-primary"
              onClick={() => act.mutate()}
              disabled={act.isPending || (hasOverpayment && !refundMode)}
            >
              {act.isPending
                ? "Processing…"
                : hasOverpayment
                  ? `Refund & Complete Check-out`
                  : "Complete Check-out"}
            </button>
          </div>
        </div>
      </ModalShell>
    );
  }

  return (
    <ModalShell title="Check Out & Generate Invoice" onClose={props.onClose}>
      <div className="space-y-3">
        <div className="text-sm">
          Confirming will generate the final tax invoice for this stay, record the payment, and
          release every room on this reservation.
        </div>

        {/* Late-checkout fee — entered HERE and applied ONLY when Complete
            Check-out is pressed. Nothing is saved while you type. */}
        {(props.overdueLabel || lateFeeAmount > 0) && (
          <div className="rounded-sm border border-warning/40 bg-warning/5 p-3 space-y-1.5">
            <div className="text-xs font-semibold uppercase tracking-wide text-warning">
              Late-checkout fee (optional)
            </div>
            {props.overdueLabel && (
              <div className="text-xs text-textSecondary">
                Stay is overdue ({props.overdueLabel}). Enter a late fee to add
                to this bill, or leave blank to skip. It is applied only when
                you press Complete Check-out.
              </div>
            )}
            <input
              className="input"
              type="number"
              min={0}
              placeholder="0"
              value={lateFee === 0 ? "" : lateFee}
              onChange={(e) => {
                const v = e.target.value;
                setLateFee(v === "" ? 0 : Math.max(0, Number(v)));
                setUserEdited(false);
              }}
            />
          </div>
        )}

        <div className="border border-borderc rounded p-3 space-y-1 bg-bg/40">
          {(() => {
            const chargesTotal = props.additionalCharges.reduce(
              (s, c) => s + c.amount,
              0,
            );
            const roomPortion = +(props.subtotal - chargesTotal).toFixed(2);
            // Only itemise when there ARE additional charges; otherwise keep
            // the single combined subtotal line as before.
            if (props.additionalCharges.length === 0) {
              return (
                <div className="flex justify-between text-sm">
                  <span className="text-textSecondary">
                    Subtotal (room charges, pre-GST)
                  </span>
                  <span className="font-mono">{inr(props.subtotal)}</span>
                </div>
              );
            }
            return (
              <>
                <div className="flex justify-between text-sm">
                  <span className="text-textSecondary">Room charges (pre-GST)</span>
                  <span className="font-mono">{inr(roomPortion)}</span>
                </div>
                {props.additionalCharges.map((c, i) => (
                  <div key={i} className="flex justify-between text-sm">
                    <span className="text-textSecondary pl-3">· {c.description}</span>
                    <span className="font-mono">{inr(c.amount)}</span>
                  </div>
                ))}
                <div className="flex justify-between text-sm border-t border-borderc/60 pt-1 mt-1">
                  <span className="text-textSecondary">Subtotal (pre-GST)</span>
                  <span className="font-mono">{inr(props.subtotal)}</span>
                </div>
              </>
            );
          })()}
          <div className="flex justify-between text-sm">
            <span className="text-textSecondary">CGST (Central GST, half of total tax)</span>
            <span className="font-mono">{inr(cgst)}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-textSecondary">SGST (State GST, half of total tax)</span>
            <span className="font-mono">{inr(sgst)}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-textSecondary">Total GST</span>
            <span className="font-mono">{inr(props.totalGst)}</span>
          </div>
          {lateFeeAmount > 0.009 && (
            <div className="flex justify-between text-sm text-warning">
              <span>+ Late checkout fee (this checkout)</span>
              <span className="font-mono">{inr(lateFeeAmount)}</span>
            </div>
          )}
          <div className="flex justify-between text-sm border-t border-borderc pt-2 mt-2">
            <span className="text-textSecondary">Grand Total (bill for this stay)</span>
            <span className="font-mono">{inr(props.grandTotal + lateFeeAmount)}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-textSecondary">Already paid</span>
            <span className="font-mono">− {inr(props.totalPaid)}</span>
          </div>
          <div className="flex justify-between border-t border-borderc pt-2 mt-2">
            <strong>Balance before final payment</strong>
            <strong className="font-mono">{inr(props.balance + lateFeeAmount)}</strong>
          </div>
        </div>

        {props.remainingRoomCount > 1 && (
          <InvoiceModeToggle
            value={combineIntoOne}
            onChange={setCombineIntoOne}
            count={props.remainingRoomCount}
          />
        )}

        {hasPrevious && (
          <div className="rounded-sm border-2 border-danger/40 bg-danger/5 p-3 space-y-2">
            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="checkbox"
                className="mt-0.5 accent-danger"
                checked={collectPrevious}
                onChange={(e) => {
                  setCollectPrevious(e.target.checked);
                  setUserEdited(false);
                }}
              />
              <div className="min-w-0 flex-1 text-sm">
                <div className="font-bold text-danger uppercase tracking-wider text-xs">
                  Previous unpaid balance
                </div>
                <div className="text-textPrimary mt-0.5">
                  Guest also owes{" "}
                  <span className="font-mono font-bold text-danger">{inr(previousTotal)}</span>{" "}
                  from {previousItems.length === 1
                    ? "1 previous booking"
                    : `${previousItems.length} previous bookings`}
                  . Collect along with this checkout?
                </div>
                <ul className="text-xs text-textSecondary mt-1 space-y-0.5">
                  {previousItems.map((it) => (
                    <li
                      key={`${it.kind}-${it.invoiceId ?? it.reservationId}`}
                      className="font-mono"
                    >
                      {it.invoiceNumber ?? it.reservationNumber}
                      {it.invoiceNumber && ` (${it.reservationNumber})`}
                      {it.kind === "pre_invoice" && (
                        <span className="text-textSecondary italic ml-1">
                          · advance (not invoiced yet)
                        </span>
                      )}
                      {" · "}
                      <span className="text-danger">{inr(it.balanceDue)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </label>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label block mb-1">
              Final Payment {balanceRemaining && <span className="text-danger">*</span>}
            </label>
            <input
              className="input"
              type="number"
              min={0}
              step="0.01"
              value={finalAmount || ""}
              placeholder={balanceRemaining ? String(suggestedTotal) : "0"}
              onChange={(e) => {
                setFinalAmount(Number(e.target.value));
                setUserEdited(true);
              }}
              disabled={(!balanceRemaining && !hasPrevious) || isWallet}
            />
            {hasPrevious && collectPrevious && finalAmount > 0.009 && !isWallet && (
              <div className="text-[11px] text-textSecondary mt-1 leading-tight">
                Apply: <span className="font-mono">{inr(appliedToCurrent)}</span> to this bill
                {remainderForPrevious > 0.009 && (
                  <>
                    {" + "}
                    <span className="font-mono text-danger">{inr(remainderForPrevious)}</span> to
                    previous
                  </>
                )}
              </div>
            )}
          </div>
          <div>
            <label className="label block mb-1">Method</label>
            <select
              className="input"
              value={method}
              onChange={(e) => setMethod(e.target.value as typeof method)}
              disabled={!balanceRemaining && !hasPrevious}
            >
              <option value="cash">Cash</option>
              <option value="upi">UPI</option>
              <option value="card">Card</option>
              <option value="bank_transfer">Bank Transfer</option>
              <option value="unpaid">Unpaid · Collect later</option>
              <option value="wallet" disabled={walletBalance <= 0.009 || !balanceRemaining}>
                Wallet credit · available {inr(walletBalance)}
              </option>
            </select>
            {isWallet && (
              <div className="text-[11px] text-textSecondary mt-1 leading-tight">
                Redeems from the guest's wallet only. Covers up to{" "}
                <span className="font-mono">{inr(walletRedeemCap)}</span> of this bill.
                {hasPrevious && (
                  <> Previous-balance items aren't collected with this method.</>
                )}
              </div>
            )}
          </div>
        </div>
        {collectingPreviousWithUnpaid && (
          <div className="rounded-sm border border-danger/40 bg-danger/5 p-3 text-xs text-danger">
            Can't record an "unpaid" method while collecting previous balance. Pick Cash / UPI /
            Card / Bank Transfer, or uncheck "Collect previous balance".
          </div>
        )}
        {isUnpaid && (
          <div className="rounded-sm border border-warning/40 bg-warning/5 p-3 space-y-2">
            <div className="text-xs text-warning font-semibold uppercase tracking-wider">
              Unpaid checkout
            </div>
            <div className="text-xs text-textSecondary">
              Invoice will be issued as unpaid. Mark it received from the guest profile or the
              reservation page when the guest pays.
            </div>
            <div>
              <label className="label block mb-1">
                Reason / notes <span className="text-danger">*</span>
              </label>
              <input
                className="input"
                value={paymentNotes}
                onChange={(e) => setPaymentNotes(e.target.value)}
                placeholder="e.g. trusted regular, will pay next visit"
              />
            </div>
          </div>
        )}
        {mightOverpay && (
          <div className="rounded-sm border border-accentBlue/30 bg-accentBlue/5 p-3 space-y-2">
            <div className="text-xs text-accentBlue font-semibold uppercase tracking-wider">
              If guest overpaid (e.g. early check-out)
            </div>
            <div className="text-xs text-textSecondary">
              Charges are recomputed at check-out. If the guest paid more than the actual bill, choose
              how to handle the refund.
            </div>
            <div className="grid grid-cols-2 gap-2">
              <label className={`flex items-center gap-2 px-3 py-2 rounded-sm border cursor-pointer ${refundMode === "credit" ? "border-brand bg-brand/5" : "border-borderc"}`}>
                <input
                  type="radio"
                  name="refundMode"
                  checked={refundMode === "credit"}
                  onChange={() => setRefundMode("credit")}
                  className="accent-brand"
                />
                <div className="text-sm">
                  <div className="font-medium">Wallet credit</div>
                  <div className="text-[11px] text-textSecondary">Saved against guest, no expiry</div>
                </div>
              </label>
              <label className={`flex items-center gap-2 px-3 py-2 rounded-sm border cursor-pointer ${refundMode === "cash" ? "border-brand bg-brand/5" : "border-borderc"}`}>
                <input
                  type="radio"
                  name="refundMode"
                  checked={refundMode === "cash"}
                  onChange={() => setRefundMode("cash")}
                  className="accent-brand"
                />
                <div className="text-sm">
                  <div className="font-medium">Cash refund</div>
                  <div className="text-[11px] text-textSecondary">Paid out from cash drawer</div>
                </div>
              </label>
            </div>
            <input
              className="input"
              value={refundNote}
              onChange={(e) => setRefundNote(e.target.value)}
              placeholder="Refund note (optional)"
            />
          </div>
        )}
        {err && <div className="text-danger text-sm">{err}</div>}
        <div className="flex justify-end gap-2">
          <button className="btn-secondary" onClick={props.onClose}>Cancel</button>
          <button
            className="btn-primary"
            onClick={() => act.mutate()}
            disabled={act.isPending || submitDisabled}
          >
            {act.isPending ? "Processing…" : "Complete Check-out"}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

function formatTime(hhmm: string): string {
  if (!hhmm) return "";
  const [hStr, mStr] = hhmm.split(":");
  const h = Number(hStr);
  const m = mStr ?? "00";
  const period = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${m.padStart(2, "0")} ${period}`;
}

// Mark an existing booking as complimentary. Reason is required; approver
// is optional. Pure reclassification — no invoice voiding, no payment
// changes. The booking is REMOVED from every revenue surface (Dashboard /
// Revenue / GST / Collections / Room Performance / Reservations list)
// and appears ONLY in the Complimentary report. The guest's URL still
// resolves so the stay history isn't lost.
function MakeCompModal(props: {
  reservationNumber: string;
  grandTotal: string;
  totalPaid: string;
  onClose: () => void;
  onSubmit: (vars: { reason: string; approver?: string }) => void;
  pending: boolean;
}) {
  const [reason, setReason] = useState("");
  const [approver, setApprover] = useState("");
  return (
    <ModalShell title="Make Complimentary" onClose={props.onClose}>
      <div className="space-y-3 text-sm">
        <div className="rounded-sm border border-warning/40 bg-warning/5 p-3 text-xs text-textPrimary leading-snug">
          <div className="font-bold text-warning uppercase tracking-wider text-[10px] mb-1">
            What this does
          </div>
          Moves <strong>{props.reservationNumber}</strong> out of every revenue view -
          Dashboard, Revenue report, GST, Collections, Room Performance, and the main
          Reservations list. It only appears in <strong>Reports → Complimentary</strong>{" "}
          from then on (value <span className="font-mono">{inr(props.grandTotal)}</span>,
          already collected <span className="font-mono">{inr(props.totalPaid)}</span>).
          <div className="mt-2 text-textSecondary">
            No invoices are voided. No payments are touched. The guest's stay history
            still shows the stay. The reservation URL still opens directly.
          </div>
        </div>
        <div>
          <label className="label block mb-1">
            Reason <span className="text-danger">*</span>
          </label>
          <textarea
            className="input !h-auto !py-2 leading-snug resize-y min-h-[64px]"
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Owner comp · VIP guest · Compensation for AC failure"
            autoFocus
          />
        </div>
        <div>
          <label className="label block mb-1">Approved by (optional)</label>
          <input
            className="input"
            value={approver}
            onChange={(e) => setApprover(e.target.value)}
            placeholder="Owner name, manager on duty, etc."
          />
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <button className="btn-secondary" onClick={props.onClose} disabled={props.pending}>
            Cancel
          </button>
          <button
            className="btn-primary"
            disabled={props.pending || !reason.trim()}
            onClick={() =>
              props.onSubmit({
                reason: reason.trim(),
                approver: approver.trim() || undefined,
              })
            }
          >
            {props.pending ? "Saving…" : "Mark as Complimentary"}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

// Shared inline banner shown at the top of mutation modals (Add Room,
// Extend Stay, Add Charge) when the reservation is past its effective
// check-out time. The user can still proceed — staff might be adding
// a last-minute incidental or extending a guest who's been chatting at
// the desk — but they're warned so they consider Late Checkout first.
function OverdueWarning({ minutesOverdue }: { minutesOverdue: number }) {
  if (minutesOverdue <= 0) return null;
  const h = Math.floor(minutesOverdue / 60);
  const m = minutesOverdue % 60;
  const lateText =
    h > 0 ? `${h}h ${m}m` : `${m} min`;
  return (
    <div className="rounded-sm border border-warning/40 bg-warning/10 text-warning text-xs px-3 py-2 flex items-start gap-2">
      <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
      <div>
        <strong>{lateText} past check-out time.</strong> For a{" "}
        <strong>late-checkout fee</strong>, enter it on the Check Out screen
        (it's applied when you complete check-out) - this form is for other
        extras like restaurant or laundry.
      </div>
    </div>
  );
}

function ModalShell({
  title,
  onClose,
  children,
  size = "md",
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  // md (default ~512px) for narrow forms; lg for content-heavy modals
  // like Add Room with floor sections; xl for grids.
  size?: "md" | "lg" | "xl";
}) {
  const widthCls =
    size === "xl"
      ? "sm:max-w-4xl"
      : size === "lg"
        ? "sm:max-w-3xl"
        : "sm:max-w-lg";
  return (
    // Phone: a bottom sheet — backdrop, content pinned to the bottom,
    // full width, rounded top corners, slides up. sm+: the classic
    // centered card. Same markup, responsive positioning.
    <div
      className="fixed inset-0 bg-black/50 flex items-end justify-center sm:items-center z-50 sm:p-4"
      onClick={onClose}
    >
      <div
        className={`bg-surface w-full rounded-t-2xl sm:rounded-md ${widthCls} p-6 sm:p-7 pb-safe max-h-[92vh] sm:max-h-[90vh] overflow-y-auto`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Grab handle — a small affordance that this sheet drags up
            from the bottom on phone. Hidden on sm+. */}
        <div className="sm:hidden mx-auto mb-4 h-1 w-10 rounded-full bg-borderc" aria-hidden />
        <h2 className="text-lg font-semibold text-navy mb-5 pb-3 border-b border-borderc">
          {title}
        </h2>
        {children}
      </div>
    </div>
  );
}
