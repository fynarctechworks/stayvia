import { useQuery } from "@tanstack/react-query";
import { format, formatDistanceToNow, isToday, isYesterday, startOfMonth, startOfWeek, startOfYear } from "date-fns";
import { Activity as ActivityIcon, Calendar } from "@/lib/micons";
import { useMemo, useState } from "react";
import { QueryError } from "@/components/kit";
import { Loader } from "@/components/Loader";
import { StickyBar } from "@/components/StickyBar";
import { TimePicker12h } from "@/components/TimePicker12h";
import { api } from "@/lib/api";

interface ActivityRow {
  id: string;
  action: string;
  description: string;
  performedBy: string;
  createdAt: string;
}

type RangeKey = "today" | "week" | "month" | "year" | "custom";

function isoDay(d: Date): string {
  // yyyy-MM-dd in the user's local timezone — matches what the API expects.
  return format(d, "yyyy-MM-dd");
}

function rangeForKey(key: RangeKey, customFrom: string, customTo: string) {
  const today = new Date();
  if (key === "today") return { from: isoDay(today), to: isoDay(today) };
  if (key === "week") return { from: isoDay(startOfWeek(today, { weekStartsOn: 1 })), to: isoDay(today) };
  if (key === "month") return { from: isoDay(startOfMonth(today)), to: isoDay(today) };
  if (key === "year") return { from: isoDay(startOfYear(today)), to: isoDay(today) };
  return { from: customFrom, to: customTo };
}

function dayLabel(d: Date): string {
  if (isToday(d)) return "Today";
  if (isYesterday(d)) return "Yesterday";
  return format(d, "EEE, d MMM yyyy");
}

// Parse "HH:mm" into minutes-since-midnight; returns null if blank/invalid.
function toMinutes(hhmm: string): number | null {
  if (!hhmm) return null;
  const [h, m] = hhmm.split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

export default function Activity() {
  const [range, setRange] = useState<RangeKey>("today");
  const today = isoDay(new Date());
  const [customFrom, setCustomFrom] = useState(today);
  const [customTo, setCustomTo] = useState(today);
  // Optional intra-day window. Empty strings = no time filter.
  const [timeFrom, setTimeFrom] = useState("");
  const [timeTo, setTimeTo] = useState("");

  const { from, to } = useMemo(
    () => rangeForKey(range, customFrom, customTo),
    [range, customFrom, customTo],
  );

  // A native date input can be cleared (Backspace), leaving one side of the
  // custom range blank. Querying then sends a single bound and returns the
  // whole unbounded history under a half-written range label, so we hold the
  // query until both dates are filled in.
  const customIncomplete = range === "custom" && (!customFrom || !customTo);

  const activityQ = useQuery({
    queryKey: ["activity", { from, to }],
    queryFn: () =>
      api.get<ActivityRow[]>("/activity", { date_from: from, date_to: to }),
    refetchInterval: 30_000,
    enabled: !customIncomplete,
  });
  const { isLoading } = activityQ;
  const rows = activityQ.data;
  const data = useMemo(() => rows ?? [], [rows]);

  // Apply the time-of-day filter client-side. Server already scoped by date,
  // so we just need to check each row's local HH:mm against the window. If
  // timeTo < timeFrom we treat it as a "wraps midnight" window (22:00 → 06:00
  // covers night shifts).
  const tFrom = toMinutes(timeFrom);
  const tTo = toMinutes(timeTo);
  const timeFiltered = useMemo(() => {
    if (tFrom == null && tTo == null) return data;
    return data.filter((row) => {
      const d = new Date(row.createdAt);
      const m = d.getHours() * 60 + d.getMinutes();
      if (tFrom != null && tTo != null) {
        return tFrom <= tTo ? m >= tFrom && m <= tTo : m >= tFrom || m <= tTo;
      }
      if (tFrom != null) return m >= tFrom;
      return m <= (tTo as number);
    });
  }, [data, tFrom, tTo]);

  // Group rows by local calendar day. Insertion order is preserved (newest
  // first), so the resulting Map iterates in the same order — newest day at
  // the top, then newest row within each day.
  const groups = useMemo(() => {
    const m = new Map<string, ActivityRow[]>();
    for (const row of timeFiltered) {
      const day = isoDay(new Date(row.createdAt));
      if (!m.has(day)) m.set(day, []);
      m.get(day)!.push(row);
    }
    return Array.from(m.entries());
  }, [timeFiltered]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-[clamp(22px,3vw,28px)] font-semibold tracking-[-0.5px] text-ink flex items-center gap-2.5">
          <ActivityIcon className="w-6 h-6 text-brand-deep" /> Recent activity
        </h1>
        <div className="text-xs text-inkMuted">
          {/* A failed fetch must never be counted as zero entries — this is the
              page staff read to answer "did anyone touch that invoice?". */}
          {activityQ.isError
            ? "Couldn't load activity"
            : isLoading
              ? "Loading…"
              : timeFiltered.length === data.length
                ? `${data.length} entr${data.length === 1 ? "y" : "ies"}`
                : `${timeFiltered.length} of ${data.length} entries`}
        </div>
      </div>

      <StickyBar>
      <div className="card !p-3 !rounded-[14px] flex flex-wrap items-center gap-3">
        <div className="inline-flex items-center bg-bg border border-borderControl rounded-[10px] p-[3px] gap-0.5">
          {(["today", "week", "month", "year", "custom"] as RangeKey[]).map((k) => (
            <button
              key={k}
              onClick={() => setRange(k)}
              className={`text-xs font-semibold px-3 py-1.5 rounded-[7px] transition-colors capitalize ${
                range === k
                  ? "bg-inkDark text-cream"
                  : "text-textSecondary hover:text-ink hover:bg-surface"
              }`}
            >
              {k === "today"
                ? "Today"
                : k === "week"
                  ? "This Week"
                  : k === "month"
                    ? "This Month"
                    : k === "year"
                      ? "This Year"
                      : "Custom"}
            </button>
          ))}
        </div>

        {range === "custom" && (
          <div className="flex items-end gap-2">
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-wide text-inkMuted mb-1">
                From
              </label>
              <input
                type="date"
                className="input !h-8 text-sm"
                value={customFrom}
                max={customTo || undefined}
                onChange={(e) => setCustomFrom(e.target.value)}
              />
            </div>
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-wide text-inkMuted mb-1">
                To
              </label>
              <input
                type="date"
                className="input !h-8 text-sm"
                value={customTo}
                min={customFrom || undefined}
                max={today}
                onChange={(e) => setCustomTo(e.target.value)}
              />
            </div>
          </div>
        )}

        {/* Two 12h pickers side by side are ~500px — wider than the ~456px
            card interior in the tablet band (md, next to the 240px sidebar),
            so md wraps them onto two lines; lg+ restores the single row. */}
        <div className="flex flex-wrap lg:flex-nowrap items-end gap-2 border-l border-divider pl-3">
          <div>
            <label className="block text-[10px] font-bold uppercase tracking-wide text-inkMuted mb-1">
              Time from
            </label>
            <TimePicker12h value={timeFrom} onChange={setTimeFrom} />
          </div>
          <div>
            <label className="block text-[10px] font-bold uppercase tracking-wide text-inkMuted mb-1">
              Time to
            </label>
            <TimePicker12h value={timeTo} onChange={setTimeTo} />
          </div>
          {(timeFrom || timeTo) && (
            <button
              onClick={() => {
                setTimeFrom("");
                setTimeTo("");
              }}
              className="h-8 px-2 text-xs text-textSecondary hover:text-ink"
              title="Clear time filter"
            >
              Clear
            </button>
          )}
        </div>

        <div className="ml-auto text-[11px] text-inkMuted flex items-center gap-1.5">
          <Calendar className="w-3.5 h-3.5" />
          {customIncomplete ? "Pick a start and end date" : from === to ? from : `${from} → ${to}`}
          {(timeFrom || timeTo) && (
            <span className="font-mono">
              · {timeFrom || "00:00"}–{timeTo || "23:59"}
            </span>
          )}
        </div>
      </div>
      </StickyBar>

      {activityQ.isError ? (
        <div className="card">
          <QueryError
            error={activityQ.error}
            onRetry={() => activityQ.refetch()}
            isRetrying={activityQ.isFetching}
            message="The audit log didn't load, so this range is missing entries — it is not a quiet period. Try again, and check with an administrator if it keeps failing."
          />
        </div>
      ) : isLoading ? (
        <Loader label="Loading activity…" />
      ) : groups.length === 0 ? (
        <div className="card flex flex-col items-center justify-center py-16 text-center text-textSecondary">
          <ActivityIcon className="w-8 h-8 mb-2 opacity-40" />
          <div className="text-sm">
            {customIncomplete
              ? "Pick a start and end date to see activity."
              : data.length > 0
                ? `No activity between ${timeFrom || "00:00"} and ${timeTo || "23:59"}. ${data.length} entr${
                    data.length === 1 ? "y" : "ies"
                  } in this date range ${data.length === 1 ? "is" : "are"} outside that time window.`
                : "No activity in this range."}
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {groups.map(([day, rows]) => {
            const d = new Date(day);
            return (
              <section key={day} className="card">
                <header className="flex items-baseline gap-3 border-b border-divider pb-2.5 mb-3.5">
                  <h2 className="text-[15px] font-semibold text-ink">{dayLabel(d)}</h2>
                  <span className="font-mono text-[11px] text-inkMuted">
                    {format(d, "yyyy-MM-dd")}
                  </span>
                  <span className="ml-auto text-xs text-inkMuted">
                    {rows.length} entr{rows.length === 1 ? "y" : "ies"}
                  </span>
                </header>
                <ul className="space-y-3.5 text-sm">
                  {rows.map((a) => {
                    const ts = new Date(a.createdAt);
                    return (
                      <li key={a.id} className="flex gap-3.5">
                        <div className="shrink-0 w-16 text-right font-mono text-xs text-inkMuted pt-px">
                          {format(ts, "HH:mm")}
                        </div>
                        <div className="relative flex-1 min-w-0 pl-[18px] border-l-2 border-divider">
                          <span
                            aria-hidden
                            className="absolute -left-[5px] top-1 w-2 h-2 rounded-full bg-brand"
                          />
                          <div className="text-xs text-inkMuted">
                            {a.performedBy} ·{" "}
                            <span title={format(ts, "EEE, d MMM yyyy 'at' h:mm a")}>
                              {formatDistanceToNow(ts, { addSuffix: true })}
                            </span>
                          </div>
                          <div className="mt-0.5 leading-normal break-words">{a.description}</div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
