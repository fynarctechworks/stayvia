import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  ActivityFill,
  BadgeIndianRupee,
  BadgeIndianRupeeFill,
  BarChart3,
  BarChart3Fill,
  Bell,
  BellFill,
  BellRing,
  BellRingFill,
  CalendarCheck,
  CalendarCheckFill,
  CalendarDays,
  CalendarDaysFill,
  ChevronLeft,
  ChevronRight,
  CreditCard,
  CreditCardFill,
  DoorOpen,
  DoorOpenFill,
  LayoutDashboard,
  LayoutDashboardFill,
  LogOut,
  MessageSquare,
  MessageSquareFill,
  QrCode,
  Receipt,
  ReceiptFill,
  Settings,
  SettingsFill,
  SprayCan,
  SprayCanFill,
  TrendingDown,
  TrendingDownFill,
  UserCog,
  UserCogFill,
  Users,
  UsersFill,
  Wallet,
  WalletFill,
} from "@/lib/micons";
import { GUEST_REQUEST_OPEN_STATUSES } from "@stayvia/shared";
import { NavLink } from "react-router-dom";
import { useAuth } from "@/auth/AuthContext";
import { useDialog } from "@/components/Dialog";
import { api, getList } from "@/lib/api";
import { cn } from "@/lib/utils";

interface NavItem {
  to: string;
  label: string;
  icon: typeof LayoutDashboard;
  // FILL=1 variant rendered when the item is active (Material Symbols
  // outline + filled-active pattern).
  iconFill: typeof LayoutDashboard;
  permission?: string; // permission key required to see this item
  // Strictly role-gated items (no permission key exists) — e.g. Billing,
  // which the API guards with requireRole('admin').
  adminOnly?: boolean;
  // Live indicator rendered at the right edge when expanded.
  indicator?: "collections" | "guestRequests" | "messages" | "notifications" | "requests";
}

// Warm Concierge grouped nav. Same items + permissions as before, now
// organised into labelled sections (see design handoff "App Shell").
const NAV_SECTIONS: { title: string; items: NavItem[] }[] = [
  {
    title: "OVERVIEW",
    items: [
      { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard, iconFill: LayoutDashboardFill, permission: "view_dashboard" },
      { to: "/reservations", label: "Reservations", icon: CalendarCheck, iconFill: CalendarCheckFill, permission: "view_reservations" },
      // QR self-bookings waiting for desk confirmation. Same icon for both
      // states (no fill variant needed for a code glyph).
      { to: "/requests", label: "Booking Requests", icon: QrCode, iconFill: QrCode, permission: "view_reservations", indicator: "requests" },
      // In-room QR service requests (cleaning / amenity / issue). A different
      // queue from Booking Requests above — same QR family, different table.
      // Gated on view_housekeeping to match routes/guestRequests.ts.
      { to: "/guest-requests", label: "Guest Requests", icon: BellRing, iconFill: BellRingFill, permission: "view_housekeeping", indicator: "guestRequests" },
      { to: "/rooms", label: "Rooms", icon: DoorOpen, iconFill: DoorOpenFill, permission: "view_rooms" },
      { to: "/housekeeping", label: "Housekeeping", icon: SprayCan, iconFill: SprayCanFill, permission: "view_housekeeping" },
      { to: "/calendar", label: "Calendar", icon: CalendarDays, iconFill: CalendarDaysFill, permission: "view_reservations" },
      { to: "/guests", label: "Guests", icon: Users, iconFill: UsersFill, permission: "view_guests" },
    ],
  },
  {
    title: "MONEY",
    items: [
      { to: "/invoices", label: "Invoices", icon: Receipt, iconFill: ReceiptFill, permission: "view_invoices" },
      { to: "/collections", label: "Collections", icon: Wallet, iconFill: WalletFill, permission: "view_revenue", indicator: "collections" },
      { to: "/credits", label: "Credits", icon: BadgeIndianRupee, iconFill: BadgeIndianRupeeFill, permission: "view_revenue" },
      { to: "/expenses", label: "Expenses", icon: TrendingDown, iconFill: TrendingDownFill, permission: "view_expenses" },
    ],
  },
  {
    title: "INSIGHTS",
    items: [
      { to: "/reports", label: "Reports", icon: BarChart3, iconFill: BarChart3Fill, permission: "view_reports" },
      { to: "/activity", label: "Activity", icon: Activity, iconFill: ActivityFill, permission: "view_activity" },
    ],
  },
  {
    title: "WORKSPACE",
    items: [
      { to: "/messages", label: "Messages", icon: MessageSquare, iconFill: MessageSquareFill, permission: "view_messages", indicator: "messages" },
      { to: "/notifications", label: "Notifications", icon: Bell, iconFill: BellFill, permission: "view_notifications", indicator: "notifications" },
      { to: "/staff", label: "Staff", icon: UserCog, iconFill: UserCogFill, permission: "manage_staff" },
      { to: "/billing", label: "Billing", icon: CreditCard, iconFill: CreditCardFill, adminOnly: true },
      { to: "/settings", label: "Settings", icon: Settings, iconFill: SettingsFill, permission: "manage_settings" },
    ],
  },
];

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}

export function Sidebar({
  collapsed,
  onToggle,
  mobile = false,
}: {
  collapsed: boolean;
  onToggle: () => void;
  // When true, renders inside the AppShell's mobile drawer:
  //   - no fixed-position absolute on the aside (the drawer wrapper
  //     handles slide-in already)
  //   - the footer "Collapse" control is hidden
  //   - always expanded
  mobile?: boolean;
}) {
  const { profile, signOut, can } = useAuth();
  const dialog = useDialog();

  async function handleSignOut() {
    const ok = await dialog.confirm({
      title: "Sign out?",
      message: "You'll need to log in again to use the system.",
      okLabel: "Sign out",
      cancelLabel: "Stay signed in",
    });
    if (ok) await signOut();
  }
  const notifQ = useQuery({
    queryKey: ["notifications"],
    queryFn: () => api.get<{ unreadCount: number }>("/notifications"),
    refetchInterval: 30_000,
    enabled: !!profile && can("view_notifications"),
  });
  const unread = notifQ.data?.unreadCount ?? 0;

  const collectionsQ = useQuery({
    queryKey: ["collections-summary"],
    queryFn: () =>
      api
        .get<{ pendingPayments: { paymentId: string }[] }>("/reports/outstanding")
        .then((d) => d.pendingPayments.length),
    refetchInterval: 60_000,
    // Match the nav: Collections is revenue-gated, so we shouldn't be
    // polling /reports/outstanding for a user who can't even see the page.
    enabled: !!profile && can("view_revenue"),
  });
  const owingCount = collectionsQ.data ?? 0;

  // Pending QR booking requests (holds). 15s poll — these expire in 30
  // minutes, so the badge has to feel live.
  const requestsQ = useQuery({
    queryKey: ["reservations", { status: "hold" }, "count"],
    queryFn: () =>
      // live_only drops holds already past their expiry that the sweep
      // hasn't collected yet, so the badge matches the queue's card count.
      getList("/reservations", { status: "hold", live_only: "true", per_page: 1 }).then(
        (d) => d.meta.total,
      ),
    refetchInterval: 15_000,
    enabled: !!profile && can("view_reservations"),
  });
  const pendingRequests = requestsQ.data ?? 0;

  // In-room guest requests still needing someone (open + acknowledged). Same
  // 15s cadence as Booking Requests above and for the same reason: a guest is
  // physically waiting in their room, so a 30s badge is a 30s-late towel.
  // There is no dedicated count endpoint — the list's meta.total with
  // per_page=1 is the same trick the Booking Requests badge uses.
  const guestRequestsQ = useQuery({
    queryKey: ["guest-requests", "count"],
    queryFn: () =>
      getList("/guest-requests", {
        statuses: GUEST_REQUEST_OPEN_STATUSES.join(","),
        per_page: 1,
      }).then((d) => d.meta.total),
    refetchInterval: 15_000,
    // Matches the nav item and the API's own gate (view_housekeeping) — don't
    // poll an endpoint for a user who can't open the page.
    enabled: !!profile && can("view_housekeeping"),
  });
  const pendingGuestRequests = guestRequestsQ.data ?? 0;

  // Messages badge — sum of per-thread unread counts. Same polling
  // cadence as collections so the sidebar stays cheap.
  const messagesQ = useQuery({
    queryKey: ["messages-threads-summary"],
    queryFn: () =>
      api
        .get<{ items: { unread: number }[] }>("/messages/threads")
        .then((d) => d.items.reduce((s, t) => s + (t.unread ?? 0), 0)),
    refetchInterval: 30_000,
    enabled: !!profile && can("view_messages"),
  });
  const unreadMessages = messagesQ.data ?? 0;

  if (!profile) return null;

  // A badge that silently disappears reads as "nothing waiting" — which is
  // exactly what a guest sitting in their room with an open request is not.
  // So each indicator carries its query's failure state, and a failed count
  // renders a warning marker instead of nothing.
  //
  // Only when the count was NEVER obtained, though. These badges poll every
  // 15-60s and TanStack keeps the last value through a failed refetch, so
  // keying off `isError` alone turned a correct "3" into a "!" — strictly less
  // information than the number it replaced — on one dropped poll. A slightly
  // stale count beats no count; the marker is for genuine ignorance.
  const failedWithNoCount = (q: { isError: boolean; data: unknown }) =>
    q.isError && q.data === undefined;
  const indicatorFailed: Record<NonNullable<NavItem["indicator"]>, boolean> = {
    collections: failedWithNoCount(collectionsQ),
    guestRequests: failedWithNoCount(guestRequestsQ),
    messages: failedWithNoCount(messagesQ),
    notifications: failedWithNoCount(notifQ),
    requests: failedWithNoCount(requestsQ),
  };

  function renderIndicator(item: NavItem) {
    const kind = item.indicator;
    if (!kind) return null;
    if (collapsed && !mobile) return null;
    if (indicatorFailed[kind]) {
      return (
        <span
          className="shrink-0 min-w-[19px] h-[19px] px-1.5 rounded-full bg-warnBg text-warnFg border border-warnBorder text-[11px] font-bold inline-flex items-center justify-center"
          aria-label={`${item.label} count unavailable — the request failed`}
          title="Count unavailable — this didn't load. It is not necessarily zero."
        >
          !
        </span>
      );
    }
    if (kind === "collections" && owingCount > 0) {
      return (
        <span
          className="shrink-0 min-w-[19px] h-[19px] px-1.5 rounded-full bg-brand text-white text-[11px] font-bold tabular-nums inline-flex items-center justify-center"
          aria-label={`${owingCount} guest(s) owing`}
        >
          {owingCount}
        </span>
      );
    }
    if (kind === "requests" && pendingRequests > 0) {
      return (
        <span
          className="shrink-0 min-w-[19px] h-[19px] px-1.5 rounded-full bg-gold text-white text-[11px] font-bold tabular-nums inline-flex items-center justify-center"
          aria-label={`${pendingRequests} booking request${pendingRequests === 1 ? "" : "s"} waiting`}
        >
          {pendingRequests}
        </span>
      );
    }
    if (kind === "guestRequests" && pendingGuestRequests > 0) {
      return (
        <span
          className="shrink-0 min-w-[19px] h-[19px] px-1.5 rounded-full bg-gold text-white text-[11px] font-bold tabular-nums inline-flex items-center justify-center"
          aria-label={`${pendingGuestRequests} guest request${pendingGuestRequests === 1 ? "" : "s"} waiting`}
        >
          {pendingGuestRequests}
        </span>
      );
    }
    if (kind === "messages" && unreadMessages > 0) {
      return (
        <span
          className="shrink-0 min-w-[19px] h-[19px] px-1.5 rounded-full bg-brand text-white text-[11px] font-bold tabular-nums inline-flex items-center justify-center"
          aria-label={`${unreadMessages} unread message${unreadMessages === 1 ? "" : "s"}`}
        >
          {unreadMessages}
        </span>
      );
    }
    if (kind === "notifications" && unread > 0) {
      return (
        <span
          className="shrink-0 w-[7px] h-[7px] rounded-full bg-danger"
          aria-label={`${unread} unread`}
          title={`${unread} unread`}
        />
      );
    }
    return null;
  }

  const iconOnly = collapsed && !mobile;

  return (
    <aside
      className={cn(
        "bg-surfaceAlt text-ink border-r border-borderc flex flex-col h-full transition-[width] duration-200 ease-out",
        mobile ? "w-[284px] relative" : "fixed top-0 left-0 z-50",
        !mobile && (collapsed ? "w-[74px]" : "w-60"),
      )}
    >
      {/* Brand header: logo tile + wordmark. */}
      <div
        className={cn(
          "py-4 border-b border-borderc flex items-center gap-3",
          iconOnly ? "px-0 justify-center" : "px-4",
        )}
      >
        <span className="w-9 h-9 rounded-[11px] overflow-hidden bg-brand-soft grid place-items-center shrink-0">
          <img src="/logo.png" alt="Stayvia" className="w-full h-full object-contain" />
        </span>
        {!iconOnly && (
          <div className="min-w-0">
            <div className="font-bold text-[15.5px] tracking-tight leading-tight truncate">Stayvia</div>
            <div className="text-[10px] font-bold text-inkMuted tracking-[0.16em] mt-0.5">HOTEL OS</div>
          </div>
        )}
      </div>

      <nav className="flex-1 px-2.5 py-1.5 overflow-y-auto overflow-x-hidden no-scrollbar">
        {NAV_SECTIONS.map((section) => {
          const visible = section.items.filter((i) =>
            i.adminOnly ? profile.role === "admin" : i.permission ? can(i.permission) : true,
          );
          if (visible.length === 0) return null;
          return (
            <div key={section.title}>
              {!iconOnly && (
                <div className="px-2.5 pt-3.5 pb-1 text-[10px] font-bold tracking-[0.13em] text-inkMuted">
                  {section.title}
                </div>
              )}
              {visible.map((item) => {
                // Dashboard lives at both / and /dashboard — highlight
                // the Dashboard nav item for either URL.
                const onRootDashboard =
                  item.to === "/dashboard" && window.location.pathname === "/";
                return (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.to === "/dashboard"}
                    title={iconOnly ? item.label : undefined}
                    className={({ isActive }) => {
                      const active = isActive || onRootDashboard;
                      return cn(
                        "flex items-center gap-3 my-px py-[9px] rounded-[11px] text-sm transition-colors",
                        iconOnly ? "px-0 justify-center" : "px-[11px]",
                        active
                          ? "bg-brand-soft text-brand-deep font-semibold shadow-[inset_3px_0_0_theme(colors.brand.DEFAULT)]"
                          : "text-inkBody font-medium hover:bg-parchment hover:text-ink",
                      );
                    }}
                  >
                    {({ isActive }) => {
                      const Icon = isActive || onRootDashboard ? item.iconFill : item.icon;
                      return (
                        <>
                          <Icon className="w-5 h-5 shrink-0" />
                          {!iconOnly && <span className="flex-1 min-w-0 truncate">{item.label}</span>}
                          {renderIndicator(item)}
                        </>
                      );
                    }}
                  </NavLink>
                );
              })}
            </div>
          );
        })}
      </nav>

      {/* Footer: collapse, sign out, user card. */}
      <div className="mt-auto p-2.5 border-t border-borderc flex flex-col gap-1.5">
        {/* Icon only, and small: this is a chrome control, not a destination,
            so it should not carry the same visual weight as the nav items
            above it. Sits on the edge it collapses toward. Desktop-only (the
            mobile drawer has its own close), so the 32px target is a mouse
            target, not a thumb one. */}
        {!mobile && (
          <button
            onClick={onToggle}
            title={collapsed ? "Expand" : "Collapse"}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className={cn(
              "grid place-items-center w-8 h-8 rounded-[9px] text-inkMuted hover:bg-parchment hover:text-inkBody transition-colors",
              iconOnly ? "self-center" : "self-end",
            )}
          >
            {collapsed ? (
              <ChevronRight className="w-4 h-4" />
            ) : (
              <ChevronLeft className="w-4 h-4" />
            )}
          </button>
        )}
        <button
          onClick={handleSignOut}
          title="Sign out"
          aria-label="Sign out"
          className={cn(
            "flex items-center gap-3 w-full py-[9px] rounded-[11px] text-[13px] font-semibold text-inkBody hover:bg-parchment transition-colors",
            iconOnly ? "px-0 justify-center" : "px-[11px]",
          )}
        >
          <LogOut className="w-5 h-5 shrink-0" />
          {!iconOnly && <span className="flex-1 text-left">Sign out</span>}
        </button>
        <div
          className={cn(
            "flex items-center gap-2.5 rounded-md bg-parchment/70 p-2",
            iconOnly && "justify-center bg-transparent p-0 pt-1",
          )}
        >
          <span className="w-[34px] h-[34px] rounded-full bg-brand-soft text-brand-deep grid place-items-center font-bold text-[12.5px] shrink-0">
            {initials(profile.fullName)}
          </span>
          {!iconOnly && (
            <div className="min-w-0">
              <div className="text-[13px] font-semibold truncate">{profile.fullName}</div>
              <div className="text-[11px] text-inkMuted capitalize truncate">
                {profile.rbacRoleKey ?? profile.role}
              </div>
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
