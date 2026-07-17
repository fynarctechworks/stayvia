// Pre-arrival reminder + no-show watch banner.
//
// Renders on every page (via AppShell) when the dashboard endpoint
// surfaces:
//   - upcoming_arrivals: confirmed bookings due in the reminder window
//   - likely_no_shows:   confirmed bookings past their cutoff
//
// Style intentionally mirrors CheckoutAlerts (sticky top bar, row
// cards, "Open →" buttons, large day-pills) so both alert types
// share the same visual language. Color rules:
//   - Upcoming arrivals → INFO BLUE. Heads-up, not urgent.
//   - Likely no-shows   → DANGER RED. Same red as multi-day overdue.

import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, BellRing } from "lucide-react";
import { useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "@/auth/AuthContext";
import { api } from "@/lib/api";

interface UpcomingArrival {
  id: string;
  reservationNumber: string;
  guestName: string;
  guestPhone: string;
  checkInDate: string;
  reminderSent: boolean;
}

interface LikelyNoShow {
  id: string;
  reservationNumber: string;
  guestName: string;
  guestPhone: string;
  checkInDate: string;
  daysLate: number;
}

interface DashboardData {
  upcoming_arrivals?: UpcomingArrival[];
  likely_no_shows?: LikelyNoShow[];
}

// Days between today and the given yyyy-MM-dd. Positive when the date
// is in the future, negative when past, 0 when today. Computed against
// the browser's local midnight — same approach the dashboard uses.
function daysUntil(dateStr: string, now: number): number {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const d = new Date(dateStr);
  d.setHours(0, 0, 0, 0);
  return Math.round((d.getTime() - today.getTime()) / 86400000);
}

export function ArrivalAlerts() {
  const { session } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  // One-time "tick" used by the arrival pills so a 24h reminder rolls
  // from "1 day away" to "today" automatically without a page refresh.
  const [now] = useState(() => Date.now());

  const onLogin = location.pathname.startsWith("/login");

  const { data } = useQuery({
    queryKey: ["dashboard"],
    queryFn: () => api.get<DashboardData>("/dashboard"),
    enabled: !!session && !onLogin,
    refetchInterval: 30_000,
    staleTime: 15_000,
  });

  // Decorate arrivals with the days-away number so pills are sorted
  // soonest-first. Filter to "1 day before or sooner" — anything
  // farther out is too distant to flash a banner about.
  const arrivals = useMemo(() => {
    const rows = data?.upcoming_arrivals ?? [];
    return rows
      .map((r) => ({ ...r, daysAway: daysUntil(r.checkInDate, now) }))
      .filter((r) => r.daysAway <= 1)
      .sort((a, b) => a.daysAway - b.daysAway);
  }, [data, now]);

  const noShows = data?.likely_no_shows ?? [];

  if (onLogin || (arrivals.length === 0 && noShows.length === 0)) return null;

  // Pluralised headline tokens shared by both banners.
  const arrivalsHeadline = (() => {
    const today = arrivals.filter((a) => a.daysAway <= 0).length;
    const tomorrow = arrivals.filter((a) => a.daysAway === 1).length;
    const parts: string[] = [];
    if (today > 0) parts.push(`${today} arriving today`);
    if (tomorrow > 0) parts.push(`${tomorrow} tomorrow`);
    return parts.join(" · ") || `${arrivals.length} upcoming`;
  })();

  return (
    <>
      {/* Likely no-shows — RED, sticky, highest priority. */}
      {noShows.length > 0 && (
        <div className="border-b-2 border-danger bg-danger text-cream">
          <div className="px-4 py-2.5">
            <div className="flex items-center gap-2 mb-2">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <div className="font-bold text-[12px] uppercase tracking-[0.14em] leading-tight">
                {noShows.length} likely no-show{noShows.length === 1 ? "" : "s"} · verify or mark
              </div>
            </div>
            <ul className="space-y-1.5">
              {noShows.map((n) => (
                <li
                  key={n.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => navigate(`/reservations/${n.reservationNumber}`)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      navigate(`/reservations/${n.reservationNumber}`);
                    }
                  }}
                  className="flex items-center gap-3 px-3 py-2 rounded-md bg-cream/10 border border-cream/30 cursor-pointer hover:bg-cream/20 transition-colors focus:outline-none focus:ring-2 focus:ring-cream/60"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-mono text-[11px] text-cream/90">
                        {n.reservationNumber}
                      </span>
                      <span className="font-semibold text-[14px] truncate">{n.guestName}</span>
                      <span className="font-mono text-[11px] text-cream/80">
                        {n.guestPhone}
                      </span>
                    </div>
                    <div className="text-[11px] text-cream/80 mt-0.5">
                      Scheduled in {n.checkInDate}
                      {n.daysLate > 0
                        ? ` · ${n.daysLate} day${n.daysLate === 1 ? "" : "s"} ago`
                        : " · past cutoff"}
                    </div>
                  </div>
                  <span className="inline-flex items-center px-2.5 h-7 rounded-md text-[11px] font-bold uppercase tracking-wider shrink-0 bg-cream text-danger">
                    {n.daysLate > 0 ? `${n.daysLate}d late` : "late"}
                  </span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      navigate(`/reservations/${n.reservationNumber}`);
                    }}
                    className="inline-flex items-center px-3 h-8 text-xs font-bold rounded-sm bg-cream text-danger hover:opacity-90 transition-colors shrink-0"
                  >
                    Open →
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {/* Upcoming arrivals — BLUE, sticky, informational. */}
      {arrivals.length > 0 && (
        <div className="border-b-2 border-info bg-info text-cream">
          <div className="px-4 py-2.5">
            <div className="flex items-center gap-2 mb-2">
              <BellRing className="w-4 h-4 shrink-0" />
              <div className="font-bold text-[12px] uppercase tracking-[0.14em] leading-tight">
                {arrivalsHeadline}
              </div>
            </div>
            <ul className="space-y-1.5">
              {arrivals.map((a) => {
                const pillLabel =
                  a.daysAway <= 0
                    ? "Today"
                    : a.daysAway === 1
                      ? "Tomorrow"
                      : `${a.daysAway} days`;
                return (
                  <li
                    key={a.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => navigate(`/reservations/${a.reservationNumber}`)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        navigate(`/reservations/${a.reservationNumber}`);
                      }
                    }}
                    className="flex items-center gap-3 px-3 py-2 rounded-md bg-cream/10 border border-cream/30 cursor-pointer hover:bg-cream/20 transition-colors focus:outline-none focus:ring-2 focus:ring-cream/60"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-mono text-[11px] text-cream/90">
                          {a.reservationNumber}
                        </span>
                        <span className="font-semibold text-[14px] truncate">{a.guestName}</span>
                        <span className="font-mono text-[11px] text-cream/80">
                          {a.guestPhone}
                        </span>
                        {a.reminderSent && (
                          <span
                            className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-cream/15 text-cream"
                            title="WhatsApp reminder sent"
                          >
                            ✓ reminded
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-cream/80 mt-0.5">
                        Check-in {a.checkInDate}
                      </div>
                    </div>
                    <span className="inline-flex items-center px-2.5 h-7 rounded-md text-[11px] font-bold uppercase tracking-wider shrink-0 bg-cream text-info">
                      {pillLabel}
                    </span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        navigate(`/reservations/${a.reservationNumber}`);
                      }}
                      className="inline-flex items-center px-3 h-8 text-xs font-bold rounded-sm bg-cream text-info hover:opacity-90 transition-colors shrink-0"
                    >
                      Open →
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      )}
    </>
  );
}
