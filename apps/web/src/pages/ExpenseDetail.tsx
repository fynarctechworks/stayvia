// Full-detail view for a single expense row.
//
// Surfaces everything the list page truncates: full description,
// notes, vendor info, recorded-by + timestamps, and an inline bill
// preview (image embedded, PDF in iframe).
//
// Actions: Edit (reuses the same modal as the list page), Mark Paid
// (when the row is pending), Delete (confirm dialog → list page).

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import {
  ArrowLeft,
  CalendarDays,
  CheckCircle2,
  FileText,
  Pencil,
  Receipt,
  Trash2,
  User,
  Wallet,
} from "lucide-react";
import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useAuth } from "@/auth/AuthContext";
import { useDialog } from "@/components/Dialog";
import { Loader } from "@/components/Loader";
import { useToast } from "@/components/Toast";
import { api } from "@/lib/api";
import { inr } from "@/lib/utils";
import {
  CATEGORY_LABELS,
  ExpenseModal,
  PAYMENT_METHOD_LABELS,
  type ExpenseRow,
} from "./Expenses";

// What `/expenses/:id` returns. Same fields as the list row plus a
// fresh signed URL for the bill so we can render it inline.
interface ExpenseDetailResponse extends ExpenseRow {
  attachmentSignedUrl: string | null;
}

export default function ExpenseDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const dialog = useDialog();
  const { toast } = useToast();
  const { can } = useAuth();
  const canManage = can("manage_expenses");

  const [editOpen, setEditOpen] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ["expense", id],
    queryFn: () => api.get<ExpenseDetailResponse>(`/expenses/${id}`),
    enabled: !!id,
  });

  const del = useMutation({
    mutationFn: () => api.del(`/expenses/${id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["expenses"] });
      void qc.invalidateQueries({ queryKey: ["expenses-summary"] });
      toast("Expense deleted", "success");
      navigate("/expenses");
    },
    onError: (e: Error) => toast(e.message, "error"),
  });

  // Quick action: flip a pending bill to paid (cash, today) without
  // opening the full edit modal. The server auto-fills paidAt when
  // it sees paymentMethod move off "pending".
  const markPaid = useMutation({
    mutationFn: () => api.patch(`/expenses/${id}`, { paymentMethod: "cash" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["expense", id] });
      void qc.invalidateQueries({ queryKey: ["expenses"] });
      void qc.invalidateQueries({ queryKey: ["expenses-summary"] });
      toast("Marked as paid (cash)", "success");
    },
    onError: (e: Error) => toast(e.message, "error"),
  });

  async function confirmDelete() {
    if (!data) return;
    const ok = await dialog.confirm({
      title: "Delete this expense?",
      message: `"${data.description}" — ${inr(data.amount)}. This can't be undone.`,
      okLabel: "Delete",
      cancelLabel: "Keep",
      tone: "danger",
    });
    if (ok) del.mutate();
  }

  if (isLoading) return <Loader />;
  if (error || !data) {
    return (
      <div className="space-y-4">
        <button
          className="btn-secondary inline-flex items-center gap-2"
          onClick={() => navigate("/expenses")}
        >
          <ArrowLeft className="w-4 h-4" /> Back to Expenses
        </button>
        <div className="card text-textSecondary text-center py-10">
          Expense not found.
        </div>
      </div>
    );
  }

  const isPending = data.paymentMethod === "pending";
  const amount = Number(data.amount);
  const gst = Number(data.gstAmount);
  const total = +(amount + gst).toFixed(2);
  // Same heuristic used in BillPreview on the list page: signed URL
  // contains ".pdf" iff the original upload was a PDF. Image uploads
  // are stored as .jpg/.png/.webp.
  const isPdf = data.attachmentSignedUrl?.includes(".pdf") ?? false;

  return (
    <div className="space-y-4">
      {/* Header — back button + title + actions. */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-start gap-3 min-w-0">
          <button
            onClick={() => navigate("/expenses")}
            className="grid place-items-center h-9 w-9 rounded-sm border border-borderc text-textSecondary hover:border-brand-dark hover:text-brand-dark"
            title="Back to Expenses"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div className="min-w-0">
            <h1 className="text-2xl font-bold text-brand-dark truncate">
              {data.description}
            </h1>
            <p className="text-xs text-textSecondary mt-0.5">
              {CATEGORY_LABELS[data.category]}
              {data.subcategory ? ` · ${data.subcategory}` : ""}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span
            className={`inline-flex items-center px-2 h-7 rounded-sm text-[11px] font-bold uppercase tracking-wider border ${
              isPending
                ? "bg-warning/15 text-warning border-warning/30"
                : "bg-success/15 text-success border-success/30"
            }`}
          >
            {PAYMENT_METHOD_LABELS[data.paymentMethod]}
          </span>
          {canManage && isPending && (
            <button
              className="btn-secondary inline-flex items-center gap-2"
              onClick={() => markPaid.mutate()}
              disabled={markPaid.isPending}
            >
              <CheckCircle2 className="w-4 h-4" />
              {markPaid.isPending ? "Saving…" : "Mark Paid"}
            </button>
          )}
          {canManage && (
            <>
              <button
                className="btn-secondary inline-flex items-center gap-2"
                onClick={() => setEditOpen(true)}
              >
                <Pencil className="w-4 h-4" /> Edit
              </button>
              <button
                className="inline-flex items-center gap-2 px-3 h-9 text-xs font-semibold rounded-sm border-2 border-danger text-danger hover:bg-danger hover:text-cream disabled:opacity-40"
                onClick={confirmDelete}
                disabled={del.isPending}
              >
                <Trash2 className="w-4 h-4" /> Delete
              </button>
            </>
          )}
        </div>
      </div>

      {/* Identity card — every field rendered, "—" for empty so
          the layout doesn't change based on how much was filled. */}
      <div className="card">
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          <Detail
            label="Date"
            icon={<CalendarDays className="w-3.5 h-3.5" />}
            value={format(new Date(data.expenseDate), "dd MMM yyyy")}
            sub={
              data.paidAt && !isPending
                ? `Paid ${format(new Date(data.paidAt), "dd MMM yyyy, h:mm a")}`
                : isPending
                  ? "Not yet paid"
                  : null
            }
          />
          <Detail
            label="Category"
            icon={<Receipt className="w-3.5 h-3.5" />}
            value={CATEGORY_LABELS[data.category]}
          />
          <Detail
            label="Subcategory"
            icon={<Receipt className="w-3.5 h-3.5" />}
            value={data.subcategory ?? "—"}
          />
          <Detail
            label="Bill / Invoice #"
            icon={<FileText className="w-3.5 h-3.5" />}
            value={data.billNumber ?? "—"}
          />
          <Detail
            label="Payment"
            icon={<Wallet className="w-3.5 h-3.5" />}
            value={PAYMENT_METHOD_LABELS[data.paymentMethod]}
          />
        </div>
      </div>

      {/* Money card — amount + GST + total. */}
      <div className="card">
        <h2 className="text-sm font-semibold text-brand-dark mb-3">Money</h2>
        <div className="grid grid-cols-3 gap-3">
          <Money label="Amount" value={amount} tone="default" />
          <Money
            label="Input GST"
            value={gst}
            tone="muted"
            sub={gst > 0.009 ? "claimable at filing" : "no GST on this bill"}
          />
          <Money
            label="Total"
            value={total}
            tone="primary"
            sub="amount + GST"
          />
        </div>
      </div>

      {/* Vendor card — always rendered, "—" when staff didn't fill
          it in. Keeps the page layout predictable. */}
      <div className="card">
        <h2 className="text-sm font-semibold text-brand-dark mb-3">Vendor</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Detail
            label="Name"
            icon={<User className="w-3.5 h-3.5" />}
            value={data.vendorName ?? "—"}
          />
          <Detail
            label="Phone"
            icon={<User className="w-3.5 h-3.5" />}
            value={
              data.vendorPhone ? (
                <a
                  href={`tel:${data.vendorPhone}`}
                  className="text-accentBlue hover:underline font-mono"
                >
                  {data.vendorPhone}
                </a>
              ) : (
                "—"
              )
            }
          />
        </div>
      </div>

      {/* Notes — always rendered. */}
      <div className="card">
        <h2 className="text-sm font-semibold text-brand-dark mb-2">Notes</h2>
        {data.notes ? (
          <p className="text-sm text-textPrimary whitespace-pre-wrap">
            {data.notes}
          </p>
        ) : (
          <p className="text-sm text-textSecondary italic">No notes recorded.</p>
        )}
      </div>

      {/* Bill attachment — always rendered, with empty-state when
          nothing was uploaded. Image inline, PDF in iframe. */}
      <div className="card !p-0 overflow-hidden">
        <div className="px-4 py-3 border-b border-borderc bg-bg/50 flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-brand-dark inline-flex items-center gap-1.5">
            <FileText className="w-4 h-4" /> Bill / Receipt
          </h2>
          {data.attachmentSignedUrl && (
            <a
              href={data.attachmentSignedUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[11px] text-accentBlue hover:underline"
            >
              Open in new tab ↗
            </a>
          )}
        </div>
        {data.attachmentSignedUrl ? (
          <div className="bg-bg grid place-items-center">
            {isPdf ? (
              <iframe
                src={data.attachmentSignedUrl}
                title="bill"
                className="w-full h-[70vh] bg-white"
              />
            ) : (
              <img
                src={data.attachmentSignedUrl}
                alt={data.description}
                className="max-w-full max-h-[70vh] object-contain bg-white"
              />
            )}
          </div>
        ) : (
          <div className="bg-bg/40 py-10 text-center text-sm text-textSecondary italic">
            No bill or receipt attached.
            {canManage && (
              <>
                {" "}
                Use{" "}
                <button
                  type="button"
                  className="text-accentBlue hover:underline"
                  onClick={() => setEditOpen(true)}
                >
                  Edit
                </button>{" "}
                to upload one.
              </>
            )}
          </div>
        )}
      </div>

      {/* Audit footer — who recorded, when, last touched. */}
      <div className="text-[11px] text-textSecondary flex flex-wrap gap-x-3 gap-y-1 px-1">
        <span>
          Recorded by{" "}
          <span className="text-brand-dark font-semibold">
            {data.recordedByName ?? "—"}
          </span>{" "}
          on {format(new Date(data.createdAt), "dd MMM yyyy, h:mm a")}
        </span>
        {data.updatedAt && data.updatedAt !== data.createdAt && (
          <span>
            · Last updated{" "}
            {format(new Date(data.updatedAt), "dd MMM yyyy, h:mm a")}
          </span>
        )}
      </div>

      {editOpen && (
        <ExpenseModal expense={data} onClose={() => setEditOpen(false)} />
      )}
    </div>
  );
}

// Small reusable label + value block. Keeps the cards visually
// consistent and lets the value be a string OR JSX (for the tel:
// link in the vendor card).
function Detail({
  label,
  icon,
  value,
  sub,
}: {
  label: string;
  icon?: React.ReactNode;
  value: React.ReactNode;
  sub?: string | null;
}) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-wider text-textSecondary font-semibold inline-flex items-center gap-1">
        {icon}
        {label}
      </div>
      <div className="text-sm text-brand-dark font-medium mt-0.5 break-words">
        {value}
      </div>
      {sub && <div className="text-[11px] text-textSecondary mt-0.5">{sub}</div>}
    </div>
  );
}

function Money({
  label,
  value,
  tone,
  sub,
}: {
  label: string;
  value: number;
  tone: "default" | "muted" | "primary";
  sub?: string;
}) {
  const toneClass =
    tone === "primary"
      ? "text-brand-dark font-bold"
      : tone === "muted"
        ? "text-textSecondary font-semibold"
        : "text-brand-dark font-semibold";
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-wider text-textSecondary font-semibold">
        {label}
      </div>
      <div className={`text-xl font-mono mt-1 ${toneClass}`}>{inr(value)}</div>
      {sub && <div className="text-[11px] text-textSecondary mt-0.5">{sub}</div>}
    </div>
  );
}
