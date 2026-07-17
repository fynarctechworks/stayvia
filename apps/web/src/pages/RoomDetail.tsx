import {
  MAINTENANCE_CATEGORY_LABELS,
  MAINTENANCE_SEVERITY_LABELS,
  MAINTENANCE_STATUS_LABELS,
  type MaintenanceCategory,
  type MaintenanceSeverity,
  type MaintenanceStatus,
} from "@hoteldesk/shared";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { ChevronLeft, Plus, Snowflake, Tv, Wifi, Wrench } from "lucide-react";
import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Can } from "@/auth/Can";
import { Loader } from "@/components/Loader";
import { NewIssueModal } from "@/components/NewIssueModal";
import { api, getList } from "@/lib/api";
import { inr } from "@/lib/utils";

interface Room {
  id: string;
  roomNumber: string;
  floor: number;
  roomType: string;
  baseRate: string;
  maxOccupancy: number;
  hasAc: boolean;
  hasTv: boolean;
  hasWifi: boolean;
  status: string;
  notes: string | null;
}

// Room detail page — focused on maintenance history. Editing room
// properties (number, rate, amenities) is handled on the /rooms page
// to keep this view scoped to issue tracking.
export default function RoomDetail() {
  const { id } = useParams();
  const navigate = useNavigate();

  const { data: room, isLoading } = useQuery({
    queryKey: ["room", id],
    queryFn: () => api.get<Room>(`/rooms/${id}`),
    enabled: !!id,
  });

  if (isLoading || !room) return <Loader size="lg" />;

  return (
    <div className="space-y-5 max-w-5xl">
      {/* Header: back button + room number + quick metadata pills. */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate(-1)}
            className="btn-secondary !h-9 !px-2"
            title="Back"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <div>
            <h1 className="text-2xl font-bold text-brand-dark">
              Room {room.roomNumber}
            </h1>
            <div className="text-xs text-textSecondary mt-0.5 capitalize">
              {room.roomType.replace(/_/g, " ")} · Floor {room.floor}
              {Number(room.baseRate) > 0
                ? ` · Base ${inr(room.baseRate)}`
                : ""}
            </div>
          </div>
        </div>

        {/* Amenity pills — read-only at-a-glance for housekeeping
            staff so they know what's in the room when planning a
            maintenance visit. */}
        <div className="flex flex-wrap items-center gap-1.5">
          {room.hasAc && <AmenityPill icon={<Snowflake className="w-3 h-3" />} label="AC" />}
          {room.hasTv && <AmenityPill icon={<Tv className="w-3 h-3" />} label="TV" />}
          {room.hasWifi && <AmenityPill icon={<Wifi className="w-3 h-3" />} label="Wi-Fi" />}
        </div>
      </div>

      {/* Maintenance history — the main reason this page exists. */}
      <Can do="view_maintenance">
        <RoomMaintenanceSection roomId={room.id} roomNumber={room.roomNumber} />
      </Can>
    </div>
  );
}

function AmenityPill({
  icon,
  label,
}: {
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <span className="inline-flex items-center gap-1 px-2 py-1 rounded border border-borderc bg-bg text-textSecondary text-[11px] font-semibold">
      {icon}
      {label}
    </span>
  );
}

interface RoomIssueRow {
  id: string;
  category: MaintenanceCategory;
  severity: MaintenanceSeverity;
  status: MaintenanceStatus;
  title: string;
  reportedAt: string;
  reportedByName: string | null;
  resolvedAt: string | null;
  costActual: string | null;
}

const ROOM_MAINT_STATUS_STYLES: Record<MaintenanceStatus, string> = {
  open: "bg-danger/10 text-danger border-danger/30",
  in_progress: "bg-warning/10 text-[#B45309] border-warning/40",
  resolved: "bg-success/10 text-success border-success/30",
  cancelled: "bg-bg text-textSecondary border-borderc line-through",
};

const ROOM_MAINT_SEVERITY_STYLES: Record<MaintenanceSeverity, string> = {
  urgent: "bg-danger/10 text-danger border-danger/30",
  normal: "bg-warning/10 text-[#B45309] border-warning/40",
  low: "bg-bg text-textSecondary border-borderc",
};

function RoomMaintenanceSection({
  roomId,
  roomNumber,
}: {
  roomId: string;
  roomNumber: string;
}) {
  const navigate = useNavigate();
  const [showNew, setShowNew] = useState(false);
  const issuesQ = useQuery({
    queryKey: ["maint-room", roomId],
    queryFn: () =>
      getList<RoomIssueRow>("/maintenance", {
        room_id: roomId,
        per_page: 100,
      }),
    enabled: !!roomId,
    refetchInterval: 30_000,
  });

  const rows = issuesQ.data?.data ?? [];
  const openCount = rows.filter(
    (r) => r.status === "open" || r.status === "in_progress",
  ).length;

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <Wrench className="w-5 h-5 text-brand-dark" />
          <h2 className="text-lg font-semibold text-brand-dark">
            Maintenance History
          </h2>
          {openCount > 0 && (
            <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider font-bold px-2 py-0.5 rounded border bg-danger/10 text-danger border-danger/30">
              {openCount} active
            </span>
          )}
        </div>
        <Can do="manage_maintenance">
          <button
            onClick={() => setShowNew(true)}
            className="btn-primary inline-flex items-center gap-1.5"
          >
            <Plus className="w-4 h-4" /> New Issue
          </button>
        </Can>
      </div>

      {issuesQ.isLoading ? (
        <Loader />
      ) : rows.length === 0 ? (
        <div className="card text-sm text-textSecondary text-center py-10">
          No maintenance issues recorded for Room {roomNumber}.
        </div>
      ) : (
        <div className="card !p-0 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-bg text-[11px] uppercase tracking-wider text-textSecondary">
              <tr>
                <th className="text-left px-4 py-2.5 font-semibold">Title</th>
                <th className="text-left px-4 py-2.5 font-semibold">
                  Category
                </th>
                <th className="text-left px-4 py-2.5 font-semibold">
                  Severity
                </th>
                <th className="text-left px-4 py-2.5 font-semibold">Status</th>
                <th className="text-left px-4 py-2.5 font-semibold">
                  Reported
                </th>
                <th className="text-right px-4 py-2.5 font-semibold">Cost</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-borderc">
              {rows.map((r) => (
                <tr
                  key={r.id}
                  className="hover:bg-brand-soft/30 cursor-pointer transition-colors"
                  onClick={() => navigate(`/maintenance/${r.id}`)}
                >
                  <td className="px-4 py-3">
                    <div className="font-medium text-brand-dark">
                      {r.title}
                    </div>
                    {r.reportedByName && (
                      <div className="text-[11px] text-textSecondary mt-0.5">
                        by {r.reportedByName}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs text-textSecondary">
                    {MAINTENANCE_CATEGORY_LABELS[r.category]}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex items-center text-[10px] uppercase tracking-wider font-bold px-2 py-0.5 rounded border ${ROOM_MAINT_SEVERITY_STYLES[r.severity]}`}
                    >
                      {MAINTENANCE_SEVERITY_LABELS[r.severity]}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex items-center text-[10px] uppercase tracking-wider font-bold px-2 py-0.5 rounded border ${ROOM_MAINT_STATUS_STYLES[r.status]}`}
                    >
                      {MAINTENANCE_STATUS_LABELS[r.status]}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-textSecondary">
                    {format(new Date(r.reportedAt), "dd MMM yyyy")}
                    {r.resolvedAt && (
                      <div className="text-[10px]">
                        resolved{" "}
                        {format(new Date(r.resolvedAt), "dd MMM yyyy")}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right text-xs font-mono text-textSecondary">
                    {r.costActual ? inr(r.costActual) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showNew && (
        <NewIssueModal
          presetRoomId={roomId}
          onClose={() => setShowNew(false)}
          onCreated={() => {
            setShowNew(false);
            // Refresh the list rather than navigating away — staff
            // probably wants to log another issue or stay on this
            // room's history view.
          }}
        />
      )}
    </section>
  );
}
