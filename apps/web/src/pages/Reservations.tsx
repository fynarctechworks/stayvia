import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import {
  CalendarPlus,
  ChevronRight,
  Clock,
  DoorOpen,
  Search,
  UserPlus,
} from "@/lib/micons";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  DatePresetBar,
  rangeForPreset,
  type DatePresetKey,
} from "@/components/DatePresetBar";
import { Loader } from "@/components/Loader";
import { StickyBar } from "@/components/StickyBar";
import { StatusBadge } from "@/components/StatusBadge";
import { api } from "@/lib/api";
import { inr } from "@/lib/utils";

interface Reservation {
  id: string;
  reservationNumber: string;
  guestId: string;
  guestName: string;
  guestPhone?: string;
  // Signed URL for the guest's customer photo from KYC. Null until KYC is
  // captured — the card falls back to a coloured-initials avatar.
  guestPhotoUrl?: string | null;
  checkInDate: string;
  checkOutDate: string;
  checkedInAt: string | null;
  checkedOutAt: string | null;
  // 0023 — staff-chosen planned arrival / departure clock times.
  // Preferred over hotel policy when present and the guest hasn't
  // actually checked in / out yet.
  plannedCheckInAt?: string | null;
  plannedCheckOutAt?: string | null;
  numNights: number;
  // Day-use bookings: stayType='short_stay' + durationHours. The card shows
  // "Day use · Nh" instead of the night count.
  stayType?: "overnight" | "short_stay";
  durationHours?: string | null;
  // Late-checkout grant in hours, accumulates with each grant. Used to
  // compute the effective overnight check-out time on the card.
  lateCheckoutHours?: string | null;
  // Comma-joined room numbers from the API list endpoint subquery.
  roomNumbers?: string;
  grandTotal: string;
  balanceDue: string;
  status: string;
  createdAt: string;
}

interface PublicSettings {
  checkInTime: string;
  checkOutTime: string;
}

// Renders an "HH:MM" hotel time like "12:00" as "12:00 PM" without a date
// dependency. Used as the fallback when we don't have a real checkedInAt
// timestamp yet.
function formatHotelTime(hhmm: string | undefined | null): string {
  if (!hhmm) return "";
  const [hStr, mStr] = hhmm.split(":");
  const h = Number(hStr);
  const m = mStr ?? "00";
  const period = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${m.padStart(2, "0")} ${period}`;
}

const STATUS_OPTIONS = [
  "confirmed",
  "checked_in",
  "checked_out",
  "cancelled",
  "no_show",
];

export default function Reservations() {
  const navigate = useNavigate();
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  // Default to today. The preset bar updates dateFrom/dateTo when staff
  // picks Week / Month / Year / Custom; the `preset` key drives which
  // pill looks active.
  const initialRange = rangeForPreset("today")!;
  const [preset, setPreset] = useState<DatePresetKey>("today");
  const [dateFrom, setDateFrom] = useState(initialRange.from);
  const [dateTo, setDateTo] = useState(initialRange.to);
  // floor + roomId filters. Empty string = "all". roomId is a UUID we
  // ship to the API; floor is a number coerced server-side from the
  // query string.
  const [floor, setFloor] = useState("");
  const [roomId, setRoomId] = useState("");

  // Rooms list for the picker. Cheap — small property — and the
  // dropdown options need both id (for the API filter) + number/floor
  // (for the label). We compute the floor list off this same response
  // so we don't keep two queries in sync.
  const roomsQ = useQuery({
    queryKey: ["rooms-min"],
    queryFn: () =>
      api.get<{ id: string; roomNumber: string; floor: number }[]>("/rooms"),
    staleTime: 5 * 60_000,
  });
  const allRooms = roomsQ.data ?? [];
  const floors = Array.from(new Set(allRooms.map((r) => r.floor))).sort(
    (a, b) => a - b,
  );
  // When a floor is selected, narrow the room picker to that floor so
  // the two filters are visibly consistent (and the user doesn't pick
  // a room that contradicts the floor).
  const roomOptions = floor
    ? allRooms.filter((r) => String(r.floor) === floor)
    : allRooms;

  const { data = [], isLoading } = useQuery({
    queryKey: ["reservations", { status, q, dateFrom, dateTo, floor, roomId }],
    queryFn: () =>
      api.get<Reservation[]>("/reservations", {
        status: status || undefined,
        q: q || undefined,
        date_from: dateFrom || undefined,
        date_to: dateTo || undefined,
        // floor is a number on the server; pass it as string and let
        // zod's z.coerce handle the conversion.
        floor: floor || undefined,
        room_id: roomId || undefined,
      }),
  });

  // Hotel-policy times. We fall back to these when a reservation hasn't been
  // checked in yet (so we can't show the real timestamp).
  const settingsQ = useQuery({
    queryKey: ["settings-public"],
    queryFn: () => api.get<PublicSettings>("/settings/public"),
    staleTime: 5 * 60_000,
  });
  const hotelCheckInTime = settingsQ.data?.checkInTime ?? "12:00";
  const hotelCheckOutTime = settingsQ.data?.checkOutTime ?? "11:00";

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-brand-dark">Reservations</h1>
          <p className="text-xs text-textSecondary mt-0.5">
            {data.length} reservation{data.length === 1 ? "" : "s"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => navigate("/reservations/new?mode=booking")}
            className="btn-secondary inline-flex items-center gap-2"
          >
            <CalendarPlus className="w-4 h-4" /> Pre-booking
          </button>
          <button
            onClick={() => navigate("/reservations/new?mode=walkin")}
            className="btn-primary inline-flex items-center gap-2"
          >
            <UserPlus className="w-4 h-4" /> Walk-in
          </button>
        </div>
      </div>

      <StickyBar>
      <div className="card flex flex-wrap gap-3 items-end">
        {/* Search input takes a full row on phones for clarity, then
            flexes back into the wrap-row on sm+. */}
        <div className="w-full sm:flex-1 sm:min-w-[200px]">
          <label className="label block mb-1">Search</label>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-textSecondary" />
            <input
              className="input pl-9"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search by name, phone number or RES-…"
            />
          </div>
        </div>
        <div className="flex-1 min-w-[120px] sm:flex-none">
          <label className="label block mb-1">Status</label>
          <select
            className="input sm:w-40"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="">All</option>
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {s.replace("_", " ")}
              </option>
            ))}
          </select>
        </div>
        <div className="flex-1 min-w-[80px] sm:flex-none">
          <label className="label block mb-1">Floor</label>
          <select
            className="input sm:w-28"
            value={floor}
            onChange={(e) => {
              const next = e.target.value;
              setFloor(next);
              // If the currently picked room isn't on the new floor,
              // clear it so the two filters don't contradict.
              if (next && roomId) {
                const ok = allRooms.find((r) => r.id === roomId && String(r.floor) === next);
                if (!ok) setRoomId("");
              }
            }}
          >
            <option value="">All</option>
            {floors.map((f) => (
              <option key={f} value={f}>
                F{f}
              </option>
            ))}
          </select>
        </div>
        <div className="flex-1 min-w-[120px] sm:flex-none">
          <label className="label block mb-1">Room</label>
          <select
            className="input sm:w-32"
            value={roomId}
            onChange={(e) => setRoomId(e.target.value)}
          >
            <option value="">All</option>
            {roomOptions.map((r) => (
              <option key={r.id} value={r.id}>
                {r.roomNumber}
                {!floor ? ` · F${r.floor}` : ""}
              </option>
            ))}
          </select>
        </div>
        {(status || q || floor || roomId || preset !== "today") && (
          <button
            onClick={() => {
              setStatus("");
              setQ("");
              setFloor("");
              setRoomId("");
              const r = rangeForPreset("today")!;
              setPreset("today");
              setDateFrom(r.from);
              setDateTo(r.to);
            }}
            className="text-xs text-accentBlue hover:underline self-end pb-2"
          >
            Reset filters
          </button>
        )}
      </div>

      {/* Quick range presets — Today / Week / Month / Year / Custom.
          Filters the list by check-in date inside the picked window. */}
      <div className="card !py-2.5">
        <DatePresetBar
          preset={preset}
          from={dateFrom}
          to={dateTo}
          onChange={(next) => {
            setPreset(next.preset);
            setDateFrom(next.from);
            setDateTo(next.to);
          }}
        />
      </div>
      </StickyBar>

      {isLoading ? (
        <Loader />
      ) : data.length === 0 ? (
        <div className="card text-textSecondary text-center py-10">
          No reservations match these filters.
        </div>
      ) : (
        // Single-column dense list. One row per reservation; all the
        // info reads left-to-right at a glance. Hover shows the right-
        // chevron so the row clearly behaves as a link.
        <div className="card !p-0 overflow-hidden">
          {/* Column header (desktop only). Keeps the row layout legible
              at scale without the per-row "Check-in / Check-out / Nights"
              labels that bloated the old grid. */}
          <div className="hidden md:grid grid-cols-[40px_minmax(180px,1fr)_140px_140px_60px_minmax(120px,1fr)_120px_120px_28px] gap-3 px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-textSecondary bg-bg/60 border-b border-borderc">
            <div />
            <div>Guest</div>
            <div>Check-in</div>
            <div>Check-out</div>
            <div className="text-center">Nights</div>
            <div>Rooms</div>
            <div className="text-right">Total</div>
            <div className="text-right">Balance</div>
            <div />
          </div>
          <ul className="divide-y divide-borderc">
            {data.map((r) => (
              <ReservationRow
                key={r.id}
                r={r}
                hotelCheckInTime={hotelCheckInTime}
                hotelCheckOutTime={hotelCheckOutTime}
                onOpen={() => navigate(`/reservations/${r.reservationNumber}`)}
              />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// Two-char initials from a guest's full name. Same look as Guests page.
function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

// Stable color tone hashed off the seed, so the same guest always gets the
// same avatar shade across pages.
function avatarTone(seed: string): string {
  const tones = [
    "bg-[#24b47e] text-white",
    "bg-[#644fc1] text-white",
    "bg-[#2563eb] text-white",
    "bg-brand text-textPrimary",
    "bg-[#e2005a] text-white",
    "bg-[#157f5f] text-white",
  ];
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return tones[h % tones.length]!;
}

// Dense single-row layout. Desktop renders an 8-column grid that
// matches the header strip; mobile falls back to a stacked card with
// the same data. One row reads at a glance — guest + dates + rooms +
// balance — and clicking anywhere on the row opens the reservation.
function ReservationRow({
  r,
  hotelCheckInTime,
  hotelCheckOutTime,
  onOpen,
}: {
  r: Reservation;
  hotelCheckInTime: string;
  hotelCheckOutTime: string;
  onOpen: () => void;
}) {
  const isShort = r.stayType === "short_stay";
  const dur = Number(r.durationHours ?? 0);
  const bal = Number(r.balanceDue);
  const hasBalance = bal > 0.009;
  const rooms = r.roomNumbers ? r.roomNumbers.split(",").filter(Boolean) : [];

  // Check-in time priority (0023): real checkedInAt > staff-chosen
  // planned time > hotel policy default.
  const checkInTimeLabel = r.checkedInAt
    ? format(new Date(r.checkedInAt), "h:mm a")
    : r.plannedCheckInAt
      ? format(new Date(r.plannedCheckInAt), "h:mm a")
      : formatHotelTime(hotelCheckInTime);
  // Check-out time, accounting for short_stay duration + late-checkout grant.
  // Same priority: actual > planned > policy/late-grant.
  const checkOutTimeLabel = (() => {
    if (r.checkedOutAt) return format(new Date(r.checkedOutAt), "h:mm a");
    if (isShort && r.checkedInAt && dur > 0) {
      return format(
        new Date(new Date(r.checkedInAt).getTime() + Math.round(dur * 3600 * 1000)),
        "h:mm a",
      );
    }
    if (r.plannedCheckOutAt) {
      return format(new Date(r.plannedCheckOutAt), "h:mm a");
    }
    const grantHours = Number(r.lateCheckoutHours ?? 0);
    if (grantHours <= 0) return formatHotelTime(hotelCheckOutTime);
    const [hh, mm] = hotelCheckOutTime.split(":");
    const base = new Date(
      `${r.checkOutDate}T${(hh ?? "11").padStart(2, "0")}:${(mm ?? "00").padStart(2, "0")}:00`,
    );
    return format(new Date(base.getTime() + Math.round(grantHours * 3600 * 1000)), "h:mm a");
  })();

  return (
    <li
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      className="group cursor-pointer transition-colors hover:bg-brand-soft/30 focus:outline-none focus:bg-brand-soft/30"
    >
      {/* DESKTOP — 8-column grid that mirrors the header. Compact, scannable. */}
      <div className="hidden md:grid grid-cols-[40px_minmax(180px,1fr)_140px_140px_60px_minmax(120px,1fr)_120px_120px_28px] gap-3 items-center px-3 py-2.5">
        {/* Avatar */}
        {r.guestPhotoUrl ? (
          <img
            src={r.guestPhotoUrl}
            alt=""
            className="w-9 h-9 rounded-full object-cover ring-1 ring-borderc bg-bg"
          />
        ) : (
          <div
            className={`w-9 h-9 rounded-full grid place-items-center font-semibold text-xs ${avatarTone(r.guestName)}`}
            aria-hidden="true"
          >
            {initialsOf(r.guestName)}
          </div>
        )}

        {/* Guest + reservation # + status */}
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="font-semibold text-brand-dark text-sm truncate">{r.guestName}</span>
            {isShort && (
              <span
                className="inline-flex items-center gap-0.5 px-1 rounded-sm text-[9px] font-semibold bg-brand/10 text-brand-dark border border-brand/30 shrink-0"
                title={`Day use · ${dur}h`}
              >
                <Clock className="w-2.5 h-2.5" /> {dur}h
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5 mt-0.5">
            <span className="font-mono text-[10px] text-accentBlue">{r.reservationNumber}</span>
            <StatusBadge status={r.status} />
            {r.guestPhone && (
              <span className="text-[10px] text-textSecondary font-mono truncate">{r.guestPhone}</span>
            )}
          </div>
        </div>

        {/* Check-in */}
        <div className="text-xs">
          <div className="text-brand-dark font-medium">{format(new Date(r.checkInDate), "dd MMM")}</div>
          <div className="text-[10px] text-textSecondary font-mono">
            {r.checkedInAt ? checkInTimeLabel : `from ${checkInTimeLabel}`}
          </div>
        </div>

        {/* Check-out */}
        <div className="text-xs">
          <div className="text-brand-dark font-medium">{format(new Date(r.checkOutDate), "dd MMM")}</div>
          <div className="text-[10px] text-textSecondary font-mono">
            {r.checkedOutAt ? checkOutTimeLabel : `by ${checkOutTimeLabel}`}
          </div>
        </div>

        {/* Nights / duration */}
        <div className="text-center text-sm font-medium text-brand-dark">
          {isShort ? `${dur}h` : r.numNights}
        </div>

        {/* Rooms */}
        <div className="flex items-center gap-1 flex-wrap text-[11px]">
          {rooms.length > 0 ? (
            rooms.map((rm) => (
              <span
                key={rm}
                className="font-mono font-semibold text-brand-dark bg-bg px-1.5 py-0.5 rounded border border-borderc"
              >
                {rm}
              </span>
            ))
          ) : (
            <span className="text-textSecondary/60 inline-flex items-center gap-1">
              <DoorOpen className="w-3 h-3" /> -
            </span>
          )}
        </div>

        {/* Total */}
        <div className="text-right text-sm font-mono font-semibold text-brand-dark">
          {inr(r.grandTotal)}
        </div>

        {/* Balance */}
        <div className="text-right">
          <div
            className={`text-sm font-mono font-semibold ${hasBalance ? "text-danger" : "text-success"}`}
          >
            {hasBalance ? inr(r.balanceDue) : "Paid"}
          </div>
        </div>

        <ChevronRight className="w-4 h-4 text-textSecondary/40 group-hover:text-brand justify-self-end" />
      </div>

      {/* MOBILE — stacked card. Same data, two-line layout for phones. */}
      <div className="md:hidden px-3 py-3 flex items-start gap-2">
        {r.guestPhotoUrl ? (
          <img
            src={r.guestPhotoUrl}
            alt=""
            className="w-9 h-9 rounded-full object-cover ring-1 ring-borderc bg-bg shrink-0"
          />
        ) : (
          <div
            className={`w-9 h-9 rounded-full grid place-items-center font-semibold text-xs shrink-0 ${avatarTone(r.guestName)}`}
            aria-hidden="true"
          >
            {initialsOf(r.guestName)}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span className="font-semibold text-brand-dark text-sm truncate">{r.guestName}</span>
            <div
              className={`text-sm font-mono font-semibold shrink-0 ${hasBalance ? "text-danger" : "text-success"}`}
            >
              {hasBalance ? inr(r.balanceDue) : "Paid"}
            </div>
          </div>
          <div className="flex items-center gap-1.5 mt-0.5">
            <span className="font-mono text-[10px] text-accentBlue">{r.reservationNumber}</span>
            <StatusBadge status={r.status} />
          </div>
          <div className="mt-1 text-[11px] text-textSecondary font-mono">
            {format(new Date(r.checkInDate), "dd MMM")} → {format(new Date(r.checkOutDate), "dd MMM")}
            {" · "}
            {isShort ? `${dur}h day-use` : `${r.numNights}n`}
            {rooms.length > 0 ? ` · Rm ${rooms.join(",")}` : ""}
          </div>
        </div>
      </div>
    </li>
  );
}
