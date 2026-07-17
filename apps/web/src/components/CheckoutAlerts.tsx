import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Clock } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "@/auth/AuthContext";
import { api } from "@/lib/api";

// One row from the dashboard's upcoming_checkouts list. effectiveCheckoutAt
// already accounts for any late-checkout hours granted to that reservation.
interface UpcomingCheckout {
  id: string;
  reservationNumber: string;
  guestName: string;
  roomNumbers: string;
  // Day-use bookings are tagged so the alert can show "Day use" next to
  // the room numbers — staff need to know it's an hours-based exit, not
  // the usual 11 AM overnight check-out.
  stayType?: "overnight" | "short_stay";
  durationHours?: number | null;
  lateCheckoutHours: number;
  effectiveCheckoutAt: string; // ISO
}

// A multi-day overdue stay: a guest still checked_in whose check_out_date
// is in the PAST. Distinct from upcoming_checkouts (which only covers
// reservations due to leave *today*). Surfaced here so the warning
// follows staff to every page until the guest is checked out.
interface OverdueStay {
  id: string;
  reservationNumber: string;
  guestName: string;
  status: string;
  checkOutDate: string;
  daysOverdue: number;
}

// We piggyback on the dashboard endpoint so we don't add another poll.
interface DashboardData {
  upcoming_checkouts?: UpcomingCheckout[];
  overdue?: { count: number; reservations: OverdueStay[] };
}

type AlertLevel = "approaching" | "imminent" | "overdue";

// Minutes-to-checkout boundaries. Negative numbers mean already past.
const APPROACHING_WINDOW_MIN = 60;
const IMMINENT_WINDOW_MIN = 30;

interface Decorated extends UpcomingCheckout {
  minutesLeft: number; // can be negative when overdue
  level: AlertLevel | null; // null when outside the 60-min window
}

function classify(minutesLeft: number): AlertLevel | null {
  if (minutesLeft < 0) return "overdue";
  if (minutesLeft <= IMMINENT_WINDOW_MIN) return "imminent";
  if (minutesLeft <= APPROACHING_WINDOW_MIN) return "approaching";
  return null;
}

// Singleton AudioContext shared across re-renders. Lazily created on first
// chime so we don't request audio capability before it's needed (and so
// browsers don't autoplay-block us during page load).
let audioCtx: AudioContext | null = null;
function playChime() {
  try {
    if (typeof window === "undefined") return;
    if (!audioCtx) {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      audioCtx = new AC();
    }
    const ctx = audioCtx;
    const now = ctx.currentTime;
    // Two-tone "ding": E5 then A5, 120ms each, gentle envelope. Loud enough
    // to notice in a quiet front desk without making people jump.
    [659.25, 880].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, now + i * 0.13);
      gain.gain.exponentialRampToValueAtTime(0.25, now + i * 0.13 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.13 + 0.13);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + i * 0.13);
      osc.stop(now + i * 0.13 + 0.14);
    });
  } catch {
    // Audio is best-effort. If the browser blocked it (autoplay policy
    // before any user gesture), the visual alert is still there.
  }
}

// Persist "we already chimed for this reservation today" across reloads so
// staff don't get a fresh chime every time they navigate. Cleared at IST
// midnight automatically because the key embeds the IST date.
function chimeStorageKey(): string {
  const istDate = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  return `hd:checkout-chimed:${istDate}`;
}

function loadChimedSet(): Set<string> {
  try {
    const raw = localStorage.getItem(chimeStorageKey());
    if (!raw) return new Set();
    return new Set(JSON.parse(raw) as string[]);
  } catch {
    return new Set();
  }
}

function saveChimedSet(set: Set<string>) {
  try {
    localStorage.setItem(chimeStorageKey(), JSON.stringify(Array.from(set)));
  } catch {
    /* private mode etc. */
  }
}

// Reads upcoming_checkouts off the dashboard endpoint, computes
// minutes-to-checkout client-side (so we don't need to repoll every minute),
// re-ticks a clock every 15s for fine-grained labels, and renders the
// sticky alert bar + floating counter chip. Plays one chime per reservation
// when it first crosses into "overdue".
export function CheckoutAlerts() {
  const { session } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  // Suppress the bar on the login page so it never overlaps the sign-in
  // form for someone who's been bounced back by the 401 handler.
  const onLogin = location.pathname.startsWith("/login");

  // Hide the floating bottom-right chip on form-heavy pages where the
  // submit buttons live near the bottom-right and the chip would cover
  // them. The sticky top bar still shows; only the floating counter is
  // suppressed.
  const suppressFloatingChip =
    location.pathname.startsWith("/reservations/new")
    || /^\/reservations\/[^/]+\/?$/.test(location.pathname)
    || location.pathname.startsWith("/guests/")
    || location.pathname.startsWith("/settings");

  const { data } = useQuery({
    queryKey: ["dashboard"],
    queryFn: () => api.get<DashboardData>("/dashboard"),
    enabled: !!session && !onLogin,
    // Match the existing Dashboard page's polling cadence so this doesn't
    // add server load — we share the cache key.
    refetchInterval: 30_000,
    staleTime: 15_000,
  });

  // Clock tick so minutesLeft labels stay accurate without a server roundtrip.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);

  const chimedRef = useRef<Set<string>>(loadChimedSet());

  const decorated = useMemo<Decorated[]>(() => {
    const rows = data?.upcoming_checkouts ?? [];
    return rows
      .map((r) => {
        const minutesLeft = Math.floor(
          (new Date(r.effectiveCheckoutAt).getTime() - now) / 60000,
        );
        return { ...r, minutesLeft, level: classify(minutesLeft) };
      })
      // Drop anything still outside the 60-min window. Order: most-urgent first.
      .filter((d) => d.level !== null)
      .sort((a, b) => a.minutesLeft - b.minutesLeft);
  }, [data, now]);

  // Fire one chime per reservation when it crosses into overdue.
  useEffect(() => {
    let mutated = false;
    for (const d of decorated) {
      if (d.level === "overdue" && !chimedRef.current.has(d.id)) {
        chimedRef.current.add(d.id);
        mutated = true;
        playChime();
      }
    }
    if (mutated) saveChimedSet(chimedRef.current);
  }, [decorated]);

  // Multi-day overdue stays (checked-in past their check_out_date).
  // These show on every page until resolved, regardless of whether
  // there are any same-day checkout alerts.
  const overdueStays = data?.overdue?.reservations ?? [];

  // Bail only when there's genuinely nothing to show — neither a
  // same-day alert window nor a multi-day overdue stay.
  if (onLogin || (decorated.length === 0 && overdueStays.length === 0)) return null;

  const overdueRows = decorated.filter((d) => d.level === "overdue");
  const imminentRows = decorated.filter((d) => d.level === "imminent");
  const approachingRows = decorated.filter((d) => d.level === "approaching");

  // Bar tone reflects the worst-case row.
  const worst: AlertLevel = overdueRows.length
    ? "overdue"
    : imminentRows.length
      ? "imminent"
      : "approaching";

  // Bar tone — solid backgrounds (no translucency) so the dashboard
  // content scrolling under the sticky bar doesn't bleed through. We
  // use brand-soft tints layered on the page bg colour instead of
  // alpha-on-transparent.
  const toneClasses: Record<AlertLevel, string> = {
    approaching: "bg-[#fef3c7] border-warning text-warning",
    imminent: "bg-[#fee2e2] border-danger text-danger",
    overdue: "bg-danger text-cream border-danger",
  };

  // Headline strategy: when rooms span multiple states, show a tally so
  // staff see the full load at a glance ("1 overdue · 2 imminent · 1
  // approaching"). When everything is in one state, fall back to a simpler
  // single-state phrasing that includes the worst-case countdown.
  //
  // Guarded: this whole block is only meaningful when there's at least
  // one same-day alert row. If `decorated` is empty (e.g. there are
  // only multi-day overdue stays, which render in a separate block),
  // we return an empty string and never index into the empty arrays —
  // that was the crash: imminentRows[0]!.minutesLeft on undefined.
  const headline = (() => {
    if (decorated.length === 0) return "";
    const parts: string[] = [];
    if (overdueRows.length) parts.push(`${overdueRows.length} overdue`);
    if (imminentRows.length) parts.push(`${imminentRows.length} imminent`);
    if (approachingRows.length) parts.push(`${approachingRows.length} approaching`);

    const onlyOverdue =
      overdueRows.length > 0 && imminentRows.length === 0 && approachingRows.length === 0;
    const onlyImminent =
      imminentRows.length > 0 && overdueRows.length === 0 && approachingRows.length === 0;
    const onlyApproaching =
      approachingRows.length > 0 && overdueRows.length === 0 && imminentRows.length === 0;

    if (onlyOverdue) {
      const worstLate = Math.abs(overdueRows[0]!.minutesLeft);
      return `${overdueRows.length} overdue check-out${overdueRows.length === 1 ? "" : "s"} · ${worstLate} min late`;
    }
    if (onlyImminent) {
      return `Check-out in ${imminentRows[0]!.minutesLeft} min · ${imminentRows.length} room${imminentRows.length === 1 ? "" : "s"}`;
    }
    if (onlyApproaching) {
      return `Approaching check-out · ${approachingRows.length} room${approachingRows.length === 1 ? "" : "s"}`;
    }
    // Mixed: tally per level + suffix with the most-urgent countdown so the
    // headline still tells you the immediate pressure. Both arms are
    // safe here because reaching this point means parts.length >= 2,
    // so at least one of overdue/imminent is non-empty.
    const tail = overdueRows.length
      ? `worst ${Math.abs(overdueRows[0]!.minutesLeft)} min late`
      : `next in ${imminentRows[0]!.minutesLeft} min`;
    return `${parts.join(" · ")} · ${tail}`;
  })();

  const Icon = worst === "overdue" ? AlertTriangle : Clock;

  return (
    <>
      {/* Multi-day overdue stays. Highest priority — guests who never
          checked out on their scheduled date. Sticky at the very top so
          it follows staff to every page until resolved. Blinks (via the
          animate-overdue-pulse class) so it's impossible to ignore. */}
      {overdueStays.length > 0 && (
        <div className="border-b-2 border-danger bg-danger text-cream animate-overdue-pulse">
          <div className="px-4 py-2.5">
            <div className="flex items-center gap-2 mb-2">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <div className="font-bold text-[12px] uppercase tracking-[0.14em] leading-tight">
                {overdueStays.length} overdue check-out
                {overdueStays.length === 1 ? "" : "s"} · guest stayed past scheduled date
              </div>
            </div>
            <ul className="space-y-1.5">
              {overdueStays.map((o) => (
                <li
                  key={o.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => navigate(`/reservations/${o.reservationNumber}`)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      navigate(`/reservations/${o.reservationNumber}`);
                    }
                  }}
                  className="flex items-center gap-3 px-3 py-2 rounded-md bg-cream/10 border border-cream/30 cursor-pointer hover:bg-cream/20 transition-colors focus:outline-none focus:ring-2 focus:ring-cream/60"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-mono text-[11px] text-cream/90">
                        {o.reservationNumber}
                      </span>
                      <span className="font-semibold text-[14px] truncate">{o.guestName}</span>
                    </div>
                    <div className="text-[11px] text-cream/80 mt-0.5">
                      Scheduled out {o.checkOutDate} · {o.daysOverdue} day
                      {o.daysOverdue === 1 ? "" : "s"} late
                    </div>
                  </div>
                  <button
                    onClick={(e) => {
                      // Stop the row's onClick from also firing — both go
                      // to the same place, but avoiding the double-nav keeps
                      // history clean.
                      e.stopPropagation();
                      navigate(`/reservations/${o.reservationNumber}`);
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

      {/* Same-day checkout window bar (approaching / imminent / overdue
          by *time today*). Only render when there's a same-day alert —
          a pure multi-day-overdue situation shows just the block above. */}
      {decorated.length > 0 && (
      <div className={`border-b-2 ${toneClasses[worst]}`}>
        <div className="px-4 py-2.5">
          {/* Headline */}
          <div className="flex items-center gap-2 mb-2">
            <Icon className="w-4 h-4 shrink-0" />
            <div className="font-bold text-[12px] uppercase tracking-[0.14em] leading-tight">
              {headline}
            </div>
          </div>

          {/* Rows */}
          <ul className="space-y-1.5">
            {decorated.map((d) => (
              <CheckoutRow
                key={d.id}
                row={d}
                worstLevel={worst}
                onOpen={() => navigate(`/reservations/${d.reservationNumber}`)}
                onCheckout={() =>
                  navigate(`/reservations/${d.reservationNumber}?action=checkout`)
                }
              />
            ))}
          </ul>
        </div>
      </div>
      )}

      {/* Floating bottom-right chip — bigger + higher contrast than before so
          staff can spot it from across the room. Pulses for overdue to draw
          peripheral vision. Suppressed on form pages where its position
          would overlap the primary submit button (see suppressFloatingChip). */}
      {!suppressFloatingChip && (overdueRows.length > 0 || imminentRows.length > 0) && (
        <div
          className={`fixed bottom-5 right-5 z-50 px-4 py-3 rounded-md shadow-[0_8px_24px_-4px_rgba(0,0,0,0.35)] border-2 inline-flex items-center gap-3 ${
            overdueRows.length > 0
              ? "border animate-checkout-blink"
              : imminentRows.length > 0
                ? "border animate-checkout-blink"
                : "bg-warning text-cream border-warning"
          }`}
        >
          <Icon className="w-6 h-6" />
          <div className="leading-tight">
            <div className="text-[10px] uppercase tracking-[0.18em] font-semibold opacity-90">
              {overdueRows.length > 0 ? "Overdue" : "Due now"}
            </div>
            <div className="text-lg font-bold font-mono">
              {overdueRows.length > 0 ? overdueRows.length : imminentRows.length}
              <span className="text-xs font-semibold opacity-90 ml-1">
                room{(overdueRows.length || imminentRows.length) === 1 ? "" : "s"}
              </span>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// Per-row card. Spacious by design — staff should be able to read it at a
// glance and act in one click without leaning into the screen.
function CheckoutRow({
  row,
  worstLevel,
  onOpen,
  onCheckout,
}: {
  row: Decorated;
  worstLevel: AlertLevel;
  onOpen: () => void;
  onCheckout: () => void;
}) {
  const rooms = row.roomNumbers ? row.roomNumbers.split(",").filter(Boolean) : [];
  const isOverdue = row.level === "overdue";
  const minsAbs = Math.abs(row.minutesLeft);

  // Time pill — sits on the right of the row.
  //   - overdue → cream pill, dark-red text, breathing pulse (pops on
  //     blinking row).
  //   - imminent → cream pill, dark-red text, no inner pulse (the row
  //     itself is already blinking; double-animation is noisy).
  //   - approaching → warning yellow.
  const pillBase =
    "inline-flex items-center px-2.5 h-7 rounded-md text-[11px] font-bold uppercase tracking-wider shrink-0";
  const pillTone =
    row.level === "overdue"
      ? "bg-cream text-danger animate-checkout-pulse"
      : row.level === "imminent"
        ? "bg-cream text-danger"
        : "bg-warning text-cream";
  const pillLabel = isOverdue ? `${minsAbs} min late` : `${row.minutesLeft} min left`;

  // Card frame:
  //   - row's own level is imminent or overdue → HARD BLINK (red ⇄ deep
  //     red, 1s). Forced cream text so contrast stays readable on both
  //     peaks of the blink.
  //   - approaching → calm static card.
  // The overall bar tone (worstLevel) still influences the calm rows so
  // they read sensibly when nested under a red bar.
  const blinks = row.level === "imminent" || row.level === "overdue";
  const cardClass = blinks
    ? "border animate-checkout-blink"
    : worstLevel === "overdue"
      ? "bg-cream/10 border border-cream/30"
      : "bg-surface border border-borderc";

  // Buttons read against the row background. When the row is blinking
  // red the buttons need cream backgrounds to stay readable.
  const onRedRow = blinks || worstLevel === "overdue";
  const primaryBtn = onRedRow
    ? "bg-cream text-danger hover:opacity-90"
    : "bg-brand text-textPrimary hover:bg-brand-deep";

  const secondaryBtn = onRedRow
    ? "text-cream hover:underline"
    : "text-textSecondary hover:text-brand-dark";

  return (
    <li className={`flex items-center gap-3 px-3 py-2 rounded-md ${cardClass}`}>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          {rooms.map((rm) => {
            const isSwap = rm.includes("→");
            return (
              <span
                key={rm}
                title={isSwap ? "Room swapped mid-stay" : undefined}
                className={`font-mono text-[13px] font-extrabold px-2 py-0.5 rounded ${
                  onRedRow
                    ? "bg-cream/20 text-cream"
                    : "bg-bg text-brand-dark border border-borderc"
                }`}
              >
                Room {rm.replace("→", " → ")}
              </span>
            );
          })}
          <span className="font-semibold text-[14px] truncate">
            {row.guestName}
          </span>
          {row.stayType === "short_stay" && (
            <span
              className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ${
                onRedRow
                  ? "bg-cream/15 text-cream"
                  : "bg-brand/10 text-brand-dark border border-brand/30"
              }`}
              title={`Day-use booking · ${Number(row.durationHours ?? 0)} hours`}
            >
              Day use · {Number(row.durationHours ?? 0)}h
            </span>
          )}
          {row.lateCheckoutHours > 0 && (
            <span
              className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ${
                worstLevel === "overdue"
                  ? "bg-cream/15 text-cream"
                  : "bg-bg text-textSecondary border border-borderc"
              }`}
              title={`Late checkout extension of +${row.lateCheckoutHours}h granted`}
            >
              +{row.lateCheckoutHours}h grant
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          <span
            className={`font-mono text-[11px] ${
              onRedRow ? "text-cream" : "text-textSecondary"
            }`}
          >
            {row.reservationNumber}
          </span>
          <button
            onClick={onOpen}
            className={`text-[11px] font-semibold ${secondaryBtn}`}
          >
            Open →
          </button>
        </div>
      </div>

      <span className={`${pillBase} ${pillTone}`}>{pillLabel}</span>

      <button
        onClick={onCheckout}
        className={`inline-flex items-center px-3 h-8 text-xs font-bold rounded-sm transition-colors shrink-0 ${primaryBtn}`}
      >
        Check out
      </button>
    </li>
  );
}
