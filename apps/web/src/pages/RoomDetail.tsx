import {
  MAINTENANCE_CATEGORY_LABELS,
  MAINTENANCE_SEVERITY_LABELS,
  MAINTENANCE_STATUS_LABELS,
  type MaintenanceCategory,
  type MaintenanceSeverity,
  type MaintenanceStatus,
} from "@stayvia/shared";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { ChevronLeft, Plus, QrCode, Snowflake, Tv, Wifi, Wrench } from "@/lib/micons";
import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Can } from "@/auth/Can";
import { Loader } from "@/components/Loader";
import { NewIssueModal } from "@/components/NewIssueModal";
import QrCodeModal from "@/components/QrCodeModal";
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
  qrToken: string;
  notes: string | null;
}

// Room detail page — focused on maintenance history. Editing room
// properties (number, rate, amenities) is handled on the /rooms page
// to keep this view scoped to issue tracking.
export default function RoomDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [showQr, setShowQr] = useState(false);

  const { data: room, isLoading } = useQuery({
    queryKey: ["room", id],
    queryFn: () => api.get<Room>(`/rooms/${id}`),
    enabled: !!id,
  });

  if (isLoading || !room) return <Loader size="lg" />;

  return (
    <div className="space-y-[22px] max-w-5xl">
      {/* Header: back button + room number + quick metadata pills. */}
      <div className="flex items-start justify-between flex-wrap gap-3.5">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate(-1)}
            className="btn-secondary !h-10 w-10 !px-0 grid place-items-center !rounded-[11px]"
            title="Back"
          >
            <ChevronLeft className="w-5 h-5" />
          </button>
          <div>
            <h1 className="text-[clamp(20px,3vw,26px)] font-semibold tracking-[-0.4px] text-ink">
              Room {room.roomNumber}
            </h1>
            <div className="text-[12.5px] text-inkMuted mt-0.5 capitalize">
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
          {room.hasAc && <AmenityPill icon={<Snowflake className="w-3.5 h-3.5" />} label="AC" />}
          {room.hasTv && <AmenityPill icon={<Tv className="w-3.5 h-3.5" />} label="TV" />}
          {room.hasWifi && <AmenityPill icon={<Wifi className="w-3.5 h-3.5" />} label="Wi-Fi" />}
          <button
            onClick={() => setShowQr(true)}
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-[9px] border border-borderControl bg-surface text-inkBody text-xs font-semibold hover:bg-surfaceAlt transition-colors"
          >
            <QrCode className="w-4 h-4" /> Room QR
          </button>
        </div>
      </div>

      {/* Maintenance history — the main reason this page exists. */}
      <Can do="view_maintenance">
        <RoomMaintenanceSection roomId={room.id} roomNumber={room.roomNumber} />
      </Can>

      {showQr && (
        <QrCodeModal
          open
          onClose={() => setShowQr(false)}
          url={`${window.location.origin}/r/${room.qrToken}`}
          title={`Room ${room.roomNumber}`}
          subtitle="Stick this inside the room. Guests scan it for WiFi & requests"
        />
      )}
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
    <span className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-[9px] border border-borderControl bg-surfaceSubtle text-textSecondary text-xs font-semibold">
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

// Semantic bg/fg/border triads per the Warm Concierge spec.
const ROOM_MAINT_STATUS_STYLES: Record<MaintenanceStatus, string> = {
  open: "bg-dangerBg text-dangerFg border-dangerBorder",
  in_progress: "bg-warnBg text-warning border-warnBorder",
  resolved: "bg-successBg text-success border-successBorder",
  cancelled: "bg-neutralBg text-inkMuted border-neutralBorder",
};

const ROOM_MAINT_SEVERITY_STYLES: Record<MaintenanceSeverity, string> = {
  urgent: "bg-dangerBg text-dangerFg border-dangerBorder",
  normal: "bg-warnBg text-warning border-warnBorder",
  low: "bg-bg text-textSecondary border-borderControl",
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
    <section>
      <div className="card !p-0 overflow-hidden">
        <div className="flex items-center justify-between flex-wrap gap-3 px-[18px] py-4 border-b border-divider">
          <div className="flex items-center gap-2">
            <Wrench className="w-5 h-5 text-brand-deep" />
            <h2 className="text-base font-semibold text-ink">
              Maintenance History
            </h2>
            {openCount > 0 && (
              <span className="inline-flex items-center text-[10px] uppercase tracking-[0.06em] font-bold px-2 py-0.5 rounded-full bg-dangerBg text-dangerFg border border-dangerBorder">
                {openCount} active
              </span>
            )}
          </div>
          <Can do="manage_maintenance">
            <button
              onClick={() => setShowNew(true)}
              className="btn-primary !h-[38px] inline-flex items-center gap-1.5"
            >
              <Plus className="w-4 h-4" /> New Issue
            </button>
          </Can>
        </div>

        {issuesQ.isLoading ? (
          <div className="py-8">
            <Loader />
          </div>
        ) : rows.length === 0 ? (
          <div className="text-sm text-textSecondary text-center py-10">
            No maintenance issues recorded for Room {roomNumber}.
          </div>
        ) : (
          <table className="table-base min-w-[720px]">
            <thead>
              <tr>
                <th>Title</th>
                <th>Category</th>
                <th>Severity</th>
                <th>Status</th>
                <th>Reported</th>
                <th className="!text-right">Cost</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.id}
                  className="cursor-pointer transition-colors"
                  onClick={() => navigate(`/maintenance/${r.id}`)}
                >
                  <td>
                    <div className="font-semibold text-sm text-ink">
                      {r.title}
                    </div>
                    {r.reportedByName && (
                      <div className="text-[11.5px] text-inkMuted mt-0.5">
                        by {r.reportedByName}
                      </div>
                    )}
                  </td>
                  <td className="text-[12.5px] text-textSecondary">
                    {MAINTENANCE_CATEGORY_LABELS[r.category]}
                  </td>
                  <td>
                    <span
                      className={`inline-flex items-center text-[10px] uppercase tracking-[0.05em] font-bold px-2 py-0.5 rounded-[6px] border ${ROOM_MAINT_SEVERITY_STYLES[r.severity]}`}
                    >
                      {MAINTENANCE_SEVERITY_LABELS[r.severity]}
                    </span>
                  </td>
                  <td>
                    <span
                      className={`inline-flex items-center text-[10px] uppercase tracking-[0.05em] font-bold px-2 py-0.5 rounded-[6px] border ${ROOM_MAINT_STATUS_STYLES[r.status]}`}
                    >
                      {MAINTENANCE_STATUS_LABELS[r.status]}
                    </span>
                  </td>
                  <td className="text-xs text-textSecondary">
                    {format(new Date(r.reportedAt), "dd MMM yyyy")}
                    {r.resolvedAt && (
                      <div className="text-[10.5px] text-inkMuted">
                        resolved{" "}
                        {format(new Date(r.resolvedAt), "dd MMM yyyy")}
                      </div>
                    )}
                  </td>
                  <td className="!text-right text-[12.5px] font-mono text-textSecondary">
                    {r.costActual ? inr(r.costActual) : "-"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

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
