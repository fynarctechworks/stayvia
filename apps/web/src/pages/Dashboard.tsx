import { useQuery } from "@tanstack/react-query";
import {
  ArrowRight,
  BedDouble,
  CalendarClock,
  CalendarPlus,
  CheckCircle2,
  LogIn,
  LogOut,
  Receipt,
  UserPlus,
  Wallet,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Can } from "@/auth/Can";
import { Loader } from "@/components/Loader";
import { RoomActionPopover } from "@/components/RoomActionPopover";
import { api } from "@/lib/api";
import { inr } from "@/lib/utils";

interface TodayRow {
  id: string;
  reservationNumber: string;
  guestName: string;
  status: string;
  roomNumbers: string;
}

interface DashboardData {
  occupancy: { occupied: number; total: number; percentage: number };
  today_checkins: { count: number; reservations: TodayRow[] };
  today_checkouts: { count: number; reservations: TodayRow[] };
  overdue?: {
    count: number;
    reservations: {
      id: string;
      reservationNumber: string;
      guestName: string;
      status: string;
      checkOutDate: string;
      daysOverdue: number;
    }[];
  };
  // Omitted by the API for users without `view_revenue`. We still render
  // the Dashboard, just without the Revenue Today tile.
  revenue_today?: {
    // NET movement through the drawer today (collections minus refunds) —
    // negative on a refund-only day.
    total_collected: number;
    // Gross split so a negative net explains itself.
    gross_collected?: number;
    total_refunded?: number;
    // Per-payment-method split of today's collections for the daily
    // money overview / owner cash-up.
    by_method?: {
      method: string;
      total: number;
      collected?: number;
      refunded?: number;
      count: number;
      refund_count?: number;
    }[];
  };
  revenue_kpis?: {
    // mtd_collected is omitted for view_daily_collections-only users
    // (front desk) — they see outstanding but not month-to-date revenue.
    mtd_collected?: number;
    outstanding_balance?: number;
  };
  // Operations counters — visible to everyone (no money). Drives the
  // "morning work" cards on the dashboard.
  operations_kpis?: {
    pending_checkouts_today: number;
    rooms_out_of_service: number;
  };
  // Forecast is always present (occupancy-only, no money).
  forecast: {
    total_rooms: number;
    days: { day: string; occupied: number; arrivals: number }[];
  };
  room_grid: {
    id: string;
    room_number: string;
    room_type: string;
    floor: number;
    status: string;
    guest_name: string | null;
    reservation_id: string | null;
    reservation_number: string | null;
    // Upcoming hold window when the room is sellable tonight but
    // booked for a future stay. Both ends are yyyy-MM-dd.
    held_from: string | null;
    held_to: string | null;
    // Same-day re-let: room currently held by a walk-in but a
    // confirmed booking is arriving within 24h.
    relet_pending: { nextGuestName: string; nextCheckIn: string } | null;
  }[];
}

export default function Dashboard() {
  const navigate = useNavigate();
  const { data, isLoading } = useQuery({
    queryKey: ["dashboard"],
    queryFn: () => api.get<DashboardData>("/dashboard"),
    refetchInterval: 30_000,
  });

  if (isLoading || !data) return <Loader label="Loading dashboard…" size="lg" />;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-2xl font-bold text-brand-dark">Dashboard</h1>
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

      {/* Overdue check-out alert now lives in the app-wide sticky
          CheckoutAlerts bar (rendered in AppShell), so it follows
          staff to every page instead of only the Dashboard. The
          duplicate card that used to live here was removed to keep a
          single source of truth. */}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard
          icon={<BedDouble className="w-5 h-5" />}
          label="Occupancy"
          value={`${data.occupancy.occupied} / ${data.occupancy.total} rooms`}
          sub={`${data.occupancy.percentage}% occupied`}
        />
        <StatCard
          icon={<LogIn className="w-5 h-5" />}
          label="Today's Check-ins"
          value={String(data.today_checkins.count)}
          sub={`${
            data.today_checkins.reservations.filter((r) => r.status === "confirmed").length
          } pending`}
        />
        <StatCard
          icon={<LogOut className="w-5 h-5" />}
          label="Today's Check-outs"
          value={String(data.today_checkouts.count)}
          sub={`${
            data.today_checkouts.reservations.filter((r) => r.status === "checked_in").length
          } pending`}
        />
        <Can any={["view_revenue", "view_daily_collections"]}>
          <StatCard
            icon={<Wallet className="w-5 h-5" />}
            label="Revenue Today"
            value={inr(data.revenue_today?.total_collected ?? 0)}
            // Net can go negative when a refund lands today for a booking
            // paid on an earlier day. Spell out the two halves so the minus
            // number is never a mystery at the desk.
            sub={
              (data.revenue_today?.total_refunded ?? 0) > 0
                ? `${inr(data.revenue_today?.gross_collected ?? 0)} in · ${inr(
                    data.revenue_today?.total_refunded ?? 0,
                  )} refunded`
                : "collected"
            }
          />
        </Can>
      </div>

      {/* Operating + financial KPIs. Mixed row:
          - Revenue MTD + Outstanding Balance gated behind view_revenue
            so only users with permission see money figures.
          - Pending Check-outs + Rooms Out of Service are operational
            counters (no rupee values) and visible to everyone — they're
            the morning work queue for housekeeping and the front desk. */}
      {(data.revenue_kpis || data.operations_kpis) && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {data.revenue_kpis?.mtd_collected !== undefined && (
            <Can do="view_revenue">
              <StatCard
                icon={<Receipt className="w-5 h-5" />}
                label="Revenue MTD"
                value={inr(data.revenue_kpis.mtd_collected)}
                sub="collected this month"
              />
            </Can>
          )}
          {data.revenue_kpis?.outstanding_balance !== undefined && (
            <Can any={["view_revenue", "view_daily_collections"]}>
              <StatCard
                icon={<Wallet className="w-5 h-5" />}
                label="Outstanding Balance"
                value={inr(data.revenue_kpis.outstanding_balance)}
                sub="unpaid across all bookings"
              />
            </Can>
          )}
          {data.operations_kpis && (
            <StatCard
              icon={<LogOut className="w-5 h-5" />}
              label="Pending Check-outs"
              value={String(data.operations_kpis.pending_checkouts_today)}
              sub="due today, not yet processed"
            />
          )}
          {data.operations_kpis && (
            <StatCard
              icon={<BedDouble className="w-5 h-5" />}
              label="Rooms Out of Service"
              value={String(data.operations_kpis.rooms_out_of_service)}
              sub="maintenance + dirty"
            />
          )}
        </div>
      )}

      {/* Today's money overview — collections split by payment method
          (Cash / UPI / Card / Bank transfer / Cheque). Visible to anyone
          who can see the daily cash-up (front desk settles the drawer at
          shift end); full view_revenue isn't required. MTD + outstanding
          above stay view_revenue-only. */}
      <Can any={["view_revenue", "view_daily_collections"]}>
        {data.revenue_today && (
          <TodaysCollections data={data.revenue_today} />
        )}
      </Can>

      <div className="card">
        <h2 className="font-semibold text-brand-dark mb-3">Availability by Floor</h2>
        {/* Floor → number-sorted tile grid. One row per floor; rooms
            inside a floor are sorted by room number (201, 202, 203…)
            regardless of type, so the layout mirrors how staff walks
            the property. The floor-level headline rolls up the same
            status chips that used to live on per-type strips. */}
        {groupByFloor(data.room_grid).map((floorGroup, floorIdx) => {
          const floorStats = rollupFloorStats(floorGroup.rooms);
          const sellable = floorStats.available + floorStats.held;
          const pct = floorStats.total > 0
            ? Math.round((sellable / floorStats.total) * 100)
            : 0;
          const chips: { label: string; count: number; dot: string }[] = [];
          if (floorStats.available > 0) chips.push({ label: "Available", count: floorStats.available, dot: "bg-[#ffdb13]" });
          if (floorStats.held > 0) chips.push({ label: "Held", count: floorStats.held, dot: "bg-warning" });
          if (floorStats.occupied > 0) chips.push({ label: "Occupied", count: floorStats.occupied, dot: "bg-navy" });
          if (floorStats.reserved > 0) chips.push({ label: "Reserved", count: floorStats.reserved, dot: "bg-[#644fc1]" });
          if (floorStats.dirty > 0) chips.push({ label: "Needs Cleaning", count: floorStats.dirty, dot: "bg-warning" });
          if (floorStats.maintenance > 0) chips.push({ label: "Maintenance", count: floorStats.maintenance, dot: "bg-danger" });

          return (
            <div
              key={`floor-${floorGroup.floor}`}
              className={floorIdx === 0 ? "pb-2" : "mt-5 pt-4 border-t-2 border-brand-dark/15 pb-2"}
            >
              <div className="flex items-center justify-between gap-3 flex-wrap mb-2">
                <div className="flex items-baseline gap-3">
                  <div className="font-semibold text-brand-dark">
                    Floor {floorGroup.floor}
                  </div>
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-xl font-bold text-brand">{sellable}</span>
                    <span className="text-[11px] text-textSecondary">
                      sellable · {pct}%
                      {floorStats.held > 0 && (
                        <span className="ml-1 text-warning font-semibold">
                          ({floorStats.held} held)
                        </span>
                      )}
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-1.5 flex-wrap">
                  {chips.map((c) => (
                    <span
                      key={c.label}
                      className="inline-flex items-center gap-1 text-[11px] text-textSecondary"
                      title={`${c.label} ${c.count}`}
                    >
                      <span className={`w-1.5 h-1.5 rounded-full ${c.dot}`} />
                      <span className="font-semibold text-brand-dark">{c.count}</span>
                      <span>{c.label}</span>
                    </span>
                  ))}
                  <span className="text-[11px] text-textSecondary/70 ml-1">
                    · {floorStats.total} total
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-7 gap-2.5 mt-3">
                {floorGroup.rooms.map((r) => (
                  <RoomTile
                    key={r.id}
                    room={r}
                    onWalkIn={() =>
                      navigate(`/reservations/new?mode=walkin&room=${r.id}`)
                    }
                    onOpenReservation={() => {
                      const handle = r.reservation_number ?? r.reservation_id;
                      if (handle) navigate(`/reservations/${handle}`);
                    }}
                    onOpenRoom={() => navigate(`/rooms/${r.room_number}`)}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <TodayPanel
          kind="arrivals"
          title="Today's Check-ins"
          rows={data.today_checkins.reservations}
          emptyMessage="No arrivals today."
          onOpen={(id) => navigate(`/reservations/${id}`)}
        />
        <TodayPanel
          kind="departures"
          title="Today's Check-outs"
          rows={data.today_checkouts.reservations}
          emptyMessage="No departures today."
          onOpen={(id) => navigate(`/reservations/${id}`)}
        />
      </div>

    </div>
  );
}

type TodayKind = "arrivals" | "departures";

function TodayPanel({
  kind,
  title,
  rows,
  emptyMessage,
  onOpen,
}: {
  kind: TodayKind;
  title: string;
  rows: TodayRow[];
  emptyMessage: string;
  onOpen: (id: string) => void;
}) {
  // Pending = the row still needs an action. For arrivals it's "confirmed",
  // for departures it's "checked_in".
  const pendingStatus = kind === "arrivals" ? "confirmed" : "checked_in";
  const pending = rows.filter((r) => r.status === pendingStatus);
  const done = rows.filter((r) => r.status !== pendingStatus);

  const HeaderIcon = kind === "arrivals" ? LogIn : LogOut;

  return (
    <div className="card !p-0 overflow-hidden">
      <div className="px-4 py-3 border-b border-borderc flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <HeaderIcon className="w-4 h-4 text-brand" />
          <strong className="text-brand-dark">{title}</strong>
        </div>
        <div className="flex items-center gap-1.5 text-[11px] font-semibold">
          {pending.length > 0 && (
            <span className="px-2 py-0.5 rounded-sm bg-warning/15 text-warning">
              {pending.length} pending
            </span>
          )}
          {done.length > 0 && (
            <span className="px-2 py-0.5 rounded-sm bg-success/15 text-success">
              {done.length} done
            </span>
          )}
          {rows.length === 0 && (
            <span className="text-textSecondary">0 today</span>
          )}
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="px-4 py-6 text-textSecondary text-sm">{emptyMessage}</div>
      ) : (
        <ul className="divide-y divide-borderc">
          {/* Pending first so they're visually prioritised, then the done rows. */}
          {[...pending, ...done].map((r) => (
            <TodayRowItem key={r.id} kind={kind} row={r} onOpen={onOpen} />
          ))}
        </ul>
      )}
    </div>
  );
}

function TodayRowItem({
  kind,
  row,
  onOpen,
}: {
  kind: TodayKind;
  row: TodayRow;
  onOpen: (id: string) => void;
}) {
  const isArrivalPending = kind === "arrivals" && row.status === "confirmed";
  const isDeparturePending = kind === "departures" && row.status === "checked_in";
  const isArrivalDone = kind === "arrivals" && row.status === "checked_in";
  const isDepartureDone = kind === "departures" && row.status === "checked_out";

  // Smart action — see chat thread; all routes deep-link to the reservation
  // page because both check-in and check-out require their own multi-step
  // modals that already live there.
  let actionLabel = "View";
  let ActionIcon = ArrowRight;
  let actionTone: "primary" | "secondary" = "secondary";
  if (isArrivalPending) {
    actionLabel = "Start check-in";
    ActionIcon = LogIn;
    actionTone = "primary";
  } else if (isDeparturePending) {
    actionLabel = "Start check-out";
    ActionIcon = LogOut;
    actionTone = "primary";
  } else if (isDepartureDone || isArrivalDone) {
    actionLabel = "Open";
    ActionIcon = ArrowRight;
    actionTone = "secondary";
  }

  // Status pill colouring — derive from the row's literal status.
  const statusPill = (() => {
    if (row.status === "confirmed") {
      return { label: "Confirmed", cls: "bg-brand-soft text-brand-dark" };
    }
    if (row.status === "checked_in") {
      return { label: "Checked in", cls: "bg-success/15 text-success" };
    }
    if (row.status === "checked_out") {
      return { label: "Checked out", cls: "bg-textSecondary/15 text-textSecondary" };
    }
    return { label: row.status, cls: "bg-bg text-textSecondary" };
  })();

  const PillIcon =
    row.status === "checked_in" || row.status === "checked_out"
      ? CheckCircle2
      : Receipt;

  const rooms = row.roomNumbers
    ? row.roomNumbers.split(",").filter(Boolean)
    : [];

  return (
    <li className="flex items-center gap-3 px-4 py-3 hover:bg-brand-soft/30 transition-colors">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-semibold text-brand-dark truncate">{row.guestName}</span>
          {rooms.map((rm) => (
            <span
              key={rm}
              className="font-mono text-[11px] font-bold px-1.5 py-0.5 rounded-sm bg-bg border border-borderc text-brand-dark"
            >
              Room {rm}
            </span>
          ))}
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          <span className="font-mono text-[11px] text-accentBlue">{row.reservationNumber}</span>
          <span
            className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm text-[10px] font-semibold ${statusPill.cls}`}
          >
            <PillIcon className="w-2.5 h-2.5" />
            {statusPill.label}
          </span>
        </div>
      </div>

      <button
        onClick={() => onOpen(row.reservationNumber || row.id)}
        className={`inline-flex items-center gap-1.5 px-2.5 h-8 text-xs font-semibold rounded-sm border transition-colors shrink-0 ${
          actionTone === "primary"
            ? "bg-brand text-textPrimary border-brand hover:bg-brand-deep"
            : "bg-surface text-textSecondary border-borderc hover:border-brand hover:text-brand"
        }`}
      >
        <ActionIcon className="w-3.5 h-3.5" />
        {actionLabel}
      </button>
    </li>
  );
}

function StatCard({
  icon,
  label,
  value,
  sub,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub: string;
}) {
  return (
    <div className="card">
      <div className="flex items-center justify-between">
        <div className="text-textSecondary text-xs uppercase tracking-wide">{label}</div>
        <div className="text-accentBlue">{icon}</div>
      </div>
      <div className="text-2xl font-bold text-navy mt-2">{value}</div>
      <div className="text-xs text-textSecondary mt-1">{sub}</div>
    </div>
  );
}

// Human labels for the payment_method enum, in the order we want them
// shown on the cash-up. Any method not listed (future additions) still
// renders with a title-cased fallback so nothing silently disappears.
const PAYMENT_METHOD_LABELS: Record<string, string> = {
  cash: "Cash",
  upi: "UPI",
  card: "Card",
  bank_transfer: "Bank Transfer",
  cheque: "Cheque",
};
const PAYMENT_METHOD_ORDER = ["cash", "upi", "card", "bank_transfer", "cheque"];

function methodLabel(method: string): string {
  return (
    PAYMENT_METHOD_LABELS[method] ??
    method.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
  );
}

// Today's collections broken down by payment method — the daily money
// overview the front desk hands to the owner at end of day.
function TodaysCollections({
  data,
}: {
  data: {
    total_collected: number;
    gross_collected?: number;
    total_refunded?: number;
    by_method?: {
      method: string;
      total: number;
      collected?: number;
      refunded?: number;
      count: number;
      refund_count?: number;
    }[];
  };
}) {
  const rows = (data.by_method ?? [])
    .filter((m) => m.total !== 0 || m.count > 0 || (m.refund_count ?? 0) > 0)
    .slice()
    .sort(
      (a, b) =>
        PAYMENT_METHOD_ORDER.indexOf(a.method) - PAYMENT_METHOD_ORDER.indexOf(b.method),
    );
  const totalTxns = rows.reduce((s, m) => s + m.count + (m.refund_count ?? 0), 0);
  const refunded = data.total_refunded ?? 0;

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="font-semibold text-brand-dark">Today's Collections by Method</h2>
          <p className="text-xs text-textSecondary mt-0.5">
            Money received today, split by payment mode — for the daily cash-up.
          </p>
        </div>
        <Wallet className="w-5 h-5 text-accentBlue" />
      </div>

      {rows.length === 0 ? (
        <div className="text-sm text-textSecondary py-2">
          No payments collected today yet.
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          {rows.map((m) => (
            <div
              key={m.method}
              className="rounded-sm border border-borderc bg-bg p-3"
            >
              <div className="text-xs uppercase tracking-wide text-textSecondary">
                {methodLabel(m.method)}
              </div>
              <div
                className={`text-lg font-bold mt-1 font-mono ${
                  m.total < 0 ? "text-danger" : "text-navy"
                }`}
              >
                {inr(m.total)}
              </div>
              <div className="text-[11px] text-textSecondary mt-0.5">
                {m.count} payment{m.count === 1 ? "" : "s"}
                {(m.refund_count ?? 0) > 0 && (
                  <span className="text-danger">
                    {" "}· {m.refund_count} refund
                    {m.refund_count === 1 ? "" : "s"} ({inr(m.refunded ?? 0)})
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* A refund of a booking paid on an earlier day can push the net below
          zero. Show both halves so the desk can reconcile the drawer without
          hunting through Payments. */}
      {refunded > 0 && (
        <div className="flex items-center justify-between mt-3 text-sm">
          <span className="text-textSecondary">Collected</span>
          <span className="font-mono text-brand-dark">
            {inr(data.gross_collected ?? 0)}
          </span>
        </div>
      )}
      {refunded > 0 && (
        <div className="flex items-center justify-between mt-1 text-sm">
          <span className="text-danger">Refunded</span>
          <span className="font-mono text-danger">-{inr(refunded)}</span>
        </div>
      )}

      <div className="flex items-center justify-between mt-3 pt-3 border-t border-borderc">
        <span className="text-sm font-semibold text-brand-dark">
          {refunded > 0 ? "Net movement today" : "Total collected today"}
          {totalTxns > 0 && (
            <span className="text-textSecondary font-normal">
              {" "}· {totalTxns} payment{totalTxns === 1 ? "" : "s"}
            </span>
          )}
        </span>
        <span
          className={`text-lg font-bold font-mono ${
            data.total_collected < 0 ? "text-danger" : "text-brand-dark"
          }`}
        >
          {inr(data.total_collected)}
        </span>
      </div>
    </div>
  );
}

// Single-source tile component. Handles every room status with a
// consistent card frame so available/occupied/reserved/housekeeping
// rooms all use the same visual language. Held-tonight rooms get an
// extra footer band so the desk sees at a glance that the room is
// free now but locked for an upcoming arrival.
function RoomTile({
  room,
  onWalkIn,
  onOpenReservation,
  onOpenRoom,
}: {
  room: RoomGridRow;
  onWalkIn: () => void;
  onOpenReservation: () => void;
  onOpenRoom: () => void;
}) {
  const isHousekeeping =
    room.status === "dirty" || room.status === "maintenance";

  // Hold window: render both edges so staff sees the lock period at a
  // glance. Same-month windows compress to "02 → 03 Jun"; cross-month
  // windows show both labels "30 Jun → 02 Jul".
  const fmtDay = (d: string) =>
    new Date(d).toLocaleDateString("en-IN", {
      day: "2-digit",
      month: "short",
    });
  const fmtDayOnly = (d: string) =>
    new Date(d).toLocaleDateString("en-IN", { day: "2-digit" });
  const heldFromShort = room.held_from ? fmtDay(room.held_from) : null;
  const heldRange = (() => {
    if (!room.held_from) return null;
    if (!room.held_to) return heldFromShort;
    const fromMonth = new Date(room.held_from).getMonth();
    const toMonth = new Date(room.held_to).getMonth();
    const sameMonth = fromMonth === toMonth;
    return sameMonth
      ? `${fmtDayOnly(room.held_from)} → ${fmtDay(room.held_to)}`
      : `${fmtDay(room.held_from)} → ${fmtDay(room.held_to)}`;
  })();
  const showHoldHint = !!room.held_from && room.status === "available";

  // Visual tokens per status. Keeping this in one map (rather than the
  // utility-class soup we had before) makes the colour story easy to
  // see at a glance.
  // typeText controls the small "AC SINGLE ROOM" strapline. On dark-
  // card statuses (occupied) it needs a light tint to stay readable;
  // on light cards the muted brand colour matches the headline.
  const STYLES: Record<
    string,
    {
      card: string;
      statusText: string;
      statusDot: string;
      typeText: string;
      label: string;
    }
  > = {
    // Available is the ONLY outlined tile — it's the "blank canvas" /
    // "ready to sell" state. Every other status is a solid fill with
    // cream text so it pops against the row of available tiles, and
    // each status uses a distinct hue so they can't be confused at a
    // glance.
    available: {
      card: "bg-surface border-success/40 text-success",
      statusText: "text-success",
      statusDot: "bg-success",
      typeText: "text-textSecondary",
      label: "Available",
    },
    occupied: {
      // Solid near-black — the "in use" tile, reads like the dark
      // featured tier in the Supabase system.
      card: "bg-brand-dark text-cream border-brand-dark",
      statusText: "text-cream/90",
      statusDot: "bg-cream",
      typeText: "text-cream/80",
      label: "Occupied",
    },
    reserved: {
      // Solid violet — distinct from the emerald "available" outline,
      // the dark "occupied" tile, and the maintenance red.
      card: "bg-[#644fc1] text-cream border-[#644fc1]",
      statusText: "text-cream/90",
      statusDot: "bg-cream",
      typeText: "text-cream/80",
      label: "Reserved",
    },
    dirty: {
      // Solid amber-brown — the universal "needs attention" colour,
      // clearly different from reserved-violet.
      card: "bg-warning text-cream border-warning",
      statusText: "text-cream/90",
      statusDot: "bg-cream",
      typeText: "text-cream/80",
      label: "Needs Cleaning",
    },
    maintenance: {
      // Solid red — near-black now belongs to "occupied", so out-of-service
      // moves to the danger hue. Pairs with the Rooms-page maintenance
      // colour so the two views agree.
      card: "bg-danger text-cream border-danger",
      statusText: "text-cream/90",
      statusDot: "bg-cream",
      typeText: "text-cream/80",
      label: "Maintenance",
    },
  };
  const style = STYLES[room.status] ?? STYLES.available!;

  const tile = (
    <div
      className={`relative w-full rounded-lg border-2 overflow-hidden shadow-sm hover:shadow-md hover:-translate-y-0.5 transition-all cursor-pointer ${style.card}`}
      title={
        room.relet_pending
          ? `Same-day re-let: walk-in checks out today, ${room.relet_pending.nextGuestName} arrives ${room.relet_pending.nextCheckIn}`
          : showHoldHint
            ? `Free tonight. Booked for ${room.guest_name ?? "a guest"} from ${room.held_from}${
                room.held_to ? ` to ${room.held_to}` : ""
              }.`
            : room.guest_name
              ? room.guest_name
              : undefined
      }
    >
      {room.relet_pending && (
        <span
          className="absolute top-1.5 right-1.5 w-2.5 h-2.5 rounded-full bg-info ring-2 ring-cream animate-pulse"
          aria-label="Same-day re-let"
        />
      )}
      <div className="px-3 py-3.5 flex flex-col items-center gap-1.5">
        {/* Room number — largest element, anchors the tile visually. */}
        <span className="font-mono text-3xl font-bold tracking-wide leading-none">
          {room.room_number}
        </span>
        {/* Type label — strapline between room number and status pill.
            Wide tracking + semibold reads cleanly on coloured fills. */}
        <span className={`text-xs uppercase tracking-wider font-semibold truncate max-w-full ${style.typeText}`}>
          {room.room_type.replace(/_/g, " ")}
        </span>
        <span className={`inline-flex items-center gap-1.5 text-xs uppercase tracking-wider font-bold ${style.statusText}`}>
          <span className={`w-2 h-2 rounded-full ${style.statusDot}`} />
          {style.label}
        </span>
      </div>
      {showHoldHint && heldRange && (
        <div className="flex items-center justify-center gap-1 px-2 py-1 bg-warning text-cream text-[11px] uppercase tracking-wider font-bold">
          <CalendarClock className="w-3 h-3" />
          Held {heldRange}
        </div>
      )}
    </div>
  );

  if (isHousekeeping) {
    return (
      <RoomActionPopover
        roomId={room.id}
        roomNumber={room.room_number}
        status={room.status as "dirty" | "maintenance"}
        trigger={tile}
      />
    );
  }

  return (
    <button
      type="button"
      onClick={() => {
        if (room.status === "available") onWalkIn();
        else if (
          (room.status === "occupied" || room.status === "reserved") &&
          room.reservation_id
        )
          onOpenReservation();
        else onOpenRoom();
      }}
      className="text-left"
    >
      {tile}
    </button>
  );
}

interface RoomGridRow {
  reservation_id: string | null;
  reservation_number: string | null;
  id: string;
  room_number: string;
  room_type: string;
  floor: number;
  status: string;
  guest_name: string | null;
  // Upcoming hold window. Both ends are yyyy-MM-dd. Used to render
  // "HELD 02 → 03 JUN" on the tile so the desk sees both edges of
  // the lock at a glance.
  held_from: string | null;
  held_to: string | null;
  relet_pending: { nextGuestName: string; nextCheckIn: string } | null;
}

// Group rooms by physical floor so the dashboard mirrors the property's
// actual layout. Floors render in ascending order (1, 2, 3 …) and
// rooms within each floor are sorted by room number (201, 202, 203 …)
// regardless of type — staff scans the floor as if walking the corridor.
function groupByFloor(rooms: RoomGridRow[]) {
  const map = new Map<number, RoomGridRow[]>();
  for (const r of rooms) {
    const f = r.floor ?? 0;
    if (!map.has(f)) map.set(f, []);
    map.get(f)!.push(r);
  }
  return Array.from(map.entries())
    .map(([floor, rs]) => ({
      floor,
      rooms: rs.sort((a, b) =>
        a.room_number.localeCompare(b.room_number, undefined, { numeric: true }),
      ),
    }))
    .sort((a, b) => a.floor - b.floor);
}

// Roll status counts up to floor level so the floor headline can show
// the same Available/Held/Occupied/etc. chips that used to sit on the
// per-type strip. Mirrors the per-type bucket logic exactly.
function rollupFloorStats(rooms: RoomGridRow[]) {
  const s = {
    total: 0,
    available: 0,
    held: 0,
    occupied: 0,
    reserved: 0,
    dirty: 0,
    maintenance: 0,
  };
  for (const r of rooms) {
    s.total++;
    if (r.status === "available" && r.held_from) s.held++;
    else if (r.status === "available") s.available++;
    else if (r.status === "occupied") s.occupied++;
    else if (r.status === "reserved") s.reserved++;
    else if (r.status === "dirty") s.dirty++;
    else if (r.status === "maintenance") s.maintenance++;
  }
  return s;
}

