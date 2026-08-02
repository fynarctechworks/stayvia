import { useMutation, useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { ShieldAlert, X } from "@/lib/micons";
import { useEffect, useState } from "react";
import { ApiError, api } from "@/lib/api";
import { inr } from "@/lib/utils";

interface Money {
  checkInDate: string;
  nights: number;
  subtotal: number;
  gstRate: number;
  gstAmount: number;
  grandTotal: number;
  balanceDue: number;
}

interface PreviewResponse {
  today: string;
  conflictingRoomIds: string[];
  old: Money;
  new: Money;
  delta: {
    extraNights: number;
    subtotalDelta: number;
    gstAmountDelta: number;
    grandTotalDelta: number;
    balanceDueDelta: number;
  };
  advancePaid: number;
}

interface Props {
  reservationId: string;
  reservationNumber: string;
  onClose: () => void;
  // Fired after the date shift is committed. Caller should then proceed to OTP/check-in.
  onConfirmed: () => void;
}

export function EarlyCheckInModal({
  reservationId,
  reservationNumber,
  onClose,
  onConfirmed,
}: Props) {
  const [step, setStep] = useState<"ask" | "review">("ask");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  const preview = useQuery({
    queryKey: ["early-check-in-preview", reservationId],
    queryFn: () => api.get<PreviewResponse>(`/reservations/${reservationId}/early-check-in/preview`),
    enabled: step === "review",
    retry: false,
  });

  const commit = useMutation({
    mutationFn: () => api.post(`/reservations/${reservationId}/early-check-in`),
    onSuccess: () => onConfirmed(),
    onError: (e: unknown) => {
      const msg =
        e instanceof ApiError && e.code === "ROOM_UNAVAILABLE"
          ? `Cannot shift dates - ${e.message}`
          : e instanceof Error
            ? e.message
            : "Failed to shift dates";
      setError(msg);
    },
  });

  const previewErrorMsg =
    preview.isError && preview.error instanceof Error ? preview.error.message : null;

  const blocked = !!preview.data && preview.data.conflictingRoomIds.length > 0;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-inkDark/50 backdrop-blur-[3px] p-4">
      <div
        className="my-auto w-full max-w-lg bg-surface rounded-2xl shadow-modal overflow-hidden"
        role="dialog"
        aria-modal="true"
      >
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-divider">
          <div className="flex items-center gap-2">
            <ShieldAlert className="w-5 h-5 text-brand-deep" />
            <div className="text-[15px] font-semibold text-ink">
              {step === "ask" ? "Check in early?" : "Review date change"}
            </div>
          </div>
          <button onClick={onClose} className="text-inkFaint hover:text-ink transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-5 py-4 text-[13px] text-inkBody space-y-3">
          {step === "ask" && (
            <>
              <div>
                Reservation <span className="font-mono font-semibold text-ink">{reservationNumber}</span> is
                in the future. You can shift the check-in date to today, but doing so will:
              </div>
              <ul className="list-disc pl-5 space-y-1 text-textSecondary">
                <li>Re-verify the assigned room is free for the extra nights</li>
                <li>Recompute subtotal, GST, grand total, and balance due</li>
                <li>Record the change in the activity log</li>
              </ul>
              <div className="text-textSecondary">
                You'll see the exact financial impact on the next step before anything is saved.
              </div>
            </>
          )}

          {step === "review" && preview.isLoading && (
            <div className="text-textSecondary">Computing impact…</div>
          )}

          {step === "review" && previewErrorMsg && (
            <div className="px-3 py-2 rounded-md border border-dangerBorder bg-dangerBg text-dangerFg text-[12px]">
              {previewErrorMsg}
            </div>
          )}

          {step === "review" && preview.data && (
            <>
              {blocked && (
                <div className="px-3 py-2 rounded-md border border-dangerBorder bg-dangerBg text-dangerFg text-[12px]">
                  <strong>Conflict:</strong> the assigned room is not free for the extra nights
                  ({preview.data.conflictingRoomIds.length} room
                  {preview.data.conflictingRoomIds.length === 1 ? "" : "s"} blocked). Cancel or
                  reassign the conflicting booking first.
                </div>
              )}

              <div className="grid grid-cols-2 gap-3">
                <div className="border border-borderc bg-surfaceAlt rounded-xl p-3">
                  <div className="label">Current</div>
                  <div className="text-[12px] mt-1">
                    Check-in:{" "}
                    <span className="font-semibold text-ink font-mono">
                      {format(new Date(preview.data.old.checkInDate), "dd MMM yyyy")}
                    </span>
                  </div>
                  <div className="text-[12px]">
                    Nights: <span className="font-semibold text-ink">{preview.data.old.nights}</span>
                  </div>
                  <div className="text-[12px] mt-1 font-mono">
                    Subtotal {inr(preview.data.old.subtotal)}
                  </div>
                  <div className="text-[12px] font-mono">
                    GST @{preview.data.old.gstRate}% {inr(preview.data.old.gstAmount)}
                  </div>
                  <div className="text-[13px] font-mono font-bold text-ink mt-1">
                    Total {inr(preview.data.old.grandTotal)}
                  </div>
                  <div className="text-[12px] font-mono text-dangerFg">
                    Balance {inr(preview.data.old.balanceDue)}
                  </div>
                </div>
                <div className="border border-brand rounded-xl p-3 bg-brand-soft">
                  <div className="text-[10.5px] uppercase tracking-[0.06em] text-brand-deep font-bold">
                    After Shift
                  </div>
                  <div className="text-[12px] mt-1">
                    Check-in:{" "}
                    <span className="font-semibold text-ink font-mono">
                      {format(new Date(preview.data.new.checkInDate), "dd MMM yyyy")}
                    </span>
                  </div>
                  <div className="text-[12px]">
                    Nights:{" "}
                    <span className="font-semibold text-ink">
                      {preview.data.new.nights} (+{preview.data.delta.extraNights})
                    </span>
                  </div>
                  <div className="text-[12px] mt-1 font-mono">
                    Subtotal {inr(preview.data.new.subtotal)}
                  </div>
                  <div className="text-[12px] font-mono">
                    GST @{preview.data.new.gstRate}% {inr(preview.data.new.gstAmount)}
                  </div>
                  <div className="text-[13px] font-mono font-bold text-ink mt-1">
                    Total {inr(preview.data.new.grandTotal)}
                  </div>
                  <div className="text-[12px] font-mono text-dangerFg">
                    Balance {inr(preview.data.new.balanceDue)}
                  </div>
                </div>
              </div>

              <div className="border border-warnBorder bg-warnBg text-warnFg rounded-xl p-3 space-y-1 text-[12px]">
                <div className="font-semibold text-warnDeep">Change summary</div>
                <div className="flex justify-between">
                  <span>Extra nights</span>
                  <span className="font-mono font-semibold">
                    +{preview.data.delta.extraNights}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>Extra subtotal</span>
                  <span className="font-mono">{inr(preview.data.delta.subtotalDelta)}</span>
                </div>
                <div className="flex justify-between">
                  <span>Extra GST</span>
                  <span className="font-mono">{inr(preview.data.delta.gstAmountDelta)}</span>
                </div>
                <div className="flex justify-between border-t border-warnBorder pt-1 mt-1">
                  <span className="font-semibold text-warnDeep">Extra grand total</span>
                  <span className="font-mono font-bold text-warnDeep">
                    {inr(preview.data.delta.grandTotalDelta)}
                  </span>
                </div>
                <div className="flex justify-between text-dangerFg font-semibold">
                  <span>Extra balance due</span>
                  <span className="font-mono">{inr(preview.data.delta.balanceDueDelta)}</span>
                </div>
              </div>

              <div className="text-[11px] text-inkMuted">
                Advance already paid:{" "}
                <span className="font-mono">{inr(preview.data.advancePaid)}</span>. The guest will
                owe the new balance at checkout.
              </div>
            </>
          )}

          {error && (
            <div className="px-3 py-2 rounded-md border border-dangerBorder bg-dangerBg text-dangerFg text-[12px]">
              {error}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 px-5 py-3.5 border-t border-divider bg-surfaceAlt">
          <button onClick={onClose} className="btn-secondary">
            Cancel
          </button>
          {step === "ask" && (
            <button
              onClick={() => {
                setError(null);
                setStep("review");
              }}
              className="btn-primary"
            >
              See impact →
            </button>
          )}
          {step === "review" && (
            <button
              onClick={() => commit.mutate()}
              disabled={
                preview.isLoading ||
                !preview.data ||
                blocked ||
                commit.isPending ||
                !!previewErrorMsg
              }
              className="btn-primary"
            >
              {commit.isPending ? "Shifting dates…" : "Confirm & shift dates"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
