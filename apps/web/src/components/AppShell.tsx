import { useQuery } from "@tanstack/react-query";
import { Bell, Maximize2, Menu, Minimize2, Search } from "@/lib/micons";
import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "@/auth/AuthContext";
import { SUBSCRIPTION_REQUIRED_EVENT, api } from "@/lib/api";
import { ArrivalAlerts } from "./ArrivalAlerts";
import { BottomNav } from "./BottomNav";
import { CheckoutAlerts } from "./CheckoutAlerts";
import { CommandPalette } from "./CommandPalette";
import { Sidebar, initials } from "./Sidebar";
import { useNotificationToasts } from "./Toast";

interface NotifResp {
  items: Array<{ id: string; readAt: string | null }>;
  unreadCount: number;
}

// Topbar route titles — longest prefix wins.
const ROUTE_TITLES: [string, string][] = [
  ["/reservations/new", "New booking"],
  ["/reservations", "Reservations"],
  ["/dashboard", "Dashboard"],
  ["/rooms", "Rooms"],
  ["/housekeeping", "Housekeeping"],
  ["/maintenance", "Maintenance"],
  ["/calendar", "Calendar"],
  ["/guests", "Guests"],
  ["/invoices", "Invoices"],
  ["/collections", "Collections"],
  ["/credits", "Wallet credits"],
  ["/expenses", "Expenses"],
  ["/reports", "Reports"],
  ["/activity", "Activity"],
  ["/messages", "Messages"],
  ["/notifications", "Notifications"],
  ["/staff", "Staff"],
  ["/billing", "Billing"],
  ["/settings", "Settings"],
];

function routeTitle(pathname: string): string {
  if (pathname === "/") return "Dashboard";
  return ROUTE_TITLES.find(([p]) => pathname.startsWith(p))?.[1] ?? "Stayvia";
}

export function AppShell({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem("hd:sidebarCollapsed") === "1",
  );
  // Mobile drawer is independent of the desktop collapsed state. We
  // open it via the hamburger and auto-close on route change.
  const [mobileOpen, setMobileOpen] = useState(false);
  // Focus mode hides the sidebar entirely and lets the main column
  // span the full viewport. Useful for the front desk on small
  // screens or when projecting onto a TV. Persisted so a reload
  // keeps you where you were.
  const [focusMode, setFocusMode] = useState(
    () => localStorage.getItem("hd:focusMode") === "1",
  );
  const location = useLocation();
  const navigate = useNavigate();
  const { property, profile } = useAuth();

  // 402 SUBSCRIPTION_REQUIRED (fired by lib/api.ts): steer the user to
  // /billing. Several in-flight queries can 402 at once, so navigations
  // are throttled — one redirect per 5s window is plenty.
  const lastBillingRedirect = useRef(0);
  useEffect(() => {
    function onSubscriptionRequired() {
      const now = Date.now();
      if (now - lastBillingRedirect.current < 5_000) return;
      lastBillingRedirect.current = now;
      if (window.location.pathname !== "/billing") navigate("/billing");
    }
    window.addEventListener(SUBSCRIPTION_REQUIRED_EVENT, onSubscriptionRequired);
    return () => window.removeEventListener(SUBSCRIPTION_REQUIRED_EVENT, onSubscriptionRequired);
  }, [navigate]);

  function toggleCollapsed() {
    setCollapsed((c) => {
      const next = !c;
      localStorage.setItem("hd:sidebarCollapsed", next ? "1" : "0");
      return next;
    });
  }

  function toggleFocusMode(opts?: { requestBrowserFullscreen?: boolean }) {
    setFocusMode((f) => {
      const next = !f;
      localStorage.setItem("hd:focusMode", next ? "1" : "0");
      // Optional: also drive the browser's Fullscreen API (Shift+click
      // or programmatic). On exit, release fullscreen if we held it.
      try {
        if (opts?.requestBrowserFullscreen && next && document.fullscreenEnabled) {
          void document.documentElement.requestFullscreen();
        } else if (!next && document.fullscreenElement) {
          void document.exitFullscreen();
        }
      } catch {
        /* swallow — browser may refuse; UI focus mode still toggles */
      }
      return next;
    });
  }

  // Keyboard shortcut: F to toggle focus mode. Ignored while the
  // user is typing in a text field. Shift+F also requests browser
  // fullscreen at the same time.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "f" && e.key !== "F") return;
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.tagName === "SELECT" ||
          t.isContentEditable)
      )
        return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();
      toggleFocusMode({ requestBrowserFullscreen: e.shiftKey });
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Auto-close the mobile drawer whenever the route changes so a tap
  // on a nav link doesn't leave the drawer hanging open.
  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  // When the drawer is open, lock body scroll so the page underneath
  // doesn't scroll behind the overlay.
  useEffect(() => {
    if (!mobileOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [mobileOpen]);

  const q = useQuery({
    queryKey: ["notifications"],
    queryFn: () => api.get<NotifResp>("/notifications"),
    refetchInterval: 15000,
  });

  // Pre-fetch hotel branding once per session — used by receipt overlays
  useQuery({
    queryKey: ["settings-public"],
    queryFn: () => api.get("/settings/public"),
    staleTime: 30 * 60 * 1000, // fresh for 30 min
    gcTime: 60 * 60 * 1000, // keep cached for 1 hour
  });

  const unreadIds = useMemo(
    () => q.data?.items.filter((i) => !i.readAt).map((i) => i.id),
    [q.data],
  );
  useNotificationToasts(unreadIds);

  const title = routeTitle(location.pathname);

  return (
    <div className="min-h-screen bg-bg">
      <CommandPalette />

      {/* Sidebar:
          - desktop (md+): fixed left Parchment rail, width depends on `collapsed`
          - mobile (< md): hidden by default; slides in over content when
            mobileOpen=true, with a backdrop tap-to-close. */}
      <div
        className={`md:hidden fixed inset-0 z-40 bg-inkDark/40 backdrop-blur-[2px] transition-opacity ${
          mobileOpen ? "opacity-100" : "opacity-0 pointer-events-none"
        }`}
        onClick={() => setMobileOpen(false)}
        aria-hidden
      />
      <div
        className={`md:hidden fixed top-0 left-0 z-50 h-full transition-transform duration-[250ms] ease-out ${
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        {/* Force the sidebar into expanded mode in the drawer. */}
        <Sidebar collapsed={false} onToggle={() => setMobileOpen(false)} mobile />
      </div>
      {!focusMode && (
        <div className="hidden md:block">
          <Sidebar collapsed={collapsed} onToggle={toggleCollapsed} />
        </div>
      )}

      <div
        className={`relative transition-[margin] duration-200 ease-out ${
          focusMode ? "md:ml-0" : collapsed ? "md:ml-[74px]" : "md:ml-60"
        }`}
      >
        {/* Blurred sticky topbar: route title + hotel subtitle, global
            search, bell, avatar. Hamburger appears < md. */}
        <header className="sticky top-0 z-30 h-16 px-4 md:px-6 flex items-center gap-3 bg-paper/80 backdrop-blur-[10px] border-b border-borderc pt-safe">
          <button
            onClick={() => setMobileOpen(true)}
            aria-label="Open menu"
            className="md:hidden w-10 h-10 grid place-items-center rounded-[11px] border border-borderControl bg-surface text-inkBody shrink-0"
          >
            <Menu className="w-5 h-5" />
          </button>
          <div className="min-w-0">
            <div className="text-[16.5px] font-semibold tracking-[-0.2px] leading-tight truncate">
              {title}
            </div>
            {property?.name && (
              <div className="text-xs text-inkMuted truncate">{property.name}</div>
            )}
          </div>
          <div className="flex-1" />
          <button
            onClick={() => window.dispatchEvent(new Event("stayvia:search"))}
            aria-label="Search"
            className="hidden md:flex items-center gap-2.5 h-10 w-[min(260px,28vw)] rounded-[11px] border border-borderControl bg-surface px-3 text-[13.5px] text-inkFaint hover:bg-surfaceAlt transition-colors"
          >
            <Search className="w-5 h-5" />
            <span className="truncate">Search guests, bookings, rooms</span>
          </button>
          <button
            onClick={() => window.dispatchEvent(new Event("stayvia:search"))}
            aria-label="Search"
            className="md:hidden w-10 h-10 grid place-items-center rounded-[11px] border border-borderControl bg-surface text-inkBody shrink-0"
          >
            <Search className="w-5 h-5" />
          </button>
          <button
            onClick={() => navigate("/notifications")}
            aria-label="Notifications"
            className="relative w-10 h-10 grid place-items-center rounded-[11px] border border-borderControl bg-surface text-inkBody hover:bg-surfaceAlt transition-colors shrink-0"
          >
            <Bell className="w-5 h-5" />
            {(unreadIds?.length ?? 0) > 0 && (
              <span className="absolute top-[9px] right-[10px] w-2 h-2 rounded-full bg-danger ring-2 ring-surface" />
            )}
          </button>
          {/* Focus mode: hides the sidebar so content goes edge-to-edge.
              Lives in the topbar because the topbar stays visible in focus
              mode (the sidebar does not). Shift+click also requests the
              browser's real fullscreen. Keyboard: F / Shift+F. Desktop only —
              the bottom tab bar owns the phone layout. */}
          <button
            type="button"
            onClick={(e) => toggleFocusMode({ requestBrowserFullscreen: e.shiftKey })}
            className="hidden md:grid w-10 h-10 place-items-center rounded-[11px] border border-borderControl bg-surface text-inkBody hover:bg-surfaceAlt hover:text-brand-deep transition-colors shrink-0"
            aria-label={focusMode ? "Exit focus mode" : "Enter focus mode"}
            title={
              focusMode
                ? "Exit focus mode (F) - Shift+click also exits browser fullscreen"
                : "Focus mode (F) - hides sidebar. Shift+click also goes browser fullscreen."
            }
          >
            {focusMode ? <Minimize2 className="w-5 h-5" /> : <Maximize2 className="w-5 h-5" />}
          </button>
          {profile && (
            <span className="hidden sm:grid w-9 h-9 rounded-full bg-brand-soft text-brand-deep place-items-center font-bold text-[13px] shrink-0">
              {initials(profile.fullName)}
            </span>
          )}
        </header>

        {/* All alert bars pin together as a single header so they
            don't fight for top-0 individually and overlap on scroll.
            Children render as plain blocks (no sticky themselves).
            Cap the stack at 40% of the viewport so a noisy day can't
            push the rest of the page out of sight — internal scroll
            handles overflow. */}
        <div className="sticky top-16 z-40 max-h-[40vh] overflow-y-auto">
          <CheckoutAlerts />
          <ArrivalAlerts />
        </div>
        {/* Screen-enter fade-up on route change (keyed remount). Extra
            bottom padding on phone so the fixed bottom tab bar never
            covers the last row of content. */}
        <main
          key={location.pathname}
          className="animate-screen-enter p-4 pb-bottomnav sm:p-5 md:p-6 md:pb-8 xl:p-[30px]"
        >
          {children}
        </main>
      </div>

      {/* Phone-first bottom tab bar. Hidden on md+ (sidebar handles nav)
          and in focus mode (content goes edge-to-edge). "More" opens the
          same drawer the top hamburger uses. */}
      {!focusMode && <BottomNav onMore={() => setMobileOpen(true)} />}

    </div>
  );
}
