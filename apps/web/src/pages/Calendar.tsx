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
import { CalendarDays, ChevronLeft, ChevronRight, Gift, X } from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Loader } from "@/components/Loader";
import { api } from "@/lib/api";

interface CalendarBooking {
  id: string;
  reservationNumber: string;
  status:
    | "confirmed"
    | "checked_in"
    | "checked_out"
    | "cancelled"
    | "no_show";
  bookingSource: string | null;
  stayType: "overnight" | "short_stay" | null;
  durationHours: string | null;
  checkInDate: string;
  checkOutDate: string;
  guestName: string;
  roomNumbers: string;
}

// Status → pill colour. Brand palette + standard semantic hints.
const STATUS_STYLES: Record<CalendarBooking["status"], string> = {
  confirmed: "bg-brass/15 text-brand-dark border-brass/40",
  checked_in: "bg-brand-dark text-cream border-brand-dark",
  checked_out: "bg-bg text-textSecondary border-borderc",
  cancelled: "bg-danger/10 text-danger border-danger/30 line-through",
  no_show: "bg-warning/15 text-warning border-warning/40",
};

const STATUS_LABELS: Record<CalendarBooking["status"], string> = {
  confirmed: "Confirmed",
  checked_in: "Checked-in",
  checked_out: "Checked-out",
  cancelled: "Cancelled",
  no_show: "No-show",
};

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

  const selectedKey = selectedDay ? format(selectedDay, "yyyy-MM-dd") : null;
  const selectedBookings = selectedKey ? byDay.get(selectedKey) ?? [] : [];

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-navy">Calendar</h1>
          <div className="text-xs text-textSecondary mt-0.5">
            {totals.total} booking{totals.total === 1 ? "" : "s"} in {format(cursor, "MMMM yyyy")}
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap justify-end">
          {/* Prev / Today / Next as a single segmented pill. */}
          <div className="inline-flex rounded-md border border-borderc overflow-hidden shadow-sm">
            <button
              onClick={() => setCursor((c) => subMonths(c, 1))}
              className="px-2 py-2 bg-surface text-textSecondary hover:bg-bg hover:text-brand-dark transition-colors"
              aria-label="Previous month"
              title="Previous month"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <button
              onClick={() => setCursor(startOfMonth(new Date()))}
              className="px-3 py-2 text-sm font-medium border-l border-r border-borderc bg-surface text-brand-dark hover:bg-bg transition-colors"
            >
              Today
            </button>
            <button
              onClick={() => setCursor((c) => addMonths(c, 1))}
              className="px-2 py-2 bg-surface text-textSecondary hover:bg-bg hover:text-brand-dark transition-colors"
              aria-label="Next month"
              title="Next month"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
          {/* Month picker — same height/border/shadow as the nav pill so
              the two controls visually pair up. */}
          <input
            type="month"
            className="h-[38px] px-3 text-sm rounded-md border border-borderc bg-surface text-brand-dark shadow-sm cursor-pointer hover:bg-bg focus:outline-none focus:ring-2 focus:ring-brand-dark/30"
            value={monthParam}
            onChange={(e) => {
              if (!e.target.value) return;
              setCursor(parseISO(`${e.target.value}-01`));
            }}
            aria-label="Jump to month"
          />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3 text-[11px]">
        {(["confirmed", "checked_in", "checked_out", "cancelled", "no_show"] as const).map((s) => (
          <span key={s} className="inline-flex items-center gap-1.5">
            <span className={`inline-block w-3 h-3 rounded border ${STATUS_STYLES[s]}`} />
            <span className="text-textSecondary">
              {STATUS_LABELS[s]}
              {totals.byStatus[s] ? ` · ${totals.byStatus[s]}` : ""}
            </span>
          </span>
        ))}
      </div>

      {isLoading ? (
        <Loader label="Loading calendar…" />
      ) : (
        <div className="card !p-0 overflow-hidden">
          {/* Weekday header. Monday-start matches Indian hospitality norm. */}
          <div className="grid grid-cols-7 bg-brand-soft/40 border-b border-borderc">
            {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
              <div
                key={d}
                className="text-[11px] tracking-wider uppercase text-textSecondary px-2 py-2 text-center font-semibold"
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
                  className={`group relative text-left min-h-[72px] sm:min-h-[110px] p-1 sm:p-1.5 border-r border-b border-borderc last:border-r-0 flex flex-col gap-0.5 sm:gap-1 transition-colors ${
                    inMonth ? "bg-surface" : "bg-bg/60"
                  } ${isSelected ? "ring-2 ring-brand-dark ring-inset" : ""} hover:bg-brand-soft/30`}
                >
                  <div className="flex items-center justify-between">
                    <span
                      className={`text-xs font-semibold ${
                        isToday(day)
                          ? "bg-brand-dark text-cream rounded-full w-6 h-6 grid place-items-center"
                          : inMonth
                          ? "text-brand-dark"
                          : "text-textSecondary/60"
                      }`}
                    >
                      {format(day, "d")}
                    </span>
                    {dayBookings.length > 0 && (
                      <span className="text-[10px] font-mono text-textSecondary">
                        {dayBookings.length}
                      </span>
                    )}
                  </div>
                  <div className="flex flex-col gap-0.5 overflow-hidden">
                    {visible.map((b) => (
                      <span
                        key={b.id}
                        className={`text-[10px] leading-tight px-1.5 py-0.5 rounded border truncate ${STATUS_STYLES[b.status]}`}
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
                      <span className="text-[10px] text-textSecondary pl-1">
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
          className="fixed inset-0 bg-black/50 backdrop-blur-[2px] flex items-center justify-center z-50 p-4"
          onClick={() => setSelectedDay(null)}
        >
          <div
            className="bg-surface rounded-lg shadow-2xl w-full max-w-3xl max-h-[85vh] flex flex-col overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="flex items-center justify-between gap-3 px-6 py-4 border-b border-borderc bg-brand-soft/30 shrink-0">
              <div className="flex items-center gap-3">
                <span className="grid place-items-center w-10 h-10 rounded-md bg-brand-dark text-cream font-bold">
                  {format(selectedDay, "d")}
                </span>
                <div>
                  <h2 className="text-lg font-semibold text-navy leading-tight">
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
                className="grid place-items-center w-8 h-8 rounded-md text-textSecondary hover:text-brand-dark hover:bg-bg transition-colors"
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
                <ul className="divide-y divide-borderc">
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
                        className="group py-3.5 flex items-center gap-4 cursor-pointer hover:bg-bg -mx-3 px-3 rounded-sm transition-colors"
                      >
                        <span
                          className={`w-24 text-center text-[10px] font-semibold px-2 py-1 rounded border shrink-0 ${STATUS_STYLES[b.status]}`}
                        >
                          {STATUS_LABELS[b.status]}
                        </span>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-semibold text-navy flex items-center gap-1.5 truncate">
                            {b.guestName}
                            {b.bookingSource === "complimentary" && (
                              <span className="inline-flex items-center gap-0.5 text-[10px] font-medium text-[#157f5f] shrink-0">
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
                                className="text-[10px] font-mono font-semibold px-1.5 py-0.5 rounded-sm bg-brand-soft text-brand-dark"
                              >
                                {r}
                              </span>
                            ))}
                          </div>
                        </div>
                        <div className="text-xs text-textSecondary font-medium text-right shrink-0">
                          {stayLabel}
                        </div>
                        <ChevronRight className="w-4 h-4 text-textSecondary/40 group-hover:text-brand-dark transition-colors shrink-0" />
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
