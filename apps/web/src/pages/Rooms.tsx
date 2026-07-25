import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Loader2,
  Pencil,
  Plus,
  QrCode,
  Snowflake,
  Star,
  StarFill,
  Trash2,
  Tv,
  Upload,
  Wifi,
  X,
} from "@/lib/micons";
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
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

  // Pre-filter to the user-selected floor/status/type, then group by floor for
  // the section headers. The status filter narrows what the grid shows; the
  // chips above the grid always reflect *unfiltered* counts so staff knows the
  // shape of the property at a glance.
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
  const floors = Array.from(byFloor.entries()).sort((a, b) => a[0] - b[0]);
  for (const [, list] of floors) {
    list.sort((a, b) =>
      a.roomNumber.localeCompare(b.roomNumber, undefined, { numeric: true }),
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-navy">Rooms</h1>
          <div className="text-xs text-textSecondary mt-0.5">
            {totalRooms} room{totalRooms === 1 ? "" : "s"} across{" "}
            {byFloor.size === 0
              ? "-"
              : `${byFloor.size} floor${byFloor.size === 1 ? "" : "s"}`}
          </div>
        </div>
        {profile?.role === "admin" && view === "rooms" && (
          <button
            onClick={() => setShowAdd(true)}
            className="btn-primary inline-flex items-center gap-2"
          >
            <Plus className="w-4 h-4" /> Add Room
          </button>
        )}
      </div>

      {profile?.role === "admin" && (
        <div className="flex gap-1 border-b border-borderc">
          {(
            [
              { id: "rooms", label: "Rooms" },
              { id: "types", label: "Room Types" },
            ] as const
          ).map((t) => (
            <button
              key={t.id}
              onClick={() => setView(t.id)}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition ${
                view === t.id
                  ? "border-gold text-navy"
                  : "border-transparent text-textSecondary hover:text-navy"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}

      {view === "types" && profile?.role === "admin" ? (
        <RoomTypesManager />
      ) : (
      <>
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
                className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold border transition ${
                  isActive
                    ? "bg-brand text-textPrimary border-brand"
                    : "bg-surface text-textSecondary border-borderc hover:border-brand/40 hover:text-brand-dark"
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
                    isActive ? "bg-brand-dark text-white" : "bg-bg text-textSecondary"
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

      {/* Cards grouped by floor */}
      {isLoading ? (
        <Loader />
      ) : rooms.length === 0 ? (
        <div className="card p-6 text-textSecondary">No rooms match these filters.</div>
      ) : (
        <div className="space-y-5">
          {floors.map(([floorNumber, list]) => (
            <section key={floorNumber}>
              <div className="flex items-baseline justify-between mb-2">
                <h2 className="text-sm font-bold tracking-[0.15em] uppercase text-brand-dark">
                  Floor {floorNumber}
                </h2>
                <div className="text-[11px] text-textSecondary">
                  {list.length} room{list.length === 1 ? "" : "s"}
                </div>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
                {list.map((r) => (
                  <RoomCard
                    key={r.id}
                    room={r}
                    typeLabel={labelForRoomType(roomTypes, r.roomType)}
                    onEdit={
                      profile?.role === "admin" ? () => setEditing(r) : undefined
                    }
                    onQr={() => setQrRoom(r)}
                  />
                ))}
              </div>
            </section>
          ))}
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

// Maps a room status to a small dot color used inside the status chip filters.
function chipDot(key: string): string {
  switch (key) {
    case "":
      return "bg-textSecondary/50";
    case "available":
      return "bg-[#ffdb13]";
    case "occupied":
      return "bg-navy";
    case "reserved":
      return "bg-[#644fc1]";
    case "dirty":
      return "bg-warning";
    case "maintenance":
      return "bg-danger";
    default:
      return "bg-textSecondary/50";
  }
}

// Per-room visual style — top stripe + status pill colors. Matches the
// Dashboard's room-tile palette so the two pages feel consistent.
function statusVisual(status: string): { stripe: string; pillBg: string; pillText: string } {
  switch (status) {
    case "available":
      return { stripe: "bg-[#ffdb13]", pillBg: "bg-[#ffdb13]/15", pillText: "text-[#8a7500]" };
    case "occupied":
      return { stripe: "bg-navy", pillBg: "bg-navy/10", pillText: "text-navy" };
    case "reserved":
      return { stripe: "bg-[#644fc1]", pillBg: "bg-[#644fc1]/15", pillText: "text-[#4c3ba8]" };
    case "dirty":
      return { stripe: "bg-warning", pillBg: "bg-warning/15", pillText: "text-[#92400e]" };
    case "maintenance":
      return { stripe: "bg-danger", pillBg: "bg-danger/10", pillText: "text-[#b91c1c]" };
    default:
      return { stripe: "bg-borderc", pillBg: "bg-borderc/40", pillText: "text-textSecondary" };
  }
}

function RoomCard({
  room,
  typeLabel,
  onEdit,
  onQr,
}: {
  room: Room;
  typeLabel: string;
  onEdit?: () => void;
  onQr?: () => void;
}) {
  const v = statusVisual(room.status);
  return (
    <div className="group relative rounded-md border border-borderc bg-surface shadow-sm overflow-hidden hover:shadow-md hover:-translate-y-0.5 transition">
      <div className={`h-1.5 ${v.stripe}`} />
      <div className="px-3 pt-3 pb-2 flex items-start justify-between gap-2">
        <div>
          <div className="font-mono text-xl font-bold leading-none text-brand-dark">
            {room.roomNumber}
          </div>
          <div className="text-[10px] uppercase tracking-wider text-textSecondary mt-0.5">
            Floor {room.floor}
          </div>
        </div>
        <span
          className={`inline-flex items-center text-[9px] uppercase tracking-wider font-bold rounded-full px-2 py-0.5 ${v.pillBg} ${v.pillText}`}
        >
          {String(room.status).replace("_", " ")}
        </span>
      </div>
      <div className="px-3 pb-3 space-y-2">
        <div className="text-xs text-textPrimary capitalize line-clamp-1" title={typeLabel}>
          {typeLabel}
        </div>
        <div className="flex items-center gap-1.5 text-textSecondary">
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
        <div className="font-mono text-sm font-semibold text-brand-dark">
          {inr(room.baseRate)}
          <span className="text-[10px] font-normal text-textSecondary"> / night</span>
        </div>
      </div>
      {/* Always-visible action bar. Hover-reveal text links were invisible on
          touch screens and easy to miss on desktop. */}
      {(onQr || onEdit) && (
        <div className="grid grid-cols-2 border-t border-borderc divide-x divide-borderc">
          {onQr && (
            <button
              onClick={onQr}
              className={`inline-flex items-center justify-center gap-1.5 h-9 text-xs font-medium text-navy hover:bg-brand/5 hover:text-brand-dark transition-colors ${!onEdit ? "col-span-2" : ""}`}
              aria-label={`Room ${room.roomNumber} QR sticker`}
            >
              <QrCode className="w-4 h-4" /> QR
            </button>
          )}
          {onEdit && (
            <button
              onClick={onEdit}
              className={`inline-flex items-center justify-center gap-1.5 h-9 text-xs font-medium text-navy hover:bg-brand/5 hover:text-brand-dark transition-colors ${!onQr ? "col-span-2" : ""}`}
              aria-label={`Edit room ${room.roomNumber}`}
            >
              <Pencil className="w-4 h-4" /> Edit
            </button>
          )}
        </div>
      )}
    </div>
  );
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
          className="w-full border border-dashed border-borderc rounded-md py-6 text-xs text-textSecondary hover:border-brand hover:text-brand-dark transition"
        >
          No photos yet — add some so guests can see Room {roomNumber}
        </button>
      ) : (
        <div className="grid grid-cols-3 gap-2">
          {ordered.map((im) => (
            <div key={im.id} className="relative group aspect-square rounded-md overflow-hidden border border-borderc">
              <img src={im.url} alt="" className="w-full h-full object-cover" />
              {im.isPrimary && (
                <span className="absolute top-1 left-1 bg-brand text-brand-dark text-[9px] font-bold rounded-full px-1.5 py-0.5 inline-flex items-center gap-0.5">
                  <StarFill className="w-2.5 h-2.5" /> Cover
                </span>
              )}
              <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition flex items-center justify-center gap-1.5 opacity-0 group-hover:opacity-100">
                {!im.isPrimary && (
                  <button
                    type="button"
                    title="Set as cover"
                    className="w-7 h-7 rounded-full bg-white/90 grid place-items-center hover:bg-white"
                    onClick={() => setPrimary.mutate(im.id)}
                  >
                    <Star className="w-3.5 h-3.5 text-navy" />
                  </button>
                )}
                <button
                  type="button"
                  title="Remove"
                  className="w-7 h-7 rounded-full bg-white/90 grid place-items-center hover:bg-white"
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
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        className="bg-surface rounded-md w-full max-w-lg p-6 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold text-navy">
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
          <div className="border-t border-borderc pt-4">
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
      className={`inline-flex items-center gap-2 px-3 py-2 rounded-sm border-2 text-sm font-medium transition ${
        active
          ? "bg-accentBlue text-white border-accentBlue shadow-sm"
          : "bg-bg text-textSecondary border-borderc hover:border-accentBlue/60 hover:text-navy"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}
