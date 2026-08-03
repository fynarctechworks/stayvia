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
import { KycModal } from "@/components/KycModal";
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
  status: string;
  cancellationReason?: string | null;
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
  // Card under desk review - opens the full-detail overlay.
  const [review, setReview] = useState<HoldRow | null>(null);

  const q = useQuery({
    queryKey: ["reservations", { status: "hold" }],
    queryFn: () => getList<HoldRow>("/reservations", { status: "hold", per_page: 50 }),
    refetchInterval: 10_000,
  });

  // Past QR bookings - everything that came through the QR that is no
  // longer a live hold. Same 30s-ish freshness as the pending list.
  const historyQ = useQuery({
    queryKey: ["reservations", { source: "qr" }, "history"],
    queryFn: () => getList<HoldRow>("/reservations", { source: "qr", per_page: 20 }),
    refetchInterval: 30_000,
  });
  const history = (historyQ.data?.data ?? []).filter((r) => r.status !== "hold");

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
      setReview(null);
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
      setReview(null);
      void qc.invalidateQueries({ queryKey: ["reservations"] });
    },
    onError: (e) => {
      toast(e instanceof ApiError ? e.message : "Could not decline the request", "error");
    },
  });

  async function onConfirm(r: HoldRow) {
    const ok = await dialog.confirm({
      title: `Confirm ${r.reservationNumber}?`,
      message: `Confirms ${r.guestName}'s booking and marks their ID as verified - only do this after matching the documents against the guest and collecting ${inr(r.grandTotal)} at the desk. The rooms become reserved immediately.`,
      okLabel: "Yes, confirm booking",
      cancelLabel: "Not yet",
    });
    if (ok) confirm.mutate(r.id);
  }

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
                    onClick={() => setReview(r)}
                    title="Review this request"
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
                    onClick={() => onConfirm(r)}
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
                  onClick={() => setReview(r)}
                >
                  View reservation <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* History - every QR booking that already left the queue. */}
      {history.length > 0 && (
        <section className="space-y-2.5">
          <h2 className="text-[11px] font-bold uppercase tracking-[0.1em] text-inkMuted px-1 pt-2">
            History
            <span className="font-normal normal-case tracking-normal text-textSecondary">
              {" "}
              · last {history.length} QR booking{history.length === 1 ? "" : "s"}
            </span>
          </h2>
          <div className="card !p-0 overflow-hidden">
            <ul className="divide-y divide-divider">
              {history.map((r) => (
                <li key={r.id}>
                  <button
                    className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left hover:bg-surfaceAlt transition-colors min-h-[44px]"
                    onClick={() => navigate(`/reservations/${r.reservationNumber}`)}
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm font-semibold">{r.reservationNumber}</span>
                        <HistoryPill status={r.status} reason={r.cancellationReason} />
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
          </div>
        </section>
      )}

      {review && (
        <RequestReviewOverlay
          row={review}
          minsLeft={minutesLeft(review.holdExpiresAt, now)}
          confirming={confirm.isPending && confirm.variables === review.id}
          declining={decline.isPending && decline.variables === review.id}
          onConfirm={() => onConfirm(review)}
          onDecline={() => onDecline(review)}
          onClose={() => setReview(null)}
        />
      )}
    </div>
  );
}

// ---- desk review overlay ---------------------------------------------------

interface ReviewDetail {
  id: string;
  reservationNumber: string;
  guestId: string;
  checkInDate: string;
  checkOutDate: string;
  numAdults: number;
  numChildren: number;
  subtotal: string;
  gstAmount: string;
  gstRate: string;
  grandTotal: string;
  specialRequests?: string | null;
  rooms: {
    id: string;
    roomNumber: string;
    displayType: string;
    ratePerNight: string;
  }[];
  guest: {
    id: string;
    fullName: string;
    phone: string;
    idProofType: string | null;
    idProofLast4: string | null;
    kycVerifiedAt: string | null;
  };
}

interface FullGuest {
  email: string | null;
  gender: string | null;
  nationality: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  gstin: string | null;
}

interface KycStatus {
  verified: boolean;
  photoUrl: string | null;
  frontUrl: string | null;
  backUrl: string | null;
}

// Full-detail review: everything the guest typed, the ID photos they
// uploaded from their phone, and the money - so the desk can approve
// without leaving the queue. Confirm stamps KYC verification server-side
// when photos exist, then jumps to the reservation to finish check-in.
function RequestReviewOverlay({
  row,
  minsLeft,
  confirming,
  declining,
  onConfirm,
  onDecline,
  onClose,
}: {
  row: HoldRow;
  minsLeft: number | null;
  confirming: boolean;
  declining: boolean;
  onConfirm: () => void;
  onDecline: () => void;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [kycOpen, setKycOpen] = useState(false);

  const detailQ = useQuery({
    queryKey: ["reservation", row.id],
    queryFn: () => api.get<ReviewDetail>(`/reservations/${row.id}`),
  });
  const d = detailQ.data;

  const guestQ = useQuery({
    queryKey: ["guest", d?.guestId],
    queryFn: () => api.get<FullGuest>(`/guests/${d!.guestId}`),
    enabled: !!d?.guestId,
  });
  const g = guestQ.data;

  const kycQ = useQuery({
    queryKey: ["guest-kyc", d?.guestId],
    queryFn: () => api.get<KycStatus>(`/guests/${d!.guestId}/kyc`),
    enabled: !!d?.guestId,
  });
  const kyc = kycQ.data;

  const field = (label: string, value: string | null | undefined, mono = false) => (
    <div>
      <div className="text-[10px] font-bold uppercase tracking-[0.06em] text-inkMuted">{label}</div>
      <div className={`text-sm text-ink mt-0.5 ${mono ? "font-mono" : ""}`}>
        {value?.trim() ? value : <span className="text-inkFaint">-</span>}
      </div>
    </div>
  );

  const doc = (label: string, url: string | null | undefined) => (
    <div className="min-w-0">
      <div className="text-[10px] font-bold uppercase tracking-[0.06em] text-inkMuted mb-1">{label}</div>
      {url ? (
        <a href={url} target="_blank" rel="noreferrer" className="block">
          <img
            src={url}
            alt={label}
            className="w-full aspect-[4/5] object-cover rounded-lg border border-borderc hover:opacity-90 transition-opacity"
          />
        </a>
      ) : (
        <div className="w-full aspect-[4/5] rounded-lg border-2 border-dashed border-borderControl grid place-items-center text-[10px] text-inkFaint text-center p-1">
          Not uploaded
        </div>
      )}
    </div>
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-start md:items-center justify-center bg-inkDark/50 backdrop-blur-[2px] p-3 md:p-6 overflow-y-auto"
      onClick={onClose}
    >
      <div
        className="bg-surface rounded-2xl shadow-modal w-full max-w-2xl my-auto overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-2 px-5 py-3.5 border-b border-divider bg-surfaceAlt">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.1em] text-brand-deep">
              <QrCode className="w-3.5 h-3.5" /> QR booking request
            </div>
            <div className="font-mono text-sm font-semibold mt-0.5">{row.reservationNumber}</div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {minsLeft !== null && (
              <span
                className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-bold tabular-nums ${
                  minsLeft <= 5
                    ? "bg-dangerBg text-dangerFg border-dangerBorder animate-pulse"
                    : "bg-warnBg text-warnFg border-warnBorder"
                }`}
              >
                {minsLeft} min left
              </span>
            )}
            <button
              onClick={onClose}
              aria-label="Close"
              className="w-9 h-9 rounded-full grid place-items-center hover:bg-parchment transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div className="max-h-[calc(100vh-220px)] overflow-y-auto px-5 py-4 space-y-5">
          {detailQ.isLoading ? (
            <div className="py-10 grid place-items-center">
              <Loader2 className="w-6 h-6 animate-spin text-brand-deep" />
            </div>
          ) : !d ? (
            <div className="py-8 text-center text-sm text-textSecondary">
              Could not load the reservation.
            </div>
          ) : (
            <>
              {/* Guest identity - everything they typed on their phone */}
              <section>
                <h3 className="text-[11px] font-bold uppercase tracking-[0.1em] text-inkMuted mb-2.5">
                  Guest details
                </h3>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-3">
                  {field("Full name", d.guest.fullName)}
                  {field("Phone", d.guest.phone, true)}
                  {field("Email", g?.email)}
                  {field("Gender", g?.gender)}
                  {field(
                    "ID proof",
                    d.guest.idProofType
                      ? `${d.guest.idProofType.replace(/_/g, " ")} ****${d.guest.idProofLast4 ?? ""}`
                      : null,
                    true,
                  )}
                  {field("Nationality", g?.nationality)}
                  {field("State", g?.state)}
                  {field("City", g?.city)}
                  {field("GSTIN", g?.gstin, true)}
                </div>
                <div className="mt-3">{field("Address", g?.address)}</div>
                {d.specialRequests && (
                  <div className="mt-3">{field("Special requests", d.specialRequests)}</div>
                )}
              </section>

              {/* Documents the guest uploaded from their phone */}
              <section>
                <div className="flex items-center justify-between mb-2.5">
                  <h3 className="text-[11px] font-bold uppercase tracking-[0.1em] text-inkMuted">
                    ID documents
                  </h3>
                  <button
                    className="text-xs font-semibold text-brand-deep hover:text-brand transition-colors"
                    onClick={() => setKycOpen(true)}
                  >
                    {kyc?.photoUrl || kyc?.frontUrl ? "Replace..." : "Capture at desk..."}
                  </button>
                </div>
                {kycQ.isLoading ? (
                  <div className="py-6 grid place-items-center">
                    <Loader2 className="w-5 h-5 animate-spin text-brand-deep" />
                  </div>
                ) : (
                  <div className="grid grid-cols-3 gap-3">
                    {doc("Guest photo", kyc?.photoUrl)}
                    {doc("ID front", kyc?.frontUrl)}
                    {doc("ID back", kyc?.backUrl)}
                  </div>
                )}
                <p className="text-[11px] text-textSecondary mt-2">
                  Match the photo and ID against the guest in front of you. Confirming marks
                  KYC as verified.
                </p>
              </section>

              {/* Stay + money */}
              <section>
                <h3 className="text-[11px] font-bold uppercase tracking-[0.1em] text-inkMuted mb-2.5">
                  Stay & bill
                </h3>
                <div className="grid grid-cols-3 gap-x-4 gap-y-3 mb-3">
                  {field("Check-in", d.checkInDate, true)}
                  {field("Check-out", d.checkOutDate, true)}
                  {field(
                    "Guests",
                    `${d.numAdults} adult${d.numAdults === 1 ? "" : "s"}${
                      d.numChildren > 0 ? ` + ${d.numChildren} child${d.numChildren === 1 ? "" : "ren"}` : ""
                    }`,
                  )}
                </div>
                <div className="divide-y divide-divider border-t border-divider">
                  {d.rooms.map((rm) => (
                    <div key={rm.id} className="flex items-center justify-between py-2 text-sm">
                      <span>
                        <span className="font-mono font-semibold">{rm.roomNumber}</span>{" "}
                        <span className="text-textSecondary">- {rm.displayType}</span>
                      </span>
                      <span className="font-mono">{inr(rm.ratePerNight)}/night</span>
                    </div>
                  ))}
                </div>
                <div className="space-y-1 border-t border-divider pt-2.5 text-sm">
                  <div className="flex justify-between text-textSecondary">
                    <span>Subtotal</span>
                    <span className="font-mono">{inr(d.subtotal)}</span>
                  </div>
                  <div className="flex justify-between text-textSecondary">
                    <span>GST ({Number(d.gstRate)}%)</span>
                    <span className="font-mono">{inr(d.gstAmount)}</span>
                  </div>
                  <div className="flex justify-between font-semibold pt-1 border-t border-divider">
                    <span>To collect at the desk</span>
                    <span className="font-mono font-bold">{inr(d.grandTotal)}</span>
                  </div>
                </div>
              </section>
            </>
          )}
        </div>

        {/* Actions */}
        <div className="flex flex-col sm:flex-row gap-2 px-5 py-3.5 border-t border-divider bg-surfaceAlt">
          <button
            className="btn-primary flex-1 inline-flex items-center justify-center gap-1.5 disabled:opacity-60"
            disabled={confirming || declining || !d}
            onClick={onConfirm}
          >
            {confirming ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <CheckCircle2 className="w-4 h-4" />
            )}
            Confirm booking
          </button>
          <button
            className="btn-danger inline-flex items-center justify-center gap-1.5 disabled:opacity-60"
            disabled={confirming || declining}
            onClick={onDecline}
          >
            {declining ? <Loader2 className="w-4 h-4 animate-spin" /> : <X className="w-4 h-4" />}
            Decline
          </button>
        </div>
      </div>

      {kycOpen && d && (
        <div onClick={(e) => e.stopPropagation()}>
          <KycModal
            guestId={d.guestId}
            onClose={() => setKycOpen(false)}
            onUploaded={() => {
              setKycOpen(false);
              void qc.invalidateQueries({ queryKey: ["guest-kyc", d.guestId] });
            }}
          />
        </div>
      )}
    </div>
  );
}

// Outcome pill for the history list. A cancelled QR booking is either a
// desk decline or a sweep expiry - the stored cancellation reason tells
// which.
function HistoryPill({ status, reason }: { status: string; reason?: string | null }) {
  const map: Record<string, { label: string; cls: string }> = {
    confirmed: { label: "Confirmed", cls: "bg-infoBg text-info border-infoBorder" },
    checked_in: { label: "Checked in", cls: "bg-successBg text-success border-successBorder" },
    checked_out: { label: "Completed", cls: "bg-neutralBg text-inkMuted border-neutralBorder" },
    no_show: { label: "No-show", cls: "bg-dangerBg text-dangerFg border-dangerBorder" },
  };
  let m = map[status];
  if (!m && status === "cancelled") {
    m = reason?.startsWith("QR booking expired")
      ? { label: "Expired", cls: "bg-neutralBg text-inkMuted border-neutralBorder" }
      : { label: "Declined", cls: "bg-dangerBg text-dangerFg border-dangerBorder" };
  }
  if (!m) m = { label: status, cls: "bg-neutralBg text-inkMuted border-neutralBorder" };
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-bold ${m.cls}`}
    >
      {m.label}
    </span>
  );
}
