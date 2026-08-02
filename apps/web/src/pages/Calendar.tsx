import { useQuery } from "@tanstack/react-query";
import {
  addMonths,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  isSameDay,
  isSameMonth,
  isToday,
  parseISO,
  startOfMonth,
  startOfWeek,
  subMonths,
} from "date-fns";
import { RESERVATION_STATUSES, type ReservationStatus } from "@stayvia/shared";
import { CalendarDays, ChevronLeft, ChevronRight, Gift, X } from "@/lib/micons";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Loader } from "@/components/Loader";
import { api } from "@/lib/api";

interface CalendarBooking {
  id: string;
  reservationNumber: string;
  status: ReservationStatus;
  bookingSource: string | null;
  stayType: "overnight" | "short_stay" | null;
  durationHours: string | null;
  checkInDate: string;
  checkOutDate: string;
  guestName: string;
  roomNumbers: string;
}

// Status → chip colour. Warm Concierge semantic triads; checked-in is the
// one legitimate dark chip (matches the prototype's calendar).
const STATUS_STYLES: Record<ReservationStatus, string> = {
  inquiry: "bg-neutralBg text-inkMuted border-neutralBorder",
  hold: "bg-infoBg text-info border-infoBorder",
  pending_payment: "bg-warnBg text-warnDeep border-warnBorder",
  confirmed: "bg-gold/20 text-warnFg border-gold/40",
  checked_in: "bg-inkDark text-cream border-inkDark",
  checked_out: "bg-neutralBg text-inkMuted border-neutralBorder",
  cancelled: "bg-dangerBg text-dangerFg border-dangerBorder",
  no_show: "bg-warnBg text-warnDeep border-warnBorder",
};

const STATUS_LABELS: Record<ReservationStatus, string> = {
  inquiry: "Enquiry",
  hold: "Held",
  pending_payment: "Payment due",
  confirmed: "Confirmed",
  checked_in: "Checked-in",
  checked_out: "Checked-out",
  cancelled: "Cancelled",
  no_show: "No-show",
};

// The bundled client can be older than the API, so never trust the map to
// have the value — fall back to a neutral chip and a readable label.
const FALLBACK_STYLE = "bg-neutralBg text-inkMuted border-neutralBorder";
const statusStyle = (s: ReservationStatus) => STATUS_STYLES[s] ?? FALLBACK_STYLE;
const statusLabel = (s: ReservationStatus) => {
  const known = STATUS_LABELS[s];
  if (known) return known;
  const words = String(s).replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
};

// Legend rows: the five everyday statuses always, plus any other status that
// actually occurs this month — so the swatches always account for the
// "N bookings in <month>" total in the header.
const CORE_STATUSES: readonly ReservationStatus[] = [
  "confirmed",
  "checked_in",
  "checked_out",
  "cancelled",
  "no_show",
];

// Day-use bookings store the same date in checkInDate and checkOutDate; we
// still need them to render on that single day, so we accept inclusive
// overlap by checking <= and >=.
function bookingTouchesDay(b: CalendarBooking, day: Date): boolean {
  const dayStr = format(day, "yyyy-MM-dd");
  return b.checkInDate <= dayStr && b.checkOutDate >= dayStr;
}

export default function CalendarPage() {
  const navigate = useNavigate();
  const [cursor, setCursor] = useState(() => startOfMonth(new Date()));
  // Clicking a day opens its bookings in a modal; null = closed. Starts
  // closed — the grid alone is the landing view.
  const [selectedDay, setSelectedDay] = useState<Date | null>(null);

  const monthParam = format(cursor, "yyyy-MM");

  const { data, isLoading } = useQuery({
    queryKey: ["calendar", monthParam],
    queryFn: () =>
      api.get<{
        month: string;
        firstDay: string;
        lastDay: string;
        bookings: CalendarBooking[];
      }>("/calendar", { month: monthParam }),
    refetchInterval: 60_000,
  });

  // Wrap in useMemo so the `?? []` fallback returns the SAME array
  // reference between renders when the API result hasn't changed.
  // Without this, every render produces a fresh `[]` and the
  // downstream byDay / totals memos invalidate on every keystroke.
  const bookings = useMemo(() => data?.bookings ?? [], [data?.bookings]);

  // Grid is the displayed month padded out to whole weeks (Mon-start). So
  // April starts with a couple of greyed-out March days on the leading row.
  const days = useMemo(() => {
    const monthStart = startOfMonth(cursor);
    const monthEnd = endOfMonth(cursor);
    return eachDayOfInterval({
      start: startOfWeek(monthStart, { weekStartsOn: 1 }),
      end: endOfWeek(monthEnd, { weekStartsOn: 1 }),
    });
  }, [cursor]);

  // Build a per-day bucket once so each cell render is O(bookings_today),
  // not O(total_bookings).
  const byDay = useMemo(() => {
    const m = new Map<string, CalendarBooking[]>();
    for (const day of days) {
      const key = format(day, "yyyy-MM-dd");
      m.set(
        key,
        bookings.filter((b) => bookingTouchesDay(b, day)),
      );
    }
    return m;
  }, [days, bookings]);

  // Counts under the month header — useful "is this a busy month" cue.
  const totals = useMemo(() => {
    const byStatus: Record<string, number> = {};
    for (const b of bookings) byStatus[b.status] = (byStatus[b.status] ?? 0) + 1;
    return { total: bookings.length, byStatus };
  }, [bookings]);

  const legendStatuses = useMemo(
    () =>
      RESERVATION_STATUSES.filter(
        (s) => CORE_STATUSES.includes(s) || (totals.byStatus[s] ?? 0) > 0,
      ),
    [totals.byStatus],
  );

  const selectedKey = selectedDay ? format(selectedDay, "yyyy-MM-dd") : null;
  const selectedBookings = selectedKey ? byDay.get(selectedKey) ?? [] : [];

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-[clamp(22px,3vw,28px)] font-semibold tracking-[-0.5px] text-ink">
            Calendar
          </h1>
          <div className="text-sm text-textSecondary mt-1.5">
            {totals.total} booking{totals.total === 1 ? "" : "s"} in {format(cursor, "MMMM yyyy")}.
          </div>
        </div>
        <div className="flex items-center gap-2.5 flex-wrap justify-end">
          {/* Prev / Today / Next as a single segmented pill. */}
          <div className="inline-flex rounded-[11px] border border-borderControl overflow-hidden bg-surface shadow-card">
            <button
              onClick={() => setCursor((c) => subMonths(c, 1))}
              className="w-10 h-10 grid place-items-center text-textSecondary hover:bg-surfaceAlt transition-colors"
              aria-label="Previous month"
              title="Previous month"
            >
              <ChevronLeft className="w-5 h-5" />
            </button>
            <button
              onClick={() => setCursor(startOfMonth(new Date()))}
              className="h-10 px-4 text-[13.5px] font-semibold border-l border-r border-divider text-ink hover:bg-surfaceAlt transition-colors"
            >
              Today
            </button>
            <button
              onClick={() => setCursor((c) => addMonths(c, 1))}
              className="w-10 h-10 grid place-items-center text-textSecondary hover:bg-surfaceAlt transition-colors"
              aria-label="Next month"
              title="Next month"
            >
              <ChevronRight className="w-5 h-5" />
            </button>
          </div>
          {/* Month picker — same height/border/shadow as the nav pill so
              the two controls visually pair up. */}
          <input
            type="month"
            className="h-10 px-3 text-[13.5px] font-semibold rounded-[11px] border border-borderControl bg-surface text-ink shadow-card cursor-pointer hover:bg-surfaceAlt focus:outline-none focus:border-brand focus:ring-[3px] focus:ring-brand-soft transition-colors"
            value={monthParam}
            onChange={(e) => {
              if (!e.target.value) return;
              setCursor(parseISO(`${e.target.value}-01`));
            }}
            aria-label="Jump to month"
          />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-4">
        {legendStatuses.map((s) => (
          <span key={s} className="inline-flex items-center gap-1.5 text-xs text-inkBody">
            <span className={`inline-block w-3 h-3 rounded-[4px] border ${statusStyle(s)}`} />
            <span>
              {statusLabel(s)}
              {totals.byStatus[s] ? (
                <span className="text-inkMuted"> · {totals.byStatus[s]}</span>
              ) : null}
            </span>
          </span>
        ))}
      </div>

      {isLoading ? (
        <Loader label="Loading calendar…" />
      ) : (
        <div className="card !p-0 overflow-hidden">
          {/* Weekday header. Monday-start matches Indian hospitality norm. */}
          <div className="grid grid-cols-7 bg-surfaceAlt border-b border-divider">
            {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
              <div
                key={d}
                className="text-[10.5px] tracking-[0.08em] uppercase text-inkMuted px-1 py-2.5 text-center font-bold"
              >
                {d}
              </div>
            ))}
          </div>

          <div className="grid grid-cols-7">
            {days.map((day) => {
              const key = format(day, "yyyy-MM-dd");
              const inMonth = isSameMonth(day, cursor);
              const isSelected = selectedDay && isSameDay(day, selectedDay);
              const dayBookings = byDay.get(key) ?? [];
              const visible = dayBookings.slice(0, 3);
              const overflow = dayBookings.length - visible.length;
              return (
                <button
                  key={key}
                  onClick={() => setSelectedDay(day)}
                  className={`group relative text-left min-h-[72px] sm:min-h-[112px] p-1 sm:p-[7px] border-r border-b border-divider last:border-r-0 flex flex-col gap-0.5 sm:gap-1 transition-colors ${
                    inMonth ? "bg-surface" : "bg-surfaceAlt"
                  } ${isSelected ? "ring-2 ring-brand ring-inset" : ""} hover:bg-brand-softer`}
                >
                  <div className="flex items-center justify-between">
                    <span
                      className={`text-xs font-semibold min-w-[22px] h-[22px] inline-flex items-center justify-center ${
                        isToday(day)
                          ? "bg-brand text-white rounded-full"
                          : inMonth
                          ? "text-ink"
                          : "text-inkFaint"
                      }`}
                    >
                      {format(day, "d")}
                    </span>
                    {dayBookings.length > 0 && (
                      <span className="text-[10px] font-mono text-inkFaint">
                        {dayBookings.length}
                      </span>
                    )}
                  </div>
                  <div className="flex flex-col gap-0.5 overflow-hidden">
                    {visible.map((b) => (
                      <span
                        key={b.id}
                        className={`text-[10px] leading-tight px-1.5 py-0.5 rounded-[6px] border truncate ${statusStyle(b.status)}`}
                        title={`${b.reservationNumber} · ${b.guestName}${b.roomNumbers ? ` · Room ${b.roomNumbers}` : ""}`}
                      >
                        {b.bookingSource === "complimentary" && (
                          <Gift className="inline-block w-2.5 h-2.5 mr-0.5 -mt-px" />
                        )}
                        {b.roomNumbers ? `${b.roomNumbers} ` : ""}
                        {b.guestName}
                      </span>
                    ))}
                    {overflow > 0 && (
                      <span className="text-[10px] text-inkMuted pl-1">
                        +{overflow} more
                      </span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Per-day detail modal. Opens on day click — right where the staff
          is looking, instead of a panel below the grid they'd have to
          scroll to. Backdrop / X closes. */}
      {selectedDay && (
        <div
          className="fixed inset-0 bg-inkDark/50 backdrop-blur-[3px] flex items-center justify-center z-50 p-4"
          onClick={() => setSelectedDay(null)}
        >
          <div
            className="bg-surface rounded-2xl shadow-modal w-full max-w-3xl max-h-[85vh] flex flex-col overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="flex items-center justify-between gap-3 px-6 py-4 border-b border-divider bg-surfaceAlt shrink-0">
              <div className="flex items-center gap-3">
                <span className="grid place-items-center w-10 h-10 rounded-md bg-brand text-white font-mono font-semibold">
                  {format(selectedDay, "d")}
                </span>
                <div>
                  <h2 className="text-lg font-semibold text-ink leading-tight">
                    {format(selectedDay, "EEEE, d MMMM yyyy")}
                  </h2>
                  <div className="text-xs text-textSecondary">
                    {selectedBookings.length === 0
                      ? "No bookings"
                      : `${selectedBookings.length} booking${selectedBookings.length === 1 ? "" : "s"}`}
                  </div>
                </div>
              </div>
              <button
                onClick={() => setSelectedDay(null)}
                className="grid place-items-center w-8 h-8 rounded-md text-textSecondary hover:text-ink hover:bg-parchment transition-colors"
                aria-label="Close"
              >
                <X className="w-4 h-4" />
              </button>
            </header>
            <div className="overflow-y-auto px-6 py-2">
              {selectedBookings.length === 0 ? (
                <div className="py-12 text-center text-textSecondary">
                  <CalendarDays className="w-8 h-8 mx-auto mb-2 opacity-40" />
                  <div className="text-sm">No bookings on this day.</div>
                </div>
              ) : (
                <ul className="divide-y divide-divider">
                  {selectedBookings.map((b) => {
                    const sameDay = b.checkInDate === b.checkOutDate;
                    const isDayUse = b.stayType === "short_stay";
                    const stayLabel = isDayUse
                      ? `Day use${b.durationHours ? ` · ${Number(b.durationHours)}h` : ""}`
                      : sameDay
                        ? format(parseISO(b.checkInDate), "dd MMM")
                        : `${format(parseISO(b.checkInDate), "dd MMM")} → ${format(parseISO(b.checkOutDate), "dd MMM")}`;
                    const roomChips = b.roomNumbers
                      ? b.roomNumbers.split(",").map((r) => r.trim()).filter(Boolean)
                      : [];
                    return (
                      <li
                        key={b.id}
                        onClick={() => navigate(`/reservations/${b.reservationNumber}`)}
                        className="group py-3.5 flex items-center gap-4 cursor-pointer hover:bg-surfaceAlt -mx-3 px-3 rounded-sm transition-colors"
                      >
                        <span
                          className={`w-24 text-center text-[10px] font-semibold px-2 py-1 rounded-full border shrink-0 ${statusStyle(b.status)}`}
                        >
                          {statusLabel(b.status)}
                        </span>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-semibold text-ink flex items-center gap-1.5 truncate">
                            {b.guestName}
                            {b.bookingSource === "complimentary" && (
                              <span className="inline-flex items-center gap-0.5 text-[10px] font-medium text-success shrink-0">
                                <Gift className="w-3 h-3" /> Comp
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                            <span className="text-[11px] text-textSecondary font-mono">
                              {b.reservationNumber}
                            </span>
                            {roomChips.map((r) => (
                              <span
                                key={r}
                                className="text-[10px] font-mono font-semibold px-1.5 py-0.5 rounded-full bg-brand-soft text-brand-deep"
                              >
                                {r}
                              </span>
                            ))}
                          </div>
                        </div>
                        <div className="text-xs text-textSecondary font-medium text-right shrink-0">
                          {stayLabel}
                        </div>
                        <ChevronRight className="w-4 h-4 text-inkFaint group-hover:text-brand-deep transition-colors shrink-0" />
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
