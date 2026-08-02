import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  BedDouble,
  Check,
  CheckCircle2,
  KeyRound,
  SprayCan,
  Wrench,
  type LucideIcon,
} from "@/lib/micons";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/auth/AuthContext";
import { ListSkeleton } from "@/components/kit";
import { NewIssueModal } from "@/components/NewIssueModal";
import { api } from "@/lib/api";
import { invalidateRoomData } from "@/lib/invalidate";

interface Room {
  id: string;
  roomNumber: string;
  floor: number;
  roomType: string;
  status: string;
  notes: string | null;
  // Open + in_progress maintenance issues. Drives the small "N issues"
  // pill rendered on each card so staff can see at a glance where the
  // outstanding work is.
  openIssueCount: number;
}

// Single-step cleaning workflow: dirty rooms go straight to
// available via the "Mark Ready" button below. The intermediate
// clean / inspected statuses were removed in migration 0034.
const STATUS_FILTERS = [
  "all",
  "dirty",
  "available",
  "occupied",
  "reserved",
  "maintenance",
] as const;

const STATUS_LABELS: Record<string, string> = {
  all: "All",
  dirty: "Needs Cleaning",
  available: "Available",
  occupied: "Occupied",
  reserved: "Reserved",
  maintenance: "Maintenance",
};

// Kanban column config — Warm Concierge status colors: icon chip tint for
// the column header, plus the 3px left bar each room card carries.
const COLUMNS: {
  status: Exclude<(typeof STATUS_FILTERS)[number], "all">;
  Icon: LucideIcon;
  chip: string;
  bar: string;
}[] = [
  { status: "dirty", Icon: SprayCan, chip: "bg-warnBg text-warnDeep", bar: "border-l-notReady" },
  { status: "available", Icon: CheckCircle2, chip: "bg-brand-soft text-brand-deep", bar: "border-l-brand" },
  { status: "occupied", Icon: BedDouble, chip: "bg-neutralBg text-inkDark", bar: "border-l-inkDark" },
  { status: "reserved", Icon: KeyRound, chip: "bg-infoBg text-info", bar: "border-l-reserved" },
  { status: "maintenance", Icon: Wrench, chip: "bg-dangerBg text-dangerFg", bar: "border-l-danger" },
];

export default function Housekeeping() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { profile } = useAuth();
  const [floor, setFloor] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [err, setErr] = useState<string | null>(null);
  // Drives the NewIssueModal when staff clicks Flag — opens with the
  // chosen room preselected.
  const [flaggingRoom, setFlaggingRoom] = useState<Room | null>(null);

  // Fetch all rooms; floor filtering is done client-side so the floor
  // dropdown always has the full property's list (it would otherwise
  // collapse to only the active floor). Properties are small (10-20
  // rooms typical), so the extra rows in memory are free.
  const { data: rooms = [], isLoading } = useQuery({
    queryKey: ["hk"],
    queryFn: () => api.get<Room[]>("/housekeeping"),
    refetchInterval: 15_000,
  });

  // Room status changes affect: this board, the Rooms grid, the dashboard
  // room tiles, and any availability query already on screen. Centralised
  // via invalidateRoomData so we don't have to remember the list per
  // mutation.
  function invalidateRooms() {
    invalidateRoomData(qc);
    setErr(null);
  }

  // One-click shortcut: a dirty room jumps straight to available.
  // The intermediate clean / inspected statuses no longer exist
  // (migration 0034); every dirty→available is a direct ready.
  const markReady = useMutation({
    mutationFn: (id: string) =>
      api.patch(`/housekeeping/${id}`, { status: "available" }),
    onSuccess: invalidateRooms,
    onError: (e: Error) => setErr(e.message),
  });

  const resolveMaint = useMutation({
    mutationFn: (id: string) => api.post(`/housekeeping/${id}/resolve`),
    onSuccess: invalidateRooms,
    onError: (e: Error) => setErr(e.message),
  });

  const counts = rooms.reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});

  // Full floor list, derived from the unfiltered rooms set (the API
  // returns every room now — see useQuery above).
  const allFloors = Array.from(new Set(rooms.map((r) => r.floor))).sort(
    (a, b) => a - b,
  );
  // Apply both filters client-side. Floor is a numeric string from
  // the <select>; empty string means "All floors".
  const filtered = rooms.filter((r) => {
    if (statusFilter !== "all" && r.status !== statusFilter) return false;
    if (floor !== "" && r.floor !== Number(floor)) return false;
    return true;
  });
  const sorted = [...filtered].sort((a, b) => {
    if (a.floor !== b.floor) return a.floor - b.floor;
    return a.roomNumber.localeCompare(b.roomNumber, undefined, { numeric: true });
  });
  // Kanban board: one column per status, cards sorted floor-then-room
  // within each. The status filter narrows to a single column; the floor
  // filter narrows every column's cards.
  const visibleColumns = COLUMNS.filter(
    (c) => statusFilter === "all" || c.status === statusFilter,
  );

  return (
    <div className="space-y-[22px]">
      <div className="flex items-end justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-[clamp(22px,3vw,28px)] font-semibold tracking-[-0.5px] text-ink">
            Housekeeping
          </h1>
          <p className="text-sm text-textSecondary mt-1.5">
            All rooms at a glance. {rooms.length} total.
          </p>
        </div>
        <div className="flex items-end gap-3">
          <div>
            <label className="label block mb-1">Floor</label>
            <select
              className="input w-32"
              value={floor}
              onChange={(e) => setFloor(e.target.value)}
            >
              <option value="">All floors</option>
              {allFloors.map((f) => (
                <option key={f} value={String(f)}>
                  Floor {f}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {STATUS_FILTERS.map((s) => {
          const count = s === "all" ? rooms.length : counts[s] ?? 0;
          const active = statusFilter === s;
          return (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={`text-xs font-semibold px-3 py-1.5 rounded-full border transition-colors inline-flex items-center gap-2 ${
                active
                  ? "bg-brand text-white border-brand shadow-primary"
                  : "bg-surface text-textSecondary border-borderControl hover:text-ink hover:bg-surfaceAlt"
              }`}
            >
              <span>{STATUS_LABELS[s]}</span>
              <span
                className={`inline-grid place-items-center min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-bold tabular-nums leading-none ${
                  active ? "bg-white/20 text-white" : "bg-surfaceSubtle text-textSecondary"
                }`}
              >
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {err && <div className="card !bg-dangerBg !border-dangerBorder text-dangerFg text-sm">{err}</div>}

      {isLoading ? (
        <ListSkeleton rows={6} />
      ) : sorted.length === 0 ? (
        <div className="card flex flex-col items-center justify-center py-16 text-center text-textSecondary">
          <div className="text-sm">No rooms match this filter.</div>
        </div>
      ) : (
        // items-start keeps each column at its natural height instead of
        // stretching to the tallest one in the row.
        <div className="grid grid-cols-[repeat(auto-fit,minmax(230px,1fr))] gap-4 items-start">
          {visibleColumns.map((col) => {
            const colRooms = sorted.filter((r) => r.status === col.status);
            return (
              <div
                key={col.status}
                className="bg-surfaceSubtle border border-borderc rounded-2xl p-3.5 flex flex-col gap-3"
              >
                <div className="flex items-center gap-2.5">
                  <span
                    className={`w-[30px] h-[30px] rounded-[9px] grid place-items-center ${col.chip}`}
                  >
                    <col.Icon className="w-[18px] h-[18px]" />
                  </span>
                  <strong className="text-sm text-ink flex-1">
                    {STATUS_LABELS[col.status]}
                  </strong>
                  <span className="inline-flex items-center justify-center min-w-[22px] h-[22px] px-1.5 rounded-full text-xs font-bold text-textSecondary bg-surface border border-borderControl tabular-nums">
                    {colRooms.length}
                  </span>
                </div>

                {colRooms.length === 0 ? (
                  <div className="text-xs text-inkMuted text-center py-4">
                    No rooms
                  </div>
                ) : (
                  colRooms.map((r) => {
                    // Dirty rooms can be made bookable in one click via Mark
                    // Ready. The intermediate clean/inspected ladder was
                    // removed in migration 0034 — one hop now.
                    const canMarkReady = r.status === "dirty";
                    return (
                      <div
                        key={r.id}
                        className={`bg-surface border border-borderc border-l-[3px] ${col.bar} rounded-xl px-3.5 py-3 flex flex-col gap-2 cursor-pointer shadow-card hover:shadow-lift hover:-translate-y-0.5 transition-all`}
                        role="button"
                        tabIndex={0}
                        onClick={(e) => {
                          // The card contains a few action buttons (Mark
                          // Ready, status transitions, Resolve). If the
                          // click started on one of those, skip navigation
                          // — bubbling from a real button means the user
                          // intended that button's action, not card click.
                          if ((e.target as HTMLElement).closest("button, a, input, textarea, select")) {
                            return;
                          }
                          navigate(`/rooms/${r.roomNumber}`);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            navigate(`/rooms/${r.roomNumber}`);
                          }
                        }}
                        title="Open room details + maintenance history"
                      >
                        <div className="font-mono text-lg font-semibold text-ink leading-none">
                          {r.roomNumber}
                        </div>
                        <div>
                          <div className="text-xs font-semibold text-inkBody capitalize">
                            {r.roomType}
                          </div>
                          <div className="text-[11.5px] text-inkMuted mt-0.5">
                            Floor {r.floor}
                          </div>
                        </div>

                        {r.openIssueCount > 0 && (
                          <div className="inline-flex items-center gap-1.5 self-start text-[11px] font-semibold text-warnDeep bg-warnBg px-2 py-0.5 rounded-full border border-warnBorder">
                            <AlertTriangle className="w-3.5 h-3.5" />
                            {r.openIssueCount} open issue
                            {r.openIssueCount === 1 ? "" : "s"}
                          </div>
                        )}

                        {canMarkReady && (
                          <button
                            className="w-full inline-flex items-center justify-center gap-1.5 h-9 rounded-[10px] bg-brand text-white text-[13px] font-semibold shadow-primary hover:bg-brand-deep transition-colors disabled:opacity-60"
                            onClick={() => markReady.mutate(r.id)}
                            disabled={markReady.isPending}
                          >
                            <Check className="w-4 h-4" />
                            Mark Ready
                          </button>
                        )}

                        <div className="flex flex-wrap items-center gap-1.5 empty:hidden">
                          {/* Flag — always available except on rooms already
                              in maintenance status. Opens NewIssueModal so the
                              reporter records category + severity properly. */}
                          {r.status !== "maintenance" && (
                            <button
                              type="button"
                              className="w-full inline-flex items-center justify-center gap-1.5 h-9 rounded-[10px] border border-warnBorder bg-surface text-warnDeep text-[13px] font-semibold hover:bg-warnBg transition-colors"
                              onClick={(e) => {
                                // Stop propagation so the parent card's
                                // onClick handler doesn't also fire — even
                                // though it already bails on button targets,
                                // stopping here removes any ambiguity if a
                                // future refactor changes the card handler.
                                e.stopPropagation();
                                setFlaggingRoom(r);
                              }}
                              title="Open a maintenance issue for this room"
                            >
                              <AlertTriangle className="w-4 h-4" /> Flag Issue
                            </button>
                          )}
                          {r.status === "maintenance" && profile?.role === "admin" && (
                            <button
                              className="w-full inline-flex items-center justify-center gap-1.5 h-9 rounded-[10px] bg-success text-white text-[13px] font-semibold hover:opacity-90 transition-opacity"
                              onClick={() => resolveMaint.mutate(r.id)}
                            >
                              Resolve
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            );
          })}
        </div>
      )}

      {flaggingRoom && (
        <NewIssueModal
          presetRoomId={flaggingRoom.id}
          onClose={() => setFlaggingRoom(null)}
          onCreated={(issueId) => {
            setFlaggingRoom(null);
            // Refresh the housekeeping list so the new issue's count
            // bubble appears immediately, then take the user to the
            // issue's detail page.
            invalidateRooms();
            navigate(`/maintenance/${issueId}`);
          }}
        />
      )}
    </div>
  );
}
