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
import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "@/auth/AuthContext";
import { useDialog } from "@/components/Dialog";
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
  const { profile } = useAuth();
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
  const { data: roomTypes = [] } = useRoomTypes({ includeArchived: true });

  const { data: rooms = [], isLoading } = useQuery({
    queryKey: ["rooms", { floor, status, type }],
    queryFn: () =>
      api.get<Room[]>("/rooms", {
        floor: floor || undefined,
        status: status || undefined,
        type: type || undefined,
      }),
  });

  const { data: allRooms = [] } = useQuery({
    queryKey: ["rooms", "all"],
    queryFn: () => api.get<Room[]>("/rooms", {}),
  });

  // Pre-filter to the user-selected floor/status/type. byFloor feeds the
  // "N rooms across M floors" subtitle; statusCounts feeds the stat cards
  // and filter-chip counts.
  const totalRooms = rooms.length;
  const statusCounts: Record<string, number> = {};
  for (const r of rooms) statusCounts[r.status] = (statusCounts[r.status] ?? 0) + 1;

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
              {totalRooms === 0
                ? "No rooms yet - add your first one to get started."
                : `${totalRooms} room${totalRooms === 1 ? "" : "s"} across ${byFloor.size} floor${
                    byFloor.size === 1 ? "" : "s"
                  }.`}
            </div>
          )}
        </div>
        <div className="flex gap-2.5 flex-wrap">
          {profile?.role === "admin" && (
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
          {profile?.role === "admin" && view === "rooms" && (
            <button
              onClick={() => setShowAdd(true)}
              className="btn-primary inline-flex items-center gap-2"
            >
              <Plus className="w-4 h-4" /> Add Room
            </button>
          )}
        </div>
      </div>

      {view === "types" && profile?.role === "admin" ? (
        <RoomTypesManager />
      ) : (
      <>
      {/* 4 stat cards — the at-a-glance shape of the property. */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3.5">
        {(
          [
            { label: "Total rooms", value: totalRooms, tone: "text-ink" },
            {
              label: "Occupied",
              value: statusCounts["occupied"] ?? 0,
              tone: "text-inkDark",
            },
            {
              label: "Available",
              value: statusCounts["available"] ?? 0,
              tone: "text-brand-deep",
            },
            {
              label: "Out of service",
              value: statusCounts["maintenance"] ?? 0,
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
      {/* Status chips — click to filter */}
      <div className="card !p-3">
        <div className="flex flex-wrap items-center gap-2">
          {STATUS_CHIPS.map((c) => {
            const isActive = status === c.key;
            const count = c.key === "" ? totalRooms : statusCounts[c.key] ?? 0;
            return (
              <button
                key={c.key || "all"}
                onClick={() => setStatus(c.key)}
                className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold border transition ${
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
                <span>{c.label}</span>
                <span
                  className={`inline-grid place-items-center min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-bold tabular-nums leading-none ${
                    isActive ? "bg-white/20 text-white" : "bg-surfaceSubtle text-textSecondary"
                  }`}
                >
                  {count}
                </span>
              </button>
            );
          })}

          <div className="grow" />

          <div className="flex items-center gap-2">
            <select
              className="input !h-8 w-28 text-sm"
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
              className="input !h-8 w-40 text-sm"
              value={type}
              onChange={(e) => setType(e.target.value)}
              aria-label="Filter by type"
            >
              <option value="">All types</option>
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
                className="text-xs text-textSecondary hover:text-danger px-2"
              >
                Reset
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Rooms table — row click opens the room's detail page. */}
      {isLoading ? (
        <Loader />
      ) : rooms.length === 0 ? (
        <div className="card p-6 text-textSecondary">No rooms match these filters.</div>
      ) : (
        <div className="card !p-0 overflow-hidden">
          <table className="table-base min-w-[640px]">
            <thead>
              <tr>
                <th>Room</th>
                <th>Type</th>
                <th>Floor</th>
                <th className="!text-right">Rate / night</th>
                <th>Status</th>
                <th className="!text-right" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {sortedRooms.map((r) => (
                <tr
                  key={r.id}
                  className="cursor-pointer transition-colors"
                  onClick={() => navigate(`/rooms/${r.roomNumber}`)}
                >
                  <td className="font-mono text-base font-semibold text-ink">
                    {r.roomNumber}
                  </td>
                  <td>
                    <div
                      className="text-[13.5px] text-inkBody capitalize"
                      title={labelForRoomType(roomTypes, r.roomType)}
                    >
                      {labelForRoomType(roomTypes, r.roomType)}
                    </div>
                    <div className="flex items-center gap-2 text-inkMuted mt-0.5">
                      {r.hasAc && (
                        <span
                          className="inline-flex items-center gap-1 text-[10px]"
                          title="Air conditioning"
                        >
                          <Snowflake className="w-3 h-3" /> AC
                        </span>
                      )}
                      {r.hasTv && (
                        <span
                          className="inline-flex items-center gap-1 text-[10px]"
                          title="Television"
                        >
                          <Tv className="w-3 h-3" /> TV
                        </span>
                      )}
                      {r.hasWifi && (
                        <span
                          className="inline-flex items-center gap-1 text-[10px]"
                          title="Wi-Fi"
                        >
                          <Wifi className="w-3 h-3" /> Wi-Fi
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="text-[13px] text-textSecondary">
                    Floor {r.floor}
                  </td>
                  <td className="!text-right font-mono text-[13.5px] font-semibold text-ink">
                    {inr(r.baseRate)}
                  </td>
                  <td>
                    <span className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-inkBody">
                      <span
                        className={`w-2 h-2 rounded-full ${chipDot(r.status)}`}
                        aria-hidden="true"
                      />
                      <span className="capitalize">
                        {r.status === "dirty"
                          ? "Needs Cleaning"
                          : String(r.status).replace("_", " ")}
                      </span>
                    </span>
                  </td>
                  <td className="!text-right whitespace-nowrap">
                    <span
                      className="inline-flex items-center gap-1.5"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <button
                        onClick={() => setQrRoom(r)}
                        className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-[9px] border border-borderControl bg-surface text-[12px] font-semibold text-inkBody hover:bg-surfaceAlt transition-colors"
                        aria-label={`Room ${r.roomNumber} QR sticker`}
                      >
                        <QrCode className="w-4 h-4" /> QR
                      </button>
                      {profile?.role === "admin" && (
                        <button
                          onClick={() => setEditing(r)}
                          className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-[9px] border border-borderControl bg-surface text-[12px] font-semibold text-inkBody hover:bg-surfaceAlt transition-colors"
                          aria-label={`Edit room ${r.roomNumber}`}
                        >
                          <Pencil className="w-4 h-4" /> Edit
                        </button>
                      )}
                      <ChevronRight className="w-5 h-5 text-inkFaint" aria-hidden="true" />
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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

  const { data: images = [], isLoading } = useQuery({
    queryKey: ["room-images", roomId],
    queryFn: () => api.get<RoomImg[]>(`/rooms/${roomId}/images`),
  });

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
  });
  const remove = useMutation({
    mutationFn: (imageId: string) => api.del(`/rooms/${roomId}/images/${imageId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["room-images", roomId] }),
  });

  // Cover first, then by sort order.
  const ordered = [...images].sort(
    (a, b) => Number(b.isPrimary) - Number(a.isPrimary) || a.sortOrder - b.sortOrder,
  );

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <div>
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

      {isLoading ? (
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
  const { profile } = useAuth();
  const isEdit = !!room;
  const canDelete = isEdit && profile?.role === "admin";
  const { data: roomTypes = [] } = useRoomTypes({ includeArchived: isEdit });

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
    if (!room || !impact.data) return;
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
        className="bg-surface rounded-2xl shadow-modal w-full max-w-lg p-6 space-y-4 max-h-[90vh] overflow-y-auto"
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
          <Field label="Type">
            {roomTypes.length === 0 ? (
              <div className="text-xs text-danger">
                No room types defined. Add some in the Room Types tab first.
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

        <div className="flex justify-between items-center gap-2 pt-2">
          <div>
            {canDelete && (
              <button
                type="button"
                className="inline-flex items-center gap-1.5 text-xs text-danger hover:underline disabled:opacity-50"
                onClick={confirmDelete}
                disabled={del.isPending || impact.isLoading}
                title={
                  impact.data && !impact.data.canDelete
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
              disabled={save.isPending || !form.roomNumber}
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
      className={`inline-flex items-center gap-2 px-3 py-2 rounded-md border text-sm font-semibold transition ${
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
