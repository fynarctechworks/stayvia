import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { addDays, differenceInCalendarDays, format } from "date-fns";
import { AlertTriangle, ChevronDown, ChevronLeft, FileText, Minus, Plus, ShieldCheck, Snowflake, Sparkles, Trash2, Tv, Upload, Users, Wifi, X } from "lucide-react";
import { CheckInReceiptModal, type CheckInReceiptData } from "@/components/CheckInReceiptModal";
import { OtpModal } from "@/components/OtpModal";
import { TimePicker12h } from "@/components/TimePicker12h";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Loader } from "@/components/Loader";
import { ArrowKeyGroup } from "@/components/ArrowKeyGroup";
import { Combobox } from "@/components/Combobox";
import { EmailInput } from "@/components/EmailInput";
import { useDialog } from "@/components/Dialog";
import { ApiError, api } from "@/lib/api";
import { citiesForState } from "@/lib/indianCities";
import { INDIAN_STATES, INDIAN_UNION_TERRITORIES } from "@/lib/indianStates";
import { invalidateReservationData } from "@/lib/invalidate";
import { inr } from "@/lib/utils";

function describeApiError(e: unknown): string {
  // The API's error middleware already humanizes Zod errors into a
  // user-readable summary like "ID Number is missing or too short;
  // Phone is missing". Surface that directly — no extra prefixing.
  if (e instanceof ApiError) return e.message;
  return e instanceof Error ? e.message : "Something went wrong";
}

interface Guest {
  id: string;
  fullName: string;
  phone: string;
  email: string | null;
  idProofType: string | null;
  idProofLast4: string | null;
  gstin?: string | null;
  // Signed URL to the guest's customer photo (KYC). Used by the search
  // dropdown so staff can visually confirm they're picking the right
  // person before continuing. Null when the guest has no photo on file.
  photoUrl?: string | null;
}

// A single co-guest (2nd+ occupant) capture slot. Either an existing
// guest picked via search, or a fresh new-guest form + its own KYC files.
interface CoGuestForm {
  fullName: string;
  phone: string;
  email: string;
  gender: "" | "male" | "female" | "other" | "prefer_not_to_say";
  idProofType: "aadhaar" | "pan" | "passport" | "driving_license" | "voter_id";
  idProofNumber: string;
  address: string;
  city: string;
  state: string;
  nationality: string;
  gstin: string;
}

interface CoGuestEntry {
  // Stable key so React keeps each card's inputs/focus stable across
  // add/remove without remounting siblings.
  id: string;
  useNew: boolean;
  query: string;
  selected: Guest | null;
  form: CoGuestForm;
  kycPhoto: File | null;
  kycFront: File | null;
  kycBack: File | null;
}

let coGuestSeq = 0;
function makeCoGuestEntry(): CoGuestEntry {
  coGuestSeq += 1;
  return {
    id: `cg-${coGuestSeq}`,
    useNew: false,
    query: "",
    selected: null,
    form: {
      fullName: "",
      phone: "",
      email: "",
      gender: "",
      idProofType: "aadhaar",
      idProofNumber: "",
      address: "",
      city: "",
      state: "Andhra Pradesh",
      nationality: "Indian",
      gstin: "",
    },
    kycPhoto: null,
    kycFront: null,
    kycBack: null,
  };
}

// An entry counts as "started" when staff picked an existing guest or
// typed any of the three required new-guest fields.
function isCoGuestStarted(c: CoGuestEntry): boolean {
  if (c.selected) return true;
  return (
    c.form.fullName.trim() !== "" ||
    c.form.phone.trim() !== "" ||
    c.form.idProofNumber.trim() !== ""
  );
}

interface AvailableRoom {
  id: string;
  roomNumber: string;
  floor: number;
  roomType: string;
  baseRate: string;
  maxOccupancy: number;
  hasAc: boolean;
  hasTv: boolean;
  hasWifi: boolean;
  // Housekeeping status from the rooms table. "dirty" rooms are still
  // bookable but require a one-tap "Mark clean & select" acknowledgement
  // so staff doesn't accidentally hand keys to a guest before the room
  // is ready.
  status?: "available" | "occupied" | "reserved" | "maintenance" | "dirty";
  // Same-day re-let: when this room has a future reservation that
  // starts at or after the current probe's check_out, the server
  // returns it so the UI can warn "Room reserved for [guest]
  // arriving [date]." Walk-in must vacate before then.
  nextReservation?: {
    reservationId: string;
    reservationNumber: string;
    checkInDate: string;
    checkOutDate: string;
    guestName: string;
  } | null;
  // Present only when the picker asks for conflicts (include_conflicts=1):
  // this room's dates clash with an existing booking. Rendered as a
  // disabled "Booked" card so staff see WHY it can't be picked instead
  // of the room silently missing from the list.
  conflict?: {
    reservationId: string;
    reservationNumber: string;
    guestName: string;
    bookedFrom: string;
    bookedTill: string;
  } | null;
}

const todayStr = format(new Date(), "yyyy-MM-dd");
const tomorrowStr = format(addDays(new Date(), 1), "yyyy-MM-dd");
// One day back is allowed so the front desk can log a booking they forgot
// to enter earlier in the day (end-of-day catch-up). Anything older is not.
const yesterdayStr = format(addDays(new Date(), -1), "yyyy-MM-dd");

// Combine yyyy-MM-dd + HH:mm into an ISO timestamp with the IST
// offset baked in. The server stores these in plannedCheckInAt /
// plannedCheckOutAt and the rendering surfaces (receipt, invoice,
// detail page) just format them in the same zone. Returns null when
// either side is empty so the caller can drop the field from the
// request body instead of sending an invalid value.
function combineDateAndTimeISO(date: string, time: string): string | null {
  if (!date || !time) return null;
  return `${date}T${time}:00+05:30`;
}

function normalizeIndianPhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith("0")) return digits.slice(1);
  return digits;
}

function formatTime(hhmm: string | undefined | null): string {
  if (!hhmm) return "";
  const [hStr, mStr] = hhmm.split(":");
  const h = Number(hStr);
  const m = mStr ?? "00";
  const period = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${m.padStart(2, "0")} ${period}`;
}

export default function NewReservation() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const dialog = useDialog();
  const [searchParams] = useSearchParams();
  const preselectRoomId = searchParams.get("room");
  const preselectGuestId = searchParams.get("guestId");
  const initialMode = searchParams.get("mode") === "walkin" ? "walkin" : "reservation";

  const [mode, setMode] = useState<"reservation" | "walkin">(initialMode);
  // No stay-type toggle anymore. A booking is a same-day (hourly) stay when
  // check-out date == check-in date, and a multi-day (full-day) stay
  // otherwise — derived from the dates below. The backend models same-day as
  // stayType "short_stay" (flat rate, checkout == checkin) and multi-day as
  // "overnight" (rate × nights, checkout > checkin).
  const [checkInDate, setCheckInDate] = useState(todayStr);
  const [checkOutDate, setCheckOutDate] = useState(tomorrowStr);
  // Same-day booking => hourly/day-use pricing (flat rate). Derived, not a
  // toggle: if check-out is the same calendar day as check-in it's a
  // short_stay; otherwise a multi-day overnight stay.
  const isShortStay = !!checkInDate && checkOutDate === checkInDate;
  const stayType: "overnight" | "short_stay" = isShortStay
    ? "short_stay"
    : "overnight";
  // 0023 — staff-chosen clock times. Empty string means "use property
  // policy default" (rendered on the booking summary, receipt, and
  // invoice). When set, these are sent to the server as ISO timestamps
  // and stored as plannedCheckInAt / plannedCheckOutAt. UI shows them
  // alongside the date inputs so staff can promise a specific window
  // ("4 PM arrival, 10 AM next-day departure").
  const [checkInTime, setCheckInTime] = useState("");
  const [checkOutTime, setCheckOutTime] = useState("");
  // Starts empty (0 renders as a blank field) so staff must consciously
  // enter the head count rather than accepting a pre-filled "1". The field's
  // onBlur and the API's min(1) rule still guarantee a booking can't be
  // created with 0 adults.
  const [adults, setAdults] = useState(0);
  const [children, setChildren] = useState(0);
  const [purpose, setPurpose] = useState<"business" | "leisure" | "transit" | "other">("leisure");
  const [specialRequests, setSpecialRequests] = useState("");

  const [guestQuery, setGuestQuery] = useState("");
  const [selectedGuest, setSelectedGuest] = useState<Guest | null>(null);
  const [newGuest, setNewGuest] = useState({
    fullName: "",
    phone: "",
    email: "",
    gender: "" as "" | "male" | "female" | "other" | "prefer_not_to_say",
    idProofType: "aadhaar" as "aadhaar" | "pan" | "passport" | "driving_license" | "voter_id",
    idProofNumber: "",
    address: "",
    city: "",
    state: "Andhra Pradesh",
    nationality: "Indian",
    gstin: "",
  });
  const [useNewGuest, setUseNewGuest] = useState(false);

  // Co-guests (2nd+ occupants). Required when numAdults >= 2. Each entry
  // mirrors the booker state: existing-guest search OR new-guest form,
  // plus its own KYC files. The list auto-grows to (adults - 1) but staff
  // can also Add/Remove cards manually for groups of any size.
  const [coGuests, setCoGuests] = useState<CoGuestEntry[]>([]);
  const needsCoGuest = adults >= 2;

  const updateCoGuest = (id: string, patch: Partial<CoGuestEntry>) =>
    setCoGuests((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  const addCoGuest = () => setCoGuests((prev) => [...prev, makeCoGuestEntry()]);
  const removeCoGuest = (id: string) =>
    setCoGuests((prev) => prev.filter((c) => c.id !== id));

  // Show ONE co-guest card by default once there are 2+ adults — that's
  // the second guest whose KYC is legally required. Staff add the rest
  // (for larger groups) via the "Add another guest" button, so we don't
  // flood the form with empty cards for every head in the adults count.
  // Shrinking only trims trailing EMPTY cards so typed data is never lost.
  useEffect(() => {
    const minCards = adults >= 2 ? 1 : 0;
    setCoGuests((prev) => {
      if (prev.length >= minCards) return prev;
      const next = prev.slice();
      while (next.length < minCards) next.push(makeCoGuestEntry());
      return next;
    });
  }, [adults]);

  const [selectedRooms, setSelectedRooms] = useState<
    {
      roomId: string;
      ratePerNight: number;
      roomNumber: string;
      soldAsType: string | null;
      nativeType: string;
      // Base capacity of the physical room (room.maxOccupancy), captured
      // at selection so the capacity gate doesn't need the availability
      // list to recompute.
      maxOccupancy: number;
      // Extra beds (additional persons) staff added to this room. Each
      // raises effective capacity by 1 and adds extraBedRate/night.
      extraBeds: number;
      // Per-bed, per-night fee for this room, read from its (sold-as or
      // native) room type's extraPersonRate. 0 → extra beds not offered.
      extraBedRate: number;
      // Original native base rate captured when the room was first
      // picked. Used to revert the price when staff switches "Sell as"
      // back to the native option.
      nativeBaseRate: number;
      // Same-day re-let: the next reservation that's about to use this
      // room, surfaced so staff confirm they'll vacate before then.
      nextReservation?: {
        reservationId: string;
        reservationNumber: string;
        checkInDate: string;
        guestName: string;
      } | null;
    }[]
  >([]);
  // Per-room collapsed state for the selected-room controls panel. A room
  // not in the set is expanded (the default when freshly selected); adding
  // its id collapses the Sell-as / Rate / Extra-beds panel to a compact
  // summary. Selection itself is unaffected — this is purely a dropdown.
  const [collapsedRooms, setCollapsedRooms] = useState<Set<string>>(new Set());
  const toggleRoomCollapsed = (roomId: string) =>
    setCollapsedRooms((prev) => {
      const next = new Set(prev);
      if (next.has(roomId)) next.delete(roomId);
      else next.add(roomId);
      return next;
    });

  // Sticky confirmation: when one or more selected rooms have a
  // future reservation, staff has to tick a single "I'll vacate
  // before [date]" box before the create button enables.
  const [reletConfirmed, setReletConfirmed] = useState(false);
  const [kycFront, setKycFront] = useState<File | null>(null);
  const [kycBack, setKycBack] = useState<File | null>(null);
  const [kycPhoto, setKycPhoto] = useState<File | null>(null);
  const [bookingSource, setBookingSource] = useState<
    "walkin" | "phone_whatsapp" | "complimentary"
  >("walkin");
  const [creditNotes, setCreditNotes] = useState("");
  const [advance, setAdvance] = useState(0);
  const [paymentMethod, setPaymentMethod] = useState<
    "cash" | "card" | "upi" | "bank_transfer" | "cheque"
  >("cash");
  // Wallet credit the staff has chosen to apply on this booking. Capped
  // server-side at min(guest wallet balance, grand total) — we mirror the
  // cap in the UI so the user can't over-type either.
  const [walletApply, setWalletApply] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [acFilter, setAcFilter] = useState<"all" | "ac" | "non_ac">("all");
  const [walkInReceipt, setWalkInReceipt] = useState<CheckInReceiptData | null>(null);
  const [receiptVariant, setReceiptVariant] = useState<"checkin" | "booking_advance">("checkin");

  useEffect(() => {
    // Walk-in check-in is today by default, but the desk may backdate by one
    // day to log a forgotten booking. Only snap back to today if the date is
    // in the future or older than yesterday (out of the allowed range).
    if (mode === "walkin" && (checkInDate > todayStr || checkInDate < yesterdayStr)) {
      setCheckInDate(todayStr);
    }
  }, [mode, checkInDate]);

  // Short-stay is by definition same-day: keep check-out pinned to
  // check-in. For overnight we DON'T silently snap an invalid check-out
  // here — that would hide the same-date mistake. Instead the invalid
  // state stands and an inline error (see overnightDateError below) tells
  // staff to fix it, and submit is blocked. We only auto-fix check-out
  // on the mode switch INTO overnight, so the form starts in a valid
  // state rather than carrying the day-use same-date value.
  // Keep check-out from going BEFORE check-in — same-day (hourly) is now
  // allowed, but an earlier date is always invalid.
  useEffect(() => {
    if (checkOutDate < checkInDate) setCheckOutDate(checkInDate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkInDate]);

  // The only invalid date state now is check-out BEFORE check-in. Same-day
  // (== hourly stay) and later dates are both valid.
  const overnightDateError =
    checkOutDate < checkInDate
      ? "Check-out can't be before check-in."
      : null;

  // OTP verification is mandatory for every booking. The reservation row
  // is never created until OTP succeeds, so abandoning the OTP modal /
  // closing the tab / refreshing is a true no-op — no ghost rows.

  useEffect(() => {
    if (!preselectGuestId || selectedGuest) return;
    api.get<Guest>(`/guests/${preselectGuestId}`).then(setSelectedGuest).catch(() => {});
  }, [preselectGuestId, selectedGuest]);

  useEffect(() => {
    setBookingSource(mode === "walkin" ? "walkin" : "phone_whatsapp");
  }, [mode]);

  const isCreditBooking = bookingSource === "complimentary";

  const nights = useMemo(() => {
    const d = differenceInCalendarDays(new Date(checkOutDate), new Date(checkInDate));
    return Math.max(0, d);
  }, [checkInDate, checkOutDate]);

  // Same-day (hourly) stays: the duration comes from the entered check-in /
  // check-out TIMES (both required). Used as durationHours on the payload so
  // the receipt/invoice can say e.g. "Day use · 5 hours". The price itself is
  // the flat rate staff set per room — not derived from hours.
  const shortStayDurationHours = useMemo(() => {
    if (!isShortStay || !checkInTime || !checkOutTime) return 0;
    const [ih, im] = checkInTime.split(":").map(Number);
    const [oh, om] = checkOutTime.split(":").map(Number);
    const diff = (oh * 60 + om - (ih * 60 + im)) / 60;
    return diff > 0 ? +diff.toFixed(2) : 0;
  }, [isShortStay, checkInTime, checkOutTime]);

  // Pricing unit: same-day is a single flat block; multi-day uses nights.
  const canPriceStay = isShortStay ? shortStayDurationHours > 0 : nights > 0;

  // Compute the FLAT short-stay rate for a room type. Pick the band whose
  // hours ≥ the requested hours (smallest such band — "round up" to the
  // next configured price tier). Otherwise pro-rate the overnight default
  // rate over 24 h. Either way, the returned value is the price for the
  // whole short-stay block.
  // Per-night extra-bed fee for a room type slug. 0 when the type
  // doesn't offer extra beds (or isn't loaded yet).
  function extraBedRateForType(slug: string): number {
    const rt = roomTypesQ.data?.find((t) => t.slug === slug);
    return rt ? Number(rt.extraPersonRate) : 0;
  }

  const guestsSearch = useQuery({
    // Server expects `search` (see guestListQuerySchema in shared). Passing
    // `q` here silently dropped the filter and returned every guest, which
    // made the dropdown look like the typed text wasn't doing anything.
    queryKey: ["guests-search", guestQuery],
    queryFn: () => api.get<Guest[]>("/guests", { search: guestQuery }),
    enabled: guestQuery.length >= 2 && !useNewGuest,
  });

  const roomTypesQ = useQuery({
    queryKey: ["room-types-active"],
    queryFn: () =>
      api.get<
        {
          id: string;
          slug: string;
          label: string;
          defaultRate: string;
          // Per-night charge for each extra bed (person over max occupancy)
          // for this type. "0" means extra beds aren't offered.
          extraPersonRate: string;
          // Day-use bands (hours+rate) configured per room type in
          // Settings → Room Types. Empty when the property hasn't set any
          // up — we then derive a custom-hours price by pro-rating the
          // overnight default rate over 24 h.
          shortStayBands?: { label: string; hours: number; rate: number }[];
        }[]
      >("/settings/room-types"),
  });

  const publicSettings = useQuery({
    queryKey: ["settings-public"],
    queryFn: () =>
      api.get<{
        hotelName: string;
        checkInTime: string;
        checkOutTime: string;
        gstSlabExemptBelow: string;
        gstSlabLowRate: string;
        gstSlabLowMax: string;
        gstSlabHighRate: string;
        gstMode: "exclusive" | "inclusive";
        otpRequiredForCheckin: boolean;
      } | null>("/settings/public"),
  });

  // Property-wide OTP policy. Defaults to on until settings load (and for
  // rows created before the setting existed) so we never silently skip OTP.
  const otpEnabled = publicSettings.data?.otpRequiredForCheckin ?? true;

  // Wallet balance for the selected existing guest. Skipped when staff is
  // creating a new guest (no history → no credit).
  const walletQ = useQuery({
    queryKey: ["guest-wallet", selectedGuest?.id],
    queryFn: () =>
      api.get<{
        walletBalance: number;
        // Surfaces from the guest record. We use these to skip the KYC
        // upload step when the guest already has a verified record on file.
        kycVerifiedAt: string | null;
        guestPhoto: string | null;
        idProofPhotoFront: string | null;
        idProofPhotoBack: string | null;
        idProofType: string | null;
        idProofLast4: string | null;
        photoUrl: string | null;
      }>(`/guests/${selectedGuest!.id}`),
    enabled: !!selectedGuest?.id && !useNewGuest,
    staleTime: 30_000,
  });
  const walletBalance = walletQ.data?.walletBalance ?? 0;

  // KYC-on-file rule: existing guest with a verified timestamp AND both
  // a customer photo and an ID front photo. We allow KYC back to be
  // missing because it isn't strictly required for check-in (only "front"
  // is, per the walk-in guard).
  const kycOnFile = !useNewGuest
    && !!selectedGuest
    && !!walletQ.data?.kycVerifiedAt
    && !!walletQ.data?.guestPhoto
    && !!walletQ.data?.idProofPhotoFront;

  // "Did this guest forget to pay last time?" — surface unpaid balance from
  // prior bookings so the front desk can ask before creating another stay.
  // See GET /guests/:id/outstanding on the server.
  const outstandingQ = useQuery({
    queryKey: ["guest-outstanding", selectedGuest?.id],
    queryFn: () =>
      api.get<{
        total: number;
        count: number;
        pendingPromiseCount: number;
        mostRecent: {
          reservationId: string;
          reservationNumber: string;
          invoiceNumber: string | null;
          balanceDue: number;
          date: string;
        } | null;
      }>(`/guests/${selectedGuest!.id}/outstanding`),
    enabled: !!selectedGuest?.id && !useNewGuest,
    staleTime: 30_000,
  });

  // For short-stay (same-day) we still want availability — the server-side
  // availability check uses date ranges, so we pass [d, d+1) as the probe
  // window so day-use bookings exclude any room that's currently occupied
  // tonight or arriving today.
  const availRooms = useQuery({
    queryKey: ["avail", checkInDate, checkOutDate, isShortStay],
    queryFn: () =>
      api.get<AvailableRoom[]>("/rooms/availability", {
        check_in: checkInDate,
        check_out: isShortStay
          ? format(addDays(new Date(checkInDate), 1), "yyyy-MM-dd")
          : checkOutDate,
        include_conflicts: "1",
      }),
    enabled: canPriceStay,
  });

  // NOTE: no automatic short-stay re-pricing. The room rate is whatever the
  // room's base rate was on selection, and the front desk edits it manually
  // (Rate/night field) for a same-day/hourly stay. Hourly bands were removed.

  useEffect(() => {
    if (!preselectRoomId || !availRooms.data) return;
    const room = availRooms.data.find((r) => r.id === preselectRoomId);
    if (!room || room.conflict) return;
    setSelectedRooms((prev) =>
      prev.some((r) => r.roomId === room.id)
        ? prev
        : [
            ...prev,
            {
              roomId: room.id,
              ratePerNight: Number(room.baseRate),
              roomNumber: room.roomNumber,
              soldAsType: null,
              maxOccupancy: room.maxOccupancy,
              extraBeds: 0,
              extraBedRate: extraBedRateForType(room.roomType),
              nativeType: room.roomType,
              nativeBaseRate: Number(room.baseRate),
            },
          ],
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preselectRoomId, availRooms.data, roomTypesQ.data]);

  // Short-stay: ratePerNight on each selected room already holds the FLAT
  // short-stay price for the chosen block. Overnight: multiply by nights.
  // Extra beds carry a per-night, per-person fee on top. We keep the BASE
  // room amount separate (it decides the GST slab — extra-bed money must
  // not push a room into a higher slab) and add the extra-bed amount into
  // the taxable `roomAmount` at the same slab. Mirrors the server exactly
  // (apps/api/src/routes/reservations.ts).
  const billingUnits = isShortStay ? 1 : nights;
  const roomBaseAmount = selectedRooms.reduce(
    (a, r) => a + r.ratePerNight * billingUnits,
    0,
  );
  const extraBedAmount = selectedRooms.reduce(
    (a, r) => a + r.extraBeds * r.extraBedRate * billingUnits,
    0,
  );
  const roomAmount = +(roomBaseAmount + extraBedAmount).toFixed(2);
  const gstMode = publicSettings.data?.gstMode ?? "inclusive";

  // GST preview — mirrors apps/api/src/lib/gst.ts so the booking screen shows
  // the same total the server will compute. Uses the slabs from public
  // settings; falls back to the standard slabs if settings haven't loaded yet.
  const gstSlabs = {
    exemptBelow: Number(publicSettings.data?.gstSlabExemptBelow ?? 1000),
    lowRate: Number(publicSettings.data?.gstSlabLowRate ?? 5),
    lowMax: Number(publicSettings.data?.gstSlabLowMax ?? 7500),
    highRate: Number(publicSettings.data?.gstSlabHighRate ?? 18),
  };
  // For overnight: average nightly rate (roomAmount ÷ (rooms × nights)).
  // For short_stay: average per-room flat rate (roomAmount ÷ rooms). The GST
  // slab is keyed off this so room-type-aware tax still applies to day-use.
  const avgRatePerNight =
    isShortStay
      ? selectedRooms.length > 0
        ? roomBaseAmount / selectedRooms.length
        : 0
      : selectedRooms.length > 0 && nights > 0
        ? roomBaseAmount / (nights * selectedRooms.length)
        : 0;
  const gstRate =
    avgRatePerNight === 0
      ? 0
      : avgRatePerNight < gstSlabs.exemptBelow
        ? 0
        : avgRatePerNight <= gstSlabs.lowMax
          ? gstSlabs.lowRate
          : gstSlabs.highRate;
  // Mode-aware breakdown — must mirror apps/api/src/lib/gst.ts exactly.
  //   Inclusive: GST is a flat percentage of the gross amount the guest
  //     pays. ₹1000 @ 5% → GST ₹50, net ₹950 (NOT the inverse-extraction
  //     formula). The owner prefers this because the numbers stay round.
  //   Exclusive: GST is added on top of the net.
  const r = gstRate / 100;
  const gstAmount =
    gstMode === "inclusive"
      ? +(roomAmount * r).toFixed(2)
      : +(roomAmount * r).toFixed(2);
  const subtotal =
    gstMode === "inclusive"
      ? +(roomAmount - gstAmount).toFixed(2)
      : +roomAmount.toFixed(2);
  const cgst = +(gstAmount / 2).toFixed(2);
  const sgst = +(gstAmount - cgst).toFixed(2);
  const grandTotal =
    gstMode === "inclusive" ? +roomAmount.toFixed(2) : +(subtotal + gstAmount).toFixed(2);
  // Cap wallet apply at min(wallet balance, grand total). If the user typed
  // 1000 but only 600 is available, we treat it as 600.
  const maxWalletApply = +Math.min(walletBalance, grandTotal).toFixed(2);
  const effectiveWalletApply = isCreditBooking ? 0 : Math.max(0, Math.min(walletApply, maxWalletApply));
  const balanceDue = +(
    grandTotal -
    (isCreditBooking ? 0 : advance || 0) -
    effectiveWalletApply
  ).toFixed(2);
  // Hard rule, mirrored on the server: advance cannot exceed grand total.
  // Anything more would silently park money as wallet credit, which we
  // never want to happen by accident on the booking form. Surplus should
  // be a separate credit-issued ledger entry, recorded explicitly.
  const advanceTooHigh =
    !isCreditBooking && advance > 0 && advance > grandTotal + 0.009;

  // Two-phase booking submit so NOTHING is written until the moment of
  // commitment (no ghost reservations, no orphan guest rows).
  //
  //   create (Phase 1): pure validation — no DB writes at all. With OTP on
  //     it opens the modal: guestId mode for an existing guest, raw-phone
  //     mode for a new guest (whose row doesn't exist yet). With OTP off it
  //     jumps straight to Phase 2.
  //
  //   createAfterOtp (Phase 2): the commit. Creates the guest row(s) +
  //     uploads KYC (persistGuestsAndKyc), then POSTs the reservation
  //     INCLUDING the verified otpCode. Server re-verifies the OTP
  //     atomically with the insert and marks it consumed in the same
  //     transaction.

  // Modal anchors: exactly one is set while the OTP modal is up.
  const [pendingOtpGuestId, setPendingOtpGuestId] = useState<string | null>(null);
  const [pendingOtpPhone, setPendingOtpPhone] = useState<string | null>(null);

  // Guest IDs we created in THIS booking attempt (booker and/or co-guest).
  // The OTP flow forces the guest row to exist before the reservation is
  // confirmed, so if staff abandon the OTP step we must remove the rows we
  // just minted. Only freshly-created guests land here — an existing guest
  // the staff selected is never tracked, so it's never swept.
  const freshGuestIdsRef = useRef<string[]>([]);

  // Remove any guest rows we minted in the current booking attempt. Called
  // when the attempt fails or is abandoned before the reservation is
  // confirmed, so an unconfirmed booking never leaves an orphan guest on
  // file. Each cleanup is self-guarding server-side (zero stays + recently
  // created only), so it can never touch an established record; errors are
  // swallowed because this is best-effort.
  // Result cache for persistGuestsAndKyc within ONE booking attempt. If the
  // reservation POST fails after the guests were written (e.g. room got
  // taken), a retry from the OTP modal must reuse the already-created rows —
  // POSTing the same guest again would trip the duplicate-phone guard.
  const persistedRef = useRef<{ guestId: string; coGuestIds: string[] } | null>(null);

  const sweepFreshGuests = () => {
    const ids = freshGuestIdsRef.current;
    freshGuestIdsRef.current = [];
    // The cached persist result points at rows we're deleting — drop it so
    // a retry re-creates the guests instead of reusing dead IDs.
    persistedRef.current = null;
    for (const gid of ids) {
      api.post(`/guests/${gid}/abandon-cleanup`, {}).catch(() => {});
    }
  };

  // The commit-side writes: guest row(s) + KYC uploads. Runs ONLY at the
  // moment of commitment — after OTP verifies (OTP on) or at Check In /
  // Create Booking (OTP off). Anything created here is tracked in
  // freshGuestIdsRef so an attempt that fails later still gets swept.
  async function persistGuestsAndKyc(): Promise<{ guestId: string; coGuestIds: string[] }> {
    if (persistedRef.current) return persistedRef.current;

    let guestId = selectedGuest?.id;
    if (useNewGuest) {
      const g = await api.post<Guest>("/guests", {
        ...newGuest,
        phone: normalizeIndianPhone(newGuest.phone),
        email: newGuest.email || undefined,
        gstin: newGuest.gstin.trim() || undefined,
      });
      guestId = g.id;
      freshGuestIdsRef.current.push(g.id);
    }
    if (!guestId) throw new Error("Guest required");

    // Only auto-upload when we just created the guest. For existing
    // guests, the KYC pickers in this page are display-only — overwriting
    // their on-file documents on every booking would silently destroy
    // history. Use the dedicated Replace flow on the guest profile to
    // intentionally swap KYC for an existing guest.
    if (useNewGuest && (kycFront || kycPhoto || kycBack)) {
      const form = new FormData();
      if (kycFront) form.append("front", kycFront);
      if (kycBack) form.append("back", kycBack);
      if (kycPhoto) form.append("photo", kycPhoto);
      await api.upload(`/guests/${guestId}/kyc`, form);
    }

    const activeCoGuests = needsCoGuest ? coGuests : [];
    const coGuestIds: string[] = [];
    for (const c of activeCoGuests) {
      let coGuestId = c.selected?.id;
      const startedNew = c.useNew && isCoGuestStarted(c);
      if (startedNew) {
        const g2 = await api.post<Guest>("/guests", {
          ...c.form,
          phone: normalizeIndianPhone(c.form.phone),
          email: c.form.email || undefined,
          gstin: c.form.gstin.trim() || undefined,
        });
        coGuestId = g2.id;
        freshGuestIdsRef.current.push(g2.id);
        if (c.kycFront || c.kycPhoto || c.kycBack) {
          const form = new FormData();
          if (c.kycFront) form.append("front", c.kycFront);
          if (c.kycBack) form.append("back", c.kycBack);
          if (c.kycPhoto) form.append("photo", c.kycPhoto);
          await api.upload(`/guests/${coGuestId}/kyc`, form);
        }
      }
      // Skip empty cards; an empty coGuestIds array is fine server-side.
      if (!coGuestId) continue;
      if (coGuestId === guestId)
        throw new Error("The booker can't also be listed as a co-guest");
      if (coGuestIds.includes(coGuestId))
        throw new Error("The same guest is listed twice — pick a different person");
      coGuestIds.push(coGuestId);
    }

    const result = { guestId, coGuestIds };
    persistedRef.current = result;
    return result;
  }

  // Flip a dirty room straight to available so staff can re-let it
  // without leaving this page. The single-step workflow (migration
  // 0034) makes dirty→available one hop. The optimistic update bumps
  // the cached availability list immediately; the server PATCH
  // writes through and re-fetches.
  const markRoomClean = useMutation({
    mutationFn: (roomId: string) =>
      api.patch(`/rooms/${roomId}/status`, { status: "available", reason: "Re-let at booking" }),
    onSuccess: (_data, roomId) => {
      qc.setQueryData<AvailableRoom[]>(
        ["avail", checkInDate, checkOutDate, isShortStay],
        (cur) =>
          cur?.map((r) => (r.id === roomId ? { ...r, status: "available" as const } : r)) ?? cur,
      );
      qc.invalidateQueries({ queryKey: ["rooms"] });
    },
  });

  const create = useMutation({
    mutationFn: async () => {
      // Fresh attempt: reset the sweep list and the persist cache so
      // nothing from a previous abandoned attempt leaks into this one.
      freshGuestIdsRef.current = [];
      persistedRef.current = null;

      // ── Validate EVERYTHING before writing any guest row. ────────────
      // A guest POST is a real DB write that the duplicate-phone guard
      // then blocks on retry, so we must never create a guest only to
      // throw on a later check. All purely-local validation happens here,
      // up front, so the guest row is minted only once the whole booking
      // is certain to proceed to the OTP step.
      if (useNewGuest && !newGuest.gender)
        throw new Error("Gender is required for new guest");
      if (
        useNewGuest &&
        (!newGuest.nationality.trim() ||
          !newGuest.state.trim() ||
          !newGuest.city.trim() ||
          !newGuest.address.trim())
      )
        throw new Error(
          "Nationality, state, city and address are required for a new guest",
        );
      if (!useNewGuest && !selectedGuest?.id) throw new Error("Guest required");

      // Walk-in KYC guard. We bypass it when the selected existing guest
      // already has a verified record on file — re-uploading every time is
      // pure friction. Staff can still attach replacements via the optional
      // "Replace" buttons in the KYC card below.
      if (mode === "walkin" && !kycOnFile) {
        if (!kycFront)
          throw new Error("KYC front photo is required for walk-in check-in");
        if (!kycPhoto)
          throw new Error("Customer photo is required for walk-in check-in");
      }

      // Co-guest validation (no writes yet) — for every started co-guest
      // card, pre-validate its fields here so we never create the booker
      // only to choke on a malformed co-guest afterwards. A card counts as
      // "new" work only when it's in new-guest mode AND has been started.
      const activeCoGuests = needsCoGuest ? coGuests : [];
      activeCoGuests.forEach((c, i) => {
        const startedNew = c.useNew && isCoGuestStarted(c);
        if (!startedNew) return;
        const ord = i + 2; // booker is guest 1; co-guests start at 2
        if (!c.form.fullName || !c.form.phone || !c.form.idProofNumber)
          throw new Error(
            `Fill in guest ${ord}'s name, phone and ID number — or clear all three to skip`,
          );
        if (!c.form.gender)
          throw new Error(`Gender is required for guest ${ord}`);
        if (
          !c.form.nationality.trim() ||
          !c.form.state.trim() ||
          !c.form.city.trim() ||
          !c.form.address.trim()
        )
          throw new Error(
            `Nationality, state, city and address are required for guest ${ord}`,
          );
      });

      // Duplicate checks that used to happen implicitly at write time —
      // still validated up front so a bad co-guest can't fail the flow
      // after the OTP step.
      const dupCheckIds = activeCoGuests
        .map((c) => c.selected?.id)
        .filter((v): v is string => !!v);
      if (selectedGuest?.id && dupCheckIds.includes(selectedGuest.id))
        throw new Error("The booker can't also be listed as a co-guest");
      if (new Set(dupCheckIds).size !== dupCheckIds.length)
        throw new Error("The same guest is listed twice — pick a different person");

      // ── NO writes yet. The guest rows + KYC uploads happen in
      // persistGuestsAndKyc(), which runs only at the moment of commitment:
      //   OTP on  → after the code verifies (inside createAfterOtp)
      //   OTP off → when Check In / Create Booking is pressed (also inside
      //             createAfterOtp, invoked immediately below)
      // An abandoned or failed attempt therefore never leaves a guest row.
      return { existingGuestId: selectedGuest?.id ?? null };
    },
    onSuccess: ({ existingGuestId }) => {
      if (!otpEnabled) {
        // OTP disabled: commit right now (guest + KYC + reservation).
        createAfterOtp.mutate({ otpCode: null });
        return;
      }
      // OTP on: open the modal. Existing guests verify by guestId; a brand
      // new guest verifies by raw phone — their record doesn't exist yet
      // and is only written after the code checks out.
      if (existingGuestId) {
        setPendingOtpGuestId(existingGuestId);
        setPendingOtpPhone(null);
      } else {
        setPendingOtpGuestId(null);
        setPendingOtpPhone(normalizeIndianPhone(newGuest.phone));
      }
    },
    onError: (e: Error) => {
      // Phase 1 is validation-only — nothing was written, so no sweep.
      setError(describeApiError(e));
    },
  });

  const createAfterOtp = useMutation({
    // All post-create work (check-in + receipt fetch) lives INSIDE the
    // mutation so OtpModal's spinner stays up for the whole journey.
    // OtpModal awaits onVerified → mutateAsync resolves only when this
    // function returns, so the user sees "Creating reservation…" until
    // the receipt modal is ready to render.
    mutationFn: async (vars: { otpCode: string | null }) => {
      const { otpCode } = vars;

      // The commit: write the guest row(s) + KYC now that the moment of
      // commitment has arrived (OTP verified, or Check In with OTP off).
      // For a new guest the OTP was phone-anchored; the server's create
      // endpoint matches it by the guest's phone with anchors null.
      const { guestId, coGuestIds } = await persistGuestsAndKyc();

      const reservation = await api.post<{
        id: string;
        reservationNumber: string;
      }>("/reservations", {
        guestId,
        checkInDate,
        checkOutDate,
        // Staff-chosen clock times (0023). Sent only when staff filled
        // them in; omitted otherwise so the server stores NULL and
        // every surface falls back to hotel policy defaults.
        // Check-in/out times are required now — always sent.
        plannedCheckInAt:
          combineDateAndTimeISO(checkInDate, checkInTime) ?? undefined,
        plannedCheckOutAt:
          combineDateAndTimeISO(checkOutDate, checkOutTime) ?? undefined,
        // stayType is derived from the dates: same-day => short_stay (flat
        // rate, hourly), otherwise overnight. The backend requires
        // durationHours for short_stay.
        stayType,
        durationHours: isShortStay
          ? Math.max(1, Math.min(23.5, shortStayDurationHours))
          : undefined,
        shortStayLabel: isShortStay
          ? `Day use · ${shortStayDurationHours} hour${shortStayDurationHours === 1 ? "" : "s"}`
          : undefined,
        numAdults: adults,
        numChildren: children,
        specialRequests: specialRequests || undefined,
        rooms: selectedRooms.map((r) => ({
          roomId: r.roomId,
          ratePerNight: r.ratePerNight,
          soldAsType: r.soldAsType ?? undefined,
          extraBeds: r.extraBeds > 0 ? r.extraBeds : undefined,
          extraBedRate: r.extraBeds > 0 ? r.extraBedRate : undefined,
        })),
        coGuestIds: coGuestIds.length > 0 ? coGuestIds : undefined,
        advancePaid: isCreditBooking ? 0 : advance > 0 ? advance : 0,
        advancePaymentMethod: isCreditBooking ? undefined : advance > 0 ? paymentMethod : undefined,
        useWalletCredit: effectiveWalletApply > 0 ? effectiveWalletApply : undefined,
        bookingSource,
        creditNotes: isCreditBooking && creditNotes ? creditNotes : undefined,
        otpCode: otpCode ?? undefined,
        skipOtp: otpCode ? undefined : true,
      });

      const tookAdvance = !isCreditBooking && advance > 0;
      if (mode === "walkin") {
        await api.post(`/reservations/${reservation.id}/check-in`);
        setReceiptVariant("checkin");
        await buildAndShowReceipt(reservation.id);
      } else if (tookAdvance) {
        setReceiptVariant("booking_advance");
        await buildAndShowReceipt(reservation.id);
      }
      return { reservation, navigateOnly: mode !== "walkin" && !tookAdvance };
    },
    onSuccess: ({ reservation, navigateOnly }) => {
      // Booking confirmed — these guests now belong to a real reservation,
      // so drop them from the sweep list (and the server guard would refuse
      // anyway). Close the OTP modal only after all the work above resolved,
      // so the spinner doesn't blink off mid-flight.
      freshGuestIdsRef.current = [];
      persistedRef.current = null;
      setPendingOtpGuestId(null);
      setPendingOtpPhone(null);
      invalidateReservationData(qc, { reservationId: reservation.id });
      if (navigateOnly)
        navigate(`/reservations/${reservation.reservationNumber}`);
    },
    onError: (e: Error, vars) => {
      // OTP-off: no modal is open, so nobody else will sweep the guest
      // rows we just minted — do it here. OTP-on: keep the rows (and the
      // persist cache) so a retry from the still-open modal reuses them
      // instead of tripping the duplicate-phone guard; the modal's onClose
      // sweeps if staff gives up instead.
      if (vars.otpCode === null) sweepFreshGuests();
      setError(describeApiError(e));
    },
  });

  // Submit handler for the primary button. For a walk-in with OTP disabled,
  // the guest is checked in immediately without any identity code, so we ask
  // for an explicit confirmation first. Every other case submits directly
  // (pre-bookings don't check in on create; OTP-on runs the verify modal).
  async function handlePrimarySubmit() {
    if (mode === "walkin" && !otpEnabled) {
      const ok = await dialog.confirm({
        title: "Check in without OTP?",
        message:
          "OTP verification is turned off, so the guest's identity won't be confirmed with a code. Check in this guest now?",
        okLabel: "Check in",
        cancelLabel: "Cancel",
      });
      if (!ok) return;
    }
    create.mutate();
  }

  async function buildAndShowReceipt(reservationId: string) {
    try {
        const [detail, settings] = await Promise.all([
          api.get<{
            reservationNumber: string;
            checkInDate: string;
            checkOutDate: string;
            checkedInAt: string | null;
            // 0023 — staff-chosen planned arrival / departure times.
            plannedCheckInAt: string | null;
            plannedCheckOutAt: string | null;
            numNights?: number;
            stayType?: "overnight" | "short_stay";
            durationHours?: string | null;
            numAdults: number;
            numChildren: number;
            subtotal: string;
            gstRate: string;
            gstAmount: string;
            grandTotal: string;
            advancePaid: string;
            balanceDue: string;
            guest: {
              fullName: string;
              phone: string;
              gender: string | null;
              idProofType: string | null;
              idProofLast4: string | null;
              gstin: string | null;
              photoUrl: string | null;
            };
            // Migration 0020 — second-occupant block on the receipt.
            coGuests?: {
              id: string;
              position: number;
              guest: {
                fullName: string;
                phone: string;
                gender: string | null;
                idProofType: string | null;
                idProofLast4: string | null;
              };
            }[];
            rooms: {
              roomNumber: string;
              roomType: string;
              // soldAsType is the override from the "Sell as" picker at
              // booking. displayType is the pre-rendered combined label
              // ("AC SINGLE BED ROOMS booked as NON AC SINGLE BED ROOMS")
              // computed server-side. We pass them through so the receipt
              // modal shows the right label.
              soldAsType?: string | null;
              displayType?: string;
              ratePerNight: string;
              extraBeds?: number;
              extraBedRate?: string;
            }[];
            payments: {
              id: string;
              amount: string;
              paymentMethod: string;
              receiptNumber: string | null;
              paymentDate: string;
            }[];
          }>(`/reservations/${reservationId}`),
          api.get<{
            hotelName: string;
            hotelAddress: string;
            hotelPhone: string;
            ownerPhone: string | null;
            hotelGstin: string;
            hotelLogoUrl: string | null;
            checkInTime: string | null;
            checkOutTime: string | null;
          }>("/settings/public"),
        ]);

        const fallbackNights = Math.max(
          1,
          Math.round(
            (new Date(detail.checkOutDate).getTime() - new Date(detail.checkInDate).getTime()) /
              86400000,
          ),
        );

        setWalkInReceipt({
          reservationId,
          reservationNumber: detail.reservationNumber,
          bookingSource,
          checkInDate: detail.checkInDate,
          checkOutDate: detail.checkOutDate,
          checkedInAt: detail.checkedInAt,
          // 0023 — pass staff-chosen planned times so the on-screen
          // receipt reflects what was promised to the guest.
          plannedCheckInAt: detail.plannedCheckInAt ?? null,
          plannedCheckOutAt: detail.plannedCheckOutAt ?? null,
          numNights: detail.numNights ?? fallbackNights,
          stayType: detail.stayType,
          durationHours: detail.durationHours ? Number(detail.durationHours) : null,
          numAdults: detail.numAdults,
          numChildren: detail.numChildren,
          guest: {
            fullName: detail.guest.fullName,
            phone: detail.guest.phone,
            gender: detail.guest.gender,
            idProofType: detail.guest.idProofType,
            idProofLast4: detail.guest.idProofLast4,
            gstin: detail.guest.gstin,
            photoUrl: detail.guest.photoUrl,
          },
          coGuests: detail.coGuests?.map((cg) => ({
            fullName: cg.guest.fullName,
            phone: cg.guest.phone,
            gender: cg.guest.gender,
            idProofType: cg.guest.idProofType,
            idProofLast4: cg.guest.idProofLast4,
          })),
          rooms: detail.rooms.map((r) => ({
            roomNumber: r.roomNumber,
            roomType: r.roomType,
            soldAsType: r.soldAsType ?? null,
            displayType: r.displayType,
            ratePerNight: r.ratePerNight,
            extraBeds: r.extraBeds,
            extraBedRate: r.extraBedRate,
          })),
          subtotal: detail.subtotal,
          gstRate: detail.gstRate,
          gstAmount: detail.gstAmount,
          grandTotal: detail.grandTotal,
          advancePaid: detail.advancePaid,
          balanceDue: detail.balanceDue,
          latestPayment:
            detail.payments.length > 0
              ? {
                  id: detail.payments[detail.payments.length - 1]!.id,
                  amount: detail.payments[detail.payments.length - 1]!.amount,
                  paymentMethod: detail.payments[detail.payments.length - 1]!.paymentMethod,
                  receiptNumber: detail.payments[detail.payments.length - 1]!.receiptNumber,
                  paymentDate: detail.payments[detail.payments.length - 1]!.paymentDate,
                }
              : null,
          allPayments: detail.payments.map((p) => ({
            amount: p.amount,
            paymentDate: p.paymentDate,
          })),
          hotel: {
            name: settings.hotelName,
            address: settings.hotelAddress,
            phone: settings.hotelPhone,
            ownerPhone: settings.ownerPhone,
            gstin: settings.hotelGstin,
            logoUrl: settings.hotelLogoUrl ?? "/logo.jpg",
            checkInTime: settings.checkInTime,
            checkOutTime: settings.checkOutTime,
          },
        });
      } catch {
        // If receipt build fails, fall back to navigation
        navigate(`/reservations/${reservationId}`);
      }
  }

  function toggleRoom(room: AvailableRoom) {
    setSelectedRooms((prev) => {
      const exists = prev.find((r) => r.roomId === room.id);
      if (exists) {
        // Deselecting — drop any collapsed flag so a later re-select
        // opens expanded again.
        setCollapsedRooms((c) => {
          if (!c.has(room.id)) return c;
          const next = new Set(c);
          next.delete(room.id);
          return next;
        });
        return prev.filter((r) => r.roomId !== room.id);
      }
      // Initial rate is the room's base rate for BOTH stay types. For a
      // same-day (hourly) stay the front desk edits it down manually — no
      // automatic band pricing.
      const initialRate = Number(room.baseRate);
      return [
        ...prev,
        {
          roomId: room.id,
          ratePerNight: initialRate,
          roomNumber: room.roomNumber,
          soldAsType: null,
          maxOccupancy: room.maxOccupancy,
          extraBeds: 0,
          extraBedRate: extraBedRateForType(room.roomType),
          nativeType: room.roomType,
          nativeBaseRate: Number(room.baseRate),
          nextReservation: room.nextReservation ?? null,
        },
      ];
    });
  }

  // Add / remove an extra bed on a room. Capacity gate caps the total at
  // a sane ceiling (+3 over base), enforced where the stepper renders.
  function updateExtraBeds(roomId: string, beds: number) {
    setSelectedRooms((prev) =>
      prev.map((r) => (r.roomId === roomId ? { ...r, extraBeds: Math.max(0, beds) } : r)),
    );
  }

  // Per-booking override of the extra-bed rate. Seeded from the room
  // type's configured extraPersonRate but editable here so the desk can
  // negotiate the extra-bed fee for this stay.
  function updateExtraBedRate(roomId: string, rate: number) {
    setSelectedRooms((prev) =>
      prev.map((r) => (r.roomId === roomId ? { ...r, extraBedRate: Math.max(0, rate) } : r)),
    );
  }

  function updateRate(roomId: string, rate: number) {
    setSelectedRooms((prev) => prev.map((r) => (r.roomId === roomId ? { ...r, ratePerNight: rate } : r)));
  }

  function updateSoldAs(roomId: string, slug: string | null, rate: number | null) {
    setSelectedRooms((prev) =>
      prev.map((r) => {
        if (r.roomId !== roomId) return r;
        // Decide the new rate:
        //  - explicit rate from the picked sold-as type → use it
        //  - slug=null (reverting to native) → snap back to the native
        //    base rate the room was first picked at (or the native
        //    short-stay band for day-use)
        //  - otherwise leave the rate untouched
        let nextRate = r.ratePerNight;
        if (rate !== null) {
          nextRate = rate;
        } else if (slug === null) {
          // Revert to the room's native base rate (no band pricing).
          nextRate = r.nativeBaseRate;
        }
        // Extra-bed fee follows the effective (sold-as, else native) type.
        const effectiveType = slug ?? r.nativeType;
        return {
          ...r,
          soldAsType: slug,
          ratePerNight: nextRate,
          extraBedRate: extraBedRateForType(effectiveType),
        };
      }),
    );
  }

  // Rooms with a future reservation we'd be re-letting tonight.
  const reletRooms = selectedRooms.filter((r) => r.nextReservation);
  // Drop the confirmation when there's nothing to confirm anymore —
  // prevents stale state if staff removes the only re-let room.
  useEffect(() => {
    if (reletRooms.length === 0 && reletConfirmed) setReletConfirmed(false);
  }, [reletRooms.length, reletConfirmed]);

  // Occupancy gate. The selected rooms must sleep at least `adults`
  // (children don't consume a bed slot — see the capacity decision).
  // Effective capacity = Σ(base maxOccupancy) + Σ(extra beds added).
  const baseCapacity = selectedRooms.reduce((a, r) => a + (r.maxOccupancy || 0), 0);
  const extraBedCapacity = selectedRooms.reduce((a, r) => a + r.extraBeds, 0);
  const effectiveCapacity = baseCapacity + extraBedCapacity;
  const capacityShortfall = Math.max(0, adults - effectiveCapacity);
  // Only gate once rooms are picked — before that the Rooms section
  // already tells staff to select rooms.
  const capacityOk = selectedRooms.length === 0 || capacityShortfall === 0;

  const canSubmit =
    canPriceStay &&
    !overnightDateError &&
    adults >= 1 &&
    // Check-in and check-out times are now mandatory on every booking.
    !!checkInTime &&
    !!checkOutTime &&
    selectedRooms.length > 0 &&
    (selectedGuest ||
      (useNewGuest &&
        newGuest.fullName &&
        newGuest.phone &&
        newGuest.idProofNumber &&
        newGuest.nationality.trim() &&
        newGuest.state.trim() &&
        newGuest.city.trim() &&
        newGuest.address.trim())) &&
    !advanceTooHigh &&
    capacityOk &&
    (reletRooms.length === 0 || reletConfirmed);

  // Keyboard-only data entry for the front desk:
  //   Enter      → next field
  //   ArrowDown  → next field
  //   ArrowUp    → previous field
  // Arrows only move when they wouldn't eat a native interaction: inside a
  // text box the caret must already be at the end (Down) or start (Up), so
  // editing still works; dropdowns keep arrows for changing their value, and
  // textareas/buttons keep theirs entirely.
  function handleFormKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const isEnter = e.key === "Enter";
    const isDown = e.key === "ArrowDown";
    const isUp = e.key === "ArrowUp";
    if (!isEnter && !isDown && !isUp) return;

    const el = e.target as HTMLElement;
    const tag = el.tagName;
    // Let textareas insert newlines / move the caret; buttons + links keep
    // their own keys (ArrowKeyGroup handles arrows inside button groups).
    if (tag === "TEXTAREA" || tag === "BUTTON" || tag === "A") return;
    if (tag !== "INPUT" && tag !== "SELECT") return;

    if (tag === "SELECT") {
      // A dropdown owns its arrows (they change the selected option). Only
      // Enter advances, and only once it has a value — so Enter can't skip
      // an unfilled field.
      if (!isEnter) return;
      if (!(el as HTMLSelectElement).value) return;
    } else if (isDown || isUp) {
      // Text box: only jump when the caret is at the far end in the direction
      // travelled, so arrows still navigate the text being typed. Inputs like
      // date/number don't expose a caret (selectionStart is null) — those
      // jump freely, except native date inputs where arrows change the value.
      const input = el as HTMLInputElement;
      if (input.type === "date" || input.type === "time") return;
      const caret = input.selectionStart;
      const end = input.selectionEnd;
      if (caret !== null && end !== null) {
        const len = input.value.length;
        if (isDown && !(caret === len && end === len)) return;
        if (isUp && !(caret === 0 && end === 0)) return;
      }
    }
    e.preventDefault();

    // Collect the visible, enabled focusable controls in DOM order and jump
    // to the neighbour in the direction travelled.
    const root = e.currentTarget;
    const focusables = Array.from(
      root.querySelectorAll<HTMLElement>(
        'input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled])',
      ),
    ).filter((n) => n.offsetParent !== null); // skip hidden
    const idx = focusables.indexOf(el);
    if (idx < 0) return;

    if (isUp) {
      if (idx > 0) focusables[idx - 1]!.focus();
      return;
    }
    if (idx < focusables.length - 1) {
      focusables[idx + 1]!.focus();
    } else {
      el.blur();
    }
  }

  return (
    <div className="space-y-4" onKeyDown={handleFormKeyDown}>
      <div className="flex items-center gap-3 flex-wrap">
        <button onClick={() => navigate(-1)} className="btn-secondary !h-9 !px-2">
          <ChevronLeft className="w-4 h-4" />
        </button>
        <h1 className="text-2xl font-bold text-brand-dark">
          {mode === "walkin" ? "Walk-in Check-in" : "Pre-booking"}
        </h1>
        <ArrowKeyGroup className="ml-auto inline-flex rounded-sm border border-borderc overflow-hidden text-xs">
          <button
            type="button"
            onClick={() => setMode("reservation")}
            className={`px-3 py-1.5 transition ${
              mode === "reservation" ? "bg-brand text-textPrimary" : "bg-bg text-textSecondary hover:bg-borderc/40"
            }`}
          >
            Pre-booking
          </button>
          <button
            type="button"
            onClick={() => setMode("walkin")}
            className={`px-3 py-1.5 transition ${
              mode === "walkin" ? "bg-brand text-textPrimary" : "bg-bg text-textSecondary hover:bg-borderc/40"
            }`}
          >
            Walk-in
          </button>
        </ArrowKeyGroup>
      </div>

      {mode === "walkin" && (
        <div className="card bg-accentBlue/5 border-accentBlue/30 text-sm">
          <strong className="text-navy">Walk-in mode:</strong> Check-in is today. KYC documents are
          required, and the reservation will be checked in immediately.
        </div>
      )}

      <div className="card space-y-3">
        <h2 className="font-semibold text-navy">1. Stay Details</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div>
            <label className="label block mb-1">
              Check-in <span className="text-danger">*</span>
            </label>
            <input
              className="input"
              type="date"
              value={checkInDate}
              // Editable in both modes now. Allow yesterday (backdated
              // catch-up) through today for walk-in; pre-booking allows
              // yesterday and future.
              min={yesterdayStr}
              max={mode === "walkin" ? todayStr : undefined}
              onChange={(e) => {
                const next = e.target.value;
                setCheckInDate(next);
                // Keep check-out strictly after check-in (overnight). For
                // short_stay, the same-day rule snaps it via useEffect.
                if (isShortStay) {
                  setCheckOutDate(next);
                } else if (next && checkOutDate <= next) {
                  setCheckOutDate(format(addDays(new Date(next), 1), "yyyy-MM-dd"));
                }
              }}
            />
            {checkInDate < todayStr && (
              <div className="text-[11px] text-warning mt-1 flex items-start gap-1">
                <span>⚠</span>
                <span>Backdated check-in — only log this if it's a booking you forgot to enter earlier.</span>
              </div>
            )}
            {/* Check-in time is required (0023). It flows through to the
                receipt, invoice and reservation detail page. */}
            <TimePicker12h
              className="mt-1"
              value={checkInTime}
              onChange={setCheckInTime}
            />
            {!checkInTime && (
              <div className="text-[11px] text-danger mt-1">Check-in time is required</div>
            )}
            <div className="text-[11px] text-textSecondary mt-1">
              {checkInTime
                ? `Custom: ${formatTime(checkInTime)}`
                : publicSettings.data?.checkInTime
                  ? `at ${formatTime(publicSettings.data.checkInTime)} (hotel policy)`
                  : "at hotel policy"}
            </div>
          </div>
          <div>
            <label className="label block mb-1">
              Check-out <span className="text-danger">*</span>
            </label>
            <input
              className={`input ${
                overnightDateError
                  ? "border-danger focus:border-danger focus:ring-danger/30"
                  : ""
              }`}
              type="date"
              value={checkOutDate}
              // Same-day allowed (hourly stay) → min is the check-in date
              // itself, not the next day.
              min={checkInDate || todayStr}
              aria-invalid={!!overnightDateError}
              onChange={(e) => setCheckOutDate(e.target.value)}
            />
            {overnightDateError && (
              <div className="text-[11px] text-danger mt-1">{overnightDateError}</div>
            )}
            {/* Check-out time is required (0023). */}
            <TimePicker12h
              className="mt-1"
              value={checkOutTime}
              onChange={setCheckOutTime}
            />
            {!checkOutTime && (
              <div className="text-[11px] text-danger mt-1">Check-out time is required</div>
            )}
          </div>
          <div>
            <label className="label block mb-1">Adults</label>
            <input
              className="input"
              type="number"
              min={1}
              // Empty string while the field is cleared so the user can
              // type "2" without battling a sticky "0". Falls back to
              // min on blur.
              value={adults === 0 ? "" : adults}
              onChange={(e) => {
                const v = e.target.value;
                setAdults(v === "" ? 0 : Math.max(0, Number(v)));
              }}
              onBlur={() => {
                if (adults < 1) setAdults(1);
              }}
            />
          </div>
          <div>
            <label className="label block mb-1">Children</label>
            <input
              className="input"
              type="number"
              min={0}
              value={children === 0 ? "" : children}
              onChange={(e) => {
                const v = e.target.value;
                setChildren(v === "" ? 0 : Math.max(0, Number(v)));
              }}
            />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label block mb-1">Purpose</label>
            <select
              className="input"
              value={purpose}
              onChange={(e) => setPurpose(e.target.value as typeof purpose)}
            >
              <option value="leisure">Leisure</option>
              <option value="business">Business</option>
              <option value="transit">Transit</option>
              <option value="other">Other</option>
            </select>
          </div>
          <div>
            <label className="label block mb-1">Special Requests</label>
            <input
              className="input"
              value={specialRequests}
              onChange={(e) => setSpecialRequests(e.target.value)}
              placeholder="Early check-in, extra bed, etc."
            />
          </div>
        </div>
        <div className="text-sm text-textSecondary">
          {isShortStay ? (
            <>
              Same-day (hourly) stay ·{" "}
              <span className="font-semibold text-navy">
                {shortStayDurationHours > 0
                  ? `${shortStayDurationHours} hour${shortStayDurationHours === 1 ? "" : "s"}`
                  : "set check-in & check-out times"}
              </span>
            </>
          ) : (
            <>
              Nights: <span className="font-semibold text-navy">{nights}</span>
            </>
          )}
        </div>
      </div>

      <div className="card space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-navy">2. Guest</h2>
          <ArrowKeyGroup className="flex gap-2 text-xs">
            <button
              onClick={() => {
                setUseNewGuest(false);
                // Clear any KYC files staff may have attached while
                // in "New Guest" mode. Without this, those files would
                // silently upload to the *existing* guest's profile
                // and overwrite their actual photos on submit.
                setKycFront(null);
                setKycBack(null);
                setKycPhoto(null);
              }}
              className={`px-3 py-1 rounded-sm ${!useNewGuest ? "bg-navy text-white" : "bg-gray-100"}`}
            >
              Existing
            </button>
            <button
              onClick={() => {
                setUseNewGuest(true);
                setSelectedGuest(null);
                // Same reasoning in reverse — flipping back to "New"
                // shouldn't carry over a file the staffer pre-selected
                // for a then-different guest.
                setKycFront(null);
                setKycBack(null);
                setKycPhoto(null);
              }}
              className={`px-3 py-1 rounded-sm ${useNewGuest ? "bg-navy text-white" : "bg-gray-100"}`}
            >
              New Guest
            </button>
          </ArrowKeyGroup>
        </div>

        {!useNewGuest ? (
          <>
            <input
              className="input"
              placeholder="Search by phone or name (min 2 chars)"
              value={guestQuery}
              onChange={(e) => setGuestQuery(e.target.value)}
            />
            {selectedGuest && (
              <div className="bg-success/10 p-3 rounded-sm text-sm">
                Selected: <strong>{selectedGuest.fullName}</strong> ({selectedGuest.phone})
                <button
                  className="ml-3 text-xs text-danger hover:underline"
                  onClick={() => setSelectedGuest(null)}
                >
                  Clear
                </button>
                {selectedGuest.gstin && (
                  <div className="mt-1 text-xs text-textSecondary font-mono">
                    GSTIN: {selectedGuest.gstin}
                  </div>
                )}
              </div>
            )}
            {selectedGuest && outstandingQ.data && outstandingQ.data.total > 0.009 && (
              <OutstandingBanner
                data={outstandingQ.data}
                guestName={selectedGuest.fullName}
              />
            )}
            {guestsSearch.data && guestsSearch.data.length > 0 && !selectedGuest && (
              <div className="max-h-64 overflow-auto border rounded-sm">
                {guestsSearch.data.map((g) => (
                  <button
                    key={g.id}
                    className="w-full text-left px-3 py-2 hover:bg-gray-50 border-b last:border-b-0 text-sm flex items-center gap-3"
                    onClick={() => setSelectedGuest(g)}
                  >
                    {g.photoUrl ? (
                      <img
                        src={g.photoUrl}
                        alt={g.fullName}
                        className="w-10 h-10 rounded-sm object-cover border border-borderc shrink-0"
                        loading="lazy"
                      />
                    ) : (
                      <div
                        className="w-10 h-10 rounded-sm bg-bg border border-borderc shrink-0 flex items-center justify-center text-xs font-semibold text-textSecondary uppercase"
                        aria-hidden="true"
                      >
                        {g.fullName.trim().slice(0, 2)}
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="font-medium truncate">{g.fullName}</div>
                      <div className="text-xs text-textSecondary font-mono">{g.phone}</div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label block mb-1">
                Full Name <span className="text-danger">*</span>
              </label>
              <input
                className="input"
                value={newGuest.fullName}
                onChange={(e) => setNewGuest({ ...newGuest, fullName: e.target.value })}
              />
            </div>
            <div>
              <label className="label block mb-1">
                Phone <span className="text-danger">*</span>
              </label>
              <input
                className="input"
                type="tel"
                inputMode="numeric"
                maxLength={10}
                value={newGuest.phone}
                onChange={(e) =>
                  setNewGuest({ ...newGuest, phone: e.target.value.replace(/\D/g, "").slice(0, 10) })
                }
                placeholder="9876543210"
              />
            </div>
            <div>
              <label className="label block mb-1">
                Email{" "}
                <span className="text-xs text-textSecondary font-normal">(optional)</span>
              </label>
              <EmailInput
                value={newGuest.email}
                onChange={(v) => setNewGuest({ ...newGuest, email: v })}
              />
            </div>
            <div>
              <label className="label block mb-1">
                Nationality <span className="text-danger">*</span>
              </label>
              <input
                className="input"
                value={newGuest.nationality}
                onChange={(e) => setNewGuest({ ...newGuest, nationality: e.target.value })}
              />
            </div>
            <div>
              <label className="label block mb-1">
                Gender <span className="text-danger">*</span>
              </label>
              <select
                className="input"
                value={newGuest.gender}
                onChange={(e) =>
                  setNewGuest({
                    ...newGuest,
                    gender: e.target.value as typeof newGuest.gender,
                  })
                }
              >
                <option value="">Select gender…</option>
                <option value="male">Male</option>
                <option value="female">Female</option>
                <option value="other">Other</option>
                <option value="prefer_not_to_say">Prefer not to say</option>
              </select>
            </div>
            <div>
              <label className="label block mb-1">
                ID Type <span className="text-danger">*</span>
              </label>
              <select
                className="input"
                value={newGuest.idProofType}
                onChange={(e) =>
                  setNewGuest({ ...newGuest, idProofType: e.target.value as typeof newGuest.idProofType })
                }
              >
                <option value="aadhaar">Aadhaar</option>
                <option value="pan">PAN</option>
                <option value="passport">Passport</option>
                <option value="driving_license">Driving License</option>
                <option value="voter_id">Voter ID</option>
              </select>
            </div>
            <div>
              <label className="label block mb-1">
                ID Number <span className="text-danger">*</span>
              </label>
              <input
                className="input"
                value={newGuest.idProofNumber}
                onChange={(e) => setNewGuest({ ...newGuest, idProofNumber: e.target.value })}
              />
            </div>
            <div>
              <label className="label block mb-1">
                State <span className="text-danger">*</span>
              </label>
              <Combobox
                value={newGuest.state}
                onChange={(v) =>
                  setNewGuest((prev) => ({
                    ...prev,
                    state: v,
                    // Clear city when state changes so a previously-
                    // picked city from a different state doesn't sit
                    // stale in the field.
                    city: prev.state === v ? prev.city : "",
                  }))
                }
                groups={[
                  { label: "States", options: INDIAN_STATES },
                  { label: "Union Territories", options: INDIAN_UNION_TERRITORIES },
                ]}
                placeholder="Type to search or pick from list…"
              />
            </div>
            <div>
              <label className="label block mb-1">
                City <span className="text-danger">*</span>
              </label>
              <Combobox
                value={newGuest.city}
                onChange={(v) => setNewGuest({ ...newGuest, city: v })}
                options={citiesForState(newGuest.state)}
                placeholder={
                  newGuest.state
                    ? `Type to search ${newGuest.state} cities…`
                    : "Pick a state first, or type any city…"
                }
              />
            </div>
            <div className="col-span-2">
              <label className="label block mb-1">
                Address <span className="text-danger">*</span>
              </label>
              <input
                className="input"
                value={newGuest.address}
                onChange={(e) => setNewGuest({ ...newGuest, address: e.target.value })}
              />
            </div>
            <div className="col-span-2">
              <label className="label block mb-1">
                GSTIN{" "}
                <span className="text-xs text-textSecondary font-normal">(optional)</span>
              </label>
              <input
                className="input font-mono uppercase"
                value={newGuest.gstin}
                placeholder="22AAAAA0000A1Z5"
                onChange={(e) =>
                  setNewGuest({ ...newGuest, gstin: e.target.value.toUpperCase() })
                }
              />
            </div>
          </div>
        )}
      </div>

      {/* KYC card is contextual:
            - New Guest mode → render the upload pickers (required for
              walk-ins, optional otherwise).
            - Existing guest with KYC on file → render the verified-on-
              file summary so staff sees who's checking in.
            - Existing guest WITHOUT KYC on file → render the upload
              pickers so the missing docs can be captured.
            - No guest selected yet → render nothing; the section only
              makes sense once we know who the booking is for. */}
      {(useNewGuest || selectedGuest) && (
        <div className="card space-y-3">
          {kycOnFile && selectedGuest && walletQ.data ? (
            <KycOnFileCard
              guestId={selectedGuest.id}
              guestName={selectedGuest.fullName}
              verifiedAt={walletQ.data.kycVerifiedAt!}
              idProofType={walletQ.data.idProofType}
              idProofLast4={walletQ.data.idProofLast4}
              photoUrl={walletQ.data.photoUrl}
              kycFront={kycFront}
              setKycFront={setKycFront}
              kycBack={kycBack}
              setKycBack={setKycBack}
              kycPhoto={kycPhoto}
              setKycPhoto={setKycPhoto}
            />
          ) : (
            <>
              <div className="flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-accentBlue" />
                <h2 className="font-semibold text-navy">
                  KYC Documents · Primary Guest{" "}
                  {mode === "walkin" ? "(required)" : "(optional now, required at check-in)"}
                </h2>
              </div>
              <div className="text-xs text-textSecondary -mt-1">
                {mode === "walkin"
                  ? "Walk-in guests must upload a customer photo and a government ID photo now. Check-in cannot proceed without them."
                  : "Upload a clear customer photo and government ID. You can skip now and upload later, but check-in will be blocked until both are verified."}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <KycFilePicker label="Customer Photo" file={kycPhoto} onChange={setKycPhoto} required={mode === "walkin"} />
                <KycFilePicker label="ID Front" file={kycFront} onChange={setKycFront} required={mode === "walkin"} />
                <KycFilePicker label="ID Back" file={kycBack} onChange={setKycBack} />
              </div>
            </>
          )}
        </div>
      )}

      {needsCoGuest && (
        <>
          {coGuests.map((c, i) => {
            // IDs already used by the booker or another co-guest card, so a
            // person can't be picked twice across the group.
            const taken = new Set<string>();
            if (selectedGuest?.id) taken.add(selectedGuest.id);
            for (const other of coGuests) {
              if (other.id !== c.id && other.selected?.id)
                taken.add(other.selected.id);
            }
            return (
              <CoGuestCard
                key={c.id}
                index={i}
                canRemove={coGuests.length > 1}
                onRemove={() => removeCoGuest(c.id)}
                mode={c.useNew ? "new" : "existing"}
                onModeChange={(m) =>
                  updateCoGuest(c.id, { useNew: m === "new", selected: null })
                }
                query={c.query}
                setQuery={(q) => updateCoGuest(c.id, { query: q })}
                selected={c.selected}
                onSelected={(g) => updateCoGuest(c.id, { selected: g })}
                takenGuestIds={taken}
                form={c.form}
                setForm={(f) => updateCoGuest(c.id, { form: f })}
                kycPhoto={c.kycPhoto}
                setKycPhoto={(file) => updateCoGuest(c.id, { kycPhoto: file })}
                kycFront={c.kycFront}
                setKycFront={(file) => updateCoGuest(c.id, { kycFront: file })}
                kycBack={c.kycBack}
                setKycBack={(file) => updateCoGuest(c.id, { kycBack: file })}
              />
            );
          })}
          <button
            type="button"
            onClick={addCoGuest}
            className="w-full inline-flex items-center justify-center gap-1.5 h-11 rounded-sm border-2 border-dashed border-borderc text-sm font-medium text-textSecondary hover:border-brand hover:text-brand-dark hover:bg-brand-soft/20 transition"
          >
            <Plus className="w-4 h-4" /> Add another guest
          </button>
        </>
      )}

      <div className="card space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <h2 className="font-semibold text-navy">3. Rooms</h2>
          {availRooms.data && availRooms.data.length > 0 && (
            <ArrowKeyGroup className="inline-flex rounded-sm border border-borderc overflow-hidden text-xs">
              {(["all", "ac", "non_ac"] as const).map((opt) => {
                const count =
                  opt === "all"
                    ? availRooms.data!.length
                    : opt === "ac"
                    ? availRooms.data!.filter((r) => r.hasAc).length
                    : availRooms.data!.filter((r) => !r.hasAc).length;
                const label = opt === "all" ? "All" : opt === "ac" ? "AC" : "Non-AC";
                return (
                  <button
                    key={opt}
                    type="button"
                    onClick={() => setAcFilter(opt)}
                    className={`px-3 py-1.5 transition ${
                      acFilter === opt
                        ? "bg-navy text-white"
                        : "bg-bg text-textSecondary hover:bg-borderc/40"
                    }`}
                  >
                    {label} <span className="opacity-70">({count})</span>
                  </button>
                );
              })}
            </ArrowKeyGroup>
          )}
        </div>
        {/* Occupancy gate. Once rooms are picked, the selected rooms must
            sleep at least `adults`. Extra beds added per room count toward
            capacity. When short, block submit and tell staff to add an
            extra bed or another room. */}
        {selectedRooms.length > 0 && (
          capacityShortfall > 0 ? (
            <div className="rounded-sm border border-danger/40 bg-danger/5 p-3 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-danger shrink-0 mt-0.5" />
              <div className="text-sm leading-snug">
                <div className="font-semibold text-danger">
                  {adults} adult{adults === 1 ? "" : "s"} but selected rooms sleep {effectiveCapacity}.
                </div>
                <div className="text-textSecondary mt-0.5">
                  Add an extra bed to a room below, or select another room —{" "}
                  <strong>{capacityShortfall}</strong> more {capacityShortfall === 1 ? "berth" : "berths"} needed.
                </div>
              </div>
            </div>
          ) : (
            <div className="text-xs text-success flex items-center gap-1.5">
              <Users className="w-3.5 h-3.5" />
              Capacity OK — sleeps {effectiveCapacity} for {adults} adult{adults === 1 ? "" : "s"}
              {extraBedCapacity > 0 ? ` (incl. ${extraBedCapacity} extra bed${extraBedCapacity === 1 ? "" : "s"})` : ""}.
            </div>
          )
        )}
        {!canPriceStay ? (
          <div className="text-textSecondary text-sm">
            {isShortStay
              ? "Pick a duration to see available rooms."
              : "Select valid dates to see available rooms."}
          </div>
        ) : availRooms.isLoading ? (
          <Loader label="Loading availability…" size="sm" />
        ) : !availRooms.data?.length ? (
          <div className="text-danger text-sm">No rooms available for these dates.</div>
        ) : (
          // Group rooms by floor so the grid reads as Floor 1 → Floor 2
          // → Floor 3 sections instead of a flat 9-card wall. The API
          // already orders by (floor ASC, roomNumber ASC) so iteration
          // order is meaningful; we just split by the floor boundary.
          (() => {
            const filtered = availRooms.data.filter((r) =>
              acFilter === "all" ? true : acFilter === "ac" ? r.hasAc : !r.hasAc,
            );
            const byFloor = new Map<number, typeof filtered>();
            for (const room of filtered) {
              const arr = byFloor.get(room.floor) ?? [];
              arr.push(room);
              byFloor.set(room.floor, arr);
            }
            const floors = Array.from(byFloor.keys()).sort((a, b) => a - b);
            if (floors.length === 0) {
              return (
                <div className="text-textSecondary text-sm">
                  No rooms match the current AC filter.
                </div>
              );
            }
            return (
              <ArrowKeyGroup className="space-y-4">
                {floors.map((floor) => (
                  <div key={floor}>
                    <div className="text-base font-bold text-brand-dark tracking-wide mb-2 pb-1 border-b border-borderc/60">
                      Floor {floor}
                      <span className="ml-2 text-xs font-semibold text-textSecondary uppercase tracking-wider">
                        · {byFloor.get(floor)!.length} room
                        {byFloor.get(floor)!.length === 1 ? "" : "s"}
                      </span>
                    </div>
                    <div className="grid grid-cols-2 md:grid-cols-3 gap-3 auto-rows-min items-start">
                      {byFloor.get(floor)!.map((r) => {
              const selected = selectedRooms.find((s) => s.roomId === r.id);
              const conflicted = !!r.conflict;
              const isDirty = r.status === "dirty";
              // Cleanliness only gates same-day check-ins — housekeeping
              // turns the room over long before a future arrival.
              const needsClean = isDirty && checkInDate <= todayStr;
              const cleanInFlight =
                markRoomClean.isPending && markRoomClean.variables === r.id;
              return (
                <div
                  key={r.id}
                  className={`border rounded-sm p-3 transition ${
                    conflicted
                      ? "border-borderc bg-bg/60 opacity-60 cursor-not-allowed"
                      : needsClean && !selected
                        ? "border-warning/50 bg-warning/5"
                        : selected
                          ? "border-accentBlue bg-accentBlue/5 cursor-pointer"
                          : "border-borderc hover:border-navy cursor-pointer"
                  }`}
                  onClick={() => {
                    if (conflicted) return;
                    if (needsClean && !selected) return;
                    // Clicking the card toggles selection. The controls
                    // panel below (Sell as / Rate / Extra beds) stops its
                    // own click propagation, so editing those never
                    // deselects — only the room header / empty card area
                    // does. The chevron stays for collapse-only.
                    toggleRoom(r);
                  }}
                >
                  <div className="flex justify-between items-start">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <div className="font-mono font-bold">{r.roomNumber}</div>
                        {conflicted && (
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded-sm text-[10px] font-semibold bg-danger/15 text-danger">
                            BOOKED
                          </span>
                        )}
                        {needsClean && (
                          <span
                            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm text-[10px] font-semibold bg-warning/15 text-warning"
                            title="Room hasn't been cleaned since the last checkout. Mark clean before assigning to a guest."
                          >
                            <Sparkles className="w-3 h-3" /> DIRTY
                          </span>
                        )}
                        {r.hasAc ? (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm text-[10px] font-semibold bg-accentBlue/15 text-accentBlue">
                            <Snowflake className="w-3 h-3" /> AC
                          </span>
                        ) : (
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded-sm text-[10px] font-semibold bg-gray-200 text-textSecondary">
                            Non-AC
                          </span>
                        )}
                        {r.hasTv && (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm text-[10px] font-semibold bg-brand-soft text-brand-dark">
                            <Tv className="w-3 h-3" /> TV
                          </span>
                        )}
                        {r.hasWifi && (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm text-[10px] font-semibold bg-success/15 text-success">
                            <Wifi className="w-3 h-3" /> Wi-Fi
                          </span>
                        )}
                        {r.maxOccupancy > 0 && (
                          <span
                            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm text-[10px] font-semibold bg-navy/10 text-navy"
                            title={`Sleeps up to ${r.maxOccupancy} guest${r.maxOccupancy === 1 ? "" : "s"}`}
                          >
                            <Users className="w-3 h-3" /> Sleeps {r.maxOccupancy}
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-textSecondary capitalize mt-0.5">
                        {r.roomType.replace(/_/g, " ")} · Floor {r.floor}
                      </div>
                    </div>
                    <div className="flex items-start gap-2 shrink-0">
                      <div className="text-sm font-mono">
                        {/* Once a room is selected, show what the guest
                            will actually be billed (effective rate). Falls
                            back to the room's native base rate before the
                            card is selected so the price is still visible
                            in the picker grid. */}
                        {selected ? inr(selected.ratePerNight) : inr(r.baseRate)}
                      </div>
                      {/* Collapse / expand the controls panel — behaves
                          like a dropdown. Selection is unaffected; the
                          room stays in the booking. Stop propagation so
                          the click doesn't hit the card's select handler. */}
                      {selected && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleRoomCollapsed(r.id);
                          }}
                          className="inline-flex items-center justify-center rounded-sm border border-borderc w-6 h-6 text-navy hover:border-brand hover:bg-brand-soft/30"
                          title={collapsedRooms.has(r.id) ? "Expand" : "Collapse"}
                          aria-label={collapsedRooms.has(r.id) ? "Expand room options" : "Collapse room options"}
                          aria-expanded={!collapsedRooms.has(r.id)}
                        >
                          <ChevronDown
                            className={`w-4 h-4 transition-transform ${
                              collapsedRooms.has(r.id) ? "-rotate-90" : ""
                            }`}
                          />
                        </button>
                      )}
                    </div>
                  </div>
                  {/* Date conflict: card stays visible but disabled so
                      staff see exactly which booking holds the room. */}
                  {r.conflict && (
                    <div className="mt-2 rounded-sm border border-danger/30 bg-danger/5 p-2 text-[11px] text-textSecondary leading-snug">
                      Booked for <strong>{r.conflict.guestName}</strong> till{" "}
                      <strong>{format(new Date(r.conflict.bookedTill), "dd MMM yyyy")}</strong>{" "}
                      · {r.conflict.reservationNumber}
                    </div>
                  )}
                  {/* Same-day re-let warning. Shown for reserved rooms
                      whose existing booking arrives AFTER the walk-in's
                      check-out. Staff must confirm via the checkbox
                      below the room body before submitting. */}
                  {r.nextReservation && (
                    <div className="mt-2 rounded-sm border border-warning/40 bg-warning/10 p-2 text-[11px] text-warning">
                      <div className="flex items-start gap-1.5">
                        <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                        <div className="leading-snug">
                          Reserved for{" "}
                          <strong>{r.nextReservation.guestName}</strong>{" "}
                          from{" "}
                          <strong>
                            {format(
                              new Date(r.nextReservation.checkInDate),
                              "dd MMM yyyy",
                            )}
                          </strong>{" "}
                          to{" "}
                          <strong>
                            {format(
                              new Date(r.nextReservation.checkOutDate),
                              "dd MMM yyyy",
                            )}
                          </strong>{" "}
                          · {r.nextReservation.reservationNumber}. Vacate
                          before then.
                        </div>
                      </div>
                    </div>
                  )}

                  {needsClean && !selected && (
                    <div className="mt-2" onClick={(e) => e.stopPropagation()}>
                      <button
                        type="button"
                        disabled={cleanInFlight}
                        onClick={() => {
                          markRoomClean.mutate(r.id, {
                            onSuccess: () => toggleRoom({ ...r, status: "available" }),
                          });
                        }}
                        className="w-full inline-flex items-center justify-center gap-1.5 px-2 h-8 rounded-sm border border-warning/50 text-warning hover:bg-warning/10 text-xs font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        <Sparkles className="w-3.5 h-3.5" />
                        {cleanInFlight ? "Marking clean…" : "Mark clean & select"}
                      </button>
                      <div className="text-[10px] text-textSecondary mt-1 leading-tight">
                        Confirms the room has been cleaned. Required before assigning a guest.
                      </div>
                    </div>
                  )}
                  {/* Collapsed summary — shown when the room is selected
                      but its panel is closed. Compact recap of the key
                      choices so staff don't have to expand to check. */}
                  {selected && collapsedRooms.has(r.id) && (
                    <div className="mt-2 text-xs text-textSecondary flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span className="font-mono font-semibold text-brand-dark">
                        {inr(selected.ratePerNight)}
                        {isShortStay ? `/${shortStayDurationHours}h` : "/night"}
                      </span>
                      {selected.soldAsType && (
                        <span>
                          · sold as{" "}
                          {roomTypesQ.data?.find((t) => t.slug === selected.soldAsType)?.label
                            ?? selected.soldAsType.replace(/_/g, " ")}
                        </span>
                      )}
                      {selected.extraBeds > 0 && (
                        <span>
                          · {selected.extraBeds} extra bed
                          {selected.extraBeds === 1 ? "" : "s"} (
                          {inr(selected.extraBeds * selected.extraBedRate * (isShortStay ? 1 : nights))})
                        </span>
                      )}
                    </div>
                  )}
                  {selected && !collapsedRooms.has(r.id) && (
                    // No blanket stopPropagation here — only the actual
                    // controls (select / inputs / stepper buttons) swallow
                    // the click, so tapping blank space in this panel still
                    // bubbles to the card and deselects the room.
                    <div className="mt-2 space-y-2">
                      <div>
                        <label className="label block mb-1">Sell as</label>
                        <select
                          className="input !h-8 text-sm"
                          value={selected.soldAsType ?? ""}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => {
                            const slug = e.target.value || null;
                            const t = roomTypesQ.data?.find((x) => x.slug === slug);
                            updateSoldAs(r.id, slug, t ? Number(t.defaultRate) : null);
                          }}
                        >
                          {(() => {
                            const native = roomTypesQ.data?.find(
                              (t) => t.slug === selected.nativeType,
                            );
                            const nativeLabel = native?.label
                              ?? selected.nativeType.replace(/_/g, " ").toUpperCase();
                            return (
                              <option value="">{nativeLabel} (native)</option>
                            );
                          })()}
                          {roomTypesQ.data
                            ?.filter((t) => t.slug !== selected.nativeType)
                            .map((t) => (
                              <option key={t.id} value={t.slug}>
                                {t.label} ({inr(t.defaultRate)})
                              </option>
                            ))}
                        </select>
                      </div>
                      <div>
                        <label className="label block mb-1">
                          {isShortStay ? `Rate for ${shortStayDurationHours} hrs` : "Rate/night"}
                        </label>
                        <input
                          className="input !h-8 text-sm"
                          type="number"
                          value={selected.ratePerNight || ""}
                          placeholder="0"
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => updateRate(r.id, Number(e.target.value))}
                        />
                      </div>
                      {/* Extra beds (additional persons). Shown when the
                          effective room type offers extra beds (its
                          configured rate > 0). The fee is seeded from that
                          rate but editable per-booking. Capped at +3 over
                          base; each bed raises effective capacity. */}
                      {extraBedRateForType(selected.soldAsType ?? selected.nativeType) > 0 && (
                        <div>
                          <label className="label block mb-1">Extra beds</label>
                          <div className="flex items-center gap-2 flex-wrap">
                            <button
                              type="button"
                              className="h-8 w-8 grid place-items-center rounded-sm border border-borderc text-navy disabled:opacity-40 hover:border-brand"
                              disabled={selected.extraBeds <= 0}
                              onClick={(e) => {
                                e.stopPropagation();
                                updateExtraBeds(r.id, selected.extraBeds - 1);
                              }}
                              aria-label="Remove extra bed"
                            >
                              <Minus className="w-3.5 h-3.5" />
                            </button>
                            <span className="min-w-8 text-center font-mono font-semibold">
                              {selected.extraBeds}
                            </span>
                            <button
                              type="button"
                              className="h-8 w-8 grid place-items-center rounded-sm border border-borderc text-navy disabled:opacity-40 hover:border-brand"
                              // Only allow adding a bed while guests are
                              // still uncovered. Once the selected rooms'
                              // total capacity meets the adult headcount,
                              // there's no one left to seat — block the +.
                              disabled={capacityShortfall <= 0}
                              onClick={(e) => {
                                e.stopPropagation();
                                updateExtraBeds(r.id, selected.extraBeds + 1);
                              }}
                              aria-label="Add extra bed"
                            >
                              <Plus className="w-3.5 h-3.5" />
                            </button>
                            <span className="text-[11px] text-textSecondary">
                              sleeps {selected.maxOccupancy + selected.extraBeds}
                            </span>
                          </div>
                          {/* Editable per-bed, per-night fee. Defaults to the
                              room type's rate; staff can change it for this
                              booking. */}
                          <div className="flex items-center gap-1.5 mt-1.5">
                            <span className="text-[11px] text-textSecondary whitespace-nowrap">
                              ₹/bed/night
                            </span>
                            <input
                              className="input !h-8 text-sm !w-28"
                              type="number"
                              min={0}
                              value={selected.extraBedRate || ""}
                              placeholder="0"
                              onClick={(e) => e.stopPropagation()}
                              onChange={(e) =>
                                updateExtraBedRate(r.id, Number(e.target.value))
                              }
                            />
                          </div>
                          {/* Running extra-bed charge for THIS room so staff
                              see the total (rate × beds × units) without
                              scrolling to the summary. 0 beds → no charge. */}
                          {selected.extraBeds > 0 && selected.extraBedRate > 0 && (
                            <div className="text-[11px] text-textSecondary mt-1.5">
                              Extra-bed charge:{" "}
                              <span className="font-mono font-semibold text-brand-dark">
                                {inr(
                                  selected.extraBeds *
                                    selected.extraBedRate *
                                    (isShortStay ? 1 : nights),
                                )}
                              </span>{" "}
                              ({selected.extraBeds} × {inr(selected.extraBedRate)}
                              {isShortStay
                                ? ""
                                : ` × ${nights} night${nights === 1 ? "" : "s"}`})
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
                    </div>
                  </div>
                ))}
              </ArrowKeyGroup>
            );
          })()
        )}
      </div>

      <div className="card space-y-3">
        <h2 className="font-semibold text-brand-dark">4. Booking Source</h2>
        <ArrowKeyGroup className="grid grid-cols-3 gap-2">
          {([
            { v: "walkin", label: "Walk-in" },
            { v: "phone_whatsapp", label: "Phone / WhatsApp" },
            { v: "complimentary", label: "Complimentary" },
          ] as const).map((opt) => (
            <button
              key={opt.v}
              type="button"
              onClick={() => setBookingSource(opt.v)}
              className={`px-3 py-2 rounded-sm border-2 text-sm font-medium transition ${
                bookingSource === opt.v
                  ? "bg-brand text-textPrimary border-brand"
                  : "bg-bg text-textSecondary border-borderc hover:border-brand/60"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </ArrowKeyGroup>
        {isCreditBooking && (
          <>
            <div className="text-xs text-warning bg-warning/5 border border-warning/30 rounded-sm px-3 py-2">
              This stay is marked <strong>complimentary</strong>. It will be excluded from
              revenue reports and logged separately.
            </div>
            <div>
              <label className="label block mb-1">
                Complimentary notes (who authorized, purpose, etc.)
              </label>
              <input
                className="input"
                value={creditNotes}
                onChange={(e) => setCreditNotes(e.target.value)}
                placeholder="Owner approved · corporate stay · staff training…"
              />
            </div>
          </>
        )}

        <div className="flex items-start gap-3 px-3 py-2.5 border border-borderc rounded-sm bg-bg select-none">
          <div
            className={`w-4 h-4 mt-0.5 rounded-sm grid place-items-center ${
              otpEnabled ? "bg-brand" : "bg-borderc"
            }`}
          >
            <span className="text-white text-[10px] leading-none">
              {otpEnabled ? "✓" : "—"}
            </span>
          </div>
          <div className="text-sm">
            <div className="font-medium text-textPrimary">
              OTP verification {otpEnabled ? "(required)" : "(disabled)"}
            </div>
            <div className="text-xs text-textSecondary mt-0.5">
              {otpEnabled
                ? "A code will be sent to the guest's phone or email and must be entered before check-in is completed."
                : "OTP is turned off for this property (Settings → Guest Check-in). No code will be sent."}
            </div>
          </div>
        </div>
      </div>

      {!isCreditBooking && (
        <div className="card space-y-3">
          <h2 className="font-semibold text-navy">5. Advance Payment (optional)</h2>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label block mb-1">Amount (₹)</label>
              <input
                className={`input ${
                  advanceTooHigh
                    ? "border-danger focus:border-danger focus:ring-danger/30"
                    : ""
                }`}
                type="number"
                min={0}
                max={grandTotal || undefined}
                value={advance || ""}
                placeholder="0"
                onChange={(e) => setAdvance(Number(e.target.value))}
                aria-invalid={advanceTooHigh}
              />
              {advanceTooHigh && (
                <div className="text-[11px] text-danger mt-1">
                  Advance can't exceed grand total{" "}
                  <span className="font-mono">{inr(grandTotal)}</span>. If the
                  guest is pre-paying for another visit, record it as wallet
                  credit instead.
                </div>
              )}
            </div>
            <div>
              <label className="label block mb-1">Method</label>
              <select
                className="input"
                value={paymentMethod}
                onChange={(e) => setPaymentMethod(e.target.value as typeof paymentMethod)}
              >
                <option value="cash">Cash</option>
                <option value="upi">UPI</option>
                <option value="card">Card</option>
                <option value="bank_transfer">Bank Transfer</option>
                <option value="cheque">Cheque</option>
              </select>
            </div>
          </div>
        </div>
      )}

      {/* Wallet credit — only shown when an existing guest is selected and
          they actually have a positive balance. Discounts the booking. */}
      {!isCreditBooking && selectedGuest && walletBalance > 0.009 && grandTotal > 0 && (
        <div className="card space-y-3 border-2 border-brand/30">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div>
              <h2 className="font-semibold text-navy">6. Wallet Credit</h2>
              <p className="text-xs text-textSecondary mt-0.5">
                Available balance:{" "}
                <span className="font-mono font-semibold text-brand-dark">
                  {inr(walletBalance)}
                </span>
              </p>
            </div>
            <ArrowKeyGroup className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setWalletApply(0)}
                className={`text-xs px-2 py-1 rounded-sm border ${
                  walletApply === 0
                    ? "bg-brand-dark text-cream border-brand-dark"
                    : "border-borderc text-textSecondary hover:border-brand"
                }`}
              >
                Don't apply
              </button>
              <button
                type="button"
                onClick={() => setWalletApply(maxWalletApply)}
                className={`text-xs px-2 py-1 rounded-sm border ${
                  walletApply >= maxWalletApply - 0.009 && walletApply > 0
                    ? "bg-brand text-textPrimary border-brand"
                    : "border-borderc text-textSecondary hover:border-brand"
                }`}
              >
                Apply max ({inr(maxWalletApply)})
              </button>
            </ArrowKeyGroup>
          </div>
          <div>
            <label className="label block mb-1">Amount to apply (₹)</label>
            <input
              className="input"
              type="number"
              min={0}
              max={maxWalletApply}
              step="0.01"
              value={walletApply || ""}
              placeholder="0"
              onChange={(e) => {
                const n = Math.max(0, Math.min(maxWalletApply, Number(e.target.value)));
                setWalletApply(n);
              }}
            />
            {walletApply > 0 && (
              <div className="text-[11px] text-textSecondary mt-1">
                Reduces the bill directly. Remaining wallet after this booking:{" "}
                <span className="font-mono">
                  {inr(Math.max(0, walletBalance - effectiveWalletApply))}
                </span>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="card">
        {gstMode === "inclusive" && roomAmount > 0 && (
          <div className="flex justify-between text-sm">
            <span className="text-textSecondary">
              Quoted rate (
              {isShortStay
                ? `${shortStayDurationHours} hrs × ${selectedRooms.length}`
                : `${nights} × ${selectedRooms.length}`}{" "}
              room{selectedRooms.length === 1 ? "" : "s"}) — GST included
            </span>
            <span className="font-mono">{inr(roomAmount)}</span>
          </div>
        )}
        {/* Extra-bed charge breakdown. roomAmount already includes this;
            we surface it as its own line so the bill is transparent. */}
        {extraBedAmount > 0 && (
          <div className="flex justify-between text-sm text-textSecondary">
            <span>
              Extra beds (
              {selectedRooms.reduce((a, r) => a + r.extraBeds, 0)} ×{" "}
              {isShortStay ? `${shortStayDurationHours} hrs` : `${nights} night${nights === 1 ? "" : "s"}`})
            </span>
            <span className="font-mono">{inr(extraBedAmount)}</span>
          </div>
        )}
        <div className="flex justify-between text-sm">
          <span>
            {isShortStay
              ? `Subtotal (${shortStayDurationHours} hrs × ${selectedRooms.length} room${selectedRooms.length === 1 ? "" : "s"})`
              : `Subtotal (${nights} × ${selectedRooms.length} room${selectedRooms.length === 1 ? "" : "s"})`}
            {gstMode === "inclusive" && (
              <span className="text-[10px] text-textSecondary"> · net, after GST extracted</span>
            )}
          </span>
          <span className="font-mono">{inr(subtotal)}</span>
        </div>
        {subtotal > 0 && (
          <>
            <div className="flex justify-between text-sm mt-1">
              <span>CGST @ {(gstRate / 2).toFixed(gstRate % 2 === 0 ? 0 : 1)}%</span>
              <span className="font-mono">{inr(cgst)}</span>
            </div>
            <div className="flex justify-between text-sm mt-1">
              <span>SGST @ {(gstRate / 2).toFixed(gstRate % 2 === 0 ? 0 : 1)}%</span>
              <span className="font-mono">{inr(sgst)}</span>
            </div>
            <div className="flex justify-between text-base font-bold text-brand-dark mt-2 pt-2 border-t border-borderc">
              <span>Grand Total</span>
              <span className="font-mono">{inr(grandTotal)}</span>
            </div>
            {!isCreditBooking && effectiveWalletApply > 0 && (
              <div className="flex justify-between text-sm text-brand mt-1">
                <span>Wallet credit applied</span>
                <span className="font-mono">−{inr(effectiveWalletApply)}</span>
              </div>
            )}
            {!isCreditBooking && advance > 0 && (
              <div className="flex justify-between text-sm text-textSecondary mt-1">
                <span>Advance</span>
                <span className="font-mono">−{inr(advance)}</span>
              </div>
            )}
            {!isCreditBooking && (advance > 0 || effectiveWalletApply > 0) && (
              <div className="flex justify-between text-sm font-semibold mt-1">
                <span>Balance Due</span>
                <span className={`font-mono ${balanceDue > 0 ? "text-danger" : "text-success"}`}>
                  {inr(balanceDue)}
                </span>
              </div>
            )}
            <div className="text-[11px] text-textSecondary mt-2">
              GST {gstRate}% applied via slab (avg rate ₹{avgRatePerNight.toFixed(2)}
              {isShortStay ? `/${shortStayDurationHours} hrs` : "/night"}
              {gstMode === "inclusive" ? ", GST-inclusive" : ", GST extra"}). Final tax
              recomputed at check-out if charges change.
            </div>
          </>
        )}
        {/* Same-day re-let acknowledgement. Required when one or more
            picked rooms have a confirmed reservation that arrives AFTER
            the walk-in vacates. Staff must explicitly confirm they'll
            free the room in time. */}
        {reletRooms.length > 0 && (
          <div className="mt-4 rounded-sm border border-warning/50 bg-warning/10 p-3">
            <div className="flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-warning shrink-0 mt-0.5" />
              <div className="flex-1 text-xs leading-snug">
                <div className="font-semibold text-warning mb-1.5">
                  Same-day re-let — {reletRooms.length} room
                  {reletRooms.length === 1 ? "" : "s"} reserved for tomorrow
                </div>
                <ul className="space-y-1 mb-2">
                  {reletRooms.map((r) => (
                    <li key={r.roomId}>
                      Room <span className="font-mono font-bold">{r.roomNumber}</span> →{" "}
                      {r.nextReservation?.guestName} arrives on{" "}
                      <strong>{r.nextReservation?.checkInDate}</strong>{" "}
                      ({r.nextReservation?.reservationNumber})
                    </li>
                  ))}
                </ul>
                <label className="flex items-start gap-2 cursor-pointer text-textPrimary">
                  <input
                    type="checkbox"
                    className="mt-0.5 accent-warning"
                    checked={reletConfirmed}
                    onChange={(e) => setReletConfirmed(e.target.checked)}
                  />
                  <span>
                    I confirm the walk-in guest will check out and the room will
                    be ready before the next reservation arrives.
                  </span>
                </label>
              </div>
            </div>
          </div>
        )}
        {error && <div className="text-danger text-sm mt-3">{error}</div>}
        <div className="flex justify-end gap-2 mt-4">
          <button className="btn-secondary" onClick={() => navigate(-1)}>
            Cancel
          </button>
          <button
            className="btn-primary"
            disabled={!canSubmit || create.isPending}
            onClick={handlePrimarySubmit}
          >
            {create.isPending
              ? mode === "walkin"
                ? "Checking in…"
                : "Creating…"
              : mode === "walkin"
                ? "Check In Now"
                : "Create Reservation"}
          </button>
        </div>
      </div>

      {walkInReceipt && (
        <CheckInReceiptModal
          data={walkInReceipt}
          variant={receiptVariant}
          onClose={() => {
            const id = walkInReceipt.reservationId;
            setWalkInReceipt(null);
            navigate(id ? `/reservations/${id}` : "/reservations");
          }}
        />
      )}

      <OtpModal
        guestId={pendingOtpGuestId ?? undefined}
        phone={pendingOtpPhone ?? undefined}
        open={(!!pendingOtpGuestId || !!pendingOtpPhone) && otpEnabled}
        onClose={() => {
          // OTP abandoned. Normally nothing was written yet (guests are
          // only created after verify), so this sweep is a no-op — but if
          // a verified attempt failed at the reservation POST and staff
          // closed the modal instead of retrying, it removes the guest
          // rows that commit attempt minted.
          sweepFreshGuests();
          setPendingOtpGuestId(null);
          setPendingOtpPhone(null);
        }}
        onVerified={async (code) => {
          // OTP verified — commit: create guests + KYC, then POST the
          // reservation with the code so the server can re-verify
          // atomically with the insert. Returning the promise keeps
          // OtpModal's spinner visible until the reservation is fully
          // created and navigation fires.
          if (!code) return;
          await createAfterOtp.mutateAsync({ otpCode: code });
        }}
      />
    </div>
  );
}

function KycOnFileCard({
  guestId,
  guestName,
  verifiedAt,
  idProofType,
  idProofLast4,
  photoUrl,
  kycPhoto,
  setKycPhoto,
  kycFront,
  setKycFront,
  kycBack,
  setKycBack,
}: {
  guestId: string;
  guestName: string;
  verifiedAt: string;
  idProofType: string | null;
  idProofLast4: string | null;
  photoUrl: string | null;
  kycPhoto: File | null;
  setKycPhoto: (f: File | null) => void;
  kycFront: File | null;
  setKycFront: (f: File | null) => void;
  kycBack: File | null;
  setKycBack: (f: File | null) => void;
}) {
  const [showReplace, setShowReplace] = useState(false);
  const verified = new Date(verifiedAt);
  return (
    <div className="space-y-3">
      <div className="flex items-start gap-3">
        {photoUrl ? (
          <img
            src={photoUrl}
            alt={`KYC photo of ${guestName}`}
            className="w-14 h-14 rounded-sm object-cover border border-borderc shrink-0"
          />
        ) : (
          <div className="w-14 h-14 rounded-sm bg-success/10 grid place-items-center shrink-0">
            <ShieldCheck className="w-6 h-6 text-success" />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm text-[10px] font-semibold bg-success/15 text-success">
              <ShieldCheck className="w-3 h-3" /> KYC ON FILE
            </span>
            <span className="text-xs text-textSecondary">
              Verified {verified.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}
            </span>
          </div>
          <div className="text-sm text-textPrimary mt-1">
            {idProofType ? (
              <>
                <span className="capitalize">{idProofType.replace(/_/g, " ")}</span>
                {idProofLast4 && (
                  <>
                    {" "}
                    ending in <span className="font-mono">{idProofLast4}</span>
                  </>
                )}
              </>
            ) : (
              "Documents on file"
            )}
          </div>
          <div className="text-xs text-textSecondary mt-0.5">
            No need to re-upload. Existing documents will be used for this booking.
          </div>
          <div className="flex gap-3 mt-2 text-xs">
            <Link to={`/guests/${guestId}`} className="text-accentBlue hover:underline">
              View documents
            </Link>
            <button
              type="button"
              onClick={() => setShowReplace((v) => !v)}
              className="text-textSecondary hover:text-brand-dark"
            >
              {showReplace ? "Hide replace options" : "Replace if guest brought new ID"}
            </button>
          </div>
        </div>
      </div>
      {showReplace && (
        <div className="grid grid-cols-3 gap-3 border-t border-borderc pt-3">
          <KycFilePicker label="Customer Photo" file={kycPhoto} onChange={setKycPhoto} />
          <KycFilePicker label="ID Front" file={kycFront} onChange={setKycFront} />
          <KycFilePicker label="ID Back" file={kycBack} onChange={setKycBack} />
        </div>
      )}
    </div>
  );
}

function OutstandingBanner({
  data,
  guestName,
}: {
  data: {
    total: number;
    count: number;
    pendingPromiseCount: number;
    mostRecent: {
      reservationId: string;
      reservationNumber: string;
      invoiceNumber: string | null;
      balanceDue: number;
      date: string;
    } | null;
  };
  guestName: string;
}) {
  const daysAgo = data.mostRecent
    ? Math.max(
        0,
        Math.floor((Date.now() - new Date(data.mostRecent.date).getTime()) / 86_400_000),
      )
    : null;
  return (
    <div className="border-2 border-danger/40 bg-danger/5 rounded-sm p-3 flex gap-3 items-start">
      <AlertTriangle className="w-5 h-5 text-danger shrink-0 mt-0.5" />
      <div className="min-w-0 flex-1 text-sm">
        <div className="font-bold text-danger uppercase tracking-wider text-xs mb-1">
          Outstanding balance
        </div>
        <div className="text-textPrimary">
          <strong>{guestName}</strong> owes{" "}
          <span className="font-mono font-bold text-danger">{inr(data.total)}</span> from{" "}
          {data.count === 1 ? "a previous booking" : `${data.count} previous bookings`}.
        </div>
        {data.mostRecent && (
          <div className="text-xs text-textSecondary mt-1">
            Most recent:{" "}
            <Link
              to={`/reservations/${data.mostRecent.reservationNumber}`}
              className="font-mono text-accentBlue hover:underline"
            >
              {data.mostRecent.reservationNumber}
            </Link>
            {data.mostRecent.invoiceNumber && (
              <>
                {" · "}
                <span className="font-mono">{data.mostRecent.invoiceNumber}</span>
              </>
            )}
            {daysAgo !== null && (
              <>
                {" · "}
                {daysAgo === 0 ? "today" : `${daysAgo}d ago`}
              </>
            )}
          </div>
        )}
        {data.pendingPromiseCount > 0 && (
          <div className="text-[11px] text-warning mt-1">
            {data.pendingPromiseCount} pending payment promise
            {data.pendingPromiseCount === 1 ? "" : "s"} on file.
          </div>
        )}
        <div className="text-xs text-textSecondary mt-2 italic">
          Collect at check-in or remind the guest to settle the previous balance.
        </div>
      </div>
    </div>
  );
}

function KycFilePicker({
  label,
  file,
  onChange,
  required = false,
}: {
  label: string;
  file: File | null;
  onChange: (f: File | null) => void;
  required?: boolean;
}) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!file || !file.type.startsWith("image/")) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const isPdf = file?.type === "application/pdf";
  const sizeKb = file ? Math.round(file.size / 1024) : 0;
  // Unique per-instance id. Multiple KYC blocks on the same page
  // (primary guest + second guest) would otherwise share a DOM id
  // and clicking the second block's label would activate the first
  // block's input. useId() generates a stable, unique id per render
  // instance — safe across SSR/CSR.
  const reactId = useId();
  const inputId = `kyc-${reactId}-${label.toLowerCase().replace(/\s+/g, "-")}`;

  return (
    <div>
      <label htmlFor={inputId} className="label block mb-1">
        {label}
        {required && !file && <span className="text-danger ml-1">*</span>}
        {file && <span className="text-success ml-1">✓</span>}
      </label>

      <input
        id={inputId}
        type="file"
        accept="image/jpeg,image/png,image/webp,application/pdf"
        onChange={(e) => onChange(e.target.files?.[0] ?? null)}
        className="hidden"
      />

      {!file ? (
        <label
          htmlFor={inputId}
          className="flex flex-col items-center justify-center gap-1.5 h-32 border-2 border-dashed border-borderc rounded-md cursor-pointer hover:border-brand hover:bg-brand-soft/30 transition-colors text-textSecondary"
        >
          <Upload className="w-5 h-5" />
          <div className="text-xs">Click to upload {label.toLowerCase()}</div>
          <div className="text-[10px] text-textSecondary/70">JPG, PNG, WebP or PDF</div>
        </label>
      ) : (
        <div className="border border-borderc rounded-md overflow-hidden bg-surface">
          <div className="relative h-32 bg-bg flex items-center justify-center">
            {previewUrl ? (
              <img src={previewUrl} alt={label} className="max-h-full max-w-full object-contain" />
            ) : isPdf ? (
              <div className="flex flex-col items-center gap-1 text-textSecondary">
                <FileText className="w-7 h-7 text-brand" />
                <div className="text-xs font-mono">PDF document</div>
              </div>
            ) : (
              <div className="text-xs text-textSecondary">No preview</div>
            )}
            <button
              type="button"
              onClick={() => onChange(null)}
              className="absolute top-1.5 right-1.5 grid place-items-center w-6 h-6 rounded-full bg-surface border border-borderc text-textSecondary hover:text-danger hover:border-danger"
              aria-label="Remove"
              title="Remove"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="px-2.5 py-1.5 flex items-center justify-between gap-2 text-[11px] border-t border-borderc">
            <div className="truncate text-textSecondary" title={file.name}>
              {file.name}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <span className="text-textSecondary/70">{sizeKb} KB</span>
              <label htmlFor={inputId} className="text-brand cursor-pointer hover:underline">
                Replace
              </label>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Co-guest block. One per additional occupant — shown when numAdults >= 2
// and replicated as staff add more guests. Either pick an existing guest
// (search by phone/name) or create a fresh guest + upload their KYC. The
// submitted reservation links each via reservationCoGuests.
function CoGuestCard(props: {
  index: number; // 0-based co-guest index; booker is guest 1
  canRemove: boolean;
  onRemove: () => void;
  mode: "existing" | "new";
  onModeChange: (m: "existing" | "new") => void;
  query: string;
  setQuery: (q: string) => void;
  selected: Guest | null;
  onSelected: (g: Guest | null) => void;
  takenGuestIds: Set<string>;
  form: CoGuestForm;
  setForm: (f: CoGuestForm) => void;
  kycPhoto: File | null;
  setKycPhoto: (f: File | null) => void;
  kycFront: File | null;
  setKycFront: (f: File | null) => void;
  kycBack: File | null;
  setKycBack: (f: File | null) => void;
}) {
  const f = props.form;
  const setF = (patch: Partial<typeof f>) => props.setForm({ ...f, ...patch });
  const guestNumber = props.index + 2; // booker is guest 1
  const search = useQuery({
    queryKey: ["coGuestSearch", props.query],
    queryFn: () =>
      api.get<Guest[]>("/guests", { search: props.query, per_page: 8 }),
    enabled: props.query.length >= 2 && props.mode === "existing",
  });
  const results = (search.data ?? []).filter(
    (g) => !props.takenGuestIds.has(g.id),
  );

  // KYC-on-file lookup for a selected existing co-guest. Mirrors the
  // booker's walletQ so every guest card shows the same "KYC ON FILE"
  // summary (photo, verified date, ID last-4, View/Replace) instead of
  // a bare "Selected: name" line.
  const kycQ = useQuery({
    queryKey: ["coGuestKyc", props.selected?.id],
    queryFn: () =>
      api.get<{
        kycVerifiedAt: string | null;
        idProofType: string | null;
        idProofLast4: string | null;
        photoUrl: string | null;
      }>(`/guests/${props.selected!.id}`),
    enabled: !!props.selected?.id && props.mode === "existing",
  });
  const coKycOnFile =
    props.mode === "existing" && !!props.selected && !!kycQ.data?.kycVerifiedAt;

  return (
    <div className="card space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h2 className="font-semibold text-navy">
          Guest {guestNumber}{" "}
          <span className="text-xs text-textSecondary font-normal">
            (optional — skip to book without this guest's KYC)
          </span>
        </h2>
        <div className="flex items-center gap-2 text-xs">
          <button
            type="button"
            className={`px-3 py-1 rounded-sm ${props.mode === "existing" ? "bg-navy text-white" : "bg-gray-100"}`}
            onClick={() => {
              props.onModeChange("existing");
              props.onSelected(null);
            }}
          >
            Existing
          </button>
          <button
            type="button"
            className={`px-3 py-1 rounded-sm ${props.mode === "new" ? "bg-navy text-white" : "bg-gray-100"}`}
            onClick={() => {
              props.onModeChange("new");
              props.onSelected(null);
            }}
          >
            New
          </button>
          {props.canRemove && (
            <button
              type="button"
              onClick={props.onRemove}
              className="ml-1 inline-flex items-center gap-1 px-2 py-1 rounded-sm text-danger hover:bg-danger/10"
              title="Remove this guest"
            >
              <Trash2 className="w-3.5 h-3.5" /> Remove
            </button>
          )}
        </div>
      </div>
      <div className="text-xs text-textSecondary -mt-1">
        With 2 or more adults, each additional guest's KYC is required by law.
      </div>

      {props.mode === "existing" ? (
        <div className="space-y-2">
          <input
            className="input"
            placeholder="Search by phone or name (min 2 chars)"
            value={props.query}
            onChange={(e) => props.setQuery(e.target.value)}
          />
          {props.selected && (
            <div className="text-sm text-success">
              Selected: <strong>{props.selected.fullName}</strong> ({props.selected.phone})
              <button
                type="button"
                className="ml-3 text-xs text-danger hover:underline"
                onClick={() => props.onSelected(null)}
              >
                Clear
              </button>
              {props.selected.gstin && (
                <div className="text-xs text-textSecondary font-mono">
                  GSTIN: {props.selected.gstin}
                </div>
              )}
            </div>
          )}
          {coKycOnFile && props.selected && kycQ.data && (
            <div className="card">
              <KycOnFileCard
                guestId={props.selected.id}
                guestName={props.selected.fullName}
                verifiedAt={kycQ.data.kycVerifiedAt!}
                idProofType={kycQ.data.idProofType}
                idProofLast4={kycQ.data.idProofLast4}
                photoUrl={kycQ.data.photoUrl}
                kycFront={props.kycFront}
                setKycFront={props.setKycFront}
                kycBack={props.kycBack}
                setKycBack={props.setKycBack}
                kycPhoto={props.kycPhoto}
                setKycPhoto={props.setKycPhoto}
              />
            </div>
          )}
          {!props.selected && results.length > 0 && (
            <ul className="border border-borderc rounded divide-y divide-borderc">
              {results.map((g) => (
                <li
                  key={g.id}
                  className="px-3 py-2 hover:bg-bg cursor-pointer text-sm"
                  onClick={() => props.onSelected(g)}
                >
                  <span className="font-medium">{g.fullName}</span>{" "}
                  <span className="text-textSecondary">· {g.phone}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="label block mb-1">
                Full name <span className="text-danger">*</span>
              </label>
              <input
                className="input"
                value={f.fullName}
                onChange={(e) => setF({ fullName: e.target.value })}
              />
            </div>
            <div>
              <label className="label block mb-1">
                Phone <span className="text-danger">*</span>
              </label>
              <input
                className="input"
                type="tel"
                inputMode="numeric"
                maxLength={10}
                value={f.phone}
                onChange={(e) =>
                  setF({ phone: e.target.value.replace(/\D/g, "").slice(0, 10) })
                }
                placeholder="9876543210"
              />
            </div>
            <div>
              <label className="label block mb-1">
                Email{" "}
                <span className="text-xs text-textSecondary font-normal">(optional)</span>
              </label>
              <EmailInput value={f.email} onChange={(v) => setF({ email: v })} />
            </div>
            <div>
              <label className="label block mb-1">
                Gender <span className="text-danger">*</span>
              </label>
              <select
                className="input"
                value={f.gender}
                onChange={(e) =>
                  setF({ gender: e.target.value as typeof f.gender })
                }
              >
                <option value="">Select gender…</option>
                <option value="male">Male</option>
                <option value="female">Female</option>
                <option value="other">Other</option>
                <option value="prefer_not_to_say">Prefer not to say</option>
              </select>
            </div>
            <div>
              <label className="label block mb-1">
                ID Type <span className="text-danger">*</span>
              </label>
              <select
                className="input"
                value={f.idProofType}
                onChange={(e) =>
                  setF({
                    idProofType: e.target.value as typeof f.idProofType,
                  })
                }
              >
                <option value="aadhaar">Aadhaar</option>
                <option value="pan">PAN</option>
                <option value="passport">Passport</option>
                <option value="driving_license">Driving License</option>
                <option value="voter_id">Voter ID</option>
              </select>
            </div>
            <div>
              <label className="label block mb-1">
                ID Number <span className="text-danger">*</span>
              </label>
              <input
                className="input"
                value={f.idProofNumber}
                onChange={(e) => setF({ idProofNumber: e.target.value })}
              />
            </div>
            <div>
              <label className="label block mb-1">
                Nationality <span className="text-danger">*</span>
              </label>
              <input
                className="input"
                value={f.nationality}
                onChange={(e) => setF({ nationality: e.target.value })}
              />
            </div>
            <div>
              <label className="label block mb-1">
                State <span className="text-danger">*</span>
              </label>
              <Combobox
                value={f.state}
                onChange={(v) =>
                  // Wipe city when state changes so the city dropdown
                  // doesn't keep a stale value from the previous state.
                  setF({ state: v, city: f.state === v ? f.city : "" })
                }
                groups={[
                  { label: "States", options: INDIAN_STATES },
                  { label: "Union Territories", options: INDIAN_UNION_TERRITORIES },
                ]}
                placeholder="Type to search or pick from list…"
              />
            </div>
            <div>
              <label className="label block mb-1">
                City <span className="text-danger">*</span>
              </label>
              <Combobox
                value={f.city}
                onChange={(v) => setF({ city: v })}
                options={citiesForState(f.state)}
                placeholder={
                  f.state
                    ? `Type to search ${f.state} cities…`
                    : "Pick a state first, or type any city…"
                }
              />
            </div>
            <div className="sm:col-span-2">
              <label className="label block mb-1">
                Address <span className="text-danger">*</span>
              </label>
              <input
                className="input"
                value={f.address}
                onChange={(e) => setF({ address: e.target.value })}
              />
            </div>
            <div className="sm:col-span-2">
              <label className="label block mb-1">
                GSTIN{" "}
                <span className="text-xs text-textSecondary font-normal">(optional)</span>
              </label>
              <input
                className="input font-mono uppercase"
                value={f.gstin}
                placeholder="22AAAAA0000A1Z5"
                onChange={(e) => setF({ gstin: e.target.value.toUpperCase() })}
              />
            </div>
          </div>

          <div className="pt-2 border-t border-borderc">
            <div className="text-[11px] uppercase tracking-wider text-textSecondary font-semibold mb-2">
              KYC Documents · Guest {guestNumber} (optional)
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <KycFilePicker
                label="Customer Photo"
                file={props.kycPhoto}
                onChange={props.setKycPhoto}
                required
              />
              <KycFilePicker
                label="ID Front"
                file={props.kycFront}
                onChange={props.setKycFront}
                required
              />
              <KycFilePicker
                label="ID Back"
                file={props.kycBack}
                onChange={props.setKycBack}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
