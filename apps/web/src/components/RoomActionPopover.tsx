import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  CheckCheck,
  Loader2,
  Undo2,
  Wrench,
  X,
} from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { useToast } from "@/components/Toast";

type HkStatus = "dirty" | "available" | "maintenance";

function mutateRoomStatus(old: unknown, roomId: string, next: HkStatus): unknown {
  if (!old || typeof old !== "object") return old;
  const obj = old as Record<string, unknown>;

  // Dashboard shape: { room_grid: [{ id, status, ... }], ... }
  if (Array.isArray(obj.room_grid)) {
    return {
      ...obj,
      room_grid: (obj.room_grid as Array<Record<string, unknown>>).map((r) =>
        r.id === roomId ? { ...r, status: next } : r,
      ),
    };
  }

  // Reservation detail shape: { rooms: [{ id, status, ... }], ... }
  if (Array.isArray(obj.rooms)) {
    return {
      ...obj,
      rooms: (obj.rooms as Array<Record<string, unknown>>).map((r) =>
        r.id === roomId ? { ...r, status: next } : r,
      ),
    };
  }

  return old;
}

// Status pill colour map for the popover header.
const STATUS_BADGE: Record<HkStatus, string> = {
  dirty: "bg-warning/20 text-[#B45309]",
  available: "bg-success/15 text-success",
  maintenance: "bg-danger/15 text-danger",
};

// Picks the icon that best telegraphs what each action does.
function iconForTarget(opt: { to: HkStatus; direction: string }) {
  switch (opt.to) {
    case "available":
      return CheckCheck;
    case "maintenance":
      return Wrench;
    case "dirty":
      return Undo2;
    default:
      return opt.direction === "forward" ? ArrowRight : Undo2;
  }
}

type TransitionOpt = {
  to: HkStatus;
  label: string;
  direction: "forward" | "reverse" | "side";
};

// Single-step cleaning workflow (migration 0034). Dirty rooms go
// straight to available; the intermediate clean / inspected states
// are gone.
const TRANSITIONS: Record<HkStatus, TransitionOpt[]> = {
  dirty: [
    { to: "available", label: "Mark Ready", direction: "forward" },
    { to: "maintenance", label: "Send to Maintenance", direction: "side" },
  ],
  available: [
    { to: "dirty", label: "Needs Cleaning (turn-down)", direction: "reverse" },
    { to: "maintenance", label: "Send to Maintenance", direction: "side" },
  ],
  maintenance: [
    { to: "available", label: "Back to Available", direction: "forward" },
    { to: "dirty", label: "Needs Cleaning", direction: "reverse" },
  ],
};

interface Props {
  roomId: string;
  roomNumber: string;
  status: HkStatus;
  trigger: ReactNode;
  onChanged?: () => void;
  invalidateKeys?: string[][];
}

// Menu dimensions used for viewport-fit math. Width matches w-64 (16rem);
// height is an estimate generous enough for the tallest 2-option menu.
const MENU_WIDTH = 272;
const MENU_MAX_HEIGHT = 240;
const GAP = 6;

export function RoomActionPopover({ roomId, roomNumber, status, trigger, onChanged, invalidateKeys }: Props) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // Fixed-position coordinates for the portalled menu, computed from the
  // trigger's viewport rect so the menu is never clipped by a scroll
  // container or the page fold.
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const qc = useQueryClient();
  const { toast } = useToast();

  const update = useMutation({
    mutationFn: (v: { to: HkStatus }) =>
      api.patch(`/housekeeping/${roomId}`, { status: v.to }),
    onMutate: async (v: { to: HkStatus }) => {
      const keys = invalidateKeys ?? [["dashboard"], ["reservation"]];
      // Cancel any in-flight refetches so they don't overwrite our optimistic update
      await Promise.all(keys.map((k) => qc.cancelQueries({ queryKey: k })));

      // Snapshot previous state for rollback
      const snapshots = keys.map((k) => [k, qc.getQueriesData({ queryKey: k })] as const);

      // Optimistically rewrite the room's status everywhere it appears
      keys.forEach((k) => {
        qc.setQueriesData({ queryKey: k }, (old: unknown) => mutateRoomStatus(old, roomId, v.to));
      });

      setOpen(false); // close instantly
      return { snapshots };
    },
    onError: (e, _next, ctx) => {
      // Roll back
      ctx?.snapshots.forEach(([_k, entries]) => {
        for (const [qk, data] of entries) qc.setQueryData(qk, data);
      });
      const msg = e instanceof ApiError ? e.message : "Update failed";
      toast(msg, "error");
    },
    onSettled: () => {
      // Default set covers everything that depends on room status: the
      // dashboard tile grid, the Rooms page list, the Housekeeping board,
      // any open reservation detail, and the availability query used by
      // NewReservation. Caller can still override via invalidateKeys.
      const keys = invalidateKeys ?? [
        ["dashboard"],
        ["reservation"],
        ["rooms"],
        ["hk"],
        ["avail"],
      ];
      keys.forEach((k) => qc.invalidateQueries({ queryKey: k }));
      onChanged?.();
    },
  });

  // Measure the trigger and place the menu in viewport (fixed) coords.
  // Prefer below-and-right-aligned; flip above when there isn't room below,
  // and clamp horizontally so it never runs off either edge.
  useLayoutEffect(() => {
    if (!open || !wrapRef.current) return;
    const place = () => {
      const r = wrapRef.current!.getBoundingClientRect();
      const triggerCenter = r.left + r.width / 2;
      const spaceBelow = window.innerHeight - r.bottom;
      // Measure the actual rendered menu when we can — falls back to the
      // estimated MENU_MAX_HEIGHT before first paint. Measuring fixes the
      // "huge visual gap above a small trigger" problem caused by a
      // pessimistic height estimate.
      const measuredHeight = menuRef.current?.offsetHeight ?? MENU_MAX_HEIGHT;
      const openUp = spaceBelow < measuredHeight + GAP && r.top > spaceBelow;
      const top = openUp
        ? r.top - GAP - measuredHeight
        : r.bottom + GAP;
      // Center the menu horizontally on the trigger so it visually
      // connects to the room tile, then clamp into the viewport.
      let left = triggerCenter - MENU_WIDTH / 2;
      left = Math.max(GAP, Math.min(left, window.innerWidth - MENU_WIDTH - GAP));
      setPos({ top: Math.max(GAP, top), left });
    };
    place();
    // Re-place once the menu is in the DOM so we use its actual
    // height instead of the pessimistic estimate. Two RAFs ensures
    // the browser has laid out the portalled content.
    requestAnimationFrame(() => requestAnimationFrame(place));
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      const t = e.target as Node;
      // The menu lives in a portal outside wrapRef, so check both.
      if (wrapRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  const options = TRANSITIONS[status] ?? [];

  return (
    <div className="relative inline-block" ref={wrapRef}>
      <span
        role="button"
        tabIndex={0}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen((v) => !v);
          }
        }}
      >
        {trigger}
      </span>

      {open &&
        pos &&
        createPortal(
          <div
            ref={menuRef}
            style={{ position: "fixed", top: pos.top, left: pos.left, width: MENU_WIDTH }}
            className="z-[100] bg-surface border border-borderc rounded-lg shadow-xl ring-1 ring-black/5 overflow-hidden"
          >
            <div className="px-3 py-2.5 border-b border-borderc bg-brand-soft/60 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="font-mono text-sm font-bold text-brand-dark">
                  {roomNumber}
                </span>
                <span
                  className={`inline-flex items-center px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider rounded-sm ${STATUS_BADGE[status]}`}
                >
                  {status}
                </span>
              </div>
              <button
                onClick={() => setOpen(false)}
                className="text-textSecondary hover:text-textPrimary"
                aria-label="Close"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>

            <div className="p-2 flex flex-col gap-1.5">
              {options.map((opt) => {
                const Icon = iconForTarget(opt);
                const cls =
                  opt.direction === "forward"
                    ? "bg-brand-dark text-cream hover:bg-brand-dark/90 shadow-sm"
                    : opt.direction === "reverse"
                      ? "bg-surface text-textPrimary border border-borderc hover:bg-bg"
                      : opt.to === "maintenance"
                        ? "bg-surface text-danger border border-danger/30 hover:bg-danger/5"
                        : "bg-surface text-textPrimary border border-borderc hover:bg-bg";
                return (
                  <button
                    key={opt.to}
                    onClick={() => update.mutate({ to: opt.to })}
                    disabled={update.isPending}
                    className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm font-medium rounded-md text-left transition-colors disabled:opacity-50 ${cls}`}
                  >
                    {update.isPending ? (
                      <Loader2 className="w-4 h-4 animate-spin shrink-0" />
                    ) : (
                      <Icon className="w-4 h-4 shrink-0" />
                    )}
                    <span className="flex-1">{opt.label}</span>
                  </button>
                );
              })}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
