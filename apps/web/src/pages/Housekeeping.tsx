import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/auth/AuthContext";
import { Loader } from "@/components/Loader";
import { NewIssueModal } from "@/components/NewIssueModal";
import { StatusBadge } from "@/components/StatusBadge";
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
  // Group by floor so housekeeping works one level at a time. Each
  // floor renders its own header + grid, with floors separated by a
  // divider so the page mirrors the property's physical layout.
  const byFloor: { floor: number; rooms: typeof sorted }[] = [];
  for (const r of sorted) {
    const last = byFloor[byFloor.length - 1];
    if (last && last.floor === r.floor) last.rooms.push(r);
    else byFloor.push({ floor: r.floor, rooms: [r] });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-brand-dark">Housekeeping</h1>
          <p className="text-sm text-textSecondary mt-0.5">
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

      <div className="inline-flex flex-wrap items-center bg-white border border-borderc rounded-md p-1 gap-1">
        {STATUS_FILTERS.map((s) => {
          const count = s === "all" ? rooms.length : counts[s] ?? 0;
          const active = statusFilter === s;
          return (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={`text-xs font-semibold px-3 py-1.5 rounded-sm transition-colors inline-flex items-center gap-2 ${
                active
                  ? "bg-brand-dark text-cream"
                  : "text-textSecondary hover:text-brand-dark hover:bg-bg"
              }`}
            >
              <span>{STATUS_LABELS[s]}</span>
              <span className={`text-[10px] px-1.5 py-0.5 rounded ${active ? "bg-cream/20" : "bg-bg"}`}>
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {err && <div className="card bg-danger/5 border-danger text-danger text-sm">{err}</div>}

      {isLoading ? (
        <Loader />
      ) : sorted.length === 0 ? (
        <div className="card flex flex-col items-center justify-center py-16 text-center text-textSecondary">
          <div className="text-sm">No rooms match this filter.</div>
        </div>
      ) : (
        <div className="space-y-5">
          {byFloor.map((fg, idx) => (
            <section
              key={`hk-floor-${fg.floor}`}
              className={idx === 0 ? "" : "pt-4 border-t-2 border-brand-dark/15"}
            >
              <div className="text-[10px] uppercase tracking-[0.18em] text-brand font-bold mb-2">
                Floor {fg.floor}
                <span className="ml-2 text-textSecondary font-semibold">
                  · {fg.rooms.length} room{fg.rooms.length === 1 ? "" : "s"}
                </span>
              </div>
              {/* items-start prevents grid auto-stretching every cell
                  to the tallest one in the row. Cards without an open
                  issue badge are naturally shorter — they shouldn't
                  bloat with empty space just because a sibling has more
                  to show. */}
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 items-start">
          {fg.rooms.map((r) => {
            // Dirty rooms can be made bookable in one click via Mark
            // Ready. The intermediate clean/inspected ladder was
            // removed in migration 0034 — one hop now.
            const canMarkReady = r.status === "dirty";
            return (
              <div
                key={r.id}
                className="card p-4 flex flex-col gap-3 cursor-pointer hover:shadow-md hover:-translate-y-0.5 transition-all"
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
                <div className="flex justify-between items-start">
                  <div>
                    <div className="font-mono text-xl font-bold text-brand-dark leading-none">
                      {r.roomNumber}
                    </div>
                    <div className="text-xs text-textSecondary capitalize mt-1">
                      {r.roomType} · Floor {r.floor}
                    </div>
                  </div>
                  <StatusBadge status={r.status} />
                </div>

                {r.openIssueCount > 0 && (
                  <div className="inline-flex items-center gap-1.5 self-start text-xs font-semibold text-warning bg-warning/10 px-2 py-1 rounded border border-warning/30">
                    <AlertTriangle className="w-3.5 h-3.5" />
                    {r.openIssueCount} open issue
                    {r.openIssueCount === 1 ? "" : "s"}
                  </div>
                )}

                {canMarkReady && (
                  <button
                    className="w-full text-sm px-3 py-2 bg-brand-dark text-cream rounded-sm hover:opacity-90 inline-flex items-center justify-center gap-1.5 font-semibold disabled:opacity-60"
                    onClick={() => markReady.mutate(r.id)}
                    disabled={markReady.isPending}
                  >
                    <Check className="w-4 h-4" />
                    Mark Ready
                  </button>
                )}

                <div className="flex flex-wrap items-center gap-1.5">
                  {/* Flag — always available except on rooms already
                      in maintenance status. Opens NewIssueModal so the
                      reporter records category + severity properly. */}
                  {r.status !== "maintenance" && (
                    <button
                      type="button"
                      className="w-full text-sm px-3 py-2 bg-[#B45309] text-cream rounded-sm hover:bg-[#92400E] inline-flex items-center justify-center gap-1.5 font-semibold shadow-sm"
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
                      className="w-full text-sm px-3 py-2 bg-success text-cream rounded-sm hover:opacity-90 font-semibold inline-flex items-center justify-center gap-1.5 shadow-sm"
                      onClick={() => resolveMaint.mutate(r.id)}
                    >
                      Resolve
                    </button>
                  )}
                </div>
              </div>
            );
          })}
              </div>
            </section>
          ))}
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
