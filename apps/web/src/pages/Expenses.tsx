// Property expenses ledger page.
//
// Surface: list with filters + KPI strip + an "Add expense" modal
// that doubles as an editor. Default view is "This month" via the
// shared DatePresetBar.
//
// Permissions: page-level guard is `view_expenses` (in App.tsx); the
// Add/Edit/Delete buttons here additionally require `manage_expenses`
// so a property could grant a CA read-only access to history without
// letting them edit.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  EXPENSE_CATEGORIES,
  EXPENSE_PAYMENT_METHODS,
  type ExpenseCategory,
  type ExpensePaymentMethod,
} from "@hoteldesk/shared";
import { format } from "date-fns";
import {
  ChevronLeft,
  ChevronRight,
  FileText,
  Plus,
  Receipt,
  Search,
  Wallet,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/auth/AuthContext";
import {
  DatePresetBar,
  rangeForPreset,
  type DatePresetKey,
} from "@/components/DatePresetBar";
import { Loader } from "@/components/Loader";
import { StickyBar } from "@/components/StickyBar";
import { Money } from "@/components/Money";
import { useToast } from "@/components/Toast";
import { api, getList } from "@/lib/api";
import { inr } from "@/lib/utils";

// Display labels for the enum slugs. Kept in this file (not the
// shared package) because the slugs are the contract; labels are UI
// copy and might evolve independently per property's accountant.
export const CATEGORY_LABELS: Record<ExpenseCategory, string> = {
  utilities: "Utilities",
  repairs_maintenance: "Repairs & Maintenance",
  supplies: "Supplies",
  salaries_wages: "Salaries & Wages",
  food_kitchen: "Food & Kitchen",
  marketing: "Marketing",
  government_compliance: "Government & Compliance",
  other: "Other",
};

export const PAYMENT_METHOD_LABELS: Record<ExpensePaymentMethod, string> = {
  cash: "Cash",
  upi: "UPI",
  card: "Card",
  bank_transfer: "Bank Transfer",
  pending: "Pending",
};

export interface ExpenseRow {
  id: string;
  expenseDate: string;
  category: ExpenseCategory;
  subcategory: string | null;
  description: string;
  amount: string;
  gstAmount: string;
  paymentMethod: ExpensePaymentMethod;
  paidAt: string | null;
  vendorName: string | null;
  vendorPhone: string | null;
  billNumber: string | null;
  attachmentUrl: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  recordedById: string;
  recordedByName: string | null;
}

interface ExpenseSummary {
  count: number;
  total: string;
  paid: string;
  pending: string;
  gst: string;
  byCategory: { category: ExpenseCategory; total: string; count: number }[];
}

const PER_PAGE = 25;

export default function Expenses() {
  const { can } = useAuth();
  const canManage = can("manage_expenses");

  // Filters — date range (driven by the shared preset bar), category,
  // payment status, and a free-text search.
  const initialRange = rangeForPreset("month")!;
  const [preset, setPreset] = useState<DatePresetKey>("month");
  const [dateFrom, setDateFrom] = useState(initialRange.from);
  const [dateTo, setDateTo] = useState(initialRange.to);
  const [category, setCategory] = useState<"" | ExpenseCategory>("");
  const [statusFilter, setStatusFilter] = useState<"" | "paid" | "pending">(
    "",
  );
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);

  // Modal state. `editing` doubles as both "create" (null) and
  // "edit" (a row's id) — when set, we pre-fill the form from the
  // matching row in the current page; when null, the form starts
  // blank.
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<ExpenseRow | null>(null);

  const queryParams = useMemo(
    () => ({
      date_from: dateFrom || undefined,
      date_to: dateTo || undefined,
      category: category || undefined,
      status: statusFilter || undefined,
      q: q.trim() || undefined,
      page,
      per_page: PER_PAGE,
    }),
    [dateFrom, dateTo, category, statusFilter, q, page],
  );

  const { data: listData, isLoading } = useQuery({
    queryKey: ["expenses", queryParams],
    queryFn: () => getList<ExpenseRow>("/expenses", queryParams),
  });

  const summaryQ = useQuery({
    queryKey: ["expenses-summary", queryParams],
    queryFn: () =>
      api.get<ExpenseSummary>("/expenses/summary", queryParams as never),
  });

  const rows = listData?.data ?? [];
  const total = listData?.meta.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));

  const filtersActive =
    !!category || !!statusFilter || !!q.trim() || preset !== "month";

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-brand-dark">Expenses</h1>
          <p className="text-xs text-textSecondary mt-0.5">
            Property overheads — utilities, repairs, supplies, salaries
          </p>
        </div>
        {canManage && (
          <button
            className="btn-primary inline-flex items-center gap-2"
            onClick={() => {
              setEditing(null);
              setModalOpen(true);
            }}
          >
            <Plus className="w-4 h-4" /> Record Expense
          </button>
        )}
      </div>

      {/* KPI strip — sums across the FULL filtered set (server-side),
          not just the current page. */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="card">
          <div className="label">Total</div>
          <Money
            value={summaryQ.data?.total ?? 0}
            className="block text-2xl font-bold text-brand-dark font-mono mt-1"
          />
          <div className="text-xs text-textSecondary mt-0.5">
            {summaryQ.data?.count ?? 0} entr
            {(summaryQ.data?.count ?? 0) === 1 ? "y" : "ies"}
          </div>
        </div>
        <div className="card">
          <div className="label">Paid</div>
          <Money
            value={summaryQ.data?.paid ?? 0}
            className="block text-2xl font-bold text-success font-mono mt-1"
          />
          <div className="text-xs text-textSecondary mt-0.5">
            settled (any method)
          </div>
        </div>
        <div className="card">
          <div className="label">Pending</div>
          <Money
            value={summaryQ.data?.pending ?? 0}
            className="block text-2xl font-bold text-warning font-mono mt-1"
          />
          <div className="text-xs text-textSecondary mt-0.5">
            recorded, not yet paid
          </div>
        </div>
        <div className="card">
          <div className="label">Input GST</div>
          <Money
            value={summaryQ.data?.gst ?? 0}
            className="block text-2xl font-bold text-brand-dark font-mono mt-1"
          />
          <div className="text-xs text-textSecondary mt-0.5">
            claimable at filing
          </div>
        </div>
      </div>

      {/* Per-category breakdown — only rendered when there's data. */}
      {(summaryQ.data?.byCategory.length ?? 0) > 0 && (
        <div className="card">
          <div className="text-xs uppercase tracking-wider text-textSecondary font-semibold mb-2">
            By category
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
            {summaryQ.data?.byCategory.map((c) => (
              <div
                key={c.category}
                className="flex items-center justify-between px-3 py-2 rounded-sm bg-bg/60 border border-borderc"
              >
                <div className="min-w-0">
                  <div className="text-[11px] uppercase tracking-wider text-textSecondary truncate">
                    {CATEGORY_LABELS[c.category]}
                  </div>
                  <div className="text-[10px] text-textSecondary mt-0.5">
                    {c.count} entr{c.count === 1 ? "y" : "ies"}
                  </div>
                </div>
                <div className="text-sm font-mono font-semibold text-brand-dark">
                  {inr(c.total)}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Date preset bar. Same component used by Reservations + Invoices. */}
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

      {/* Secondary filters. Search + category + payment status. */}
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
              placeholder="Description, vendor, bill #…"
            />
          </div>
        </div>
        <div className="flex-1 min-w-[160px] sm:flex-none">
          <label className="label block mb-1">Category</label>
          <select
            className="input sm:w-52"
            value={category}
            onChange={(e) => {
              setCategory(e.target.value as "" | ExpenseCategory);
              setPage(1);
            }}
          >
            <option value="">All</option>
            {EXPENSE_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABELS[c]}
              </option>
            ))}
          </select>
        </div>
        <div className="flex-1 min-w-[140px] sm:flex-none">
          <label className="label block mb-1">Status</label>
          <select
            className="input sm:w-36"
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value as "" | "paid" | "pending");
              setPage(1);
            }}
          >
            <option value="">All</option>
            <option value="paid">Paid</option>
            <option value="pending">Pending</option>
          </select>
        </div>
        {filtersActive && (
          <button
            onClick={() => {
              setCategory("");
              setStatusFilter("");
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
        <Loader />
      ) : rows.length === 0 ? (
        <div className="card flex flex-col items-center justify-center py-16 text-center text-textSecondary">
          <Receipt className="w-10 h-10 mb-3 opacity-40" />
          <div className="text-sm">No expenses match these filters.</div>
        </div>
      ) : (
        <div className="card !p-0 overflow-hidden">
          <div className="hidden md:grid grid-cols-[110px_140px_minmax(180px,1fr)_140px_120px_120px] gap-3 px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-textSecondary bg-bg/60 border-b border-borderc">
            <div>Date</div>
            <div>Category</div>
            <div>Description</div>
            <div>Vendor</div>
            <div className="text-right">Amount</div>
            <div>Payment</div>
          </div>
          {/* Edit / delete / bill preview live on the detail page the
              row opens — no inline action buttons. */}
          <ul className="divide-y divide-borderc">
            {rows.map((r) => (
              <ExpenseRowItem key={r.id} r={r} />
            ))}
          </ul>
        </div>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-between gap-3 text-xs text-textSecondary">
          <div>
            Page {page} of {totalPages} · {total} expense{total === 1 ? "" : "s"}
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
              className="h-8 px-2 rounded-sm border-2 border-borderc text-textSecondary hover:border-brand-dark hover:text-brand-dark disabled:opacity-40 inline-flex items-center gap-1"
            >
              <ChevronLeft className="w-3.5 h-3.5" /> Prev
            </button>
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
              className="h-8 px-2 rounded-sm border-2 border-borderc text-textSecondary hover:border-brand-dark hover:text-brand-dark disabled:opacity-40 inline-flex items-center gap-1"
            >
              Next <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

      {modalOpen && (
        <ExpenseModal
          expense={editing}
          onClose={() => {
            setModalOpen(false);
            setEditing(null);
          }}
        />
      )}

    </div>
  );
}

// ============================================================
// Row + actions
// ============================================================

// An expense counts as "edited" when updated meaningfully after
// creation. The 60s grace skips the updated_at bump caused by the
// attachment upload that immediately follows a create.
function wasEdited(r: ExpenseRow): boolean {
  return new Date(r.updatedAt).getTime() - new Date(r.createdAt).getTime() > 60_000;
}

function EditedChip({ updatedAt }: { updatedAt: string }) {
  return (
    <span
      title={`Last edited ${format(new Date(updatedAt), "dd MMM yyyy, h:mm a")}`}
      className="inline-block px-1 py-px rounded-sm text-[9px] font-bold uppercase tracking-wider bg-warning/15 text-warning border border-warning/30"
    >
      edited
    </span>
  );
}

function ExpenseRowItem({ r }: { r: ExpenseRow }) {
  const navigate = useNavigate();
  const isPending = r.paymentMethod === "pending";

  // Open the full detail page. Bound to the whole row + keyboard so
  // staff can tab through and Enter on any row.
  function openDetail() {
    navigate(`/expenses/${r.id}`);
  }

  return (
    <li
      role="button"
      tabIndex={0}
      onClick={openDetail}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openDetail();
        }
      }}
      className="group hover:bg-brand-soft/30 focus:bg-brand-soft/40 focus:outline-none cursor-pointer transition-colors"
    >
      {/* DESKTOP */}
      <div className="hidden md:grid grid-cols-[110px_140px_minmax(180px,1fr)_140px_120px_120px] gap-3 items-center px-3 py-2.5">
        <div className="text-xs">
          <div className="text-brand-dark font-medium">
            {format(new Date(r.expenseDate), "dd MMM yyyy")}
          </div>
          {r.paidAt && !isPending && (
            <div className="text-[10px] text-textSecondary font-mono">
              paid {format(new Date(r.paidAt), "dd MMM")}
            </div>
          )}
        </div>
        <div className="text-xs">
          <div className="font-semibold text-brand-dark">
            {CATEGORY_LABELS[r.category]}
          </div>
          {r.subcategory && (
            <div className="text-[10px] text-textSecondary truncate">
              {r.subcategory}
            </div>
          )}
        </div>
        <div className="min-w-0">
          <div className="text-sm text-brand-dark truncate">{r.description}</div>
          {(r.billNumber || wasEdited(r)) && (
            <div className="flex items-center gap-1.5 min-w-0">
              {r.billNumber && (
                <span className="text-[10px] text-textSecondary font-mono truncate">
                  Bill #{r.billNumber}
                </span>
              )}
              {wasEdited(r) && <EditedChip updatedAt={r.updatedAt} />}
            </div>
          )}
        </div>
        <div className="min-w-0 text-xs">
          <div className="text-brand-dark truncate">{r.vendorName ?? "—"}</div>
          {r.vendorPhone && (
            <div className="text-[10px] text-textSecondary font-mono">
              {r.vendorPhone}
            </div>
          )}
        </div>
        <div className="text-right">
          <div className="text-sm font-mono font-semibold text-brand-dark">
            {inr(r.amount)}
          </div>
          {Number(r.gstAmount) > 0.009 && (
            <div className="text-[10px] text-textSecondary font-mono">
              + GST {inr(r.gstAmount)}
            </div>
          )}
        </div>
        <div>
          <span
            className={`inline-block px-1.5 py-0.5 rounded-sm text-[10px] font-bold uppercase tracking-wider border ${
              isPending
                ? "bg-warning/15 text-warning border-warning/30"
                : "bg-success/15 text-success border-success/30"
            }`}
          >
            {PAYMENT_METHOD_LABELS[r.paymentMethod]}
          </span>
        </div>
      </div>

      {/* MOBILE */}
      <div className="md:hidden px-3 py-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="text-[11px] text-textSecondary flex items-center gap-1.5">
              {format(new Date(r.expenseDate), "dd MMM yyyy")} ·{" "}
              {CATEGORY_LABELS[r.category]}
              {wasEdited(r) && <EditedChip updatedAt={r.updatedAt} />}
            </div>
            <div className="text-sm text-brand-dark mt-0.5 truncate">
              {r.description}
            </div>
            {r.vendorName && (
              <div className="text-[11px] text-textSecondary mt-0.5">
                {r.vendorName}
              </div>
            )}
          </div>
          <div className="text-right shrink-0">
            <div className="text-sm font-mono font-semibold text-brand-dark">
              {inr(r.amount)}
            </div>
            <span
              className={`inline-block mt-1 px-1.5 py-0.5 rounded-sm text-[9px] font-bold uppercase tracking-wider border ${
                isPending
                  ? "bg-warning/15 text-warning border-warning/30"
                  : "bg-success/15 text-success border-success/30"
              }`}
            >
              {PAYMENT_METHOD_LABELS[r.paymentMethod]}
            </span>
          </div>
        </div>
      </div>
    </li>
  );
}

// ============================================================
// Add / edit modal
// ============================================================

export function ExpenseModal({
  expense,
  onClose,
}: {
  expense: ExpenseRow | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const isEdit = !!expense;
  const todayStr = format(new Date(), "yyyy-MM-dd");

  const [form, setForm] = useState({
    expenseDate: expense?.expenseDate ?? todayStr,
    category: (expense?.category ?? "utilities") as ExpenseCategory,
    subcategory: expense?.subcategory ?? "",
    description: expense?.description ?? "",
    amount: expense?.amount ?? "",
    gstAmount: expense?.gstAmount ?? "0",
    paymentMethod: (expense?.paymentMethod ?? "cash") as ExpensePaymentMethod,
    vendorName: expense?.vendorName ?? "",
    vendorPhone: expense?.vendorPhone ?? "",
    billNumber: expense?.billNumber ?? "",
    notes: expense?.notes ?? "",
  });
  const [file, setFile] = useState<File | null>(null);
  const [err, setErr] = useState<string | null>(null);

  function set<K extends keyof typeof form>(k: K, v: (typeof form)[K]) {
    setForm({ ...form, [k]: v });
  }

  const save = useMutation({
    mutationFn: async () => {
      // Common payload bits used by both create + update.
      const baseFields: Record<string, string | number | null> = {
        expenseDate: form.expenseDate,
        category: form.category,
        subcategory: form.subcategory.trim() || null,
        description: form.description.trim(),
        amount: Number(form.amount),
        gstAmount: Number(form.gstAmount) || 0,
        paymentMethod: form.paymentMethod,
        vendorName: form.vendorName.trim() || null,
        vendorPhone: form.vendorPhone.trim() || null,
        billNumber: form.billNumber.trim() || null,
        notes: form.notes.trim() || null,
      };
      if (!isEdit) {
        // Create: multipart so we can ship the bill in the same hit.
        const fd = new FormData();
        for (const [k, v] of Object.entries(baseFields)) {
          if (v === null) continue;
          fd.append(k, String(v));
        }
        if (file) fd.append("bill", file);
        return api.upload<ExpenseRow>("/expenses", fd);
      }
      // Edit: JSON PATCH for fields, then optional file upload to a
      // dedicated endpoint. Keeps the main update path simple.
      const updated = await api.patch<ExpenseRow>(
        `/expenses/${expense!.id}`,
        baseFields,
      );
      if (file) {
        const fd = new FormData();
        fd.append("bill", file);
        await api.upload(`/expenses/${expense!.id}/bill`, fd);
      }
      return updated;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["expenses"] });
      void qc.invalidateQueries({ queryKey: ["expenses-summary"] });
      toast(isEdit ? "Expense updated" : "Expense recorded", "success");
      onClose();
    },
    onError: (e: Error) => setErr(e.message),
  });

  // Esc to close.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const canSubmit =
    form.description.trim() !== "" && Number(form.amount) > 0 && !save.isPending;

  return (
    <div
      className="fixed inset-0 z-[100] grid place-items-center bg-brand-dark/50 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-2xl bg-surface rounded-md shadow-2xl border border-borderc overflow-hidden flex flex-col max-h-[90vh]">
        <div className="px-5 py-3 border-b border-borderc bg-bg/50 flex items-center justify-between gap-3">
          <div className="font-semibold text-brand-dark">
            {isEdit ? "Edit expense" : "Record expense"}
          </div>
          <button onClick={onClose} className="text-textSecondary hover:text-textPrimary">
            ✕
          </button>
        </div>
        <div className="p-5 space-y-4 overflow-y-auto">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="label block mb-1">
                Date <span className="text-danger">*</span>
              </label>
              <input
                type="date"
                className="input"
                value={form.expenseDate}
                max={todayStr}
                onChange={(e) => set("expenseDate", e.target.value)}
              />
            </div>
            <div>
              <label className="label block mb-1">
                Category <span className="text-danger">*</span>
              </label>
              <select
                className="input"
                value={form.category}
                onChange={(e) => set("category", e.target.value as ExpenseCategory)}
              >
                {EXPENSE_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {CATEGORY_LABELS[c]}
                  </option>
                ))}
              </select>
            </div>
            <div className="sm:col-span-2">
              <label className="label block mb-1">
                Description <span className="text-danger">*</span>
              </label>
              <input
                className="input"
                value={form.description}
                onChange={(e) => set("description", e.target.value)}
                placeholder="June electricity bill, plumber for room 305 …"
                maxLength={200}
              />
            </div>
            <div>
              <label className="label block mb-1">Subcategory</label>
              <input
                className="input"
                value={form.subcategory}
                onChange={(e) => set("subcategory", e.target.value)}
                placeholder="water, electricity, plumber …"
                maxLength={60}
              />
            </div>
            <div>
              <label className="label block mb-1">Bill / invoice #</label>
              <input
                className="input font-mono"
                value={form.billNumber}
                onChange={(e) => set("billNumber", e.target.value)}
                maxLength={60}
              />
            </div>
            <div>
              <label className="label block mb-1">
                Amount (₹) <span className="text-danger">*</span>
              </label>
              <input
                type="number"
                className="input font-mono"
                inputMode="decimal"
                min={0}
                step="0.01"
                value={form.amount}
                onChange={(e) => set("amount", e.target.value)}
                onBlur={() => {
                  if (form.amount === "" || isNaN(Number(form.amount)))
                    set("amount", "0");
                }}
              />
            </div>
            <div>
              <label className="label block mb-1">Input GST (₹)</label>
              <input
                type="number"
                className="input font-mono"
                inputMode="decimal"
                min={0}
                step="0.01"
                value={form.gstAmount === "0" ? "" : form.gstAmount}
                onChange={(e) => set("gstAmount", e.target.value)}
                onBlur={() => {
                  if (form.gstAmount === "" || isNaN(Number(form.gstAmount)))
                    set("gstAmount", "0");
                }}
                placeholder="0 if no GST on this bill"
              />
            </div>
            <div>
              <label className="label block mb-1">Payment</label>
              <select
                className="input"
                value={form.paymentMethod}
                onChange={(e) =>
                  set("paymentMethod", e.target.value as ExpensePaymentMethod)
                }
              >
                {EXPENSE_PAYMENT_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {PAYMENT_METHOD_LABELS[m]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label block mb-1">Vendor name</label>
              <input
                className="input"
                value={form.vendorName}
                onChange={(e) => set("vendorName", e.target.value)}
                maxLength={120}
                placeholder="AP Electricity Board, Ramu plumber …"
              />
            </div>
            <div>
              <label className="label block mb-1">Vendor phone</label>
              <input
                className="input font-mono"
                value={form.vendorPhone}
                onChange={(e) => set("vendorPhone", e.target.value)}
                maxLength={20}
              />
            </div>
            <div className="sm:col-span-2">
              <label className="label block mb-1">Notes</label>
              <textarea
                className="input min-h-[60px]"
                value={form.notes}
                onChange={(e) => set("notes", e.target.value)}
                maxLength={1000}
                placeholder="Optional context — quarterly settlement, advance against future work, etc."
              />
            </div>
            <div className="sm:col-span-2">
              <label className="label block mb-1">
                Bill / receipt photo or PDF
              </label>
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp,application/pdf"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                className="text-xs"
              />
              {expense?.attachmentUrl && !file && (
                <p className="text-[11px] text-textSecondary mt-1 inline-flex items-center gap-1">
                  <FileText className="w-3 h-3" /> Current bill attached. Pick a
                  new file to replace it.
                </p>
              )}
            </div>
          </div>
          {err && <div className="text-xs text-danger">{err}</div>}
        </div>
        <div className="border-t border-borderc bg-bg/50 px-5 py-3 flex justify-end gap-2">
          <button onClick={onClose} className="btn-secondary">
            Cancel
          </button>
          <button
            onClick={() => save.mutate()}
            disabled={!canSubmit}
            className="btn-primary inline-flex items-center gap-2"
          >
            <Wallet className="w-4 h-4" />
            {save.isPending ? "Saving…" : isEdit ? "Save changes" : "Record expense"}
          </button>
        </div>
      </div>
    </div>
  );
}

