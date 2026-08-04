import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronLeft,
  ChevronRight,
  Loader2,
  Pencil,
  Plus,
  QrCode,
  Snowflake,
  Star,
  StarFill,
  Tag,
  Trash2,
  Tv,
  Upload,
  Wifi,
  X,
} from "@/lib/micons";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { usePermission } from "@/auth/AuthContext";
import { useDialog } from "@/components/Dialog";
import { QueryError, queryErrorMessage } from "@/components/kit";
import { Loader } from "@/components/Loader";
import QrCodeModal from "@/components/QrCodeModal";
import { RoomTypesManager } from "@/components/RoomTypesManager";
import { useToast } from "@/components/Toast";
import { useRoomTypes, labelForRoomType } from "@/hooks/useRoomTypes";
import { api } from "@/lib/api";
import { invalidateRoomData } from "@/lib/invalidate";
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

export default function Rooms() {
  // Gate on PERMISSIONS, not on the legacy profiles.role column.
  //
  // PUT /rbac/users/:id/role collapses every non-admin/non-housekeeping role
  // key onto profiles.role = 'frontdesk', so the seeded "General Manager"
  // role — which genuinely holds edit_rooms / delete_rooms / manage_settings
  // on the API — arrived here as 'frontdesk' and saw no way to add, edit or
  // delete a room, or to reach room types (making the dashboard's "Add room
  // types" onboarding link a dead end). rbac.ts documents profiles.role as
  // display-only with RBAC as the source of truth.
  const canEditRooms = usePermission("edit_rooms");
  const canManageSettings = usePermission("manage_settings");
  const navigate = useNavigate();
  // Room-type management moved here from Settings — admins flip between
  // the room grid and the type catalog with these tabs. ?tab=types deep-links
  // straight to the catalog (used by the dashboard's get-started card).
  const [searchParams] = useSearchParams();
  const [view, setView] = useState<"rooms" | "types">(
    searchParams.get("tab") === "types" ? "types" : "rooms",
  );
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState<Room | null>(null);
  const [qrRoom, setQrRoom] = useState<Room | null>(null);
  const [floor, setFloor] = useState<string>("");
  const [status, setStatus] = useState<string>("");
  const [type, setType] = useState<string>("");
  const roomTypesQ = useRoomTypes({ includeArchived: true });
  const roomTypes = roomTypesQ.data ?? [];

  const roomsQ = useQuery({
    queryKey: ["rooms", { floor, status, type }],
    queryFn: () =>
      api.get<Room[]>("/rooms", {
        floor: floor || undefined,
        status: status || undefined,
        type: type || undefined,
      }),
  });
  const { isLoading } = roomsQ;
  const rooms = roomsQ.data ?? [];

  const allRoomsQ = useQuery({
    queryKey: ["rooms", "all"],
    queryFn: () => api.get<Room[]>("/rooms", {}),
  });
  const allRooms = allRoomsQ.data ?? [];

  // Both queries hit GET /rooms, so in an outage they fail together and the
  // page has nothing true to say: no table, no property totals, no chip
  // counts. That case replaces the whole body with one error instead of four
  // separate ones.
  const listFailed = roomsQ.isError;
  const summaryFailed = allRoomsQ.isError;
  const allFailed = listFailed && summaryFailed;
  const retryAll = () => {
    void roomsQ.refetch();
    void allRoomsQ.refetch();
  };

  // `rooms` is the SERVER-filtered list (floor/status/type), so it only
  // describes the current view — totalRooms and byFloor feed the subtitle
  // and the table. Anything that claims to describe the property (the stat
  // cards) or how many rooms a chip would reveal (the chip badges) is
  // derived from the unfiltered `allRooms` instead.
  const totalRooms = rooms.length;
  const hasFilter = Boolean(floor || status || type);
  // Fall back to `rooms` only until the unfiltered query resolves, so the
  // summary doesn't flash zeros on first paint.
  const summaryRooms = allRooms.length > 0 ? allRooms : rooms;

  const propertyCounts: Record<string, number> = {};
  for (const r of summaryRooms)
    propertyCounts[r.status] = (propertyCounts[r.status] ?? 0) + 1;

  // Chip badges keep the floor/type filters applied so they agree with the
  // grid, but never the status filter — otherwise every inactive chip reads 0
  // the moment one status is selected.
  const chipBase = summaryRooms.filter(
    (r) => (!floor || String(r.floor) === floor) && (!type || r.roomType === type),
  );
  const chipCounts: Record<string, number> = {};
  for (const r of chipBase) chipCounts[r.status] = (chipCounts[r.status] ?? 0) + 1;

  const STATUS_CHIPS: { key: string; label: string }[] = [
    { key: "", label: "All" },
    { key: "available", label: "Available" },
    { key: "occupied", label: "Occupied" },
    { key: "reserved", label: "Reserved" },
    { key: "dirty", label: "Needs Cleaning" },
    { key: "maintenance", label: "Maintenance" },
  ];

  const byFloor = new Map<number, Room[]>();
  for (const r of rooms) {
    if (!byFloor.has(r.floor)) byFloor.set(r.floor, []);
    byFloor.get(r.floor)!.push(r);
  }
  // Flat sorted list for the table — floor first, then natural room order.
  const sortedRooms = [...rooms].sort(
    (a, b) =>
      a.floor - b.floor ||
      a.roomNumber.localeCompare(b.roomNumber, undefined, { numeric: true }),
  );

  return (
    <div className="space-y-[22px]">
      <div className="flex items-end justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-[clamp(22px,3vw,28px)] font-semibold tracking-[-0.5px] text-ink">
            {view === "types" ? "Room Types" : "Rooms"}
          </h1>
          {view === "rooms" && (
            <div className="text-sm text-textSecondary mt-1.5">
              {/* "No rooms yet" is only true once the list actually came back
                  empty — never while it is in flight, never when it failed. */}
              {listFailed || summaryFailed
                ? "Room counts couldn't be loaded."
                : isLoading || allRoomsQ.isLoading
                  ? "Loading rooms…"
                  : summaryRooms.length === 0
                    ? "No rooms yet - add your first one to get started."
                    : hasFilter
                      ? `Showing ${totalRooms} of ${summaryRooms.length} room${
                          summaryRooms.length === 1 ? "" : "s"
                        }.`
                      : `${totalRooms} room${totalRooms === 1 ? "" : "s"} across ${byFloor.size} floor${
                          byFloor.size === 1 ? "" : "s"
                        }.`}
            </div>
          )}
        </div>
        <div className="flex gap-2.5 flex-wrap">
          {canManageSettings && (
            <button
              onClick={() => setView(view === "types" ? "rooms" : "types")}
              aria-pressed={view === "types"}
              className="btn-secondary inline-flex items-center gap-2"
            >
              {view === "types" ? (
                <>
                  <ChevronLeft className="w-[18px] h-[18px]" /> Back to Rooms
                </>
              ) : (
                <>
                  <Tag className="w-[18px] h-[18px]" /> Room Types
                </>
              )}
            </button>
          )}
          {canEditRooms && view === "rooms" && (
            <button
              onClick={() => setShowAdd(true)}
              className="btn-primary inline-flex items-center gap-2"
            >
              <Plus className="w-4 h-4" /> Add Room
            </button>
          )}
        </div>
      </div>

      {view === "types" && canManageSettings ? (
        <RoomTypesManager />
      ) : (
      <>
      {allFailed ? (
        <QueryError
          error={roomsQ.error ?? allRoomsQ.error}
          onRetry={retryAll}
          isRetrying={roomsQ.isFetching || allRoomsQ.isFetching}
          title="Couldn't load rooms"
          message="The room list didn't load, so this page can't show the property — it is not empty. Don't add rooms from here until it loads."
        />
      ) : (
      <>
      {/* 4 stat cards — the at-a-glance shape of the whole property, so they
          stay on the unfiltered counts even while a filter is active. */}
      {summaryFailed ? (
        // Occupancy tiles are read as fact by managers; four zeros off a
        // failed request is worse than no tiles at all.
        <QueryError
          error={allRoomsQ.error}
          onRetry={() => allRoomsQ.refetch()}
          isRetrying={allRoomsQ.isFetching}
          title="Room totals couldn't be loaded"
          message="These tiles would read 0 for every status, which is not the same as an empty property."
        />
      ) : (
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3.5">
        {(
          [
            { label: "Total rooms", value: summaryRooms.length, tone: "text-ink" },
            {
              label: "Occupied",
              value: propertyCounts["occupied"] ?? 0,
              tone: "text-inkDark",
            },
            {
              label: "Available",
              value: propertyCounts["available"] ?? 0,
              tone: "text-brand-deep",
            },
            {
              label: "Out of service",
              value: propertyCounts["maintenance"] ?? 0,
              tone: "text-danger",
            },
          ] as const
        ).map((s) => (
          <div
            key={s.label}
            className="bg-surface border border-borderc rounded-[14px] px-[18px] py-4 shadow-card"
          >
            <div className="text-[12.5px] text-textSecondary font-semibold">
              {s.label}
            </div>
            <div className={`text-[26px] font-semibold mt-1.5 tabular-nums ${s.tone}`}>
              {s.value}
            </div>
          </div>
        ))}
      </div>
      )}
      {/* Status chips — click to filter. On phone the chip row scrolls
          sideways in its own strip so the page itself never does; the
          floor/type selects drop below it full-width. */}
      <div className="card !p-3">
        <div className="flex flex-col md:flex-row md:flex-wrap md:items-center gap-2">
          <div className="-mx-3 px-3 overflow-x-auto md:mx-0 md:px-0 md:overflow-visible md:grow">
            <div className="flex md:flex-wrap items-center gap-2 w-max md:w-auto">
              {STATUS_CHIPS.map((c) => {
                const isActive = status === c.key;
                const count = c.key === "" ? chipBase.length : chipCounts[c.key] ?? 0;
                return (
                  <button
                    key={c.key || "all"}
                    onClick={() => setStatus(c.key)}
                    className={`inline-flex shrink-0 items-center gap-1.5 rounded-full min-h-[44px] md:min-h-0 px-3.5 md:px-3 py-1.5 text-xs font-semibold border transition ${
                      isActive
                        ? "bg-brand text-white border-brand shadow-primary"
                        : "bg-surface text-textSecondary border-borderControl hover:bg-surfaceAlt hover:text-ink"
                    }`}
                    aria-pressed={isActive}
                  >
                    <span
                      className={`w-2 h-2 rounded-full ${chipDot(c.key)}`}
                      aria-hidden="true"
                    />
                    <span className="whitespace-nowrap">{c.label}</span>
                    {/* No badge rather than a zero badge when the unfiltered
                        list failed — the chips still filter, they just stop
                        claiming how many rooms are behind each one. */}
                    {!summaryFailed && (
                      <span
                        className={`inline-grid place-items-center min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-bold tabular-nums leading-none ${
                          isActive ? "bg-white/20 text-white" : "bg-surfaceSubtle text-textSecondary"
                        }`}
                      >
                        {count}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <select
              className="input !min-h-[44px] md:!min-h-0 md:!h-8 flex-1 min-w-[130px] md:flex-none md:w-28 text-sm"
              value={floor}
              onChange={(e) => setFloor(e.target.value)}
              aria-label="Filter by floor"
            >
              <option value="">All floors</option>
              {Array.from(new Set(allRooms.map((r) => r.floor)))
                .sort((a, b) => a - b)
                .map((f) => (
                  <option key={f} value={String(f)}>
                    Floor {f}
                  </option>
                ))}
            </select>
            <select
              className="input !min-h-[44px] md:!min-h-0 md:!h-8 flex-1 min-w-[130px] md:flex-none md:w-40 text-sm"
              value={type}
              onChange={(e) => setType(e.target.value)}
              aria-label="Filter by type"
            >
              <option value="">All types</option>
              {/* An empty list here would otherwise read as "this property has
                  no room types". */}
              {roomTypesQ.isError && (
                <option disabled>Room types couldn't be loaded</option>
              )}
              {roomTypes.map((t) => (
                <option key={t.id} value={t.slug}>
                  {t.label}
                </option>
              ))}
            </select>
            {(floor || type || status) && (
              <button
                onClick={() => {
                  setFloor("");
                  setType("");
                  setStatus("");
                }}
                className="text-xs text-textSecondary hover:text-danger px-2 min-h-[44px] md:min-h-0 w-full md:w-auto"
              >
                Reset
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Rooms table — row click opens the room's detail page. */}
      {listFailed ? (
        <QueryError
          error={roomsQ.error}
          onRetry={() => roomsQ.refetch()}
          isRetrying={roomsQ.isFetching}
          title="Couldn't load the room list"
          message="This list is unknown, not empty. Don't create rooms from here until it loads — they may already exist."
        />
      ) : isLoading ? (
        <Loader />
      ) : rooms.length === 0 ? (
        <div className="card p-6 text-textSecondary">
          {hasFilter
            ? "No rooms match these filters."
            : "No rooms yet - use Add Room to create your first one."}
        </div>
      ) : (
        <div className="card !p-0 overflow-hidden">
          {/* Desktop column headers — pointless above the mobile cards, so
              they only exist from md up. */}
          <div className="hidden lg:grid grid-cols-[90px_minmax(160px,1fr)_90px_130px_150px_190px] gap-3 px-3 py-2.5 text-[10px] font-bold uppercase tracking-[0.06em] text-inkMuted bg-surfaceAlt border-b border-borderc">
            <div>Room</div>
            <div>Type</div>
            <div>Floor</div>
            <div className="text-right">Rate / night</div>
            <div>Status</div>
            <div className="text-right">Actions</div>
          </div>
          <ul className="divide-y divide-divider">
            {sortedRooms.map((r) => {
              const typeLabel = labelForRoomType(roomTypes, r.roomType);
              const statusLabel =
                r.status === "dirty"
                  ? "Needs Cleaning"
                  : String(r.status).replace("_", " ");
              return (
                <li key={r.id} className="hover:bg-surfaceAlt transition-colors">
                  {/* DESKTOP */}
                  <div
                    className="hidden lg:grid grid-cols-[90px_minmax(160px,1fr)_90px_130px_150px_190px] gap-3 items-center px-3 py-3 cursor-pointer"
                    onClick={() => navigate(`/rooms/${r.roomNumber}`)}
                  >
                    <div className="font-mono text-base font-semibold text-ink">
                      {r.roomNumber}
                    </div>
                    <div className="min-w-0">
                      <div className="text-[13.5px] text-inkBody capitalize truncate" title={typeLabel}>
                        {typeLabel}
                      </div>
                      <RoomAmenities room={r} />
                    </div>
                    <div className="text-[13px] text-textSecondary">Floor {r.floor}</div>
                    <div className="text-right font-mono text-[13.5px] font-semibold text-ink">
                      {inr(r.baseRate)}
                    </div>
                    <div>
                      <span className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-inkBody">
                        <span
                          className={`w-2 h-2 rounded-full ${chipDot(r.status)}`}
                          aria-hidden="true"
                        />
                        <span className="capitalize">{statusLabel}</span>
                      </span>
                    </div>
                    <div
                      className="flex justify-end items-center gap-1.5 whitespace-nowrap"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <button
                        onClick={() => setQrRoom(r)}
                        className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-[9px] border border-borderControl bg-surface text-[12px] font-semibold text-inkBody hover:bg-surfaceAlt transition-colors"
                        aria-label={`Room ${r.roomNumber} QR sticker`}
                      >
                        <QrCode className="w-4 h-4" /> QR
                      </button>
                      {canEditRooms && (
                        <button
                          onClick={() => setEditing(r)}
                          className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-[9px] border border-borderControl bg-surface text-[12px] font-semibold text-inkBody hover:bg-surfaceAlt transition-colors"
                          aria-label={`Edit room ${r.roomNumber}`}
                        >
                          <Pencil className="w-4 h-4" /> Edit
                        </button>
                      )}
                      <ChevronRight className="w-5 h-5 text-inkFaint" aria-hidden="true" />
                    </div>
                  </div>

                  {/* MOBILE */}
                  <div className="lg:hidden px-3 py-3">
                    <button
                      onClick={() => navigate(`/rooms/${r.roomNumber}`)}
                      className="w-full min-h-[44px] flex items-start justify-between gap-3 text-left"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="font-mono text-base font-semibold text-ink">
                          {r.roomNumber}
                        </div>
                        <div className="text-[13px] text-inkBody capitalize truncate">
                          {typeLabel}
                        </div>
                        <div className="text-[11.5px] text-textSecondary mt-0.5">
                          Floor {r.floor}
                        </div>
                        <RoomAmenities room={r} />
                      </div>
                      <div className="shrink-0 flex items-start gap-1">
                        <div className="text-right">
                          <div className="font-mono text-[13.5px] font-semibold text-ink">
                            {inr(r.baseRate)}
                          </div>
                          <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-inkBody mt-1">
                            <span
                              className={`w-2 h-2 rounded-full ${chipDot(r.status)}`}
                              aria-hidden="true"
                            />
                            <span className="capitalize">{statusLabel}</span>
                          </span>
                        </div>
                        <ChevronRight
                          className="w-5 h-5 text-inkFaint mt-0.5"
                          aria-hidden="true"
                        />
                      </div>
                    </button>
                    <div className="flex gap-2 mt-2.5">
                      <button
                        onClick={() => setQrRoom(r)}
                        className="flex-1 min-h-[44px] inline-flex items-center justify-center gap-1.5 rounded-[9px] border border-borderControl bg-surface text-[13px] font-semibold text-inkBody"
                        aria-label={`Room ${r.roomNumber} QR sticker`}
                      >
                        <QrCode className="w-4 h-4" /> QR
                      </button>
                      {canEditRooms && (
                        <button
                          onClick={() => setEditing(r)}
                          className="flex-1 min-h-[44px] inline-flex items-center justify-center gap-1.5 rounded-[9px] border border-borderControl bg-surface text-[13px] font-semibold text-inkBody"
                          aria-label={`Edit room ${r.roomNumber}`}
                        >
                          <Pencil className="w-4 h-4" /> Edit
                        </button>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      </>
      )}

      {qrRoom && (
        <QrCodeModal
          open
          onClose={() => setQrRoom(null)}
          url={`${window.location.origin}/r/${qrRoom.qrToken}`}
          title={`Room ${qrRoom.roomNumber}`}
          subtitle="Stick this inside the room. Guests scan it for WiFi & requests"
        />
      )}
      {(showAdd || editing) && (
        <RoomModal
          room={editing}
          onClose={() => {
            setShowAdd(false);
            setEditing(null);
          }}
        />
      )}
      </>
      )}
    </div>
  );
}

// Amenity icon strip — same markup in the desktop row and the mobile
// card, so it lives here instead of being written twice.
function RoomAmenities({ room }: { room: Room }) {
  if (!room.hasAc && !room.hasTv && !room.hasWifi) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 text-inkMuted mt-0.5">
      {room.hasAc && (
        <span className="inline-flex items-center gap-1 text-[10px]" title="Air conditioning">
          <Snowflake className="w-3 h-3" /> AC
        </span>
      )}
      {room.hasTv && (
        <span className="inline-flex items-center gap-1 text-[10px]" title="Television">
          <Tv className="w-3 h-3" /> TV
        </span>
      )}
      {room.hasWifi && (
        <span className="inline-flex items-center gap-1 text-[10px]" title="Wi-Fi">
          <Wifi className="w-3 h-3" /> Wi-Fi
        </span>
      )}
    </div>
  );
}

// Maps a room status to a small dot color used inside the status chip
// filters and the table's status column.
function chipDot(key: string): string {
  switch (key) {
    case "":
      return "bg-inkFaint";
    case "available":
      return "bg-brand";
    case "occupied":
      return "bg-inkDark";
    case "reserved":
      return "bg-reserved";
    case "dirty":
      return "bg-notReady";
    case "maintenance":
      return "bg-danger";
    default:
      return "bg-inkFaint";
  }
}

interface RoomImg {
  id: string;
  url: string;
  caption: string | null;
  sortOrder: number;
  isPrimary: boolean;
}

// Room photo manager — lives in the edit modal. These images are what guests
// see on the booking QR page (/h/:token). Cover = the first shown; set it
// with the star. Uploads go to the public bucket via multipart.
function RoomImagesManager({ roomId, roomNumber }: { roomId: string; roomNumber: string }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const imagesQ = useQuery({
    queryKey: ["room-images", roomId],
    queryFn: () => api.get<RoomImg[]>(`/rooms/${roomId}/images`),
  });
  const { isLoading } = imagesQ;
  const images = imagesQ.data ?? [];

  async function upload(files: FileList) {
    if (!files.length) return;
    setUploading(true);
    try {
      const fd = new FormData();
      Array.from(files)
        .slice(0, 8)
        .forEach((f) => fd.append("files", f));
      await api.upload(`/rooms/${roomId}/images`, fd);
      qc.invalidateQueries({ queryKey: ["room-images", roomId] });
      toast("Photos added", "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Upload failed", "error");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  const setPrimary = useMutation({
    mutationFn: (imageId: string) =>
      api.patch(`/rooms/${roomId}/images/${imageId}`, { isPrimary: true }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["room-images", roomId] }),
    onError: (e) => toast(queryErrorMessage(e, "Couldn't change the cover photo."), "error"),
  });
  const remove = useMutation({
    mutationFn: (imageId: string) => api.del(`/rooms/${roomId}/images/${imageId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["room-images", roomId] }),
    onError: (e) => toast(queryErrorMessage(e, "Couldn't remove that photo."), "error"),
  });

  // Cover first, then by sort order.
  const ordered = [...images].sort(
    (a, b) => Number(b.isPrimary) - Number(a.isPrimary) || a.sortOrder - b.sortOrder,
  );

  return (
    <div>
      <div className="flex items-center justify-between flex-wrap gap-2 mb-2">
        <div className="min-w-0">
          <label className="label">Photos</label>
          <p className="text-[11px] text-textSecondary">
            Shown to guests on the booking QR. First (★) is the cover.
          </p>
        </div>
        <button
          type="button"
          className="btn-secondary !h-8 inline-flex items-center gap-1.5 text-xs"
          disabled={uploading}
          onClick={() => fileRef.current?.click()}
        >
          {uploading ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Upload className="w-3.5 h-3.5" />
          )}
          {uploading ? "Uploading…" : "Add photos"}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          multiple
          className="hidden"
          onChange={(e) => e.target.files && upload(e.target.files)}
        />
      </div>

      {/* The dashed "no photos" prompt invites a duplicate re-upload, so it is
          only shown once the fetch has actually succeeded. */}
      {imagesQ.isError ? (
        <QueryError
          error={imagesQ.error}
          onRetry={() => imagesQ.refetch()}
          isRetrying={imagesQ.isFetching}
          title="Couldn't load photos"
          message={`Room ${roomNumber}'s photos didn't load. Any photos already on the guest booking page are still there — don't re-upload until this loads.`}
        />
      ) : isLoading ? (
        <div className="text-xs text-textSecondary py-3">Loading photos…</div>
      ) : ordered.length === 0 ? (
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="w-full border-[1.5px] border-dashed border-borderControl bg-surfaceAlt rounded-md py-6 text-xs text-textSecondary hover:border-brand hover:text-brand-deep transition"
        >
          No photos yet — add some so guests can see Room {roomNumber}
        </button>
      ) : (
        <div className="grid grid-cols-3 gap-2">
          {ordered.map((im) => (
            <div key={im.id} className="relative group aspect-square rounded-[10px] overflow-hidden border border-borderc">
              <img src={im.url} alt="" className="w-full h-full object-cover" />
              {im.isPrimary && (
                <span className="absolute top-1 left-1 bg-brand text-white text-[9px] font-bold rounded-full px-1.5 py-0.5 inline-flex items-center gap-0.5">
                  <StarFill className="w-2.5 h-2.5" /> Cover
                </span>
              )}
              <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition flex items-center justify-center gap-1.5 opacity-0 group-hover:opacity-100">
                {!im.isPrimary && (
                  <button
                    type="button"
                    title="Set as cover"
                    className="w-7 h-7 rounded-full bg-surface/90 grid place-items-center hover:bg-surface"
                    onClick={() => setPrimary.mutate(im.id)}
                  >
                    <Star className="w-3.5 h-3.5 text-ink" />
                  </button>
                )}
                <button
                  type="button"
                  title="Remove"
                  className="w-7 h-7 rounded-full bg-surface/90 grid place-items-center hover:bg-surface"
                  onClick={() => remove.mutate(im.id)}
                >
                  <X className="w-3.5 h-3.5 text-danger" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function RoomModal({ room, onClose }: { room: Room | null; onClose: () => void }) {
  const qc = useQueryClient();
  const dialog = useDialog();
  const isEdit = !!room;
  // Hook call is unconditional (rules of hooks); the isEdit gate is applied
  // to the derived flag, not to whether the hook runs.
  const canDeleteRooms = usePermission("delete_rooms");
  const canDelete = isEdit && canDeleteRooms;
  const roomTypesQ = useRoomTypes({ includeArchived: isEdit });
  // Stable reference — the default-fill effect below depends on this list.
  const roomTypes = useMemo(() => roomTypesQ.data ?? [], [roomTypesQ.data]);

  const [form, setForm] = useState({
    roomNumber: room?.roomNumber ?? "",
    floor: room?.floor ?? 1,
    roomType: room?.roomType ?? "",
    baseRate: room ? Number(room.baseRate) : 0,
    maxOccupancy: room?.maxOccupancy ?? 2,
    hasAc: room?.hasAc ?? true,
    hasTv: room?.hasTv ?? true,
    hasWifi: room?.hasWifi ?? true,
  });
  const [err, setErr] = useState<string | null>(null);

  // Pre-fetch the deletion impact so the confirm dialog can show the exact
  // number of historical reservation links that would be detached.
  const impact = useQuery({
    queryKey: ["room-delete-impact", room?.id],
    queryFn: () =>
      api.get<{
        room: { id: string; roomNumber: string; status: string };
        totalHistoricalReservations: number;
        activeReservations: { reservationNumber: string }[];
        canDelete: boolean;
      }>(`/rooms/${room!.id}/delete-impact`),
    enabled: canDelete,
  });

  const del = useMutation({
    mutationFn: () => api.del(`/rooms/${room!.id}`),
    onSuccess: () => {
      invalidateRoomData(qc, { roomId: room!.id });
      onClose();
    },
    onError: (e: Error) => setErr(e.message),
  });

  async function confirmDelete() {
    if (!room) return;
    // The impact lookup is what tells us whether deleting is safe. If it
    // failed, the button used to re-enable and every click hit a silent early
    // return — say so instead of doing nothing.
    if (impact.isError) {
      await dialog.alert({
        title: "Couldn't check this room",
        message: `Stayvia couldn't check what deleting room ${room.roomNumber} would affect, so it can't be deleted safely right now.\n\n${queryErrorMessage(impact.error)}`,
        tone: "danger",
      });
      return;
    }
    if (!impact.data) return;
    const i = impact.data;
    if (!i.canDelete) {
      await dialog.alert({
        title: "Cannot delete room",
        message:
          i.activeReservations.length > 0
            ? `Room ${room.roomNumber} is attached to ${i.activeReservations.length} active reservation(s) (${i.activeReservations
                .map((r) => r.reservationNumber)
                .join(", ")}). Cancel or check those out first.`
            : `Room ${room.roomNumber} is currently occupied. Check the guest out first.`,
        tone: "danger",
      });
      return;
    }
    const histLine =
      i.totalHistoricalReservations > 0
        ? ` This will detach ${i.totalHistoricalReservations} historical reservation link${
            i.totalHistoricalReservations === 1 ? "" : "s"
          } - those past reservations will lose their room reference.`
        : "";
    const ok2 = await dialog.confirm({
      title: `Delete room ${room.roomNumber}?`,
      message: `This permanently removes room ${room.roomNumber} from the property.${histLine}\n\nThis cannot be undone.`,
      okLabel: "Delete room",
      tone: "danger",
    });
    if (ok2) del.mutate();
  }

  useEffect(() => {
    if (!roomTypes.length) return;
    // Fill an empty type on create (no room yet) OR on edit where the
    // existing slug doesn't match any current room_types row (legacy
    // slug, archived type, etc.). Without this fallback the <select>
    // visually shows the first option but form.roomType stays empty,
    // so submit fails server-side with "must contain at least 1
    // character".
    const hasMatch = roomTypes.some((t) => t.slug === form.roomType);
    if (!form.roomType || !hasMatch) {
      const first = roomTypes[0]!;
      setForm((f) => ({
        ...f,
        roomType: first.slug,
        baseRate: isEdit ? f.baseRate : Number(first.defaultRate),
        maxOccupancy: isEdit ? f.maxOccupancy : Number(first.maxOccupancy),
      }));
    }
  }, [roomTypes, form.roomType, isEdit]);

  function changeType(slug: string) {
    const t = roomTypes.find((x) => x.slug === slug);
    setForm({
      ...form,
      roomType: slug,
      baseRate: t ? Number(t.defaultRate) : form.baseRate,
      maxOccupancy: t ? Number(t.maxOccupancy) : form.maxOccupancy,
    });
  }

  const save = useMutation({
    mutationFn: () =>
      isEdit ? api.put(`/rooms/${room!.id}`, form) : api.post("/rooms", form),
    onSuccess: () => {
      invalidateRoomData(qc, room ? { roomId: room.id } : {});
      onClose();
    },
    onError: (e: Error) => setErr(e.message),
  });

  return (
    <div
      className="fixed inset-0 bg-inkDark/50 backdrop-blur-[3px] flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-surface rounded-2xl shadow-modal w-full max-w-lg p-4 sm:p-6 space-y-4 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold text-ink">
          {isEdit ? `Edit Room ${room!.roomNumber}` : "Add Room"}
        </h2>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Room Number">
            <input
              className="input"
              value={form.roomNumber}
              onChange={(e) => setForm({ ...form, roomNumber: e.target.value })}
              required
            />
          </Field>
          <Field label="Floor">
            <input
              className="input"
              type="number"
              value={form.floor === 0 ? "" : form.floor}
              onChange={(e) => {
                const v = e.target.value;
                setForm({ ...form, floor: v === "" ? 0 : Number(v) });
              }}
            />
          </Field>
          {/* Type gets the full width — its labels are long and would be
              unreadable in a half column on a phone. */}
          <div className="col-span-2">
            <Field label="Type">
              {/* "No room types defined" sends an admin to go create types
                  that already exist, so it waits for a successful fetch. */}
              {roomTypesQ.isError ? (
                <QueryError
                  error={roomTypesQ.error}
                  onRetry={() => roomTypesQ.refetch()}
                  isRetrying={roomTypesQ.isFetching}
                  title="Couldn't load room types"
                  message="The type list didn't load, so this room can't be saved yet. This does not mean the property has no room types."
                />
              ) : roomTypesQ.isLoading ? (
                <div className="text-xs text-textSecondary">Loading room types…</div>
              ) : roomTypes.length === 0 ? (
                <div className="text-xs text-danger">
                  No room types defined. Add some with the Room Types button first.
                </div>
              ) : (
                <select
                  className="input"
                  value={form.roomType}
                  onChange={(e) => changeType(e.target.value)}
                >
                  {roomTypes.map((t) => (
                    <option key={t.id} value={t.slug}>
                      {t.label}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          </div>
        </div>

        {form.roomType && (
          <div className="text-xs text-textSecondary -mt-1">
            Rate ₹{form.baseRate} · Max occupancy {form.maxOccupancy} (from room type)
          </div>
        )}

        <div>
          <div className="label mb-2">Amenities</div>
          <div className="flex flex-wrap gap-2">
            <AmenityToggle
              icon={<Snowflake className="w-4 h-4" />}
              label="AC"
              active={form.hasAc}
              onClick={() => setForm({ ...form, hasAc: !form.hasAc })}
            />
            <AmenityToggle
              icon={<Tv className="w-4 h-4" />}
              label="TV"
              active={form.hasTv}
              onClick={() => setForm({ ...form, hasTv: !form.hasTv })}
            />
            <AmenityToggle
              icon={<Wifi className="w-4 h-4" />}
              label="WiFi"
              active={form.hasWifi}
              onClick={() => setForm({ ...form, hasWifi: !form.hasWifi })}
            />
          </div>
        </div>

        {/* Photos — only after the room exists (needs an id to attach to).
            These are what guests see on the booking QR page. */}
        {isEdit && room && (
          <div className="border-t border-divider pt-4">
            <RoomImagesManager roomId={room.id} roomNumber={room.roomNumber} />
          </div>
        )}

        {err && <div className="text-danger text-xs">{err}</div>}

        <div className="flex flex-wrap justify-between items-center gap-3 pt-2">
          <div>
            {canDelete && (
              <button
                type="button"
                className="inline-flex items-center gap-1.5 min-h-[44px] sm:min-h-0 text-xs text-danger hover:underline disabled:opacity-50"
                onClick={confirmDelete}
                disabled={del.isPending || impact.isLoading}
                title={
                  impact.isError
                    ? "Couldn't check this room's bookings - try again"
                    : impact.data && !impact.data.canDelete
                      ? "Room is currently in use - cannot delete"
                      : "Delete this room"
                }
              >
                <Trash2 className="w-3.5 h-3.5" />
                {del.isPending ? "Deleting…" : "Delete room"}
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <button className="btn-secondary" onClick={onClose}>
              Cancel
            </button>
            <button
              className="btn-primary"
              onClick={() => save.mutate()}
              // Without a room type the POST comes back as a raw Zod message
              // that blames the operator for a GET that failed.
              disabled={save.isPending || !form.roomNumber || !form.roomType}
            >
              {save.isPending ? (isEdit ? "Saving…" : "Creating…") : isEdit ? "Save" : "Create"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="label block mb-1">{label}</label>
      {children}
    </div>
  );
}

function AmenityToggle({
  icon,
  label,
  active,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex items-center gap-2 min-h-[44px] sm:min-h-0 px-3.5 py-2 rounded-md border text-sm font-semibold transition ${
        active
          ? "bg-brand text-white border-brand shadow-primary"
          : "bg-surface text-textSecondary border-borderControl hover:border-brand/50 hover:text-ink"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}
