// Guest Requests — the staff queue behind the in-room QR service tiles.
//
// A guest scans the sticker in their room, unlocks with their phone's last 4
// digits and taps "Clean my room" / "Towels, water & amenities" / "Report a
// problem". Each tap writes a guest_requests row; this page is where the desk
// sees them and acts.
//
// NOT "Booking Requests" (/requests), which is QR self-booking holds on
// `reservations`. Different table, different page, different queue.
//
// A guest request is a guest *communication*, not a work order: the card shows
// the guest's own wording verbatim and nothing on this page can overwrite it
// (the PATCH accepts `status` and nothing else). Staff either acknowledge it,
// mark it done, or cancel it - this page does not create housekeeping tasks
// or maintenance issues. A request that was converted elsewhere (earlier, or
// via the API) still shows a link to what it became.
//
// Polling matches BookingRequests (10s): a guest standing in their room with a
// wet towel should not be waiting on someone to hit refresh.
import {
  GUEST_REQUEST_KIND_CONVERT_TARGET,
  GUEST_REQUEST_KIND_LABELS,
  GUEST_REQUEST_OPEN_STATUSES,
  GUEST_REQUEST_STATUS_LABELS,
  type GuestRequestConvertTarget,
  type GuestRequestKind,
  type GuestRequestStaffStatus,
  type GuestRequestStatus,
} from "@stayvia/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  Ban,
  BedDouble,
  Check,
  CheckCircle2,
  ChevronRight,
  ExternalLink,
  Gift,
  Loader2,
  MessageSquare,
  SprayCan,
  User,
  Wrench,
  X,
} from "@/lib/micons";
import { useAuth } from "@/auth/AuthContext";
import { useDialog } from "@/components/Dialog";
import { EmptyState, FilterChip, ListSkeleton, PageHeader, QueryError } from "@/components/kit";
import { useToast } from "@/components/Toast";
import { ApiError, api, getList } from "@/lib/api";

// Mirrors the list/detail row the API shapes in routes/guestRequests.ts.
// reservationNumber and guestName are nullable on purpose: those FKs are
// ON DELETE SET NULL, so a request outlives a DPDP purge of the stay.
interface GuestRequestRow {
  id: string;
  kind: GuestRequestKind;
  status: GuestRequestStatus;
  note: string | null;
  createdAt: string;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  acknowledgedByName: string | null;
  completedAt: string | null;
  completedBy: string | null;
  completedByName: string | null;
  roomId: string;
  roomNumber: string;
  roomType: string;
  floor: number;
  reservationId: string | null;
  reservationNumber: string | null;
  guestId: string | null;
  guestName: string | null;
  housekeepingTaskId: string | null;
  maintenanceIssueId: string | null;
}

// ---------------------------------------------------------------- helpers

// Re-render every 30s so "4m ago" stays honest between the 10s fetches.
function useNowTick(ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

function timeAgo(iso: string, now: number): string {
  const s = Math.max(1, Math.floor((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 604800) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function stampedAt(iso: string): string {
  return new Date(iso).toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const KIND_META: Record<
  GuestRequestKind,
  { icon: typeof SprayCan; chip: string; blurb: string }
> = {
  cleaning: {
    icon: SprayCan,
    chip: "bg-infoBg text-info border-infoBorder",
    blurb: "The guest asked for their room to be cleaned.",
  },
  amenity: {
    icon: Gift,
    chip: "bg-brand-soft text-brand-deep border-brand-tint",
    blurb: "The guest asked for towels, water or another amenity.",
  },
  issue: {
    icon: Wrench,
    chip: "bg-dangerBg text-dangerFg border-dangerBorder",
    blurb: "The guest reported something broken in the room.",
  },
};

const STATUS_CHIP: Record<GuestRequestStatus, string> = {
  open: "bg-warnBg text-warnFg border-warnBorder",
  acknowledged: "bg-infoBg text-info border-infoBorder",
  done: "bg-successBg text-success border-successBorder",
  cancelled: "bg-neutralBg text-inkMuted border-neutralBorder",
};

// Open before acknowledged before everything else. The API already orders
// newest-first, and Array.prototype.sort is stable, so this groups by status
// without disturbing the time order inside each group.
const STATUS_RANK: Record<GuestRequestStatus, number> = {
  open: 0,
  acknowledged: 1,
  done: 2,
  cancelled: 3,
};

const TERMINAL: readonly GuestRequestStatus[] = ["done", "cancelled"];
const isTerminal = (s: GuestRequestStatus) => TERMINAL.includes(s);

type QueueFilter = "active" | "done" | "cancelled" | "all";

const FILTERS: { key: QueueFilter; label: string }[] = [
  { key: "active", label: "Needs action" },
  { key: "done", label: "Done" },
  { key: "cancelled", label: "Cancelled" },
  { key: "all", label: "All" },
];

function filterParams(f: QueueFilter): Record<string, string> {
  // `statuses` is a comma-separated list the shared schema decodes and
  // enum-validates — never hand-write the member list here.
  if (f === "active") return { statuses: GUEST_REQUEST_OPEN_STATUSES.join(",") };
  if (f === "done") return { status: "done" };
  if (f === "cancelled") return { status: "cancelled" };
  return {};
}

// The link column that matters for a given kind. amenity has neither.
function workItemFor(r: GuestRequestRow): { target: GuestRequestConvertTarget; id: string } | null {
  const target = GUEST_REQUEST_KIND_CONVERT_TARGET[r.kind];
  if (!target) return null;
  const id = target === "maintenance" ? r.maintenanceIssueId : r.housekeepingTaskId;
  return id ? { target, id } : null;
}

// ------------------------------------------------------------------- page

export default function GuestRequests() {
  const { can } = useAuth();
  const dialog = useDialog();
  const { toast } = useToast();
  const qc = useQueryClient();
  const now = useNowTick();

  const [filter, setFilter] = useState<QueueFilter>("active");
  // Card open in the detail overlay, held by id so the 10s poll keeps it fresh.
  const [detailId, setDetailId] = useState<string | null>(null);
  // Writes are gated exactly the way the API gates them, so the UI never
  // offers a button that comes back 403.
  const canWrite = can("update_housekeeping");

  const q = useQuery({
    queryKey: ["guest-requests", "list", filter],
    queryFn: () =>
      getList<GuestRequestRow>("/guest-requests", { ...filterParams(filter), per_page: 50 }),
    // Same cadence as Booking Requests — a guest is waiting on the other end.
    refetchInterval: 10_000,
  });

  const items = useMemo(
    () => [...(q.data?.data ?? [])].sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status]),
    [q.data],
  );
  const total = q.data?.meta.total ?? 0;
  const openCount = items.filter((r) => r.status === "open").length;

  const detail = detailId ? items.find((r) => r.id === detailId) ?? null : null;

  // A row that scrolls out of the active filter after being actioned must not
  // leave a stuck overlay behind.
  useEffect(() => {
    if (detailId && !q.isLoading && !detail) setDetailId(null);
  }, [detailId, detail, q.isLoading]);

  // Covers the page list AND the sidebar badge — both live under the
  // "guest-requests" key prefix.
  const refresh = () => qc.invalidateQueries({ queryKey: ["guest-requests"] });

  const setStatus = useMutation({
    mutationFn: (v: { id: string; status: GuestRequestStaffStatus }) =>
      api.patch<GuestRequestRow>(`/guest-requests/${v.id}`, { status: v.status }),
    onSuccess: (_d, v) => {
      toast(
        v.status === "acknowledged"
          ? "Acknowledged - the guest's request is now yours."
          : v.status === "done"
            ? "Marked done."
            : "Request cancelled.",
        "success",
      );
      void refresh();
    },
    onError: (e) => {
      toast(e instanceof ApiError ? e.message : "Could not update the request", "error");
      void refresh();
    },
  });

  const busyId = (setStatus.isPending && setStatus.variables?.id) || null;

  async function onCancel(r: GuestRequestRow) {
    const ok = await dialog.confirm({
      title: `Cancel this ${GUEST_REQUEST_KIND_LABELS[r.kind].toLowerCase()} request?`,
      message: `Room ${r.roomNumber}'s request is closed without being actioned. The guest is NOT told - if they're still waiting, say so in person. They can always tap the tile again.`,
      okLabel: "Cancel request",
      cancelLabel: "Keep it open",
      tone: "danger",
    });
    if (ok) setStatus.mutate({ id: r.id, status: "cancelled" });
  }

  // A failed fetch leaves `total` at 0, so the counted subtitles below would
  // read as a calm, empty queue. Say the queue is unknown instead.
  const subtitle = q.isError
    ? "The queue didn't load - requests may be waiting."
    : filter === "active"
      ? total === 0
        ? "In-room QR requests land here the moment a guest taps a tile."
        : `${total} request${total === 1 ? "" : "s"} need${total === 1 ? "s" : ""} action${
            openCount > 0 ? ` - ${openCount} not picked up yet` : ""
          }.`
      : `${total} request${total === 1 ? "" : "s"}.`;

  return (
    <div className="space-y-[22px]">
      <PageHeader title="Guest Requests" subtitle={subtitle} />

      {/* Horizontal scroll rather than wrap so the chip row never pushes the
          page wide at 320px. */}
      <div className="-mx-3 px-3 sm:mx-0 sm:px-0 overflow-x-auto no-scrollbar">
        <div className="flex items-center gap-2 w-max">
          {FILTERS.map((f) => (
            <FilterChip
              key={f.key}
              label={f.label}
              active={filter === f.key}
              count={filter === f.key && !q.isError ? total : undefined}
              onClick={() => setFilter(f.key)}
            />
          ))}
        </div>
      </div>

      {/* Error before loading, and before the empty state: "nothing waiting"
          is only true when the fetch came back with nothing. */}
      {q.isError ? (
        <div className="card">
          <QueryError
            error={q.error}
            onRetry={() => void q.refetch()}
            isRetrying={q.isFetching}
          />
        </div>
      ) : q.isLoading ? (
        <ListSkeleton rows={3} />
      ) : items.length === 0 ? (
        <div className="card">
          <EmptyState
            icon={<MessageSquare className="w-5 h-5" />}
            title={
              filter === "active"
                ? "Nothing waiting right now"
                : `No ${filter === "all" ? "" : filter + " "}requests`
            }
            hint={
              filter === "active"
                ? "When a guest scans the QR in their room and asks for cleaning, an amenity or reports a problem, it appears here straight away."
                : "Switch back to Needs action to see the live queue."
            }
          />
        </div>
      ) : (
        <div className="grid gap-3.5 md:grid-cols-2 xl:grid-cols-3">
          {items.map((r) => (
            <RequestCard
              key={r.id}
              row={r}
              now={now}
              busy={busyId === r.id}
              canWrite={canWrite}
              onOpen={() => setDetailId(r.id)}
              onAcknowledge={() => setStatus.mutate({ id: r.id, status: "acknowledged" })}
              onDone={() => setStatus.mutate({ id: r.id, status: "done" })}
            />
          ))}
          {total > items.length && (
            <div className="md:col-span-2 xl:col-span-3 text-center text-xs text-textSecondary">
              Showing the {items.length} most recent of {total}.
            </div>
          )}
        </div>
      )}

      {detail && (
        <RequestDetailOverlay
          row={detail}
          now={now}
          busy={busyId === detail.id}
          canWrite={canWrite}
          onClose={() => setDetailId(null)}
          onAcknowledge={() => setStatus.mutate({ id: detail.id, status: "acknowledged" })}
          onDone={() => setStatus.mutate({ id: detail.id, status: "done" })}
          onCancel={() => void onCancel(detail)}
        />
      )}
    </div>
  );
}

// ------------------------------------------------------------------- card

function RequestCard({
  row,
  now,
  busy,
  canWrite,
  onOpen,
  onAcknowledge,
  onDone,
}: {
  row: GuestRequestRow;
  now: number;
  busy: boolean;
  canWrite: boolean;
  onOpen: () => void;
  onAcknowledge: () => void;
  onDone: () => void;
}) {
  const meta = KIND_META[row.kind];
  const Icon = meta.icon;
  const linked = workItemFor(row);
  const closed = isTerminal(row.status);

  return (
    <div className="card !p-[18px] space-y-3 min-w-0">
      <div className="flex items-start justify-between gap-2">
        <button className="min-w-0 text-left group" onClick={onOpen} title="Open this request">
          <span
            className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-bold uppercase tracking-[0.08em] ${meta.chip}`}
          >
            <Icon className="w-3.5 h-3.5" /> {GUEST_REQUEST_KIND_LABELS[row.kind]}
          </span>
          <div className="flex items-center gap-1.5 mt-1.5 min-w-0">
            <BedDouble className="w-4 h-4 shrink-0 text-inkMuted" />
            <span className="font-mono text-sm font-semibold truncate group-hover:text-brand-deep transition-colors">
              Room {row.roomNumber}
            </span>
            <ChevronRight className="w-3.5 h-3.5 shrink-0 text-inkFaint group-hover:text-brand-deep" />
          </div>
        </button>
        <span
          className={`shrink-0 inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-bold ${STATUS_CHIP[row.status]}`}
        >
          {GUEST_REQUEST_STATUS_LABELS[row.status]}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-textSecondary min-w-0">
        <span className="inline-flex items-center gap-1 min-w-0">
          <User className="w-3.5 h-3.5 shrink-0" />
          <span className="truncate">{row.guestName ?? "Guest record removed"}</span>
        </span>
        <span className="tabular-nums">{timeAgo(row.createdAt, now)}</span>
      </div>

      {/* The guest's own words, verbatim. Nothing on this page edits it. */}
      {row.note?.trim() ? (
        <blockquote className="rounded-md bg-surfaceSubtle border-l-2 border-brand-tint px-3 py-2 text-[13px] text-inkBody leading-snug break-words">
          &ldquo;{row.note.trim()}&rdquo;
        </blockquote>
      ) : (
        <p className="text-[13px] text-textSecondary leading-snug">{meta.blurb}</p>
      )}

      {linked && <WorkItemLink target={linked.target} id={linked.id} />}

      {canWrite && !closed && (
        <div className="flex flex-wrap gap-2 pt-0.5">
          {row.status === "open" && (
            <button
              className="btn-secondary flex-1 min-w-[112px] inline-flex items-center justify-center gap-1.5 disabled:opacity-60"
              disabled={busy}
              onClick={onAcknowledge}
            >
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
              Acknowledge
            </button>
          )}
          <button
            className="btn-primary flex-1 min-w-[112px] inline-flex items-center justify-center gap-1.5 disabled:opacity-60"
            disabled={busy}
            onClick={onDone}
          >
            {busy ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <CheckCircle2 className="w-4 h-4" />
            )}
            Mark done
          </button>
        </div>
      )}
    </div>
  );
}

// What the request became. Maintenance issues have a page of their own, so
// that one is a link. Housekeeping tasks do not have a page yet — showing a
// dead link would be worse than showing none, so it renders as a plain chip
// (the task is real; the team was notified when it was created).
function WorkItemLink({ target, id }: { target: GuestRequestConvertTarget; id: string }) {
  if (target === "maintenance") {
    return (
      <Link
        to={`/maintenance/${id}`}
        className="flex items-center gap-1.5 rounded-md border border-borderControl bg-surfaceAlt px-3 py-2 text-xs font-semibold text-brand-deep hover:bg-brand-soft hover:border-brand-tint transition-colors"
      >
        <Wrench className="w-3.5 h-3.5 shrink-0" />
        <span className="flex-1 min-w-0 truncate">Maintenance issue raised</span>
        <ExternalLink className="w-3.5 h-3.5 shrink-0" />
      </Link>
    );
  }
  return (
    <div
      className="flex items-center gap-1.5 rounded-md border border-borderControl bg-surfaceAlt px-3 py-2 text-xs font-semibold text-textSecondary"
      title={`Housekeeping task ${id}`}
    >
      <SprayCan className="w-3.5 h-3.5 shrink-0" />
      <span className="flex-1 min-w-0 truncate">Housekeeping task created</span>
    </div>
  );
}

// ---------------------------------------------------------------- overlay

function RequestDetailOverlay({
  row,
  now,
  busy,
  canWrite,
  onClose,
  onAcknowledge,
  onDone,
  onCancel,
}: {
  row: GuestRequestRow;
  now: number;
  busy: boolean;
  canWrite: boolean;
  onClose: () => void;
  onAcknowledge: () => void;
  onDone: () => void;
  onCancel: () => void;
}) {
  const meta = KIND_META[row.kind];
  const Icon = meta.icon;
  const linked = workItemFor(row);
  const closed = isTerminal(row.status);

  const field = (label: string, value: string | null | undefined, mono = false) => (
    <div className="min-w-0">
      <div className="text-[10px] font-bold uppercase tracking-[0.06em] text-inkMuted">{label}</div>
      <div className={`text-sm text-ink mt-0.5 break-words ${mono ? "font-mono" : ""}`}>
        {value?.trim() ? value : <span className="text-inkFaint">-</span>}
      </div>
    </div>
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-start md:items-center justify-center bg-inkDark/50 backdrop-blur-[2px] p-3 md:p-6 overflow-y-auto"
      onClick={onClose}
    >
      <div
        className="bg-surface rounded-2xl shadow-modal w-full max-w-lg my-auto overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-2 px-5 py-3.5 border-b border-divider bg-surfaceAlt">
          <div className="min-w-0">
            <span
              className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-bold uppercase tracking-[0.08em] ${meta.chip}`}
            >
              <Icon className="w-3.5 h-3.5" /> {GUEST_REQUEST_KIND_LABELS[row.kind]}
            </span>
            <div className="font-mono text-sm font-semibold mt-1 truncate">
              Room {row.roomNumber}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span
              className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-bold ${STATUS_CHIP[row.status]}`}
            >
              {GUEST_REQUEST_STATUS_LABELS[row.status]}
            </span>
            <button
              onClick={onClose}
              aria-label="Close"
              className="w-9 h-9 rounded-full grid place-items-center hover:bg-parchment transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div className="max-h-[calc(100vh-230px)] overflow-y-auto px-5 py-4 space-y-5">
          <section>
            <h3 className="text-[11px] font-bold uppercase tracking-[0.1em] text-inkMuted mb-2">
              What the guest said
            </h3>
            {row.note?.trim() ? (
              <blockquote className="rounded-md bg-surfaceSubtle border-l-2 border-brand-tint px-3 py-2.5 text-sm text-inkBody leading-relaxed break-words">
                &ldquo;{row.note.trim()}&rdquo;
              </blockquote>
            ) : (
              <p className="text-sm text-textSecondary leading-relaxed">
                {meta.blurb} They didn&rsquo;t add a note.
              </p>
            )}
          </section>

          <section>
            <h3 className="text-[11px] font-bold uppercase tracking-[0.1em] text-inkMuted mb-2.5">
              Where it came from
            </h3>
            <div className="grid grid-cols-2 gap-x-4 gap-y-3">
              {field("Room", `${row.roomNumber} - Floor ${row.floor}`, true)}
              {field("Room type", row.roomType.replace(/_/g, " "))}
              {field("Guest", row.guestName)}
              {row.reservationId && row.reservationNumber ? (
                <div className="min-w-0">
                  <div className="text-[10px] font-bold uppercase tracking-[0.06em] text-inkMuted">
                    Reservation
                  </div>
                  <Link
                    to={`/reservations/${row.reservationId}`}
                    className="text-sm font-mono text-brand-deep hover:underline mt-0.5 inline-flex items-center gap-1 break-all"
                  >
                    {row.reservationNumber}
                    <ChevronRight className="w-3.5 h-3.5 shrink-0" />
                  </Link>
                </div>
              ) : (
                field("Reservation", null)
              )}
            </div>
          </section>

          <section>
            <h3 className="text-[11px] font-bold uppercase tracking-[0.1em] text-inkMuted mb-2.5">
              Timeline
            </h3>
            <ol className="space-y-2 text-[13px]">
              <li className="flex items-start gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-brand mt-[7px] shrink-0" />
                <span className="min-w-0">
                  <span className="text-ink">Guest sent it</span>{" "}
                  <span className="text-textSecondary">
                    - {stampedAt(row.createdAt)} ({timeAgo(row.createdAt, now)})
                  </span>
                </span>
              </li>
              {row.acknowledgedAt && (
                <li className="flex items-start gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-info mt-[7px] shrink-0" />
                  <span className="min-w-0">
                    <span className="text-ink">
                      Acknowledged{row.acknowledgedByName ? ` by ${row.acknowledgedByName}` : ""}
                    </span>{" "}
                    <span className="text-textSecondary">- {stampedAt(row.acknowledgedAt)}</span>
                  </span>
                </li>
              )}
              {row.completedAt && (
                <li className="flex items-start gap-2">
                  <span
                    className={`w-1.5 h-1.5 rounded-full mt-[7px] shrink-0 ${
                      row.status === "cancelled" ? "bg-inkFaint" : "bg-success"
                    }`}
                  />
                  <span className="min-w-0">
                    <span className="text-ink">
                      {row.status === "cancelled" ? "Cancelled" : "Marked done"}
                      {row.completedByName ? ` by ${row.completedByName}` : ""}
                    </span>{" "}
                    <span className="text-textSecondary">- {stampedAt(row.completedAt)}</span>
                  </span>
                </li>
              )}
            </ol>
          </section>

          {linked && (
            <section>
              <h3 className="text-[11px] font-bold uppercase tracking-[0.1em] text-inkMuted mb-2">
                Converted into
              </h3>
              <WorkItemLink target={linked.target} id={linked.id} />
            </section>
          )}
        </div>

        {canWrite && !closed && (
          <div className="flex flex-wrap gap-2 px-5 py-3.5 border-t border-divider bg-surfaceAlt">
            {row.status === "open" && (
              <button
                className="btn-secondary flex-1 min-w-[120px] inline-flex items-center justify-center gap-1.5 disabled:opacity-60"
                disabled={busy}
                onClick={onAcknowledge}
              >
                <Check className="w-4 h-4" /> Acknowledge
              </button>
            )}
            <button
              className="btn-primary flex-1 min-w-[120px] inline-flex items-center justify-center gap-1.5 disabled:opacity-60"
              disabled={busy}
              onClick={onDone}
            >
              {busy ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <CheckCircle2 className="w-4 h-4" />
              )}
              Mark done
            </button>
            <button
              className="btn-danger flex-1 min-w-[120px] inline-flex items-center justify-center gap-1.5 disabled:opacity-60"
              disabled={busy}
              onClick={onCancel}
            >
              <Ban className="w-4 h-4" /> Cancel
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
