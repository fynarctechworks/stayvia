import { useMutation, useQuery } from "@tanstack/react-query";
import { Plus, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ApiError, api } from "@/lib/api";
import { inr } from "@/lib/utils";

interface InvoiceFull {
  id: string;
  invoiceNumber: string;
  status: string;
  guestName: string;
  guestAddress: string | null;
  guestGstin: string | null;
  notes: string | null;
  issueDate: string | null;
  checkInDate: string | null;
  checkOutDate: string | null;
  numNights: number | null;
  subtotal: string;
  cgstAmount: string;
  sgstAmount: string;
  grandTotal: string;
  totalPaid: string;
  walletCreditApplied: string;
  balanceDue: string;
  lineItems: {
    id: string;
    description: string;
    sacCode: string;
    quantity: number;
    rate: string;
    amount: string;
    gstRate: string;
    gstAmount: string;
    itemType: "room_charge" | "additional_charge";
  }[];
}

interface DraftLine {
  description: string;
  sacCode: string;
  quantity: number;
  rate: number;
  gstRate: number;
  itemType: "room_charge" | "additional_charge";
}

interface Props {
  invoiceId: string;
  onClose: () => void;
  onSaved: () => void;
}

// Direct in-place editor for an issued invoice. Mirrors the receipt-edit
// pattern. The server keeps a full audit-log entry (action:"invoice_edited")
// with before/after snapshots so the original state is recoverable for
// compliance review even though no new invoice number is generated.
export function EditInvoiceModal({ invoiceId, onClose, onSaved }: Props) {
  const { data, isLoading, error: loadErr } = useQuery({
    queryKey: ["invoice-full", invoiceId],
    queryFn: () => api.get<InvoiceFull>(`/invoices/${invoiceId}`),
  });

  // Form state — populated once data lands.
  const [guestName, setGuestName] = useState("");
  const [guestAddress, setGuestAddress] = useState("");
  const [guestGstin, setGuestGstin] = useState("");
  const [issueDate, setIssueDate] = useState("");
  const [checkInDate, setCheckInDate] = useState("");
  const [checkOutDate, setCheckOutDate] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!data) return;
    setGuestName(data.guestName);
    setGuestAddress(data.guestAddress ?? "");
    setGuestGstin(data.guestGstin ?? "");
    setIssueDate(data.issueDate ?? "");
    setCheckInDate(data.checkInDate ?? "");
    setCheckOutDate(data.checkOutDate ?? "");
    setNotes(data.notes ?? "");
    setLines(
      data.lineItems.map((li) => ({
        description: li.description,
        sacCode: li.sacCode,
        quantity: li.quantity,
        rate: Number(li.rate),
        gstRate: Number(li.gstRate),
        itemType: li.itemType,
      })),
    );
  }, [data]);

  // Nights count derived from the in-form check-in/out dates so staff can
  // see the impact of a date edit before saving.
  const nights = useMemo(() => {
    if (!checkInDate || !checkOutDate) return null;
    const ms = new Date(checkOutDate + "T00:00:00").getTime() - new Date(checkInDate + "T00:00:00").getTime();
    return Math.max(0, Math.round(ms / 86400000));
  }, [checkInDate, checkOutDate]);
  const datesInvalid = !!checkInDate && !!checkOutDate && checkInDate >= checkOutDate;

  // Esc closes + body lock — same pattern as other modals
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

  // Recompute totals client-side as the staff edits, so they can preview
  // the impact before saving. The server recomputes authoritative values
  // on save anyway.
  const computed = useMemo(() => {
    let subtotal = 0;
    let totalGst = 0;
    for (const l of lines) {
      const amount = +(l.rate * l.quantity).toFixed(2);
      const gst = +(amount * (l.gstRate / 100)).toFixed(2);
      subtotal += amount;
      totalGst += gst;
    }
    const grandTotal = +(subtotal + totalGst).toFixed(2);
    return {
      subtotal: +subtotal.toFixed(2),
      cgst: +(totalGst / 2).toFixed(2),
      sgst: +(totalGst / 2).toFixed(2),
      grandTotal,
    };
  }, [lines]);

  const newBalance = data
    ? +(computed.grandTotal - Number(data.totalPaid) - Number(data.walletCreditApplied)).toFixed(2)
    : 0;

  const save = useMutation({
    mutationFn: () =>
      api.patch(`/invoices/${invoiceId}`, {
        guestName: guestName.trim(),
        guestAddress: guestAddress.trim() === "" ? null : guestAddress,
        guestGstin: guestGstin.trim() === "" ? null : guestGstin.toUpperCase(),
        issueDate: issueDate || undefined,
        checkInDate: checkInDate || undefined,
        checkOutDate: checkOutDate || undefined,
        notes: notes.trim() === "" ? null : notes,
        lineItems: lines.map((l) => ({
          description: l.description,
          sacCode: l.sacCode || "9963",
          quantity: l.quantity,
          rate: l.rate,
          gstRate: l.gstRate,
          itemType: l.itemType,
        })),
      }),
    onSuccess: () => {
      onSaved();
      onClose();
    },
    onError: (e: unknown) => {
      setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : "Save failed");
    },
  });

  function updateLine(idx: number, patch: Partial<DraftLine>) {
    setLines((rows) => rows.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  }
  function removeLine(idx: number) {
    setLines((rows) => rows.filter((_, i) => i !== idx));
  }
  function addLine() {
    setLines((rows) => [
      ...rows,
      {
        description: "",
        sacCode: "9963",
        quantity: 1,
        rate: 0,
        gstRate: rows.length > 0 ? rows[0]!.gstRate : 12,
        itemType: "additional_charge",
      },
    ]);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-brand-dark/40 p-4"
      onClick={onClose}
    >
      <div
        className="my-auto w-full max-w-3xl bg-white rounded-md shadow-xl border border-borderc"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-borderc bg-brand-soft">
          <div>
            <div className="font-semibold text-brand-dark">Edit Invoice</div>
            {data && (
              <div className="text-xs text-textSecondary font-mono">{data.invoiceNumber}</div>
            )}
          </div>
          <button
            onClick={onClose}
            className="text-textSecondary hover:text-textPrimary"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4 max-h-[75vh] overflow-y-auto">
          {isLoading && <div className="text-sm text-textSecondary">Loading invoice…</div>}
          {loadErr && (
            <div className="p-2 rounded-sm bg-danger/10 text-danger text-sm">
              {loadErr instanceof Error ? loadErr.message : "Failed to load"}
            </div>
          )}

          {data && (
            <>
              {/* Guest details (printed on the bill) */}
              <section>
                <div className="text-xs uppercase tracking-[0.12em] text-textSecondary font-semibold mb-2">
                  Billed to
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="label block mb-1">Name on bill</label>
                    <input
                      className="input"
                      value={guestName}
                      onChange={(e) => setGuestName(e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="label block mb-1">GSTIN (optional)</label>
                    <input
                      className="input font-mono"
                      value={guestGstin}
                      onChange={(e) => setGuestGstin(e.target.value.toUpperCase())}
                      placeholder="37AAAAA0000A1Z5"
                    />
                  </div>
                </div>
                <div className="mt-2">
                  <label className="label block mb-1">Address (optional)</label>
                  <input
                    className="input"
                    value={guestAddress}
                    onChange={(e) => setGuestAddress(e.target.value)}
                  />
                </div>
              </section>

              {/* Dates: stay window + issue date */}
              <section>
                <div className="text-xs uppercase tracking-[0.12em] text-textSecondary font-semibold mb-2 flex items-center justify-between">
                  <span>Stay & invoice dates</span>
                  {nights !== null && !datesInvalid && (
                    <span className="text-[10px] font-normal text-textSecondary normal-case tracking-normal">
                      {nights} night{nights === 1 ? "" : "s"}
                    </span>
                  )}
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <label className="label block mb-1">Check-in</label>
                    <input
                      className="input"
                      type="date"
                      value={checkInDate}
                      max={checkOutDate || undefined}
                      onChange={(e) => setCheckInDate(e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="label block mb-1">Check-out</label>
                    <input
                      className="input"
                      type="date"
                      value={checkOutDate}
                      min={checkInDate || undefined}
                      onChange={(e) => setCheckOutDate(e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="label block mb-1">Issue date</label>
                    <input
                      className="input"
                      type="date"
                      value={issueDate}
                      onChange={(e) => setIssueDate(e.target.value)}
                    />
                  </div>
                </div>
                {datesInvalid && (
                  <div className="text-[11px] text-danger mt-1">
                    Check-out must be after check-in.
                  </div>
                )}
              </section>

              {/* Line items */}
              <section>
                <div className="flex items-center justify-between mb-2">
                  <div className="text-xs uppercase tracking-[0.12em] text-textSecondary font-semibold">
                    Line items
                  </div>
                  <button
                    type="button"
                    onClick={addLine}
                    className="inline-flex items-center gap-1 px-2 h-7 text-xs font-semibold rounded-sm border border-borderc hover:border-brand hover:text-brand"
                  >
                    <Plus className="w-3 h-3" /> Add line
                  </button>
                </div>
                <div className="border border-borderc rounded-sm overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-bg">
                      <tr className="text-[10px] uppercase tracking-[0.12em] text-textSecondary">
                        <th className="text-left px-2 py-2">Description</th>
                        <th className="text-left px-2 py-2 w-20">SAC</th>
                        <th className="text-right px-2 py-2 w-14">Qty</th>
                        <th className="text-right px-2 py-2 w-28">Rate</th>
                        <th className="text-right px-2 py-2 w-20">GST %</th>
                        <th className="text-right px-2 py-2 w-28">Amount</th>
                        <th className="w-8"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {lines.length === 0 && (
                        <tr>
                          <td
                            colSpan={7}
                            className="px-2 py-4 text-center text-textSecondary text-xs"
                          >
                            No line items. Click "Add line" to start.
                          </td>
                        </tr>
                      )}
                      {lines.map((l, idx) => {
                        const amount = +(l.rate * l.quantity).toFixed(2);
                        return (
                          <tr key={idx} className="border-t border-borderc">
                            <td className="px-2 py-1.5">
                              <input
                                className="input !h-8 !py-0 text-sm"
                                value={l.description}
                                onChange={(e) =>
                                  updateLine(idx, { description: e.target.value })
                                }
                              />
                            </td>
                            <td className="px-2 py-1.5">
                              <input
                                className="input !h-8 !py-0 text-sm font-mono"
                                value={l.sacCode}
                                onChange={(e) => updateLine(idx, { sacCode: e.target.value })}
                              />
                            </td>
                            <td className="px-2 py-1.5">
                              <input
                                className="input !h-8 !py-0 text-sm text-right tabular-nums"
                                type="number"
                                min={1}
                                value={l.quantity === 0 ? "" : l.quantity}
                                onChange={(e) => {
                                  const v = e.target.value;
                                  updateLine(idx, {
                                    quantity: v === "" ? 0 : Math.floor(Number(v)),
                                  });
                                }}
                                onBlur={() => {
                                  if (l.quantity < 1) updateLine(idx, { quantity: 1 });
                                }}
                              />
                            </td>
                            <td className="px-2 py-1.5">
                              <input
                                className="input !h-8 !py-0 text-sm text-right tabular-nums font-mono"
                                type="number"
                                min={0}
                                step="0.01"
                                value={l.rate === 0 ? "" : l.rate}
                                onChange={(e) => {
                                  const v = e.target.value;
                                  updateLine(idx, { rate: v === "" ? 0 : Number(v) });
                                }}
                              />
                            </td>
                            <td className="px-2 py-1.5">
                              <input
                                className="input !h-8 !py-0 text-sm text-right tabular-nums"
                                type="number"
                                min={0}
                                max={100}
                                step="0.01"
                                value={l.gstRate === 0 ? "" : l.gstRate}
                                onChange={(e) => {
                                  const v = e.target.value;
                                  updateLine(idx, {
                                    gstRate:
                                      v === ""
                                        ? 0
                                        : Math.min(100, Math.max(0, Number(v))),
                                  });
                                }}
                              />
                            </td>
                            <td className="px-2 py-1.5 text-right font-mono tabular-nums text-sm">
                              {inr(amount)}
                            </td>
                            <td className="px-2 py-1.5">
                              <button
                                type="button"
                                onClick={() => removeLine(idx)}
                                className="text-textSecondary hover:text-danger"
                                aria-label="Remove line"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </section>

              {/* Live recomputed totals */}
              <section className="rounded-sm border border-borderc bg-bg/60 p-3">
                <div className="grid grid-cols-2 gap-1 text-sm">
                  <div className="text-textSecondary">Subtotal</div>
                  <div className="text-right font-mono">{inr(computed.subtotal)}</div>
                  <div className="text-textSecondary">CGST</div>
                  <div className="text-right font-mono">{inr(computed.cgst)}</div>
                  <div className="text-textSecondary">SGST</div>
                  <div className="text-right font-mono">{inr(computed.sgst)}</div>
                  <div className="font-semibold text-brand-dark border-t border-borderc pt-1">
                    Grand Total
                  </div>
                  <div className="text-right font-mono font-bold text-brand-dark border-t border-borderc pt-1">
                    {inr(computed.grandTotal)}
                  </div>
                  <div className="text-textSecondary">Already paid</div>
                  <div className="text-right font-mono text-success">
                    −{inr(data.totalPaid)}
                  </div>
                  {Number(data.walletCreditApplied) > 0 && (
                    <>
                      <div className="text-textSecondary">Wallet credit applied</div>
                      <div className="text-right font-mono text-success">
                        −{inr(data.walletCreditApplied)}
                      </div>
                    </>
                  )}
                  <div className="font-semibold text-danger border-t border-borderc pt-1">
                    New balance
                  </div>
                  <div className="text-right font-mono font-bold text-danger border-t border-borderc pt-1">
                    {inr(newBalance)}
                  </div>
                </div>
              </section>

              {/* Notes */}
              <section>
                <label className="label block mb-1">Notes (printed on bill)</label>
                <textarea
                  className="input !h-20 py-2"
                  rows={3}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Optional notes…"
                />
              </section>

              {error && (
                <div className="p-2 rounded-sm bg-danger/10 text-danger text-sm">{error}</div>
              )}
            </>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 px-5 py-3 border-t border-borderc bg-bg">
          <div className="text-[11px] text-textSecondary">
            Edits are recorded in the audit log with before/after totals.
          </div>
          <div className="flex gap-2">
            <button onClick={onClose} className="btn-secondary">
              Cancel
            </button>
            <button
              onClick={() => save.mutate()}
              disabled={
                !data ||
                save.isPending ||
                guestName.trim() === "" ||
                lines.some((l) => l.description.trim() === "") ||
                datesInvalid
              }
              className="btn-primary"
            >
              {save.isPending ? "Saving…" : "Save changes"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
