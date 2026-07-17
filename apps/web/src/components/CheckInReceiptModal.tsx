import { format } from "date-fns";
import { Printer, X } from "lucide-react";
import { Fragment, useEffect } from "react";
import { authHeader } from "@/lib/api";
import { formatTime, inr } from "@/lib/utils";

function formatGender(g: string | null | undefined): string {
  if (!g) return "";
  if (g === "prefer_not_to_say") return "Prefer not to say";
  return g.charAt(0).toUpperCase() + g.slice(1);
}

export interface CheckInReceiptData {
  reservationId?: string;
  reservationNumber: string;
  // Drives whether the "balance due before check-in" note is shown.
  // Only meaningful for `phone_whatsapp` (pre-booking, guest not yet
  // on premises). Walk-ins are already at the desk; complimentary
  // bookings don't carry a balance.
  bookingSource?: "walkin" | "phone_whatsapp" | "complimentary";
  checkInDate: string;
  checkOutDate: string;
  checkedInAt?: string | null;
  // 0023 — staff-chosen planned arrival / departure times. Surface on
  // the receipt when present so the printed slip matches what staff
  // promised the guest. Fall through to hotel policy when null.
  plannedCheckInAt?: string | null;
  plannedCheckOutAt?: string | null;
  numNights: number;
  // Day-use bookings hold hours, not nights. When set, the receipt shows
  // "Day use · N hours" instead of "N night(s)" everywhere.
  stayType?: "overnight" | "short_stay";
  durationHours?: number | null;
  numAdults: number;
  numChildren: number;
  guest: {
    fullName: string;
    phone: string;
    gender?: string | null;
    idProofType?: string | null;
    idProofLast4?: string | null;
    gstin?: string | null;
    photoUrl?: string | null;
  };
  // Migration 0020 — additional adults whose KYC was captured at booking.
  // Rendered as a small "Also occupying" block under the Guest card so
  // the on-screen modal matches the printed receipt.
  coGuests?: {
    fullName: string;
    phone: string;
    gender?: string | null;
    idProofType?: string | null;
    idProofLast4?: string | null;
  }[];
  rooms: {
    roomNumber: string;
    roomType: string;
    soldAsType?: string | null;
    // Pre-rendered label from the API (e.g. "Ac Single Bed Rooms" or
    // "Ac Single Bed Rooms booked as Non Ac Bed Rooms"). When absent
    // (older payloads), we fall back to the raw roomType.
    displayType?: string;
    ratePerNight: string;
    // Extra beds (additional persons) on this room, when any (0043).
    extraBeds?: number;
    extraBedRate?: string;
  }[];
  subtotal: string;
  gstRate: string;
  gstAmount: string;
  grandTotal: string;
  advancePaid: string;
  balanceDue: string;
  latestPayment?: {
    // Optional — when set, the Print button hits the server's PDF
    // endpoint so the printed output is pixel-identical to the
    // server-rendered receipt the guest may get via WhatsApp. When
    // missing, falls back to window.print() on the modal HTML.
    id?: string;
    amount: string;
    paymentMethod: string;
    receiptNumber: string | null;
    paymentDate: string;
  } | null;
  // All non-voided payments for the reservation, oldest first or any
  // order. Used to split the totals' "Paid" line into Advance
  // (at/before checkedInAt) and Later. When absent, the modal renders a
  // single "Paid" line using advancePaid for backward compatibility.
  allPayments?: {
    amount: string;
    paymentDate: string;
    voided?: boolean;
    status?: string;
  }[];
  hotel: {
    name: string;
    address: string;
    phone: string;
    ownerPhone?: string | null;
    gstin: string;
    logoUrl?: string | null;
    checkInTime?: string | null;
    checkOutTime?: string | null;
  };
}

interface Props {
  data: CheckInReceiptData;
  onClose: () => void;
  // "checkin" (default) renders the walk-in check-in receipt.
  // "booking_advance" renders the same layout but with "Booking Advance Receipt"
  // labels for pre-bookings where money was collected at booking time.
  variant?: "checkin" | "booking_advance";
}

export function CheckInReceiptModal({ data, onClose, variant = "checkin" }: Props) {
  const isAdvance = variant === "booking_advance";
  const title = isAdvance ? "Booking Advance Receipt" : "Check-in Receipt";
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    // Lock background scroll while the modal is open so only the modal's own
    // scrollbar is visible.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  // When the payment id is known, fetch the server-rendered PDF (same one
  // available via the Download/Preview pages) and trigger the browser's
  // print dialog on it. That guarantees pixel-perfect parity with the
  // version a guest gets via WhatsApp — no CSS gymnastics, no extra
  // blank pages, no browser-injected URL footers, because the source is
  // a real PDF, not HTML.
  //
  // Falls back to window.print() on the modal HTML when:
  //   - paymentId is missing (rare, payment row not yet attached)
  //   - the fetch fails
  async function print() {
    const paymentId = data.latestPayment?.id;
    if (!paymentId) {
      window.print();
      return;
    }
    try {
      // Offline-aware token (local JWT on the desktop, Supabase online). A
      // direct supabase.auth.getSession() has no session offline, which made
      // this always fall back to window.print() in the desktop app.
      const headers = await authHeader();
      if (!("Authorization" in headers)) throw new Error("Not signed in");
      const base = (import.meta.env.VITE_API_URL as string).replace(/\/+$/, "");
      const res = await fetch(`${base}/payments/${paymentId}/receipt?disposition=inline`, {
        headers,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const objUrl = URL.createObjectURL(blob);
      // Hidden iframe — load the PDF, then ask its window to print.
      // Removed from DOM + URL revoked after a delay so the print dialog
      // has time to open against the live object URL.
      const iframe = document.createElement("iframe");
      iframe.style.position = "fixed";
      iframe.style.right = "0";
      iframe.style.bottom = "0";
      iframe.style.width = "0";
      iframe.style.height = "0";
      iframe.style.border = "0";
      iframe.src = objUrl;
      iframe.onload = () => {
        try {
          iframe.contentWindow?.focus();
          iframe.contentWindow?.print();
        } catch {
          /* some browsers throw on print(); user can use the inline PDF's
             own print button if so */
        }
      };
      document.body.appendChild(iframe);
      // Best-effort cleanup. 60s is generous — most print dialogs are
      // dismissed within a couple of seconds, but we don't want to yank
      // the iframe while the dialog is still up.
      window.setTimeout(() => {
        URL.revokeObjectURL(objUrl);
        iframe.remove();
      }, 60_000);
    } catch {
      // Server PDF fetch failed — fall back to the legacy modal print
      // so staff still gets something usable.
      window.print();
    }
  }

  return (
    <div className="print-portal fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-brand-dark/40 p-4 print:bg-white print:p-0 print:static print:overflow-visible print:block">
      <style>{`
        @media print {
          /* Zero @page margin so Chrome's auto-generated headers (date,
             page title) and footers (URL, page count) have no margin
             strip to render into. We then provide visual margin inside
             the receipt via padding so the content still breathes. */
          @page {
            size: A4 portrait;
            margin: 0;
          }
          html, body {
            margin: 0 !important;
            padding: 0 !important;
            background: #fff !important;
            height: auto !important;
            min-height: 0 !important;
            overflow: hidden !important;
          }
          /* True single-page print strategy: hide every element on the
             page EXCEPT the receipt and its ancestor chain. We use
             :has() (Chrome 105+) so the chain from body down to
             .checkin-receipt stays in layout while every sibling is
             removed. visibility:hidden is not enough -- hidden elements
             still reserve height and paginate into blank pages.
             display:none removes the layout box entirely. */
          body *:not(:has(.checkin-receipt)):not(.checkin-receipt):not(.checkin-receipt *) {
            display: none !important;
          }

          /* Collapse modal wrapper so it doesn't reserve page space */
          .print-portal {
            position: static !important;
            display: block !important;
            inset: auto !important;
            padding: 0 !important;
            margin: 0 !important;
            background: transparent !important;
            height: auto !important;
            min-height: 0 !important;
            overflow: hidden !important;
          }

          /* Pull receipt to the page origin. Hard-cap dimensions at A4
             and use border-box so the internal padding is included in the
             width — otherwise width (210mm) + padding (24mm) = 234mm and
             Chrome shoves overflow onto extra pages. */
          .checkin-receipt {
            box-sizing: border-box !important;
            position: absolute !important;
            top: 0 !important;
            left: 0 !important;
            right: 0 !important;
            width: 210mm !important;
            max-width: 210mm !important;
            min-height: 0 !important;
            height: 296mm !important;
            max-height: 296mm !important;
            margin: 0 !important;
            padding: 12mm !important;
            box-shadow: none !important;
            border: none !important;
            border-radius: 0 !important;
            background: #fff !important;
            overflow: hidden !important;
            page-break-after: avoid !important;
            page-break-inside: avoid !important;
            break-after: avoid !important;
            break-inside: avoid !important;
          }
          /* Also box-size every descendant inside the receipt so child
             paddings don't cause horizontal overflow either. */
          .checkin-receipt * {
            box-sizing: border-box !important;
          }
          /* Keep brand backgrounds (dark Amount Received panel, brass
             accents) in the fallback window.print() path — Chrome strips
             background colors by default unless the user ticks
             "Background graphics". The server-PDF path is unaffected. */
          .checkin-receipt, .checkin-receipt * {
            -webkit-print-color-adjust: exact !important;
            print-color-adjust: exact !important;
          }
          .checkin-receipt > .receipt-body {
            padding: 0 !important;
            font-size: 10.5px !important;
            line-height: 1.35 !important;
          }
          /* Trim large vertical spacings */
          .receipt-body .mt-6 { margin-top: 16px !important; }
          .receipt-body .mt-5 { margin-top: 12px !important; }
          .receipt-body .mt-4 { margin-top: 10px !important; }
          .receipt-body .mt-3 { margin-top: 8px !important; }
          .receipt-body .pt-3 { padding-top: 8px !important; }
          .receipt-body .py-3 { padding-top: 6px !important; padding-bottom: 6px !important; }
          .receipt-body .py-2\\.5 { padding-top: 4px !important; padding-bottom: 4px !important; }
          .receipt-body .p-2\\.5 { padding: 6px !important; }
          .receipt-body .p-3 { padding: 8px !important; }
          .receipt-body .p-4 { padding: 10px !important; }
          .receipt-body .p-6 { padding: 0 !important; }

          .no-print, .no-print * { display: none !important; }
          .receipt-body table { page-break-inside: avoid; break-inside: avoid; }
          .receipt-body .receipt-section { page-break-inside: avoid; break-inside: avoid; }
        }
        /* Watermark layering (print only): section content must paint
           above the faint watermark layer. Kept for the print layer
           below; on-screen has no watermark. */
        .receipt-body .receipt-section { position: relative; z-index: 1; }
        .receipt-body > div:not(.receipt-section) { position: relative; z-index: 1; }
      `}</style>

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

        <div className="receipt-body relative px-5 py-4 text-[12px] text-textPrimary">
          {/* Watermark is print-only. The on-screen modal is busy enough
              with chrome (header bar, scroll, action buttons); the faint
              logo behind text added more noise than identity. The printed
              PDF/page still gets the watermark via the print layer below. */}
          {data.hotel.logoUrl && (
            <div
              aria-hidden
              className="absolute inset-0 pointer-events-none hidden print:flex items-center justify-center overflow-hidden"
              style={{ zIndex: 0 }}
            >
              <img
                src={data.hotel.logoUrl}
                alt=""
                style={{ width: "200px", height: "200px", opacity: 0.05 }}
                className="object-contain"
              />
            </div>
          )}
          <div className="receipt-section relative z-10 flex items-start justify-between gap-3 pb-3 border-b-2 border-brand">
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
              <div className="text-[10px] text-textSecondary">
                {format(new Date(), "dd MMM yyyy · HH:mm")}
              </div>
              {data.latestPayment?.receiptNumber && (
                <div className="text-[11px] font-mono text-brand-dark/80 mt-0.5">
                  {data.latestPayment.receiptNumber}
                </div>
              )}
              <div className="text-[9px] uppercase tracking-[0.18em] text-textSecondary font-semibold mt-0.5">
                {title}
              </div>
            </div>
          </div>

          <div className="receipt-section grid grid-cols-2 gap-2 mt-3">
            <div className="border border-borderc rounded-sm bg-cream/40 p-2.5">
              <div className="text-[9px] uppercase tracking-wider text-textSecondary font-semibold">
                Guest
              </div>
              <div className="mt-1 flex items-start gap-2">
                {data.guest.photoUrl && (
                  <img
                    src={data.guest.photoUrl}
                    alt=""
                    className="w-12 h-14 object-cover rounded-sm border border-borderc shrink-0"
                  />
                )}
                <div className="min-w-0">
                  <div className="font-semibold text-brand-dark">{data.guest.fullName}</div>
                  <div className="font-mono text-[11px] mt-0.5">{data.guest.phone}</div>
                  {(data.guest.idProofType || data.guest.gender) && (
                    <div className="text-[10px] text-textSecondary mt-1 capitalize">
                      {data.guest.idProofType && data.guest.idProofLast4 && (
                        <>
                          {data.guest.idProofType.replace("_", " ")} ····{data.guest.idProofLast4}
                        </>
                      )}
                      {data.guest.idProofType && data.guest.gender && " · "}
                      {data.guest.gender && formatGender(data.guest.gender)}
                    </div>
                  )}
                  {data.guest.gstin && (
                    <div className="text-[10px] text-textSecondary font-mono mt-1">
                      GSTIN: {data.guest.gstin}
                    </div>
                  )}
                </div>
              </div>
              {data.coGuests && data.coGuests.length > 0 && (
                <div className="mt-2 pt-2 border-t border-borderc/60 space-y-1">
                  <div className="text-[9px] uppercase tracking-wider text-textSecondary font-semibold">
                    Also occupying
                  </div>
                  {data.coGuests.map((cg, i) => (
                    <div key={i} className="text-[10px] text-textSecondary leading-tight">
                      <span className="text-brand-dark font-semibold">{cg.fullName}</span>
                      <span className="font-mono"> · {cg.phone}</span>
                      {cg.idProofType && cg.idProofLast4 && (
                        <span className="capitalize">
                          {" "}· {cg.idProofType.replace("_", " ")} ····{cg.idProofLast4}
                        </span>
                      )}
                      {cg.gender && <span> · {formatGender(cg.gender)}</span>}
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="border border-borderc rounded-sm bg-cream/40 p-2.5">
              <div className="text-[9px] uppercase tracking-wider text-textSecondary font-semibold">
                Stay
              </div>
              <div className="grid grid-cols-2 gap-2 mt-1">
                <div>
                  <div className="text-[9px] uppercase tracking-wider text-[#157f5f] font-bold">Check-in</div>
                  <div className="font-semibold text-brand-dark text-[12px] leading-tight">
                    {format(
                      new Date(
                        data.checkedInAt ??
                          data.plannedCheckInAt ??
                          data.checkInDate,
                      ),
                      "dd MMM yyyy",
                    )}
                  </div>
                  <div className="text-[10px] text-textSecondary leading-tight mt-0.5">
                    {/* Priority (0023): actual checked-in stamp > staff-
                        chosen planned time > hotel policy default. */}
                    {data.checkedInAt
                      ? `at ${format(new Date(data.checkedInAt), "h:mm a")}`
                      : data.plannedCheckInAt
                        ? `at ${format(new Date(data.plannedCheckInAt), "h:mm a")}`
                        : data.hotel.checkInTime
                          ? `from ${formatTime(data.hotel.checkInTime)}`
                          : ""}
                  </div>
                </div>
                <div>
                  <div className="text-[9px] uppercase tracking-wider text-[#157f5f] font-bold">Check-out</div>
                  {(() => {
                    // Day-use bookings exit at checkedInAt + durationHours,
                    // not at the hotel's overnight check-out time.
                    const isShort = data.stayType === "short_stay";
                    const dur = Number(data.durationHours ?? 0);
                    const shortOut = isShort && data.checkedInAt && dur > 0
                      ? new Date(new Date(data.checkedInAt).getTime() + Math.round(dur * 3600 * 1000))
                      : null;
                    // Priority (0023): short-stay computed > staff-chosen
                    // planned time > hotel policy.
                    const outDate =
                      shortOut ??
                      (data.plannedCheckOutAt
                        ? new Date(data.plannedCheckOutAt)
                        : new Date(data.checkOutDate));
                    return (
                      <>
                        <div className="font-semibold text-brand-dark text-[12px] leading-tight">
                          {format(outDate, "dd MMM yyyy")}
                        </div>
                        {shortOut ? (
                          <div className="text-[10px] text-textSecondary leading-tight mt-0.5">
                            by {format(shortOut, "h:mm a")}
                          </div>
                        ) : data.plannedCheckOutAt ? (
                          <div className="text-[10px] text-textSecondary leading-tight mt-0.5">
                            by {format(new Date(data.plannedCheckOutAt), "h:mm a")}
                          </div>
                        ) : data.hotel.checkOutTime ? (
                          <div className="text-[10px] text-textSecondary leading-tight mt-0.5">
                            by {formatTime(data.hotel.checkOutTime)}
                          </div>
                        ) : null}
                      </>
                    );
                  })()}
                </div>
              </div>
              <div className="text-[10px] text-textSecondary mt-1.5">
                {data.stayType === "short_stay"
                  ? `Day use · ${Number(data.durationHours ?? 0)} hour${Number(data.durationHours ?? 0) === 1 ? "" : "s"}`
                  : `${data.numNights} night${data.numNights === 1 ? "" : "s"}`}{" "}
                · {data.numAdults} adult{data.numAdults === 1 ? "" : "s"}
                {data.numChildren > 0 && `, ${data.numChildren} child${data.numChildren === 1 ? "" : "ren"}`}
              </div>
            </div>
          </div>

          <div className="receipt-section mt-4">
            <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-[#157f5f] mb-1.5">
              Rooms Allotted
            </div>
            <table className="w-full text-[11px]">
              <thead>
                <tr className="text-left text-brand-dark">
                  <th className="py-1.5 border-b border-brand/30 font-semibold">Room</th>
                  <th className="py-1.5 border-b border-brand/30 font-semibold">Type</th>
                  <th className="py-1.5 border-b border-brand/30 font-semibold text-right">
                    {data.stayType === "short_stay"
                      ? `Rate / ${Number(data.durationHours ?? 0)} hrs`
                      : "Rate/Night"}
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.rooms.map((rm) => (
                  <Fragment key={rm.roomNumber}>
                    <tr>
                      <td className="py-1.5 border-b border-borderc font-mono font-bold">{rm.roomNumber}</td>
                      <td className="py-1.5 border-b border-borderc capitalize">
                        {rm.displayType ?? rm.roomType.replace(/_/g, " ")}
                      </td>
                      <td className="py-1.5 border-b border-borderc text-right font-mono">
                        {inr(rm.ratePerNight)}
                      </td>
                    </tr>
                    {Number(rm.extraBeds ?? 0) > 0 && Number(rm.extraBedRate ?? 0) > 0 && (
                      <tr>
                        <td className="py-1.5 border-b border-borderc"></td>
                        <td className="py-1.5 border-b border-borderc text-textSecondary">
                          + Extra bed × {rm.extraBeds}
                        </td>
                        <td className="py-1.5 border-b border-borderc text-right font-mono text-textSecondary">
                          {inr(rm.extraBedRate!)}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>

          {data.latestPayment && (
            <div className="mt-4 p-3 rounded-md text-cream text-center bg-brand-dark">
              <div className="text-[9px] tracking-[0.25em] uppercase text-brass font-bold">
                {isAdvance ? "Advance Received" : "Amount Received"}
              </div>
              <div className="text-[24px] font-bold font-mono mt-0.5">
                {inr(data.latestPayment.amount)}
              </div>
              <div className="text-[10px] mt-0.5 capitalize opacity-90">
                via {data.latestPayment.paymentMethod.replace(/_/g, " ")}
                {" · "}
                {isAdvance ? "Advance At Booking" : "At Check-in"}
              </div>
            </div>
          )}

          <div className="mt-4 flex justify-end">
            <table className="w-full max-w-[18rem] text-[11px]">
              <tbody>
                <tr>
                  <td className="py-1 text-textSecondary">
                    Subtotal (
                    {data.stayType === "short_stay"
                      ? `${Number(data.durationHours ?? 0)} hrs`
                      : `${data.numNights}n`}
                    )
                  </td>
                  <td className="py-1 text-right font-mono">{inr(data.subtotal)}</td>
                </tr>
                {(() => {
                  const gstRate = Number(data.gstRate);
                  const gstAmt = Number(data.gstAmount);
                  if (!gstRate || !gstAmt) return null;
                  const half = +(gstAmt / 2).toFixed(2);
                  const halfRate = +(gstRate / 2).toFixed(2);
                  return (
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
                  );
                })()}
                <tr className="border-t border-brand/30">
                  <td className="py-1.5 pt-2 font-bold text-brand-dark">Grand Total</td>
                  <td className="py-1.5 pt-2 text-right font-mono font-bold text-brand-dark">
                    {inr(data.grandTotal)}
                  </td>
                </tr>
                {(() => {
                  // Split paid into Advance + Later when both exist.
                  // Fallback: single "Paid" line using advancePaid.
                  const ts = data.checkedInAt ? new Date(data.checkedInAt).getTime() : null;
                  const list = data.allPayments ?? [];
                  let advance = 0;
                  let later = 0;
                  for (const p of list) {
                    if (p.voided) continue;
                    if (p.status && p.status !== "received") continue;
                    const t = new Date(p.paymentDate).getTime();
                    if (ts !== null && t > ts) later += Number(p.amount);
                    else advance += Number(p.amount);
                  }
                  advance = +advance.toFixed(2);
                  later = +later.toFixed(2);
                  const totalPaid = +(advance + later).toFixed(2);
                  if (advance > 0.009 && later > 0.009) {
                    return (
                      <>
                        <tr>
                          <td className="py-1 text-success">Advance Paid (at check-in)</td>
                          <td className="py-1 text-right font-mono text-success">{inr(advance)}</td>
                        </tr>
                        <tr>
                          <td className="py-1 text-success">Later Payments</td>
                          <td className="py-1 text-right font-mono text-success">{inr(later)}</td>
                        </tr>
                        <tr>
                          <td className="py-1 text-success font-semibold">Total Paid</td>
                          <td className="py-1 text-right font-mono text-success font-semibold">
                            {inr(totalPaid)}
                          </td>
                        </tr>
                      </>
                    );
                  }
                  return (
                    <tr>
                      <td className="py-1 text-success">Paid</td>
                      <td className="py-1 text-right font-mono text-success">
                        {inr(data.advancePaid)}
                      </td>
                    </tr>
                  );
                })()}
                <tr>
                  <td className="py-1 font-bold text-danger">Balance Due</td>
                  <td className="py-1 text-right font-mono font-bold text-danger">
                    {inr(data.balanceDue)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <div className="mt-5 pt-3 border-t border-borderc text-[10px] text-textSecondary leading-relaxed">
            {(() => {
              const isShort = data.stayType === "short_stay";
              const dur = Number(data.durationHours ?? 0);
              const shortOut = isShort && data.checkedInAt && dur > 0
                ? new Date(new Date(data.checkedInAt).getTime() + Math.round(dur * 3600 * 1000))
                : null;
              const byLabel = shortOut
                ? ` (by ${format(shortOut, "h:mm a")})`
                : data.hotel.checkOutTime
                  ? ` (by ${formatTime(data.hotel.checkOutTime)})`
                  : "";
              return `Welcome to ${data.hotel.name}. Please retain this slip for reference. Final invoice will be issued at check-out${byLabel}. For any assistance, contact the front desk.`;
            })()}
          </div>

          {/* Booking-advance reminder: only shown for pre-bookings
              (phone/WhatsApp) where the guest hasn't arrived yet and
              needs the reminder. Walk-ins are already at the desk
              checking in — telling them to "pay before check-in"
              makes no sense. Complimentary never has a balance. */}
          {isAdvance &&
            Number(data.balanceDue) > 0.009 &&
            data.bookingSource === "phone_whatsapp" && (
              <div className="receipt-section mt-3 px-3 py-2 rounded-sm border border-[#B45309] bg-[#fef3c7] text-[#7C2D12] text-center text-[11px] font-semibold">
                Note: The remaining balance of {inr(data.balanceDue)} must be paid on or before check-in.
              </div>
            )}

          <div className="receipt-section mt-6 flex justify-between gap-3">
            <div className="text-[10px] text-textSecondary">
              <div className="mt-6 inline-block min-w-[120px] pt-1 border-t border-textSecondary/40">
                Guest Signature
              </div>
            </div>
            <div className="text-[10px] text-textSecondary text-right">
              <div className="mt-6 inline-block min-w-[120px] pt-1 border-t border-textSecondary/40">
                Authorised Signatory
              </div>
            </div>
          </div>
        </div>

        <div className="no-print flex justify-end gap-2 px-5 py-3 border-t border-borderc bg-bg">
          <button onClick={onClose} className="btn-secondary">
            Done
          </button>
          <button onClick={print} className="btn-primary inline-flex items-center gap-2">
            <Printer className="w-4 h-4" /> Print
          </button>
        </div>
      </div>
    </div>
  );
}
