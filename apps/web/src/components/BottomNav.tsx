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
      className="md:hidden fixed bottom-0 inset-x-0 z-40 bg-brand-dark text-cream border-t border-brass/20 pb-safe"
      aria-label="Primary"
    >
      <div className="grid grid-cols-5 h-14">
        {tabs.map((t) => {
          const path = window.location.pathname;
          const onRootDashboard =
            t.to === "/dashboard" && (path === "/" || path === "/dashboard");
          const onExtra = (t.alsoActiveOn ?? []).some((p) => path.startsWith(p));
          return (
            <NavLink
              key={t.to}
              to={t.to}
              end={t.to === "/dashboard"}
              className={({ isActive }) => {
                const active = isActive || onRootDashboard || onExtra;
                return cn(
                  "flex flex-col items-center justify-center gap-0.5 text-[10px] font-medium transition-colors",
                  active ? "text-brass" : "text-cream/60 active:text-cream",
                );
              }}
            >
              {({ isActive }) => {
                const Icon =
                  isActive || onRootDashboard || onExtra ? t.iconFill : t.icon;
                return (
                  <>
                    <Icon className="w-5 h-5" />
                    <span>{t.label}</span>
                  </>
                );
              }}
            </NavLink>
          );
        })}
        {/* "More" opens the full nav drawer (same one the top hamburger
            uses) so every other destination stays reachable. */}
        <button
          onClick={onMore}
          className="flex flex-col items-center justify-center gap-0.5 text-[10px] font-medium text-cream/60 active:text-cream"
          aria-label="More"
        >
          <Menu className="w-5 h-5" />
          <span>More</span>
        </button>
      </div>
    </nav>
  );
}
