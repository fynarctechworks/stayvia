// Full history of QR self-bookings — every request that already left the
// Booking Requests queue (confirmed / checked in / completed / declined /
// expired / no-show). Paged 20 at a time; rows tap through to the
// reservation. Live holds stay on /requests.
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronLeft, ChevronRight, QrCode } from "@/lib/micons";
import { EmptyState, ListSkeleton, PageHeader, QueryError } from "@/components/kit";
import { getList } from "@/lib/api";
import { inr } from "@/lib/utils";

interface HistoryRow {
  id: string;
  reservationNumber: string;
  guestName: string;
  roomNumbers: string;
  checkInDate: string;
  grandTotal: string;
  status: string;
  cancellationReason?: string | null;
}

const PER_PAGE = 20;

// Outcome pill. A cancelled QR booking is either a desk decline or a sweep
// expiry — the stored cancellation reason tells which.
export function QrHistoryPill({ status, reason }: { status: string; reason?: string | null }) {
  const map: Record<string, { label: string; cls: string }> = {
    confirmed: { label: "Confirmed", cls: "bg-infoBg text-info border-infoBorder" },
    checked_in: { label: "Checked in", cls: "bg-successBg text-success border-successBorder" },
    checked_out: { label: "Completed", cls: "bg-neutralBg text-inkMuted border-neutralBorder" },
    no_show: { label: "No-show", cls: "bg-dangerBg text-dangerFg border-dangerBorder" },
  };
  let m = map[status];
  if (!m && status === "cancelled") {
    // Three ways a QR booking ends up cancelled: the sweep expired it, the
    // desk declined it from the queue, or staff cancelled it later for an
    // unrelated reason. Only the middle one is a "decline".
    if (reason?.startsWith("QR booking expired")) {
      m = { label: "Expired", cls: "bg-neutralBg text-inkMuted border-neutralBorder" };
    } else if (reason?.includes("Declined at the front desk")) {
      m = { label: "Declined", cls: "bg-dangerBg text-dangerFg border-dangerBorder" };
    } else {
      m = { label: "Cancelled", cls: "bg-neutralBg text-inkMuted border-neutralBorder" };
    }
  }
  if (!m) m = { label: status, cls: "bg-neutralBg text-inkMuted border-neutralBorder" };
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-bold ${m.cls}`}>
      {m.label}
    </span>
  );
}

export default function QrBookingHistory() {
  const navigate = useNavigate();
  const [page, setPage] = useState(1);

  // Live holds belong on /requests, so they're excluded SERVER-side —
  // filtering them client-side left meta.total (and therefore the page
  // count and header) counting rows this page never shows.
  const q = useQuery({
    queryKey: ["reservations", { source: "qr" }, "history", page],
    queryFn: () =>
      getList<HistoryRow>("/reservations", {
        source: "qr",
        exclude_status: "hold",
        page,
        per_page: PER_PAGE,
      }),
    refetchInterval: 30_000,
  });
  const rows = q.data?.data ?? [];
  const total = q.data?.meta.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PER_PAGE));

  return (
    <div className="space-y-[22px]">
      <div className="flex items-center gap-3">
        <button
          onClick={() => navigate("/requests")}
          aria-label="Back to booking requests"
          className="w-10 h-10 grid place-items-center rounded-[11px] border border-borderControl bg-surface text-inkBody hover:bg-surfaceAlt transition-colors shrink-0"
        >
          <ChevronLeft className="w-5 h-5" />
        </button>
        <PageHeader
          title="QR Booking History"
          subtitle={
            q.isError
              ? "This page didn't load - the history below is missing, not empty."
              : total === 0
                ? "Every QR self-booking that has left the queue lands here."
                : `${total} QR booking${total === 1 ? "" : "s"} so far.`
          }
        />
      </div>

      {/* Error before loading and before the empty state. The pager lives in
          the success branch, so a failed page-3 fetch would otherwise strand
          the reader with no way back to page 2 — hence the Back action. */}
      {q.isError ? (
        <div className="card">
          <QueryError
            error={q.error}
            onRetry={() => void q.refetch()}
            isRetrying={q.isFetching}
            action={
              page > 1 ? (
                <button
                  type="button"
                  className="btn-secondary !h-11 min-w-[44px] inline-flex items-center justify-center gap-1.5"
                  onClick={() => setPage((p) => p - 1)}
                >
                  <ChevronLeft className="w-4 h-4 shrink-0" />
                  Back to page {page - 1}
                </button>
              ) : undefined
            }
          />
        </div>
      ) : q.isLoading ? (
        <ListSkeleton rows={6} />
      ) : rows.length === 0 ? (
        <div className="card">
          <EmptyState
            icon={<QrCode className="w-5 h-5" />}
            title="No QR bookings yet"
            hint="Once guests start booking through your front-desk QR, every confirmed, declined and expired request shows up here."
          />
        </div>
      ) : (
        <div className="card !p-0 overflow-hidden">
          <ul className="divide-y divide-divider">
            {rows.map((r) => (
              <li key={r.id}>
                <button
                  className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left hover:bg-surfaceAlt transition-colors min-h-[44px]"
                  onClick={() => navigate(`/reservations/${r.reservationNumber}`)}
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-sm font-semibold">{r.reservationNumber}</span>
                      <QrHistoryPill status={r.status} reason={r.cancellationReason} />
                    </div>
                    <div className="text-xs text-textSecondary truncate mt-0.5">
                      {r.guestName} · Room{r.roomNumbers.includes(",") ? "s" : ""} {r.roomNumbers} ·{" "}
                      <span className="font-mono">{r.checkInDate}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="font-mono text-sm font-semibold">{inr(r.grandTotal)}</span>
                    <ChevronRight className="w-4 h-4 text-inkFaint" />
                  </div>
                </button>
              </li>
            ))}
          </ul>
          {pages > 1 && (
            <div className="flex items-center justify-between px-4 py-2.5 border-t border-divider bg-surfaceAlt">
              <button
                className="btn-secondary !h-9 !px-3 text-xs disabled:opacity-40"
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
              >
                Previous
              </button>
              <span className="text-xs text-textSecondary tabular-nums">
                Page {page} of {pages}
              </span>
              <button
                className="btn-secondary !h-9 !px-3 text-xs disabled:opacity-40"
                disabled={page >= pages}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
