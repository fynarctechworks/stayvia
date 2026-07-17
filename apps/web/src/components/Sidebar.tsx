import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  BadgeIndianRupee,
  BarChart3,
  Bell,
  CalendarCheck,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  CreditCard,
  DoorOpen,
  LayoutDashboard,
  LogOut,
  MessageSquare,
  Receipt,
  Settings,
  Sparkles,
  TrendingDown,
  Users,
  Wallet,
} from "lucide-react";
import { NavLink } from "react-router-dom";
import { useAuth } from "@/auth/AuthContext";
import { useDialog } from "@/components/Dialog";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

interface NavItem {
  to: string;
  label: string;
  icon: typeof LayoutDashboard;
  permission?: string; // permission key required to see this item
  // Strictly role-gated items (no permission key exists) — e.g. Billing,
  // which the API guards with requireRole('admin').
  adminOnly?: boolean;
}

// Each item declares the permission key required. Admin (god mode) sees everything.
const NAV: NavItem[] = [
  { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard, permission: "view_dashboard" },
  { to: "/rooms", label: "Rooms", icon: DoorOpen, permission: "view_rooms" },
  { to: "/calendar", label: "Calendar", icon: CalendarDays, permission: "view_reservations" },
  { to: "/reservations", label: "Reservations", icon: CalendarCheck, permission: "view_reservations" },
  { to: "/guests", label: "Guests", icon: Users, permission: "view_guests" },
  { to: "/housekeeping", label: "Housekeeping", icon: Sparkles, permission: "view_housekeeping" },
  { to: "/messages", label: "Messages", icon: MessageSquare, permission: "view_messages" },
  { to: "/invoices", label: "Invoices", icon: Receipt, permission: "view_invoices" },
  { to: "/collections", label: "Collections", icon: Wallet, permission: "view_revenue" },
  { to: "/credits", label: "Credits", icon: BadgeIndianRupee, permission: "view_revenue" },
  { to: "/expenses", label: "Expenses", icon: TrendingDown, permission: "view_expenses" },
  { to: "/notifications", label: "Notifications", icon: Bell, permission: "view_notifications" },
  { to: "/activity", label: "Activity", icon: Activity, permission: "view_activity" },
  { to: "/reports", label: "Reports", icon: BarChart3, permission: "view_reports" },
  { to: "/billing", label: "Billing", icon: CreditCard, adminOnly: true },
  { to: "/settings", label: "Settings", icon: Settings, permission: "manage_settings" },
];

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
  //   - hide the desktop collapse/expand arrow button
  //   - always expanded
  mobile?: boolean;
}) {
  const { profile, property, signOut, can } = useAuth();
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
    // Match the nav: Collections is now revenue-gated, so we shouldn't be
    // polling /reports/outstanding for a user who can't even see the page.
    enabled: !!profile && can("view_revenue"),
  });
  const owingCount = collectionsQ.data ?? 0;

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

  const visible = NAV.filter((i) =>
    i.adminOnly ? profile.role === "admin" : i.permission ? can(i.permission) : true,
  );

  return (
    <aside
      className={cn(
        "bg-brand-dark text-cream flex flex-col h-full transition-[width] duration-200 ease-out",
        // Desktop: fixed left rail with collapsible width. z-50 so the
        // rail (and its collapse pill) sit above the sticky checkout
        // alert bar (z-40) in the content column — otherwise the pill,
        // which juts out over the content edge, gets covered by the bar.
        mobile ? "w-72 relative" : "fixed top-0 left-0 z-50",
        !mobile && (collapsed ? "w-16" : "w-60"),
      )}
    >
      {/* Desktop collapse/expand pill. Hidden in the mobile drawer
          because the drawer has its own backdrop+tap-to-close. */}
      {!mobile && (
        <button
          onClick={onToggle}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className="absolute -right-4 top-7 z-50 grid place-items-center w-8 h-8 rounded-full bg-brand-dark text-cream ring-1 ring-brass/40 shadow-md hover:bg-[#2a2a2a] hover:text-brass transition-colors"
        >
          {collapsed ? (
            <ChevronRight className="w-5 h-5" />
          ) : (
            <ChevronLeft className="w-5 h-5" />
          )}
        </button>
      )}

      <div
        className={cn(
          "py-5 border-b border-brass/15 flex items-center gap-3",
          collapsed ? "px-3 justify-center" : "px-5",
        )}
      >
        <img
          src="/logo.jpg"
          alt="Stayvia"
          className="w-10 h-10 rounded-md bg-cream object-contain p-0.5 shrink-0 ring-1 ring-brass/30"
        />
        {!collapsed && (
          <div className="min-w-0">
            <div className="text-base font-semibold tracking-tight leading-tight truncate text-cream">{property?.name ?? "Stayvia"}</div>
            <div className="text-[10px] text-brass tracking-[0.15em] mt-0.5">HOTEL OS</div>
          </div>
        )}
      </div>

      <nav className="flex-1 py-3 overflow-y-auto overflow-x-hidden no-scrollbar">
        {visible.map((item) => {
          const Icon = item.icon;
          return (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === "/dashboard"}
              title={collapsed ? item.label : undefined}
              className={({ isActive }) => {
                // Dashboard lives at both / and /dashboard — highlight
                // the Dashboard nav item for either URL.
                const onRootDashboard =
                  item.to === "/dashboard" && window.location.pathname === "/";
                const active = isActive || onRootDashboard;
                return cn(
                  "flex items-center gap-3 py-2.5 text-sm transition-colors",
                  collapsed ? "px-0 justify-center" : "px-5",
                  active
                    ? "bg-brand-mid/30 text-cream border-l-2 border-brass"
                    : "text-cream/70 hover:bg-cream/5 hover:text-cream border-l-2 border-transparent",
                );
              }}
            >
              <Icon className="w-4 h-4 shrink-0" />
              {!collapsed && <span className="flex-1">{item.label}</span>}
              {!collapsed && item.to === "/notifications" && unread > 0 && (
                <span
                  className="w-2 h-2 rounded-full bg-brass shrink-0"
                  aria-label={`${unread} unread`}
                  title={`${unread} unread`}
                />
              )}
              {!collapsed && item.to === "/messages" && unreadMessages > 0 && (
                <span
                  className="w-2 h-2 rounded-full bg-brass shrink-0"
                  aria-label={`${unreadMessages} unread message${unreadMessages === 1 ? "" : "s"}`}
                  title={`${unreadMessages} unread message${unreadMessages === 1 ? "" : "s"}`}
                />
              )}
              {!collapsed && item.to === "/collections" && owingCount > 0 && (
                <span
                  className="relative flex w-2 h-2 shrink-0"
                  aria-label={`${owingCount} guest(s) owing`}
                  title={`${owingCount} guest(s) owing`}
                >
                  <span className="absolute inset-0 rounded-full bg-danger animate-ping opacity-60" />
                  <span className="relative w-2 h-2 rounded-full bg-danger" />
                </span>
              )}
            </NavLink>
          );
        })}
      </nav>

      {!collapsed ? (
        <div className="px-5 py-4 border-t border-brass/15">
          <div className="text-[10px] text-brass tracking-[0.15em]">SIGNED IN AS</div>
          <div className="text-sm font-medium truncate text-cream mt-1">{profile.fullName}</div>
          <div className="text-xs text-cream/50 capitalize">
            {profile.rbacRoleKey ?? profile.role}
          </div>
          <button
            onClick={handleSignOut}
            className="mt-3 flex items-center gap-2 text-xs text-cream/60 hover:text-brass transition-colors"
          >
            <LogOut className="w-3 h-3" /> Sign out
          </button>
        </div>
      ) : (
        <div className="py-4 border-t border-brass/15 flex justify-center">
          <button
            onClick={handleSignOut}
            title="Sign out"
            aria-label="Sign out"
            className="grid place-items-center w-9 h-9 rounded-md text-cream/60 hover:text-brass hover:bg-cream/5 transition-colors"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      )}
    </aside>
  );
}
