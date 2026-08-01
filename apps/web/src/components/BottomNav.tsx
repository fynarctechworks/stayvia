import {
  CalendarCheck,
  CalendarCheckFill,
  DoorOpen,
  DoorOpenFill,
  LayoutDashboard,
  LayoutDashboardFill,
  Menu,
  SprayCan,
  SprayCanFill,
} from "@/lib/micons";
import { NavLink } from "react-router-dom";
import { useAuth } from "@/auth/AuthContext";
import { cn } from "@/lib/utils";

// Phone-first bottom tab bar (hidden on md+, where the sidebar rail is
// the primary nav). Warm Concierge: blurred parchment bar, jade active
// state. Shows 4 core destinations + a "More" button that opens the
// existing full-nav drawer. Each tab is permission-gated so a
// frontdesk/housekeeping user only sees what they can reach; everything
// else lives in the "More" drawer, which renders the full Sidebar nav.
interface Tab {
  to: string;
  label: string;
  icon: typeof LayoutDashboard;
  // FILL=1 variant rendered when the tab is active.
  iconFill: typeof LayoutDashboard;
  permission: string;
  // Highlight the tab for these extra path prefixes (e.g. Bookings
  // tab stays active on /reservations/:id and /calendar).
  alsoActiveOn?: string[];
}

const TABS: Tab[] = [
  { to: "/dashboard", label: "Home", icon: LayoutDashboard, iconFill: LayoutDashboardFill, permission: "view_dashboard" },
  {
    to: "/reservations",
    label: "Bookings",
    icon: CalendarCheck,
    iconFill: CalendarCheckFill,
    permission: "view_reservations",
    alsoActiveOn: ["/reservations", "/calendar"],
  },
  { to: "/rooms", label: "Rooms", icon: DoorOpen, iconFill: DoorOpenFill, permission: "view_rooms" },
  { to: "/housekeeping", label: "Clean", icon: SprayCan, iconFill: SprayCanFill, permission: "view_housekeeping" },
];

export function BottomNav({ onMore }: { onMore: () => void }) {
  const { profile, can } = useAuth();
  if (!profile) return null;
  const tabs = TABS.filter((t) => can(t.permission));

  return (
    <nav
      className="md:hidden fixed bottom-0 inset-x-0 z-40 h-[72px] bg-surfaceAlt/95 backdrop-blur-[12px] border-t border-borderc pb-safe flex items-stretch justify-around"
      aria-label="Primary"
    >
      {tabs.map((t) => {
        const path = window.location.pathname;
        const onRootDashboard =
          t.to === "/dashboard" && (path === "/" || path === "/dashboard");
        const onExtra = (t.alsoActiveOn ?? []).some((p) => path.startsWith(p));
        return (
          <NavLink key={t.to} to={t.to} end={t.to === "/dashboard"} className="flex-1">
            {({ isActive }) => {
              const active = isActive || onRootDashboard || onExtra;
              const Icon = active ? t.iconFill : t.icon;
              return (
                <span
                  className={cn(
                    "h-full flex flex-col items-center justify-center gap-[3px] transition-colors",
                    active ? "text-brand-deep" : "text-inkMuted",
                  )}
                >
                  <Icon className="w-6 h-6" />
                  <span className="text-[10.5px] font-semibold leading-none">{t.label}</span>
                </span>
              );
            }}
          </NavLink>
        );
      })}
      {/* "More" opens the full nav drawer (same one the top hamburger uses). */}
      <button
        onClick={onMore}
        className="flex-1 flex flex-col items-center justify-center gap-[3px] text-inkMuted active:text-ink"
        aria-label="More"
      >
        <Menu className="w-6 h-6" />
        <span className="text-[10.5px] font-semibold leading-none">More</span>
      </button>
    </nav>
  );
}
