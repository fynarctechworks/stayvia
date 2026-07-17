import {
  CalendarCheck,
  DoorOpen,
  LayoutDashboard,
  Menu,
  Users,
} from "lucide-react";
import { NavLink } from "react-router-dom";
import { useAuth } from "@/auth/AuthContext";
import { cn } from "@/lib/utils";

// Phone-first bottom tab bar (hidden on md+, where the sidebar rail is
// the primary nav). Shows the 4 core destinations + a "More" button
// that opens the existing full-nav drawer. Each tab is permission-gated
// so a frontdesk/housekeeping user only sees what they can reach.
interface Tab {
  to: string;
  label: string;
  icon: typeof LayoutDashboard;
  permission: string;
  // Highlight the tab for these extra path prefixes (e.g. Reservations
  // tab stays active on /reservations/:id and /reservations/new).
  alsoActiveOn?: string[];
}

const TABS: Tab[] = [
  { to: "/dashboard", label: "Home", icon: LayoutDashboard, permission: "view_dashboard" },
  {
    to: "/reservations",
    label: "Bookings",
    icon: CalendarCheck,
    permission: "view_reservations",
    alsoActiveOn: ["/reservations", "/calendar"],
  },
  { to: "/rooms", label: "Rooms", icon: DoorOpen, permission: "view_rooms" },
  { to: "/guests", label: "Guests", icon: Users, permission: "view_guests", alsoActiveOn: ["/guests"] },
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
          const Icon = t.icon;
          return (
            <NavLink
              key={t.to}
              to={t.to}
              end={t.to === "/dashboard"}
              className={({ isActive }) => {
                const path = window.location.pathname;
                const onRootDashboard =
                  t.to === "/dashboard" && (path === "/" || path === "/dashboard");
                const onExtra = (t.alsoActiveOn ?? []).some((p) => path.startsWith(p));
                const active = isActive || onRootDashboard || onExtra;
                return cn(
                  "flex flex-col items-center justify-center gap-0.5 text-[10px] font-medium transition-colors",
                  active ? "text-brass" : "text-cream/60 active:text-cream",
                );
              }}
            >
              <Icon className="w-5 h-5" />
              <span>{t.label}</span>
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
