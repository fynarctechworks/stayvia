import { useQuery } from "@tanstack/react-query";
import { Maximize2, Menu, Minimize2 } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "@/auth/AuthContext";
import { SUBSCRIPTION_REQUIRED_EVENT, api } from "@/lib/api";
import { ArrivalAlerts } from "./ArrivalAlerts";
import { BottomNav } from "./BottomNav";
import { CheckoutAlerts } from "./CheckoutAlerts";
import { CommandPalette } from "./CommandPalette";
import { Sidebar } from "./Sidebar";
import { useNotificationToasts } from "./Toast";

interface NotifResp {
  items: Array<{ id: string; readAt: string | null }>;
  unreadCount: number;
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
  const { property } = useAuth();

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

  return (
    <div className="min-h-screen bg-bg">
      <CommandPalette />

      {/* Sidebar:
          - desktop (md+): fixed left rail, width depends on `collapsed`
          - mobile (< md): hidden by default; slides in over content when
            mobileOpen=true, with a backdrop tap-to-close. */}
      <div
        className={`md:hidden fixed inset-0 z-40 bg-brand-dark/40 backdrop-blur-[2px] transition-opacity ${
          mobileOpen ? "opacity-100" : "opacity-0 pointer-events-none"
        }`}
        onClick={() => setMobileOpen(false)}
        aria-hidden
      />
      <div
        className={`md:hidden fixed top-0 left-0 z-50 h-full transition-transform duration-200 ease-out ${
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        {/* Force the sidebar into expanded mode in the drawer. The desktop
            toggle button is hidden on mobile via Sidebar's own md: guards. */}
        <Sidebar collapsed={false} onToggle={() => setMobileOpen(false)} mobile />
      </div>
      {!focusMode && (
        <div className="hidden md:block">
          <Sidebar collapsed={collapsed} onToggle={toggleCollapsed} />
        </div>
      )}

      {/* Watermark — hidden on phones (too noisy on small screens), and
          hidden in focus mode where the content goes edge-to-edge. */}
      {!focusMode && (
        <div
          aria-hidden
          className={`hidden md:grid pointer-events-none fixed inset-0 ${
            collapsed ? "pl-16" : "pl-60"
          } place-items-center select-none transition-[padding] duration-200 ease-out`}
        >
          <img
            src="/logo.jpg"
            alt=""
            className="w-[min(70vw,640px)] h-auto opacity-[0.06] mix-blend-multiply"
          />
        </div>
      )}

      <div
        className={`relative transition-[margin] duration-200 ease-out ${
          focusMode ? "md:ml-0" : collapsed ? "md:ml-16" : "md:ml-60"
        }`}
      >
        {/* Mobile top bar with hamburger. Only visible <md. Sticky so
            the user can always reach the menu without scrolling up. */}
        <header className="md:hidden sticky top-0 z-30 bg-brand-dark text-cream flex items-center gap-2 px-3 h-12 shadow-sm pt-safe">
          <button
            onClick={() => setMobileOpen(true)}
            aria-label="Open menu"
            className="p-2 -ml-2 rounded hover:bg-white/10 active:bg-white/15"
          >
            <Menu className="w-5 h-5" />
          </button>
          <div className="flex items-center gap-2 min-w-0">
            <img
              src="/logo.jpg"
              alt=""
              className="w-7 h-7 rounded-sm bg-cream object-contain p-0.5 ring-1 ring-brass/30 shrink-0"
            />
            <div className="min-w-0">
              <div className="text-sm font-semibold leading-tight truncate">{property?.name ?? "Stayvia"}</div>
              <div className="text-[9px] text-brass tracking-[0.15em] leading-none">HOTEL OS</div>
            </div>
          </div>
        </header>

        {/* All alert bars pin together as a single header so they
            don't fight for top-0 individually and overlap on scroll.
            Children render as plain blocks (no sticky themselves).
            Cap the stack at 40% of the viewport so a noisy day can't
            push the rest of the page out of sight — internal scroll
            handles overflow. */}
        <div className="sticky top-0 z-40 max-h-[40vh] overflow-y-auto">
          <CheckoutAlerts />
          <ArrivalAlerts />
        </div>
        {/* Main content padding tightens on mobile so cards aren't crammed.
            Extra bottom padding on phone so the fixed bottom tab bar never
            covers the last row of content (pb-safe handles the home
            indicator). */}
        <main className="p-3 pb-bottomnav sm:p-5 md:p-6 md:pb-6">{children}</main>
      </div>

      {/* Phone-first bottom tab bar. Hidden on md+ (sidebar handles nav)
          and in focus mode (content goes edge-to-edge). "More" opens the
          same drawer the top hamburger uses. */}
      {!focusMode && <BottomNav onMore={() => setMobileOpen(true)} />}

      {/* Focus-mode toggle. Floats over the bottom-right corner so it's
          always reachable on any page. Click toggles in-app focus mode
          (sidebar hidden, content edge-to-edge). Shift+click also
          requests the browser's true fullscreen API on top.
          Keyboard: F (Shift+F for browser fullscreen). */}
      <button
        type="button"
        onClick={(e) =>
          toggleFocusMode({ requestBrowserFullscreen: e.shiftKey })
        }
        // Position depends on layout state so we never sit underneath
        // the sidebar (left rail) or the toast stack (bottom-right).
        // In focus mode the sidebar is gone, so we anchor bottom-left.
        // In normal mode we clear the sidebar by shifting right based
        // on its current width, and we sit ABOVE the toast stack so
        // notifications never bury the toggle.
        style={
          focusMode
            ? { left: "1rem", bottom: "1rem" }
            : {
                left: `calc(${collapsed ? "4rem" : "15rem"} + 1rem)`,
                bottom: "1rem",
              }
        }
        // Hidden on phone (<md): focus mode is a desktop/projection
        // feature, and the bottom tab bar owns that corner on mobile.
        className="hidden md:grid fixed z-[60] place-items-center w-11 h-11 rounded-full bg-brand-dark text-cream shadow-lg ring-1 ring-brass/30 hover:bg-[#2a2a2a] hover:text-brass transition-[left] duration-200 ease-out"
        aria-label={focusMode ? "Exit focus mode" : "Enter focus mode"}
        title={
          focusMode
            ? "Exit focus mode (F) — Shift+click also exits browser fullscreen"
            : "Focus mode (F) — hides sidebar. Shift+click also goes browser fullscreen."
        }
      >
        {focusMode ? (
          <Minimize2 className="w-5 h-5" />
        ) : (
          <Maximize2 className="w-5 h-5" />
        )}
      </button>
    </div>
  );
}
