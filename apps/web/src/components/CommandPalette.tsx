// Cmd-K (Ctrl-K on Windows / Linux) global search palette. Mounted
// once in AppShell so it's available on every page.
//
// Design notes:
//   - 250 ms debounce on the keystroke → fetch. Front-desk staff type
//     fast; one fetch per character would hammer the API.
//   - Arrow keys + Enter for keyboard-only navigation. Mouse works
//     too, but the whole point of Cmd-K is "no mouse".
//   - Results are grouped by kind (Reservations / Guests / Rooms) so
//     the same query string surfaces all three contexts at once.
//   - Each item carries a destination href; clicking navigates and
//     closes the palette.
//
// Add more quick-actions (e.g. "New reservation", "Open settings") in
// the QUICK_ACTIONS list — they always render at the top regardless
// of the query.

import { useQuery } from "@tanstack/react-query";
import {
  CalendarPlus,
  ChevronRight,
  DoorOpen,
  LayoutDashboard,
  Search,
  Settings,
  SprayCan,
  User,
  UserPlus,
} from "@/lib/micons";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { QueryError } from "@/components/kit";
import { api } from "@/lib/api";

interface SearchResp {
  q: string;
  guests: {
    id: string;
    fullName: string;
    phone: string;
    idProofLast4: string;
    isVip: boolean;
    isBlacklisted: boolean;
  }[];
  reservations: {
    id: string;
    reservationNumber: string;
    status: string;
    checkInDate: string;
    checkOutDate: string;
    guestId: string;
    guestName: string;
  }[];
  rooms: {
    id: string;
    roomNumber: string;
    floor: number;
    roomType: string;
    status: string;
  }[];
}

interface PaletteItem {
  id: string;
  group: "Quick actions" | "Reservations" | "Guests" | "Rooms";
  icon: React.ReactNode;
  // Monospaced prefix (RES code, room number) rendered before the label.
  code?: string;
  label: string;
  sub?: string;
  badge?: string;
  href: string;
}

const QUICK_ACTIONS: PaletteItem[] = [
  {
    id: "qa-dashboard",
    group: "Quick actions",
    icon: <LayoutDashboard className="w-4 h-4" />,
    label: "Open Dashboard",
    href: "/",
  },
  {
    id: "qa-walkin",
    group: "Quick actions",
    icon: <UserPlus className="w-4 h-4" />,
    label: "New Walk-in",
    sub: "Check guest in immediately",
    href: "/reservations/new?mode=walkin",
  },
  {
    id: "qa-prebooking",
    group: "Quick actions",
    icon: <CalendarPlus className="w-4 h-4" />,
    label: "New Pre-booking",
    sub: "Block a room for a future date",
    href: "/reservations/new?mode=booking",
  },
  {
    id: "qa-housekeeping",
    group: "Quick actions",
    icon: <SprayCan className="w-4 h-4" />,
    label: "Open Housekeeping board",
    href: "/housekeeping",
  },
  {
    id: "qa-settings",
    group: "Quick actions",
    icon: <Settings className="w-4 h-4" />,
    label: "Open Settings",
    href: "/settings",
  },
];

export function CommandPalette() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Global keyboard listener. Cmd-K (mac) / Ctrl-K (win/linux) opens;
  // Escape closes. We listen on document so the palette opens no
  // matter what page or input has focus.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const isMod = e.metaKey || e.ctrlKey;
      if (isMod && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === "Escape" && open) {
        setOpen(false);
      }
    }
    // Also open on a custom event so the mobile top-bar search icon can
    // trigger the same palette (no keyboard on phones).
    function onOpen() {
      setOpen(true);
    }
    document.addEventListener("keydown", onKey);
    window.addEventListener("stayvia:search", onOpen);
    return () => {
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("stayvia:search", onOpen);
    };
  }, [open]);

  // Focus the input on open.
  useEffect(() => {
    if (open) {
      // Reset transient state when the palette pops up.
      setQuery("");
      setActiveIdx(0);
      setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [open]);

  // 250ms debounce on the query → debounced fetch trigger.
  useEffect(() => {
    const handle = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(handle);
  }, [query]);

  const searchQ = useQuery({
    queryKey: ["palette-search", debounced],
    queryFn: () => api.get<SearchResp>("/search", { q: debounced, limit: 6 }),
    // Don't fetch on empty or one-char queries — those mean "show me
    // quick actions" only.
    enabled: open && debounced.length >= 2,
    staleTime: 10_000,
  });
  const { data, isFetching } = searchQ;

  // Build the flat item list (in display order). We render groups but
  // navigation needs a flat list for the keyboard arrow indexing.
  const items: PaletteItem[] = useMemo(() => {
    const list: PaletteItem[] = [];
    // Quick actions always; if there's a query, filter by label substring.
    const term = debounced.toLowerCase();
    for (const qa of QUICK_ACTIONS) {
      if (!term || qa.label.toLowerCase().includes(term)) list.push(qa);
    }
    if (data) {
      for (const r of data.reservations) {
        list.push({
          id: `res-${r.id}`,
          group: "Reservations",
          icon: <CalendarPlus className="w-4 h-4" />,
          code: r.reservationNumber,
          label: r.guestName,
          sub: `${r.status} · ${r.checkInDate} → ${r.checkOutDate}`,
          href: `/reservations/${r.reservationNumber}`,
        });
      }
      for (const g of data.guests) {
        list.push({
          id: `guest-${g.id}`,
          group: "Guests",
          icon: <User className="w-4 h-4" />,
          label: g.fullName,
          sub: `${g.phone} · ID ••••${g.idProofLast4}`,
          badge: g.isBlacklisted ? "BLACKLIST" : g.isVip ? "VIP" : undefined,
          href: `/guests/${g.phone}`,
        });
      }
      for (const r of data.rooms) {
        list.push({
          id: `room-${r.id}`,
          group: "Rooms",
          icon: <DoorOpen className="w-4 h-4" />,
          code: `Room ${r.roomNumber}`,
          label: "",
          sub: `Floor ${r.floor} · ${r.roomType.replace(/_/g, " ")} · ${r.status}`,
          href: `/rooms/${r.roomNumber}`,
        });
      }
    }
    return list;
  }, [data, debounced]);

  // Clamp the active index when the result set shrinks.
  useEffect(() => {
    if (activeIdx >= items.length) setActiveIdx(Math.max(0, items.length - 1));
  }, [items.length, activeIdx]);

  const choose = useCallback(
    (item: PaletteItem) => {
      navigate(item.href);
      setOpen(false);
    },
    [navigate],
  );

  function onInputKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = items[activeIdx];
      if (item) choose(item);
    }
  }

  if (!open) return null;

  // Render groups by walking the flat list and inserting headers when
  // the group changes. Each item carries its absolute index so keyboard
  // selection matches what the user sees.
  let lastGroup: PaletteItem["group"] | null = null;
  const rendered: React.ReactNode[] = [];
  items.forEach((it, idx) => {
    if (it.group !== lastGroup) {
      rendered.push(
        <div
          key={`hdr-${it.group}`}
          className="px-3 py-1.5 text-[10px] uppercase tracking-[0.06em] text-inkMuted font-bold bg-surfaceAlt border-y border-divider"
        >
          {it.group}
        </div>,
      );
      lastGroup = it.group;
    }
    const isActive = idx === activeIdx;
    rendered.push(
      <button
        key={it.id}
        onMouseEnter={() => setActiveIdx(idx)}
        onClick={() => choose(it)}
        className={`w-full text-left px-3 py-2.5 flex items-center gap-3 transition-colors ${isActive ? "bg-brand-soft" : "hover:bg-surfaceAlt"}`}
      >
        <span
          className={`shrink-0 grid place-items-center w-8 h-8 rounded-md ${isActive ? "bg-brand-tint text-brand-deep" : "bg-surfaceAlt text-inkMuted"}`}
        >
          {it.icon}
        </span>
        <span className="flex-1 min-w-0">
          <span
            className={`block text-sm font-medium truncate ${isActive ? "text-brand-deep" : "text-ink"}`}
          >
            {it.code && <span className="font-mono text-[12.5px] font-semibold">{it.code}</span>}
            {it.code && it.label ? " · " : ""}
            {it.label}
          </span>
          {it.sub && (
            <span
              className={`block text-[11px] truncate ${isActive ? "text-brand-deep/75" : "text-inkMuted"}`}
            >
              {it.sub}
            </span>
          )}
        </span>
        {it.badge && (
          <span
            className={`text-[10px] font-bold uppercase tracking-[0.06em] px-2 py-0.5 rounded-full border ${
              it.badge === "BLACKLIST"
                ? "bg-dangerBg text-dangerFg border-dangerBorder"
                : "bg-warnBg text-warnDeep border-warnBorder"
            }`}
          >
            {it.badge}
          </span>
        )}
        <ChevronRight className={`w-4 h-4 shrink-0 ${isActive ? "text-brand-deep" : "text-inkFaint"}`} />
      </button>,
    );
  });

  return (
    <div
      className="fixed inset-0 z-50 bg-inkDark/50 backdrop-blur-[3px] grid place-items-start pt-[12vh] px-4"
      onClick={() => setOpen(false)}
      role="dialog"
      aria-modal="true"
      aria-label="Global search"
    >
      <div
        className="w-full max-w-xl bg-surface rounded-2xl shadow-modal overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-3.5 py-2.5 border-b border-divider">
          <Search className="w-4 h-4 text-inkFaint" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onInputKey}
            placeholder="Search reservations, guests, rooms…"
            className="flex-1 bg-transparent outline-none text-sm py-1 text-ink placeholder:text-inkFaint"
            autoComplete="off"
            spellCheck={false}
          />
          {isFetching && (
            <span className="text-[10px] text-inkMuted uppercase tracking-[0.06em] font-bold">
              Searching…
            </span>
          )}
          <kbd className="text-[10px] font-mono px-1.5 py-0.5 bg-surfaceAlt border border-borderControl rounded-sm text-inkMuted">
            Esc
          </kbd>
        </div>
        <div className="max-h-[60vh] overflow-y-auto">
          {/* A failed search must never read as "this hotel has no such guest"
              — that's how duplicate guests get created. The quick actions
              below still render (they're local), so the banner sits above
              them rather than replacing the list. */}
          {searchQ.isError && (
            <div className="p-3">
              <QueryError
                error={searchQ.error}
                onRetry={() => searchQ.refetch()}
                isRetrying={searchQ.isFetching}
                title="Search didn't run"
                message="Reservations, guests and rooms couldn't be searched. Nothing below is a search result — try again before assuming a guest isn't on file."
              />
            </div>
          )}
          {items.length > 0
            ? rendered
            : !searchQ.isError && (
                <div className="px-3 py-10 text-sm text-textSecondary text-center">
                  {debounced.length < 2
                    ? "Type at least 2 characters to search."
                    : isFetching
                      ? "Searching…"
                      : "No results."}
                </div>
              )}
        </div>
        <div className="px-3.5 py-2.5 border-t border-divider bg-surfaceAlt flex items-center justify-between text-[10px] text-inkMuted">
          <span className="flex items-center gap-2">
            <kbd className="font-mono px-1 py-0.5 bg-surface border border-borderControl rounded-sm">↑↓</kbd>
            navigate
            <kbd className="font-mono px-1 py-0.5 bg-surface border border-borderControl rounded-sm">↵</kbd>
            open
          </span>
          <span>
            <kbd className="font-mono px-1 py-0.5 bg-surface border border-borderControl rounded-sm">
              ⌘K
            </kbd>{" "}
            anywhere to reopen
          </span>
        </div>
      </div>
    </div>
  );
}
