import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Eye,
  FileText,
  Receipt,
  Search,
} from "@/lib/micons";
import Papa from "papaparse";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  DatePresetBar,
  rangeForPreset,
  type DatePresetKey,
} from "@/components/DatePresetBar";
import { ListSkeleton } from "@/components/kit";
import { StickyBar } from "@/components/StickyBar";
import { Money } from "@/components/Money";
import { PdfPreviewModal } from "@/components/PdfPreviewModal";
import { api, getList } from "@/lib/api";
import { inr } from "@/lib/utils";

interface InvoiceRow {
  id: string;
  invoiceNumber: string;
  reservationId: string;
  reservationNumber: string | null;
  guestId: string | null;
  guestName: string;
  guestGstin: string | null;
  subtotal: string;
  grandTotal: string;
  totalPaid: string;
  balanceDue: string;
  status: string;
  scope: string;
  scopeRoomIds: string[] | null;
  createdAt: string;
}

const STATUS_OPTIONS = ["issued", "partial", "paid", "voided"] as const;
const SCOPE_OPTIONS = [
  { value: "stay", label: "Whole stay" },
  { value: "per_room", label: "Per room" },
] as const;

const PER_PAGE = 25;

function statusTone(status: string): string {
  switch (status) {
    case "paid":
      return "bg-successBg text-success border-successBorder";
    case "partial":
      return "bg-warnBg text-warnFg border-warnBorder";
    case "voided":
      return "bg-neutralBg text-inkMuted border-neutralBorder line-through";
    default:
      return "bg-infoBg text-info border-infoBorder";
  }
}

export default function Invoices() {
  const navigate = useNavigate();
  const [status, setStatus] = useState("");
  const [scope, setScope] = useState("");
  const [q, setQ] = useState("");
  // Default to This Month — financial views usually start there.
  // The preset bar swaps dateFrom/dateTo when staff picks another
  // preset; the `preset` key keeps the right pill active.
  const initialRange = rangeForPreset("month")!;
  const [preset, setPreset] = useState<DatePresetKey>("month");
  const [dateFrom, setDateFrom] = useState(initialRange.from);
  const [dateTo, setDateTo] = useState(initialRange.to);
  const [page, setPage] = useState(1);

  const [preview, setPreview] = useState<{
    url: string;
    number: string;
  } | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["invoices", { status, scope, q, dateFrom, dateTo, page }],
    queryFn: () =>
      getList<InvoiceRow>("/invoices", {
        status: status || undefined,
        scope: scope || undefined,
        q: q || undefined,
        date_from: dateFrom || undefined,
        date_to: dateTo || undefined,
        page,
        per_page: PER_PAGE,
      }),
  });

  // Totals across the full filtered set, not just the current page.
  // Without this, the summary cards lied as soon as a result spilled
  // past one page (35 → looked like only ₹69K instead of the real ₹73K).
  const summaryQ = useQuery({
    queryKey: ["invoices-summary", { status, scope, q, dateFrom, dateTo }],
    queryFn: () =>
      api.get<{
        count: number;
        countVoided: number;
        gross: string;
        paid: string;
        walletCredit: string;
        owing: string;
      }>("/invoices/summary", {
        status: status || undefined,
        scope: scope || undefined,
        q: q || undefined,
        date_from: dateFrom || undefined,
        date_to: dateTo || undefined,
      }),
  });

  const rows = data?.data ?? [];
  const total = data?.meta.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));

  const totals = {
    grand: Number(summaryQ.data?.gross ?? 0),
    paid: Number(summaryQ.data?.paid ?? 0),
    walletCredit: Number(summaryQ.data?.walletCredit ?? 0),
    balance: Number(summaryQ.data?.owing ?? 0),
  };
  // Settled = cash/UPI/card payments + wallet credit applied. Both are
  // money that's cleared the bill, so this is what "Collected" means
  // operationally. Defining it this way also enforces the identity
  //   gross = settled + outstanding
  // which is what makes the tiles add up at a glance.
  const settled = totals.paid + totals.walletCredit;

  // Full-detail CSV export hitting the server-side /invoices/export
  // endpoint. Pulls every invoice matching the current filters across
  // all pages, with reservation/guest/room/line-item/payment/audit
  // fields flattened into one row per invoice.
  const [exporting, setExporting] = useState(false);
  async function exportAll() {
    setExporting(true);
    try {
      const out = await api.get<{
        rows: Record<string, unknown>[];
        count: number;
      }>("/invoices/export", {
        status: status || undefined,
        scope: scope || undefined,
        q: q || undefined,
        date_from: dateFrom || undefined,
        date_to: dateTo || undefined,
      });
      if (out.rows.length === 0) return;
      const csv = Papa.unparse(out.rows);
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const today = format(new Date(), "yyyy-MM-dd");
      a.download = `invoices-${dateFrom || "all"}-${dateTo || today}-full.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  }

  // "Active" when any non-default filter is set. The date range is
  // always populated by the preset bar, so we treat it as active only
  // when the user moved off the default Month preset.
  const filtersActive = !!(status || scope || q || preset !== "month");

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">Invoices</h1>
          <p className="text-sm text-textSecondary mt-1">
            {total} invoice{total === 1 ? "" : "s"} - issued, partial, paid, and voided
          </p>
        </div>
        <button
          onClick={exportAll}
          disabled={total === 0 || exporting}
          className="inline-flex items-center gap-1.5 px-3.5 h-10 text-[13px] font-semibold rounded-sm border border-borderControl bg-surface text-inkBody hover:bg-surfaceAlt transition-colors disabled:opacity-40 disabled:hover:bg-surface"
        >
          <Download className="w-3.5 h-3.5" />
          {exporting ? "Exporting…" : "Export CSV"}
        </button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="card !rounded-[14px]">
          <div className="label">Invoices</div>
          <div className="text-2xl font-bold font-mono text-ink mt-1.5">{total}</div>
          <div className="text-[11px] text-inkMuted mt-1">
            matching current filters
          </div>
        </div>
        <div className="card !rounded-[14px]">
          <div className="label">Total billed</div>
          <Money value={totals.grand} className="block text-2xl font-bold text-ink font-mono mt-1.5" />
          <div className="text-[11px] text-inkMuted mt-1">non-voided · all matches</div>
        </div>
        <div className="card !rounded-[14px]">
          <div className="label">Settled</div>
          <Money value={settled} className="block text-2xl font-bold text-success font-mono mt-1.5" />
          <div className="text-[11px] text-inkMuted mt-1">
            cash {inr(totals.paid)}
            {totals.walletCredit > 0.009 ? ` + credit ${inr(totals.walletCredit)}` : ""}
          </div>
        </div>
        <div className="card !rounded-[14px]">
          <div className="label">Outstanding</div>
          <Money value={totals.balance} className="block text-2xl font-bold text-dangerFg font-mono mt-1.5" />
          <div className="text-[11px] text-inkMuted mt-1">balance due</div>
        </div>
      </div>

      {/* Date range presets. Sits on its own row so the buttons stay
          readable; the filter card below holds search / status / scope. */}
      <StickyBar>
      <div className="card !py-2.5">
        <DatePresetBar
          preset={preset}
          from={dateFrom}
          to={dateTo}
          onChange={(next) => {
            setPreset(next.preset);
            setDateFrom(next.from);
            setDateTo(next.to);
            setPage(1);
          }}
        />
      </div>

      <div className="card flex flex-wrap gap-3 items-end">
        <div className="w-full sm:flex-1 sm:min-w-[200px]">
          <label className="label block mb-1">Search</label>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-textSecondary" />
            <input
              className="input pl-9"
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setPage(1);
              }}
              placeholder="Invoice #, RES-…, guest name or GSTIN"
            />
          </div>
        </div>
        <div className="flex-1 min-w-[120px] sm:flex-none">
          <label className="label block mb-1">Status</label>
          <select
            className="input sm:w-36"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setPage(1);
            }}
          >
            <option value="">All</option>
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <div className="flex-1 min-w-[120px] sm:flex-none">
          <label className="label block mb-1">Scope</label>
          <select
            className="input sm:w-36"
            value={scope}
            onChange={(e) => {
              setScope(e.target.value);
              setPage(1);
            }}
          >
            <option value="">All</option>
            {SCOPE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        {/* Issued-date range now driven by the preset bar below. The
            inline From/To inputs are gone in favour of one-click Today/
            Week/Month/Year; Custom expands the same two fields when
            needed. */}
        {filtersActive && (
          <button
            onClick={() => {
              setStatus("");
              setScope("");
              setQ("");
              const r = rangeForPreset("month")!;
              setPreset("month");
              setDateFrom(r.from);
              setDateTo(r.to);
              setPage(1);
            }}
            className="text-xs text-accentBlue hover:underline self-end pb-2"
          >
            Reset filters
          </button>
        )}
      </div>
      </StickyBar>

      {isLoading ? (
        <ListSkeleton rows={6} />
      ) : rows.length === 0 ? (
        <div className="card flex flex-col items-center justify-center py-16 text-center text-textSecondary">
          <Receipt className="w-10 h-10 mb-3 opacity-40" />
          <div className="text-sm">No invoices match these filters.</div>
        </div>
      ) : (
        <div className="card !p-0 overflow-hidden">
          <div className="hidden md:grid grid-cols-[150px_140px_minmax(180px,1fr)_90px_120px_120px_120px_120px] gap-3 px-3 py-2.5 text-[10px] font-bold uppercase tracking-[0.06em] text-inkMuted bg-surfaceAlt border-b border-divider">
            <div>Invoice #</div>
            <div>Issued</div>
            <div>Billed to</div>
            <div>Scope</div>
            <div className="text-right">Total</div>
            <div className="text-right">Paid</div>
            <div className="text-right">Balance</div>
            <div className="text-right">Actions</div>
          </div>
          <ul className="divide-y divide-divider">
            {rows.map((inv) => (
              <InvoiceRow
                key={inv.id}
                inv={inv}
                onOpenReservation={() => {
                  // Prefer the friendly SLDT-RES-NNNN; fall back to UUID
                  // (only happens for pre-Phase-2 orphaned invoices).
                  const handle = inv.reservationNumber ?? inv.reservationId;
                  navigate(`/reservations/${handle}`);
                }}
                onPreview={() =>
                  setPreview({
                    url: `${import.meta.env.VITE_API_URL}/invoices/${inv.invoiceNumber}/pdf`,
                    number: inv.invoiceNumber,
                  })
                }
              />
            ))}
          </ul>
        </div>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-between gap-3 text-xs text-textSecondary">
          <div>
            Page {page} of {totalPages} · {total} invoice{total === 1 ? "" : "s"}
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
              className="h-8 px-2.5 rounded-sm border border-borderControl bg-surface text-textSecondary hover:bg-surfaceAlt hover:text-ink disabled:opacity-40 disabled:hover:bg-surface disabled:hover:text-textSecondary inline-flex items-center gap-1"
            >
              <ChevronLeft className="w-3.5 h-3.5" /> Prev
            </button>
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
              className="h-8 px-2.5 rounded-sm border border-borderControl bg-surface text-textSecondary hover:bg-surfaceAlt hover:text-ink disabled:opacity-40 disabled:hover:bg-surface disabled:hover:text-textSecondary inline-flex items-center gap-1"
            >
              Next <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

      <PdfPreviewModal
        open={!!preview}
        url={preview?.url ?? null}
        title={preview ? `Invoice ${preview.number}` : ""}
        filename={preview ? `${preview.number}.pdf` : "invoice.pdf"}
        onClose={() => setPreview(null)}
      />
    </div>
  );
}

function InvoiceRow({
  inv,
  onOpenReservation,
  onPreview,
}: {
  inv: InvoiceRow;
  onOpenReservation: () => void;
  onPreview: () => void;
}) {
  const bal = Number(inv.balanceDue);
  const hasBalance = bal > 0.009 && inv.status !== "voided";
  const scopeLabel =
    inv.scope === "per_room"
      ? `Per room${inv.scopeRoomIds?.length ? ` · ${inv.scopeRoomIds.length}` : ""}`
      : "Stay";

  return (
    <li className="group hover:bg-surfaceAlt transition-colors">
      {/* DESKTOP */}
      <div className="hidden md:grid grid-cols-[150px_140px_minmax(180px,1fr)_90px_120px_120px_120px_120px] gap-3 items-center px-3 py-2.5">
        <div className="min-w-0">
          <div className="font-mono text-xs font-semibold text-ink truncate">
            {inv.invoiceNumber}
          </div>
          <button
            onClick={onOpenReservation}
            className="font-mono text-[10px] text-accentBlue hover:underline truncate block"
          >
            {inv.reservationNumber ?? "-"}
          </button>
        </div>

        <div className="text-xs">
          <div className="text-ink font-medium">
            {format(new Date(inv.createdAt), "dd MMM yyyy")}
          </div>
          <div className="text-[10px] text-inkMuted font-mono">
            {format(new Date(inv.createdAt), "h:mm a")}
          </div>
        </div>

        <div className="min-w-0">
          <div className="text-sm font-semibold text-ink truncate">{inv.guestName}</div>
          {inv.guestGstin && (
            <div className="text-[10px] text-inkMuted font-mono truncate">
              GSTIN {inv.guestGstin}
            </div>
          )}
        </div>

        <div className="text-[11px] text-inkMuted">{scopeLabel}</div>

        <div className="text-right text-sm font-mono font-semibold text-ink">
          {inr(inv.grandTotal)}
        </div>

        <div className="text-right text-sm font-mono text-success">{inr(inv.totalPaid)}</div>

        <div className="text-right">
          {/* Show the outstanding amount only when there IS one — otherwise
              the status badge already reads PAID, so a second "Paid" line is
              redundant. */}
          {hasBalance && (
            <div className="text-sm font-mono font-semibold text-dangerFg">
              {inr(inv.balanceDue)}
            </div>
          )}
          <span
            className={`inline-block ${hasBalance ? "mt-0.5" : ""} px-2 py-0 rounded-full text-[9px] font-bold uppercase tracking-wider border ${statusTone(inv.status)}`}
          >
            {inv.status}
          </span>
        </div>

        <div className="flex justify-end gap-1">
          <button
            onClick={onPreview}
            className="h-7 px-2 rounded-sm border border-borderControl bg-surface text-textSecondary hover:bg-surfaceAlt hover:text-ink text-[11px] font-semibold inline-flex items-center gap-1"
            title="Preview PDF"
          >
            <Eye className="w-3 h-3" /> PDF
          </button>
          <button
            onClick={onOpenReservation}
            className="h-7 px-2 rounded-sm border border-inkDark bg-inkDark text-cream hover:opacity-90 text-[11px] font-semibold inline-flex items-center gap-1"
            title="Open reservation"
          >
            <FileText className="w-3 h-3" /> Open
          </button>
        </div>
      </div>

      {/* MOBILE */}
      <div className="md:hidden px-3 py-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="font-mono text-xs font-semibold text-ink truncate">
              {inv.invoiceNumber}
            </div>
            <div className="text-sm font-semibold text-ink truncate mt-0.5">
              {inv.guestName}
            </div>
            <button
              onClick={onOpenReservation}
              className="font-mono text-[10px] text-accentBlue hover:underline mt-0.5"
            >
              {inv.reservationNumber ?? "-"}
            </button>
            <div className="text-[10px] text-inkMuted mt-1">
              {format(new Date(inv.createdAt), "dd MMM yyyy")} · {scopeLabel}
            </div>
          </div>
          <div className="text-right shrink-0">
            <div className="text-sm font-mono font-semibold text-ink">
              {inr(inv.grandTotal)}
            </div>
            {hasBalance && (
              <div className="text-xs font-mono font-semibold mt-0.5 text-dangerFg">
                {inr(inv.balanceDue)} due
              </div>
            )}
            <span
              className={`inline-block mt-1 px-2 py-0 rounded-full text-[9px] font-bold uppercase tracking-wider border ${statusTone(inv.status)}`}
            >
              {inv.status}
            </span>
          </div>
        </div>
        <div className="flex gap-2 mt-2">
          <button
            onClick={onPreview}
            className="flex-1 h-8 rounded-sm border border-borderControl bg-surface text-textSecondary text-xs font-semibold inline-flex items-center justify-center gap-1"
          >
            <Eye className="w-3.5 h-3.5" /> PDF
          </button>
          <button
            onClick={onOpenReservation}
            className="flex-1 h-8 rounded-sm border border-inkDark bg-inkDark text-cream text-xs font-semibold inline-flex items-center justify-center gap-1"
          >
            <FileText className="w-3.5 h-3.5" /> Open
          </button>
        </div>
      </div>
    </li>
  );
}
