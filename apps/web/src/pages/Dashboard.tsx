import { useQuery } from "@tanstack/react-query";
import {
  ArrowRight,
  BedDouble,
  CalendarPlus,
  CheckCircle2,
  LogIn,
  LogOut,
  Receipt,
  Tags,
  UserPlus,
  Wallet,
  X,
} from "@/lib/micons";
import { format } from "date-fns";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "@/auth/AuthContext";
import { Can } from "@/auth/Can";
import { useRoomTypes } from "@/hooks/useRoomTypes";
import { KpiCard, KpiSkeletonRow, StackedAvailability } from "@/components/kit";
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
  const { profile } = useAuth();
  const { data, isLoading } = useQuery({
    queryKey: ["dashboard"],
    queryFn: () => api.get<DashboardData>("/dashboard"),
    refetchInterval: 30_000,
  });

  // Warm Concierge greeting header ("Good morning, <name>") — pure
  // presentation, derived from the clock + the signed-in profile.
  const hour = new Date().getHours();
  const greeting =
    hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const firstName = profile?.fullName?.trim().split(/\s+/)[0];

  const headerBlock = (
    <div>
      <h1 className="text-[clamp(22px,3vw,28px)] font-semibold tracking-[-0.5px] text-ink leading-tight">
        {greeting}
        {firstName ? `, ${firstName}` : ""}
      </h1>
      <div className="text-sm text-textSecondary mt-1.5">
        {format(new Date(), "EEEE, d MMM yyyy")} · Here's how the property looks
        today.
      </div>
    </div>
  );

  if (isLoading || !data) {
    return (
      <div className="space-y-[22px]">
        <div className="flex items-center justify-between">{headerBlock}</div>
        <KpiSkeletonRow />
        <KpiSkeletonRow />
      </div>
    );
  }

  return (
    <div className="space-y-[22px]">
      <div className="flex items-end justify-between flex-wrap gap-4">
        {headerBlock}
        <div className="flex items-center gap-2.5 w-full sm:w-auto">
          <button
            onClick={() => navigate("/reservations/new?mode=booking")}
            className="btn-secondary inline-flex items-center justify-center gap-2 flex-1 sm:flex-none"
          >
            <CalendarPlus className="w-4 h-4" /> Pre-booking
          </button>
          <button
            onClick={() => navigate("/reservations/new?mode=walkin")}
            className="btn-primary inline-flex items-center justify-center gap-2 flex-1 sm:flex-none"
          >
            <UserPlus className="w-4 h-4" /> New walk-in
          </button>
        </div>
      </div>

      {/* Overdue check-out alert now lives in the app-wide sticky
          CheckoutAlerts bar (rendered in AppShell), so it follows
          staff to every page instead of only the Dashboard. The
          duplicate card that used to live here was removed to keep a
          single source of truth. */}

      {/* Fresh signup (no rooms yet): one-time setup pointers. Uses the
          room count the dashboard payload already carries — no extra
          fetch. Dismissible; stays gone via localStorage. */}
      {data.occupancy.total === 0 && <GetStartedCard />}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        <KpiCard
          featured
          icon={<BedDouble className="w-4 h-4" />}
          label="Occupancy"
          value={`${data.occupancy.occupied} / ${data.occupancy.total}`}
          sub={
            <>
              {data.occupancy.percentage}% occupied tonight
              <span className="block h-[5px] mt-1.5 rounded-full bg-parchment overflow-hidden">
                <span
                  className="block h-full rounded-full bg-brand"
                  style={{
                    width: `${Math.min(100, Math.max(0, data.occupancy.percentage))}%`,
                  }}
                />
              </span>
            </>
          }
          to="/rooms"
        />
        <KpiCard
          icon={<LogIn className="w-4 h-4" />}
          label="Arrivals today"
          value={String(data.today_checkins.count)}
          sub={`${
            data.today_checkins.reservations.filter((r) => r.status === "confirmed").length
          } pending`}
        />
        <KpiCard
          icon={<LogOut className="w-4 h-4" />}
          label="Departures today"
          value={String(data.today_checkouts.count)}
          sub={`${
            data.today_checkouts.reservations.filter((r) => r.status === "checked_in").length
          } pending`}
        />
        <Can any={["view_revenue", "view_daily_collections"]}>
          <KpiCard
            icon={<Wallet className="w-4 h-4" />}
            label="Revenue today"
            value={inr(data.revenue_today?.total_collected ?? 0)}
            to="/collections"
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
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
          {data.revenue_kpis?.mtd_collected !== undefined && (
            <Can do="view_revenue">
              <KpiCard
                icon={<Receipt className="w-4 h-4" />}
                label="Revenue MTD"
                value={inr(data.revenue_kpis.mtd_collected)}
                sub="collected this month"
                to="/reports"
              />
            </Can>
          )}
          {data.revenue_kpis?.outstanding_balance !== undefined && (
            <Can any={["view_revenue", "view_daily_collections"]}>
              <KpiCard
                icon={<Wallet className="w-4 h-4" />}
                label="Outstanding Balance"
                value={inr(data.revenue_kpis.outstanding_balance)}
                sub="unpaid across all bookings"
                tone="warning"
              />
            </Can>
          )}
          {data.operations_kpis && (
            <KpiCard
              icon={<LogOut className="w-4 h-4" />}
              label="Pending Check-outs"
              value={String(data.operations_kpis.pending_checkouts_today)}
              sub="due today, not yet processed"
              tone="info"
            />
          )}
          {data.operations_kpis && (
            <KpiCard
              icon={<BedDouble className="w-4 h-4" />}
              label="Rooms Out of Service"
              value={String(data.operations_kpis.rooms_out_of_service)}
              sub="maintenance + dirty"
              tone="danger"
              to="/housekeeping"
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

      {/* "Rooms right now" — one card per the Warm Concierge reference:
          headline + rolled-up proportion bar with legend, then per-floor
          tile grids. Rooms inside a floor are sorted by room number
          (201, 202, 203…) regardless of type, so the layout mirrors how
          staff walks the property. */}
      {data.room_grid.length > 0 && (() => {
        const s = rollupFloorStats(data.room_grid);
        return (
          <div className="card">
            <div className="flex items-start justify-between gap-3.5 flex-wrap mb-4">
              <div>
                <h2 className="text-[17px] font-semibold tracking-[-0.2px] text-ink">
                  Rooms right now
                </h2>
                <p className="text-[13px] text-textSecondary mt-1">
                  {s.available} room{s.available === 1 ? "" : "s"} free to sell
                  tonight
                  {s.held > 0 && <> · {s.held} held for a later stay</>}.
                </p>
              </div>
            </div>

            {/* Whole-property proportion bar + legend. Held rooms roll into
                the Reserved segment: they're empty now but locked for an
                upcoming stay. */}
            <StackedAvailability
              segments={[
                { label: "Occupied", count: s.occupied, barClass: "bg-inkDark" },
                { label: "Reserved", count: s.reserved + s.held, barClass: "bg-reserved" },
                { label: "Available", count: s.available, barClass: "bg-brand" },
                { label: "Not ready", count: s.dirty + s.maintenance, barClass: "bg-notReady" },
              ]}
            />

            {groupByFloor(data.room_grid).map((floorGroup, floorIdx) => {
              const floorStats = rollupFloorStats(floorGroup.rooms);
              // "Sellable" = free to let for TONIGHT. Held rooms count: they
              // are empty now and only locked from a later date, which is why
              // the headline separates them out rather than hiding them.
              const sellable = floorStats.available + floorStats.held;

              return (
                <div
                  key={`floor-${floorGroup.floor}`}
                  className={
                    floorIdx === 0 ? "mt-5" : "mt-5 pt-[18px] border-t border-divider"
                  }
                >
                  <div className="flex items-baseline justify-between gap-3 flex-wrap mb-3">
                    <div className="flex items-baseline gap-2">
                      <span className="text-[15px] font-semibold text-ink">
                        Floor {floorGroup.floor}
                      </span>
                      <span className="text-[12.5px] text-inkMuted">
                        {floorStats.total} room{floorStats.total === 1 ? "" : "s"}
                      </span>
                    </div>
                    {/* Headline answers the one question the desk asks at a
                        glance: how many rooms can I still sell tonight? */}
                    <span
                      className="text-[12.5px] font-semibold text-brand-deep"
                      title={
                        floorStats.held > 0
                          ? `${sellable} of ${floorStats.total} room${floorStats.total === 1 ? "" : "s"} ${sellable === 1 ? "is" : "are"} free tonight — ${floorStats.held} of them ${floorStats.held === 1 ? "is" : "are"} booked from a later date`
                          : `${sellable} of ${floorStats.total} room${floorStats.total === 1 ? "" : "s"} ${sellable === 1 ? "is" : "are"} free to sell tonight`
                      }
                    >
                      {sellable} free tonight
                      {floorStats.held > 0 && (
                        <span className="text-warnFg"> · {floorStats.held} booked later</span>
                      )}
                    </span>
                  </div>

                  {/* Phone fits three ~105px tiles per row; sm+ keeps the
                      original 118px minimum so tiles never look stretched. */}
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(100px,1fr))] sm:grid-cols-[repeat(auto-fill,minmax(118px,1fr))] gap-2 sm:gap-[11px]">
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
        );
      })()}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <TodayPanel
          kind="arrivals"
          title="Today's arrivals"
          rows={data.today_checkins.reservations}
          emptyMessage="No arrivals today."
          onOpen={(id) => navigate(`/reservations/${id}`)}
        />
        <TodayPanel
          kind="departures"
          title="Today's departures"
          rows={data.today_checkouts.reservations}
          emptyMessage="No departures today."
          onOpen={(id) => navigate(`/reservations/${id}`)}
        />
      </div>

    </div>
  );
}

type TodayKind = "arrivals" | "departures";

// Two-letter initials for the avatar tile ("Ananya Rao" → "AR").
function initialsOf(name: string): string {
  return (
    name
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join("") || "?"
  );
}

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

  const isArrivals = kind === "arrivals";
  const HeaderIcon = isArrivals ? LogIn : LogOut;

  return (
    <div className="card !p-0 overflow-hidden">
      <div className="px-3 sm:px-[18px] py-4 border-b border-divider flex flex-wrap items-center justify-between gap-2.5">
        <div className="flex items-center gap-2">
          <span
            className={`w-[30px] h-[30px] rounded-[9px] grid place-items-center ${
              isArrivals ? "bg-infoBg text-info" : "bg-warnBg text-warnDeep"
            }`}
          >
            <HeaderIcon className="w-[18px] h-[18px]" />
          </span>
          <strong className="text-[15px] text-ink">{title}</strong>
        </div>
        <div className="flex items-center gap-1.5 text-xs font-semibold">
          {pending.length > 0 && (
            <span
              className={`px-2 py-0.5 rounded-full ${
                isArrivals ? "bg-warnBg text-warnFg" : "bg-dangerBg text-dangerFg"
              }`}
            >
              {pending.length} pending
            </span>
          )}
          {done.length > 0 && (
            <span className="px-2 py-0.5 rounded-full bg-neutralBg text-inkMuted">
              {done.length} done
            </span>
          )}
          {rows.length === 0 && (
            <span className="text-textSecondary font-normal">0 today</span>
          )}
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="px-3 sm:px-[18px] py-6 text-textSecondary text-sm">{emptyMessage}</div>
      ) : (
        <ul className="divide-y divide-divider">
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
    actionLabel = "Check in";
    ActionIcon = LogIn;
    actionTone = "primary";
  } else if (isDeparturePending) {
    actionLabel = "Check out";
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
      return { label: "Confirmed", cls: "bg-infoBg text-info" };
    }
    if (row.status === "checked_in") {
      return { label: "Checked in", cls: "bg-successBg text-success" };
    }
    if (row.status === "checked_out") {
      return { label: "Checked out", cls: "bg-neutralBg text-inkMuted" };
    }
    return { label: row.status, cls: "bg-neutralBg text-inkMuted" };
  })();

  const rooms = row.roomNumbers
    ? row.roomNumbers.split(",").filter(Boolean)
    : [];

  return (
    <li className="flex items-center gap-2.5 sm:gap-3 px-3 sm:px-[18px] py-3 hover:bg-surfaceAlt transition-colors">
      <span className="w-9 h-9 shrink-0 rounded-full bg-parchment text-inkBody grid place-items-center font-bold text-xs">
        {initialsOf(row.guestName)}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-semibold text-sm text-ink truncate">{row.guestName}</span>
          {rooms.map((rm) => (
            <span
              key={rm}
              className="font-mono text-[10.5px] font-semibold px-1.5 py-px rounded-[6px] bg-bg text-inkBody"
            >
              Room {rm}
            </span>
          ))}
        </div>
        <div className="flex items-center gap-2 mt-1">
          <span className="font-mono text-[11px] text-inkMuted">{row.reservationNumber}</span>
          <span
            className={`px-[7px] py-px rounded-full text-[10.5px] font-semibold ${statusPill.cls}`}
          >
            {statusPill.label}
          </span>
        </div>
      </div>

      <button
        onClick={() => onOpen(row.reservationNumber || row.id)}
        className={`inline-flex items-center gap-1.5 h-11 sm:h-[34px] px-2.5 sm:px-3 text-[12.5px] font-semibold rounded-sm border transition-colors shrink-0 ${
          actionTone === "primary"
            ? "bg-brand text-white border-brand hover:bg-brand-deep"
            : "bg-surface text-inkBody border-borderControl hover:bg-surfaceAlt"
        }`}
      >
        <ActionIcon className="w-4 h-4" />
        {actionLabel}
      </button>
    </li>
  );
}

const ONBOARD_DISMISSED_KEY = "stayvia:onboard-dismissed";

function GetStartedCard() {
  const [dismissed, setDismissed] = useState(
    () => localStorage.getItem(ONBOARD_DISMISSED_KEY) === "1",
  );
  const { profile } = useAuth();
  const isAdmin = profile?.role === "admin";

  // Live completion signals. Cheap reads, all cached elsewhere in the app.
  const typesQ = useRoomTypes();
  const roomsQ = useQuery({
    queryKey: ["rooms", "all"],
    queryFn: () => api.get<{ id: string }[]>("/rooms", {}),
    staleTime: 60_000,
    enabled: !dismissed,
  });
  const pubQ = useQuery({
    queryKey: ["settings-public"],
    queryFn: () => api.get<{ hotelGstin?: string | null }>("/settings/public"),
    staleTime: 60_000,
    enabled: !dismissed,
  });
  const staffQ = useQuery({
    queryKey: ["staff"],
    queryFn: () => api.get<{ id: string }[]>("/staff"),
    staleTime: 60_000,
    // /staff is admin-gated; other roles never fire this.
    enabled: !dismissed && isAdmin,
  });

  if (dismissed) return null;

  const steps = [
    // Room types must exist before the first room can be created, so they
    // lead the list.
    {
      to: "/rooms?tab=types",
      label: "Add room types",
      icon: <Tags className="w-4 h-4" />,
      done: (typesQ.data?.length ?? 0) > 0,
    },
    {
      to: "/rooms",
      label: "Add rooms",
      icon: <BedDouble className="w-4 h-4" />,
      done: (roomsQ.data?.length ?? 0) > 0,
    },
    {
      to: "/settings",
      label: "GST & hotel details",
      icon: <Receipt className="w-4 h-4" />,
      done: !!pubQ.data?.hotelGstin?.trim(),
    },
    {
      to: "/staff",
      label: "Invite staff",
      icon: <UserPlus className="w-4 h-4" />,
      // The admin themselves is row one — "invited" means anyone beyond that.
      done: (staffQ.data?.length ?? 0) > 1,
    },
  ];
  const doneCount = steps.filter((s) => s.done).length;

  // Everything set up — the guide has served its purpose.
  if (doneCount === steps.length) return null;

  return (
    <div className="card">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-semibold text-ink">Welcome to Stayvia - set up your hotel</h2>
          <p className="text-xs text-textSecondary mt-0.5">
            Four quick steps and your front desk is ready.
            <span className="ml-1 font-semibold text-ink">{doneCount} of 4 done.</span>
          </p>
          <div className="flex flex-wrap gap-2 mt-3">
            {steps.map((s) => (
              <Link
                key={s.label}
                to={s.to}
                className={`inline-flex items-center gap-1.5 border rounded-sm px-3 py-1.5 min-h-[44px] sm:min-h-0 text-sm font-medium transition-colors ${
                  s.done
                    ? "border-successBorder bg-successBg text-success"
                    : "border-borderControl bg-surface text-ink hover:bg-surfaceAlt"
                }`}
              >
                {s.done ? <CheckCircle2 className="w-4 h-4" /> : s.icon}
                {s.label}
                {!s.done && <ArrowRight className="w-3.5 h-3.5 text-textSecondary" />}
              </Link>
            ))}
          </div>
        </div>
        <button
          onClick={() => {
            localStorage.setItem(ONBOARD_DISMISSED_KEY, "1");
            setDismissed(true);
          }}
          className="p-1.5 -m-1 rounded text-textSecondary hover:text-ink hover:bg-surfaceSubtle shrink-0 inline-flex items-center justify-center min-w-[44px] min-h-[44px] sm:min-w-0 sm:min-h-0"
          aria-label="Dismiss setup guide"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
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
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="min-w-0">
          <h2 className="text-[16px] font-semibold text-ink">Today's Collections by Method</h2>
          <p className="text-xs text-textSecondary mt-0.5">
            Money received today, split by payment mode - for the daily cash-up.
          </p>
        </div>
        <Wallet className="w-5 h-5 shrink-0 text-inkMuted" />
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
              className="rounded-md border border-divider bg-surfaceAlt p-3"
            >
              <div className="text-[10.5px] font-bold uppercase tracking-[.07em] text-inkMuted">
                {methodLabel(m.method)}
              </div>
              <div
                className={`text-lg font-bold mt-1 font-mono tabular-nums ${
                  m.total < 0 ? "text-danger" : "text-ink"
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
          <span className="font-mono text-ink">
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

      <div className="flex items-center justify-between gap-3 mt-3 pt-3 border-t border-divider">
        <span className="text-sm font-semibold text-ink min-w-0">
          {refunded > 0 ? "Net movement today" : "Total collected today"}
          {totalTxns > 0 && (
            <span className="text-textSecondary font-normal">
              {" "}· {totalTxns} payment{totalTxns === 1 ? "" : "s"}
            </span>
          )}
        </span>
        <span
          className={`text-lg font-bold font-mono tabular-nums shrink-0 ${
            data.total_collected < 0 ? "text-danger" : "text-ink"
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
// extra footer ribbon so the desk sees at a glance that the room is
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
  // typeText controls the small "AC SINGLE ROOM" strapline. On the dark
  // occupied tile it needs a light tint to stay readable; light tiles
  // use a muted shade of their own hue.
  const STYLES: Record<
    string,
    {
      card: string;
      statusDot: string;
      typeText: string;
      label: string;
    }
  > = {
    // Warm Concierge tiles: available/held are the only white "blank
    // canvas" tiles; occupied is the one dark tile; the rest are soft
    // semantic tints so states can't be confused at a glance.
    available: {
      card: "bg-surface border-successBorder text-ink",
      statusDot: "bg-brand",
      typeText: "text-inkMuted",
      label: "Available",
    },
    // Free tonight but booked from a later date — white tile with a gold
    // hold story (dot + footer ribbon below).
    held: {
      card: "bg-surface border-warnBorder text-ink",
      statusDot: "bg-gold",
      typeText: "text-inkMuted",
      label: "Held",
    },
    occupied: {
      // The single dark tile — "in use", per the reference.
      card: "bg-inkDark border-inkDark text-cream",
      statusDot: "bg-brand-tint",
      typeText: "text-cream/60",
      label: "Occupied",
    },
    reserved: {
      card: "bg-infoBg border-infoBorder text-info",
      statusDot: "bg-reserved",
      typeText: "text-info/70",
      label: "Reserved",
    },
    dirty: {
      card: "bg-warnBg border-warnBorder text-warnFg",
      statusDot: "bg-notReady",
      typeText: "text-warnFg/70",
      label: "Needs cleaning",
    },
    maintenance: {
      card: "bg-dangerBg border-dangerBorder text-dangerFg",
      statusDot: "bg-danger",
      typeText: "text-dangerFg/70",
      label: "Maintenance",
    },
  };
  const style =
    (showHoldHint ? STYLES.held : STYLES[room.status]) ?? STYLES.available!;

  // Held tiles reserve extra bottom room: on a ~100px phone tile the
  // "HELD 30 Jun → 02 Jul" ribbon can run to two lines and would
  // otherwise ride up over the status row.
  const tile = (
    <div
      className={`relative w-full min-h-[104px] rounded-[13px] border overflow-hidden px-2 pt-3.5 ${
        showHoldHint ? "pb-6" : "pb-3"
      } flex flex-col items-center justify-center gap-1.5 cursor-pointer transition-all hover:-translate-y-0.5 hover:shadow-lift ${style.card}`}
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
          className="absolute top-1.5 right-1.5 w-2.5 h-2.5 rounded-full bg-info ring-2 ring-surface animate-pulse"
          aria-label="Same-day re-let"
        />
      )}
      {/* Room number — largest element, anchors the tile visually. */}
      <span className="font-mono text-[22px] font-semibold tracking-[.5px] leading-none">
        {room.room_number}
      </span>
      {/* Type label — overline between room number and status row. */}
      <span
        className={`text-[10px] uppercase tracking-[.06em] font-semibold truncate max-w-full ${style.typeText}`}
      >
        {room.room_type.replace(/_/g, " ")}
      </span>
      <span className="inline-flex items-center gap-[5px] text-[11px] font-semibold">
        <span className={`w-[7px] h-[7px] rounded-full ${style.statusDot}`} />
        {style.label}
      </span>
      {showHoldHint && heldRange && (
        <span className="absolute inset-x-0 bottom-0 py-[3px] text-center text-[9.5px] font-bold tracking-[.04em] bg-gold text-white">
          HELD {heldRange}
        </span>
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

// Roll status counts up to floor level so the floor headline and the
// card-level proportion bar share one source. Held = available tonight
// but locked from a later date.
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
