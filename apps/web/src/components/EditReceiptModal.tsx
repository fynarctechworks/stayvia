import { useMutation } from "@tanstack/react-query";
import { format } from "date-fns";
import { Printer, X } from "@/lib/micons";
import { useEffect, useState } from "react";
import { ApiError, api } from "@/lib/api";
import { formatTime, inr } from "@/lib/utils";
import type { CheckInReceiptData } from "./CheckInReceiptModal";

interface Props {
  data: CheckInReceiptData;
  paymentId: string;
  // Initial values for the editable fields. The "amount" + "receiptNumber"
  // come from data.latestPayment and stay read-only — editing them is not
  // supported by the server because it would desync invoice/balance math.
  initial: {
    paymentDate: string; // ISO
    paymentMethod: string;
    notes: string | null;
  };
  // If the reservation hasn't been checked in yet, this is a booking-advance
  // receipt; otherwise it's a regular check-in receipt.
  variant?: "checkin" | "booking_advance";
  onClose: () => void;
  onSaved: () => void;
}

const METHODS = ["cash", "upi", "card", "bank_transfer"] as const;

export function EditReceiptModal({
  data,
  paymentId,
  initial,
  variant = "checkin",
  onClose,
  onSaved,
}: Props) {
  const isAdvance = variant === "booking_advance";
  const title = isAdvance ? "Edit Booking Advance Receipt" : "Edit Check-in Receipt";

  const [paymentDate, setPaymentDate] = useState(
    // datetime-local input wants "YYYY-MM-DDTHH:mm" with no timezone suffix.
    new Date(initial.paymentDate).toISOString().slice(0, 16),
  );
  const [method, setMethod] = useState(initial.paymentMethod);
  const [notes, setNotes] = useState(initial.notes ?? "");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  const save = useMutation({
    mutationFn: () =>
      api.patch(`/payments/${paymentId}`, {
        paymentDate: new Date(paymentDate).toISOString(),
        paymentMethod: method,
        notes: notes.trim() === "" ? null : notes,
      }),
    onSuccess: () => {
      onSaved();
      onClose();
    },
    onError: (e: unknown) => {
      if (e instanceof ApiError) setError(e.message);
      else setError(e instanceof Error ? e.message : "Save failed");
    },
  });

  const dirty =
    new Date(paymentDate).toISOString() !== new Date(initial.paymentDate).toISOString() ||
    method !== initial.paymentMethod ||
    (notes.trim() || null) !== (initial.notes?.trim() || null);

  function print() {
    window.print();
  }

  // Computed totals — same math as the slip
  const gstRate = Number(data.gstRate);
  const gstAmt = Number(data.gstAmount);
  const half = +(gstAmt / 2).toFixed(2);
  const halfRate = +(gstRate / 2).toFixed(2);
  const showGst = !!gstRate && !!gstAmt;

  return (
    <div className="print-portal fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-brand-dark/40 p-4 print:bg-white print:p-0 print:static print:overflow-visible print:block">
      <div
        className="checkin-receipt my-auto w-full max-w-md bg-white rounded-md shadow-xl border border-borderc print:max-w-full print:my-0 print:shadow-none"
        role="dialog"
        aria-modal="true"
      >
        <div className="no-print flex items-center justify-between px-5 py-3 border-b border-borderc bg-brand-soft">
          <div className="font-semibold text-brand-dark">{title}</div>
          <button onClick={onClose} className="text-textSecondary hover:text-textPrimary">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="receipt-body px-5 py-4 text-[12px] text-textPrimary">
          {/* Header */}
          <div className="flex items-start justify-between gap-3 pb-3 border-b-2 border-brand">
            <div className="flex items-start gap-2.5">
              {data.hotel.logoUrl && (
                <img
                  src={data.hotel.logoUrl}
                  alt=""
                  className="w-12 h-12 rounded-md object-contain bg-cream p-0.5 ring-1 ring-brand/20"
                />
              )}
              <div className="leading-tight">
                <div className="text-[15px] font-bold text-brand-dark">{data.hotel.name}</div>
                <div className="text-[10px] text-textSecondary mt-0.5">
                  {data.hotel.address}
                  {(data.hotel.phone || data.hotel.ownerPhone) && (
                    <>
                      {" · "}
                      {[data.hotel.phone, data.hotel.ownerPhone].filter(Boolean).join(" · ")}
                    </>
                  )}
                </div>
                {data.hotel.gstin && (
                  <div className="text-[10px] text-textSecondary font-mono mt-0.5">
                    GSTIN: {data.hotel.gstin}
                  </div>
                )}
              </div>
            </div>
            <div className="text-right shrink-0">
              <div className="inline-block text-[10px] tracking-[0.2em] uppercase font-bold text-[#157f5f] border border-brass rounded-full px-2.5 py-0.5">
                {isAdvance ? "Advance" : "Check-in"}
              </div>
              <div className="text-[13px] font-bold font-mono text-brand-dark mt-1.5">
                {data.reservationNumber}
              </div>
              {/* Editable: payment date/time */}
              <div className="mt-1.5">
                <label className="text-[9px] uppercase tracking-wider text-textSecondary font-semibold block mb-0.5">
                  Date & Time
                </label>
                <input
                  type="datetime-local"
                  className="input !h-7 !text-[11px] !py-0.5 w-[150px] text-right font-mono"
                  value={paymentDate}
                  onChange={(e) => setPaymentDate(e.target.value)}
                />
              </div>
            </div>
          </div>

          {/* Guest + Stay cards (read-only) */}
          <div className="grid grid-cols-2 gap-2 mt-3">
            <div className="border border-borderc rounded-sm bg-cream/40 p-2.5">
              <div className="text-[9px] uppercase tracking-wider text-textSecondary font-semibold">
                Guest
              </div>
              <div className="mt-1">
                <div className="font-semibold text-brand-dark">{data.guest.fullName}</div>
                <div className="font-mono text-[11px] mt-0.5">{data.guest.phone}</div>
                {data.guest.idProofType && data.guest.idProofLast4 && (
                  <div className="text-[10px] text-textSecondary mt-1 capitalize">
                    {data.guest.idProofType.replace("_", " ")} ····{data.guest.idProofLast4}
                  </div>
                )}
              </div>
            </div>
            <div className="border border-borderc rounded-sm bg-cream/40 p-2.5">
              <div className="text-[9px] uppercase tracking-wider text-textSecondary font-semibold">
                Stay
              </div>
              <div className="grid grid-cols-2 gap-2 mt-1">
                <div>
                  <div className="text-[9px] uppercase tracking-wider text-[#157f5f] font-bold">
                    Check-in
                  </div>
                  <div className="font-semibold text-brand-dark text-[12px] leading-tight">
                    {format(new Date(data.checkedInAt ?? data.checkInDate), "dd MMM yyyy")}
                  </div>
                  <div className="text-[10px] text-textSecondary leading-tight mt-0.5">
                    {data.checkedInAt
                      ? `at ${format(new Date(data.checkedInAt), "h:mm a")}`
                      : data.hotel.checkInTime
                        ? `from ${formatTime(data.hotel.checkInTime)}`
                        : ""}
                  </div>
                </div>
                <div>
                  <div className="text-[9px] uppercase tracking-wider text-[#157f5f] font-bold">
                    Check-out
                  </div>
                  <div className="font-semibold text-brand-dark text-[12px] leading-tight">
                    {format(new Date(data.checkOutDate), "dd MMM yyyy")}
                  </div>
                  {data.hotel.checkOutTime && (
                    <div className="text-[10px] text-textSecondary leading-tight mt-0.5">
                      by {formatTime(data.hotel.checkOutTime)}
                    </div>
                  )}
                </div>
              </div>
              <div className="text-[10px] text-textSecondary mt-1.5">
                {data.numNights} night{data.numNights === 1 ? "" : "s"} · {data.numAdults} adult
                {data.numAdults === 1 ? "" : "s"}
                {data.numChildren > 0 &&
                  `, ${data.numChildren} child${data.numChildren === 1 ? "" : "ren"}`}
              </div>
            </div>
          </div>

          {/* Rooms */}
          <div className="mt-4">
            <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-[#157f5f] mb-1.5">
              Rooms Allotted
            </div>
            <table className="w-full text-[11px]">
              <thead>
                <tr className="text-left text-brand-dark">
                  <th className="py-1.5 border-b border-brand/30 font-semibold">Room</th>
                  <th className="py-1.5 border-b border-brand/30 font-semibold">Type</th>
                  <th className="py-1.5 border-b border-brand/30 font-semibold text-right">
                    Rate/Night
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.rooms.map((rm) => (
                  <tr key={rm.roomNumber}>
                    <td className="py-1.5 border-b border-borderc font-mono font-bold">
                      {rm.roomNumber}
                    </td>
                    <td className="py-1.5 border-b border-borderc capitalize">
                      {rm.displayType ?? rm.roomType.replace(/_/g, " ")}
                    </td>
                    <td className="py-1.5 border-b border-borderc text-right font-mono">
                      {inr(rm.ratePerNight)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Amount banner with editable method + notes */}
          {data.latestPayment && (
            <div className="mt-4 p-3 rounded-md text-cream bg-brand-dark">
              <div className="text-[9px] tracking-[0.25em] uppercase text-brass font-bold text-center">
                {isAdvance ? "Advance Received" : "Amount Received"}
              </div>
              <div className="text-[24px] font-bold font-mono mt-0.5 text-center">
                {inr(data.latestPayment.amount)}
              </div>
              {data.latestPayment.receiptNumber && (
                <div className="text-[10px] mt-0.5 text-center opacity-80 font-mono">
                  {data.latestPayment.receiptNumber}
                </div>
              )}
              <div className="grid grid-cols-2 gap-2 mt-3 text-cream">
                <label className="block">
                  <div className="text-[9px] tracking-[0.15em] uppercase opacity-80 mb-1">
                    Payment Method
                  </div>
                  <select
                    className="w-full !text-[11px] !h-7 rounded-sm bg-cream text-brand-dark px-2"
                    value={method}
                    onChange={(e) => setMethod(e.target.value)}
                  >
                    {METHODS.map((m) => (
                      <option key={m} value={m}>
                        {m.replace("_", " ")}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <div className="text-[9px] tracking-[0.15em] uppercase opacity-80 mb-1">
                    Notes
                  </div>
                  <input
                    type="text"
                    className="w-full !text-[11px] !h-7 rounded-sm bg-cream text-brand-dark px-2"
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="e.g. Advance at booking"
                    maxLength={500}
                  />
                </label>
              </div>
            </div>
          )}

          {/* Totals */}
          <div className="mt-4 flex justify-end">
            <table className="w-full max-w-[18rem] text-[11px]">
              <tbody>
                <tr>
                  <td className="py-1 text-textSecondary">Subtotal ({data.numNights}n)</td>
                  <td className="py-1 text-right font-mono">{inr(data.subtotal)}</td>
                </tr>
                {showGst && (
                  <>
                    <tr>
                      <td className="py-1 text-textSecondary">CGST @ {halfRate}%</td>
                      <td className="py-1 text-right font-mono">{inr(half)}</td>
                    </tr>
                    <tr>
                      <td className="py-1 text-textSecondary">SGST @ {halfRate}%</td>
                      <td className="py-1 text-right font-mono">{inr(gstAmt - half)}</td>
                    </tr>
                  </>
                )}
                <tr className="border-t border-brand/30">
                  <td className="py-1.5 pt-2 font-bold text-brand-dark">Grand Total</td>
                  <td className="py-1.5 pt-2 text-right font-mono font-bold text-brand-dark">
                    {inr(data.grandTotal)}
                  </td>
                </tr>
                <tr>
                  <td className="py-1 text-success">Paid</td>
                  <td className="py-1 text-right font-mono text-success">{inr(data.advancePaid)}</td>
                </tr>
                <tr>
                  <td className="py-1 font-bold text-danger">Balance Due</td>
                  <td className="py-1 text-right font-mono font-bold text-danger">
                    {inr(data.balanceDue)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <div className="mt-4 pt-3 border-t border-borderc text-[10px] text-textSecondary leading-relaxed">
            Amount and receipt number are locked for audit integrity. To change the amount, void
            this payment and record a new one.
          </div>

          {error && (
            <div className="mt-3 p-2 rounded-sm bg-danger/10 text-danger text-[11px]">{error}</div>
          )}
        </div>

        <div className="no-print flex justify-end gap-2 px-5 py-3 border-t border-borderc bg-bg">
          <button onClick={onClose} className="btn-secondary">
            Cancel
          </button>
          <button onClick={print} className="btn-secondary inline-flex items-center gap-2">
            <Printer className="w-4 h-4" /> Print
          </button>
          <button
            onClick={() => save.mutate()}
            disabled={!dirty || save.isPending}
            className="btn-primary"
          >
            {save.isPending ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
