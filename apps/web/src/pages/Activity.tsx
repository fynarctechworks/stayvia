import { useQuery } from "@tanstack/react-query";
import { format, formatDistanceToNow, isToday, isYesterday, startOfMonth, startOfWeek, startOfYear } from "date-fns";
import { Activity as ActivityIcon, Calendar } from "lucide-react";
import { useMemo, useState } from "react";
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

  const { data = [], isLoading } = useQuery({
    queryKey: ["activity", { from, to }],
    queryFn: () =>
      api.get<ActivityRow[]>("/activity", { date_from: from, date_to: to }),
    refetchInterval: 30_000,
  });

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
        <h1 className="text-2xl font-bold text-navy flex items-center gap-2">
          <ActivityIcon className="w-5 h-5" /> Recent Activity
        </h1>
        <div className="text-xs text-textSecondary">
          {timeFiltered.length === data.length
            ? `${data.length} entr${data.length === 1 ? "y" : "ies"}`
            : `${timeFiltered.length} of ${data.length} entries`}
        </div>
      </div>

      <StickyBar>
      <div className="card !p-3 flex flex-wrap items-center gap-3">
        <div className="inline-flex items-center bg-bg border border-borderc rounded-md p-1 gap-1">
          {(["today", "week", "month", "year", "custom"] as RangeKey[]).map((k) => (
            <button
              key={k}
              onClick={() => setRange(k)}
              className={`text-xs font-semibold px-3 py-1.5 rounded-sm transition-colors capitalize ${
                range === k
                  ? "bg-brand-dark text-cream"
                  : "text-textSecondary hover:text-brand-dark hover:bg-white"
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
              <label className="block text-[10px] uppercase tracking-wide text-textSecondary mb-1">
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
              <label className="block text-[10px] uppercase tracking-wide text-textSecondary mb-1">
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

        <div className="flex items-end gap-2 border-l border-borderc pl-3">
          <div>
            <label className="block text-[10px] uppercase tracking-wide text-textSecondary mb-1">
              Time from
            </label>
            <TimePicker12h value={timeFrom} onChange={setTimeFrom} />
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-wide text-textSecondary mb-1">
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
              className="h-8 px-2 text-xs text-textSecondary hover:text-brand-dark"
              title="Clear time filter"
            >
              Clear
            </button>
          )}
        </div>

        <div className="ml-auto text-[11px] text-textSecondary flex items-center gap-1.5">
          <Calendar className="w-3.5 h-3.5" />
          {from === to ? from : `${from} → ${to}`}
          {(timeFrom || timeTo) && (
            <span className="font-mono">
              · {timeFrom || "00:00"}–{timeTo || "23:59"}
            </span>
          )}
        </div>
      </div>
      </StickyBar>

      {isLoading ? (
        <Loader label="Loading activity…" />
      ) : groups.length === 0 ? (
        <div className="card flex flex-col items-center justify-center py-16 text-center text-textSecondary">
          <ActivityIcon className="w-8 h-8 mb-2 opacity-40" />
          <div className="text-sm">No activity in this range.</div>
        </div>
      ) : (
        <div className="space-y-4">
          {groups.map(([day, rows]) => {
            const d = new Date(day);
            return (
              <section key={day} className="card">
                <header className="flex items-baseline gap-3 border-b border-borderc pb-2 mb-3">
                  <h2 className="font-semibold text-brand-dark">{dayLabel(d)}</h2>
                  <span className="text-[11px] tracking-wider uppercase text-textSecondary">
                    {format(d, "yyyy-MM-dd")}
                  </span>
                  <span className="ml-auto text-xs text-textSecondary">
                    {rows.length} entr{rows.length === 1 ? "y" : "ies"}
                  </span>
                </header>
                <ul className="space-y-3 text-sm">
                  {rows.map((a) => {
                    const ts = new Date(a.createdAt);
                    return (
                      <li
                        key={a.id}
                        className="flex gap-3 border-b border-borderc/60 last:border-b-0 pb-3 last:pb-0"
                      >
                        <div className="shrink-0 w-16 text-right font-mono text-xs text-textSecondary pt-0.5">
                          {format(ts, "HH:mm")}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-xs text-textSecondary">
                            {a.performedBy} ·{" "}
                            <span title={format(ts, "EEE, d MMM yyyy 'at' h:mm a")}>
                              {formatDistanceToNow(ts, { addSuffix: true })}
                            </span>
                          </div>
                          <div className="mt-0.5 break-words">{a.description}</div>
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
