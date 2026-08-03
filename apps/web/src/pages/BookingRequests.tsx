// Booking Requests — QR self-bookings waiting for the front desk.
// A guest who scans the master QR books a HOLD (30-minute expiry, never
// blocks inventory). This page is where those holds land: the desk verifies
// the guest in person, takes payment, and either confirms (rooms become
// reserved; check-in continues from the reservation page) or declines.
// Polls every 10s so a phone booking appears without a refresh.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { BedDouble, CheckCircle2, ChevronRight, Loader2, QrCode, Users, X } from "@/lib/micons";
import { useDialog } from "@/components/Dialog";
import { EmptyState, ListSkeleton, PageHeader } from "@/components/kit";
import { useToast } from "@/components/Toast";
import { ApiError, api, getList } from "@/lib/api";
import { inr } from "@/lib/utils";

interface HoldRow {
  id: string;
  reservationNumber: string;
  guestName: string;
  guestPhone: string;
  roomNumbers: string;
  checkInDate: string;
  checkOutDate: string;
  numAdults: number;
  numChildren: number;
  grandTotal: string;
  holdExpiresAt: string | null;
  createdAt: string;
}

// Re-render every 30s so the countdown chips stay honest without a fetch.
function useNowTick(ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

function minutesLeft(expiresAt: string | null, now: number): number | null {
  if (!expiresAt) return null;
  return Math.max(0, Math.round((new Date(expiresAt).getTime() - now) / 60_000));
}

export default function BookingRequests() {
  const navigate = useNavigate();
  const dialog = useDialog();
  const { toast } = useToast();
  const qc = useQueryClient();
  const now = useNowTick();

  const q = useQuery({
    queryKey: ["reservations", { status: "hold" }],
    queryFn: () => getList<HoldRow>("/reservations", { status: "hold", per_page: 50 }),
    refetchInterval: 10_000,
  });

  // The server sweep cancels expired holds on its own cadence; hide anything
  // already past its expiry so the desk never acts on a dead request.
  const items = (q.data?.data ?? []).filter((r) => {
    const m = minutesLeft(r.holdExpiresAt, now);
    return m === null || m > 0;
  });

  const confirm = useMutation({
    mutationFn: (id: string) => api.post(`/reservations/${id}/confirm`, {}),
    onSuccess: (_d, id) => {
      toast("Booking confirmed - rooms reserved. Open it to check the guest in.", "success");
      void qc.invalidateQueries({ queryKey: ["reservations"] });
      const row = items.find((r) => r.id === id);
      if (row) navigate(`/reservations/${row.reservationNumber}`);
    },
    onError: (e) => {
      toast(e instanceof ApiError ? e.message : "Could not confirm the request", "error");
      void qc.invalidateQueries({ queryKey: ["reservations"] });
    },
  });

  const decline = useMutation({
    mutationFn: (id: string) =>
      api.post(`/reservations/${id}/cancel`, {
        cancellationReason: "Declined at the front desk (QR booking request)",
      }),
    onSuccess: () => {
      toast("Request declined", "success");
      void qc.invalidateQueries({ queryKey: ["reservations"] });
    },
    onError: (e) => {
      toast(e instanceof ApiError ? e.message : "Could not decline the request", "error");
    },
  });

  async function onDecline(r: HoldRow) {
    const ok = await dialog.confirm({
      title: `Decline ${r.reservationNumber}?`,
      message: `${r.guestName}'s request for room${r.roomNumbers.includes(",") ? "s" : ""} ${r.roomNumbers} will be cancelled. The guest is NOT notified automatically - let them know at the desk.`,
      okLabel: "Decline request",
      cancelLabel: "Keep it",
    });
    if (ok) decline.mutate(r.id);
  }

  return (
    <div className="space-y-[22px]">
      <PageHeader
        title="Booking Requests"
        subtitle={
          items.length === 0
            ? "QR self-bookings land here for the desk to confirm."
            : `${items.length} request${items.length === 1 ? "" : "s"} waiting - each expires 30 minutes after booking.`
        }
      />

      {q.isLoading ? (
        <ListSkeleton rows={3} />
      ) : items.length === 0 ? (
        <div className="card">
          <EmptyState
            icon={<QrCode className="w-5 h-5" />}
            title="No booking requests right now"
            hint="When a guest books through your front-desk QR, the request appears here with a 30-minute window for you to take payment and confirm."
          />
        </div>
      ) : (
        <div className="grid gap-3.5 md:grid-cols-2 xl:grid-cols-3">
          {items.map((r) => {
            const mins = minutesLeft(r.holdExpiresAt, now);
            const urgent = mins !== null && mins <= 5;
            const confirming = confirm.isPending && confirm.variables === r.id;
            const declining = decline.isPending && decline.variables === r.id;
            return (
              <div key={r.id} className="card !p-[18px] space-y-3">
                <div className="flex items-start justify-between gap-2">
                  <button
                    className="min-w-0 text-left group"
                    onClick={() => navigate(`/reservations/${r.reservationNumber}`)}
                    title="View full reservation"
                  >
                    <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.1em] text-brand-deep">
                      <QrCode className="w-3.5 h-3.5" /> QR booking
                    </div>
                    <div className="font-mono text-sm font-semibold mt-1 inline-flex items-center gap-1 group-hover:text-brand-deep transition-colors">
                      {r.reservationNumber}
                      <ChevronRight className="w-3.5 h-3.5 text-inkFaint group-hover:text-brand-deep" />
                    </div>
                  </button>
                  {mins !== null && (
                    <span
                      className={`shrink-0 inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-bold tabular-nums ${
                        urgent
                          ? "bg-dangerBg text-dangerFg border-dangerBorder animate-pulse"
                          : "bg-warnBg text-warnFg border-warnBorder"
                      }`}
                    >
                      {mins} min left
                    </span>
                  )}
                </div>

                <div>
                  <div className="font-semibold text-ink">{r.guestName}</div>
                  <div className="font-mono text-xs text-textSecondary mt-0.5">{r.guestPhone}</div>
                </div>

                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-textSecondary">
                  <span className="inline-flex items-center gap-1">
                    <BedDouble className="w-3.5 h-3.5" />
                    Room{r.roomNumbers.includes(",") ? "s" : ""}{" "}
                    <span className="font-mono font-semibold text-ink">{r.roomNumbers}</span>
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <Users className="w-3.5 h-3.5" />
                    {r.numAdults} adult{r.numAdults === 1 ? "" : "s"}
                    {r.numChildren > 0
                      ? ` + ${r.numChildren} child${r.numChildren === 1 ? "" : "ren"}`
                      : ""}
                  </span>
                  <span className="font-mono">
                    {r.checkInDate} → {r.checkOutDate}
                  </span>
                </div>

                <div className="flex items-center justify-between border-t border-divider pt-2.5">
                  <span className="text-xs text-textSecondary">To collect at the desk</span>
                  <span className="font-mono font-bold text-ink">{inr(r.grandTotal)}</span>
                </div>

                <div className="flex gap-2">
                  <button
                    className="btn-primary flex-1 inline-flex items-center justify-center gap-1.5 disabled:opacity-60"
                    disabled={confirming || declining}
                    onClick={() => confirm.mutate(r.id)}
                  >
                    {confirming ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <CheckCircle2 className="w-4 h-4" />
                    )}
                    Confirm
                  </button>
                  <button
                    className="btn-danger inline-flex items-center justify-center gap-1.5 disabled:opacity-60"
                    disabled={confirming || declining}
                    onClick={() => onDecline(r)}
                  >
                    {declining ? <Loader2 className="w-4 h-4 animate-spin" /> : <X className="w-4 h-4" />}
                    Decline
                  </button>
                </div>
                <button
                  className="btn-secondary w-full inline-flex items-center justify-center gap-1.5"
                  onClick={() => navigate(`/reservations/${r.reservationNumber}`)}
                >
                  View reservation <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
