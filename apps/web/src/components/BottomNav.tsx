import {
  CalendarCheck,
  CalendarCheckFill,
  DoorOpen,
  DoorOpenFill,
  LayoutDashboard,
  LayoutDashboardFill,
  Menu,
  Users,
  UsersFill,
} from "@/lib/micons";
import { NavLink } from "react-router-dom";
import { useAuth } from "@/auth/AuthContext";
import { cn } from "@/lib/utils";

// Phone-first bottom tab bar (hidden on md+, where the sidebar rail is
// the primary nav). Shows the 4 core destinations + a "More" button
// that opens the existing full-nav drawer. Each tab is permission-gated
// so a frontdesk/housekeeping user only sees what they can reach.
// Admin-only destinations that don't earn a core tab (Billing, Settings…)
// live in the "More" drawer — it renders the full Sidebar nav, which
// already role-filters them.
interface Tab {
  to: string;
  label: string;
  icon: typeof LayoutDashboard;
  // FILL=1 variant rendered when the tab is active.
  iconFill: typeof LayoutDashboard;
  permission: string;
  // Highlight the tab for these extra path prefixes (e.g. Reservations
  // tab stays active on /reservations/:id and /reservations/new).
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
  { to: "/guests", label: "Guests", icon: Users, iconFill: UsersFill, permission: "view_guests", alsoActiveOn: ["/guests"] },
];

export function BottomNav({ onMore }: { onMore: () => void }) {
  const { profile, can } = useAuth();
  if (!profile) return null;
  const tabs = TABS.filter((t) => can(t.permission));

  return (
    <nav
      className="md:hidden fixed bottom-0 inset-x-0 z-40 bg-brand-dark/95 backdrop-blur text-cream border-t border-white/10 pb-safe shadow-[0_-2px_12px_rgba(0,0,0,0.25)]"
      aria-label="Primary"
    >
      <div className="grid grid-cols-5 h-16">
        {tabs.map((t) => {
          const path = window.location.pathname;
          const onRootDashboard =
            t.to === "/dashboard" && (path === "/" || path === "/dashboard");
          const onExtra = (t.alsoActiveOn ?? []).some((p) => path.startsWith(p));
          return (
            <NavLink key={t.to} to={t.to} end={t.to === "/dashboard"} className="relative">
              {({ isActive }) => {
                const active = isActive || onRootDashboard || onExtra;
                const Icon = active ? t.iconFill : t.icon;
                return (
                  <div className="h-full flex flex-col items-center justify-center gap-1">
                    {/* Active accent bar at the top of the tab. */}
                    <span
                      className={cn(
                        "absolute top-0 h-0.5 w-8 rounded-full transition-all",
                        active ? "bg-brand" : "bg-transparent",
                      )}
                    />
                    <span
                      className={cn(
                        "grid place-items-center w-9 h-7 rounded-full transition-colors",
                        active ? "bg-brand/15 text-brand" : "text-cream/60",
                      )}
                    >
                      <Icon className="w-5 h-5" />
                    </span>
                    <span
                      className={cn(
                        "text-[10px] font-medium leading-none transition-colors",
                        active ? "text-brand" : "text-cream/60",
                      )}
                    >
                      {t.label}
                    </span>
                  </div>
                );
              }}
            </NavLink>
          );
        })}
        {/* "More" opens the full nav drawer (same one the top hamburger uses). */}
        <button
          onClick={onMore}
          className="h-full flex flex-col items-center justify-center gap-1 text-cream/60 active:text-cream"
          aria-label="More"
        >
          <span className="grid place-items-center w-9 h-7">
            <Menu className="w-5 h-5" />
          </span>
          <span className="text-[10px] font-medium leading-none">More</span>
        </button>
      </div>
    </nav>
  );
}
