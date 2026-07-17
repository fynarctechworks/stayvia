import { useMutation, useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { ShieldAlert, X } from "lucide-react";
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
          ? `Cannot shift dates — ${e.message}`
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
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-brand-dark/40 p-4">
      <div
        className="my-auto w-full max-w-lg bg-white rounded-md shadow-xl border border-borderc"
        role="dialog"
        aria-modal="true"
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-borderc bg-brand-soft">
          <div className="flex items-center gap-2">
            <ShieldAlert className="w-4 h-4 text-brand" />
            <div className="font-semibold text-brand-dark">
              {step === "ask" ? "Check in early?" : "Review date change"}
            </div>
          </div>
          <button onClick={onClose} className="text-textSecondary hover:text-textPrimary">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-5 py-4 text-[13px] text-textPrimary space-y-3">
          {step === "ask" && (
            <>
              <div>
                Reservation <span className="font-mono font-semibold">{reservationNumber}</span> is
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
            <div className="p-2 rounded-sm bg-danger/10 text-danger text-[12px]">
              {previewErrorMsg}
            </div>
          )}

          {step === "review" && preview.data && (
            <>
              {blocked && (
                <div className="p-2 rounded-sm bg-danger/10 text-danger text-[12px]">
                  <strong>Conflict:</strong> the assigned room is not free for the extra nights
                  ({preview.data.conflictingRoomIds.length} room
                  {preview.data.conflictingRoomIds.length === 1 ? "" : "s"} blocked). Cancel or
                  reassign the conflicting booking first.
                </div>
              )}

              <div className="grid grid-cols-2 gap-3">
                <div className="border border-borderc rounded-sm p-3">
                  <div className="text-[10px] uppercase tracking-wider text-textSecondary font-semibold">
                    Current
                  </div>
                  <div className="text-[12px] mt-1">
                    Check-in:{" "}
                    <span className="font-semibold">
                      {format(new Date(preview.data.old.checkInDate), "dd MMM yyyy")}
                    </span>
                  </div>
                  <div className="text-[12px]">
                    Nights: <span className="font-semibold">{preview.data.old.nights}</span>
                  </div>
                  <div className="text-[12px] mt-1 font-mono">
                    Subtotal {inr(preview.data.old.subtotal)}
                  </div>
                  <div className="text-[12px] font-mono">
                    GST @{preview.data.old.gstRate}% {inr(preview.data.old.gstAmount)}
                  </div>
                  <div className="text-[13px] font-mono font-bold mt-1">
                    Total {inr(preview.data.old.grandTotal)}
                  </div>
                  <div className="text-[12px] font-mono text-danger">
                    Balance {inr(preview.data.old.balanceDue)}
                  </div>
                </div>
                <div className="border-2 border-brand rounded-sm p-3 bg-brand/5">
                  <div className="text-[10px] uppercase tracking-wider text-brand font-semibold">
                    After Shift
                  </div>
                  <div className="text-[12px] mt-1">
                    Check-in:{" "}
                    <span className="font-semibold">
                      {format(new Date(preview.data.new.checkInDate), "dd MMM yyyy")}
                    </span>
                  </div>
                  <div className="text-[12px]">
                    Nights:{" "}
                    <span className="font-semibold">
                      {preview.data.new.nights} (+{preview.data.delta.extraNights})
                    </span>
                  </div>
                  <div className="text-[12px] mt-1 font-mono">
                    Subtotal {inr(preview.data.new.subtotal)}
                  </div>
                  <div className="text-[12px] font-mono">
                    GST @{preview.data.new.gstRate}% {inr(preview.data.new.gstAmount)}
                  </div>
                  <div className="text-[13px] font-mono font-bold mt-1">
                    Total {inr(preview.data.new.grandTotal)}
                  </div>
                  <div className="text-[12px] font-mono text-danger">
                    Balance {inr(preview.data.new.balanceDue)}
                  </div>
                </div>
              </div>

              <div className="border border-brass/40 bg-brass/10 rounded-sm p-3 space-y-1 text-[12px]">
                <div className="font-semibold text-brand-dark">Change summary</div>
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
                <div className="flex justify-between border-t border-brass/30 pt-1 mt-1">
                  <span className="font-semibold">Extra grand total</span>
                  <span className="font-mono font-bold">
                    {inr(preview.data.delta.grandTotalDelta)}
                  </span>
                </div>
                <div className="flex justify-between text-danger font-semibold">
                  <span>Extra balance due</span>
                  <span className="font-mono">{inr(preview.data.delta.balanceDueDelta)}</span>
                </div>
              </div>

              <div className="text-[11px] text-textSecondary">
                Advance already paid:{" "}
                <span className="font-mono">{inr(preview.data.advancePaid)}</span>. The guest will
                owe the new balance at checkout.
              </div>
            </>
          )}

          {error && (
            <div className="p-2 rounded-sm bg-danger/10 text-danger text-[12px]">{error}</div>
          )}
        </div>

        <div className="flex justify-end gap-2 px-5 py-3 border-t border-borderc bg-bg">
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
