// Collections — every flavour of money owed by guests, in one place.
//
// The /reports/outstanding endpoint returns three streams of debt
// that map to three different situations:
//
//   1. invoices       — issued invoices that still have a balance
//                       (partial paid, or not paid at all)
//   2. preInvoice     — active reservations with a non-zero balance
//                       that haven't been invoiced yet (advance pending,
//                       stay still open). This is the largest bucket
//                       in practice and was missing from the previous
//                       version of this page entirely.
//   3. pendingPayments — payments staff explicitly marked as
//                       "collect later" via the 'unpaid' method.
//                       Niche; staff use this when the guest leaves
//                       promising to pay later.
//
// All three contribute to "money the property is owed". Previously
// only stream 3 was rendered, so the page falsely said "everyone's
// paid up" when guests had ₹thousands of advance pending.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { CheckCircle2, FileText, Receipt, User, Wallet } from "@/lib/micons";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useDialog } from "@/components/Dialog";
import { PageError } from "@/components/kit";
import { Loader } from "@/components/Loader";
import { StickyBar } from "@/components/StickyBar";
import { Money, useMaskedInr } from "@/components/Money";
import { useToast } from "@/components/Toast";
import { api } from "@/lib/api";
import { invalidateReservationData } from "@/lib/invalidate";
import { inr } from "@/lib/utils";

interface InvoiceRow {
  invoiceId: string;
  invoiceNumber: string;
  reservationId: string;
  reservationNumber: string;
  guestId: string;
  guestName: string;
  guestPhone: string;
  grandTotal: string;
  totalPaid: string;
  balanceDue: string;
  status: string;
  issuedAt: string;
  checkedOutAt: string | null;
}

interface PreInvoiceRow {
  reservationId: string;
  reservationNumber: string;
  guestId: string;
  guestName: string;
  guestPhone: string;
  grandTotal: string;
  advancePaid: string;
  balanceDue: string;
  status: string;
  checkInDate: string;
  checkOutDate: string;
  createdAt: string;
}

interface PendingPaymentRow {
  paymentId: string;
  invoiceId: string | null;
  reservationId: string;
  reservationNumber: string;
  guestId: string;
  guestName: string;
  guestPhone: string;
  amount: string;
  notes: string | null;
  promisedAt: string;
}

interface ByGuestRow {
  guestId: string;
  guestName: string;
  guestPhone: string;
  balance: number;
  oldest: string;
}

interface OutstandingResp {
  invoices: InvoiceRow[];
  preInvoice: PreInvoiceRow[];
  pendingPayments: PendingPaymentRow[];
  byGuest: ByGuestRow[];
  totalOutstanding: number;
}

function daysSince(iso: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86400000));
}

function ageBucket(days: number): "fresh" | "warm" | "old" {
  if (days <= 7) return "fresh";
  if (days <= 30) return "warm";
  return "old";
}

export default function Collections() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { toast } = useToast();
  const dialog = useDialog();
  const maskedInr = useMaskedInr();
  const [search, setSearch] = useState("");

  const outstandingQ = useQuery({
    queryKey: ["collections"],
    queryFn: () => api.get<OutstandingResp>("/reports/outstanding"),
    refetchInterval: 30_000,
  });
  const data = outstandingQ.data;

  const markReceived = useMutation({
    mutationFn: ({ id, method }: { id: string; method: string }) =>
      api.post(`/payments/${id}/mark-received`, { paymentMethod: method }),
    onSuccess: () => {
      invalidateReservationData(qc);
      toast("Marked as received", "success");
    },
    onError: (e: Error) => toast(e.message, "error"),
  });

  // Shared by the desktop row button and the mobile card button so the
  // prompt/mutate flow lives in exactly one place.
  async function askAndMarkReceived(p: PendingPaymentRow) {
    const chosen = await dialog.prompt({
      title: "Mark payment received",
      message: `Confirm collection of ${maskedInr(p.amount)} from ${p.guestName}.`,
      okLabel: "Mark received",
      tone: "success",
      required: true,
      defaultValue: "cash",
      options: [
        { value: "cash", label: "Cash" },
        { value: "upi", label: "UPI" },
        { value: "card", label: "Card" },
        { value: "bank_transfer", label: "Bank transfer" },
      ],
    });
    if (!chosen) return;
    markReceived.mutate({ id: p.paymentId, method: chosen });
  }

  const q = search.trim().toLowerCase();
  // The match predicate is inlined inside each useMemo (rather than
  // hoisted to a top-level `matches` function) so the memos depend
  // only on `data` and `q`. A hoisted function would be a new
  // reference every render, invalidating these memos for free.
  const filteredInvoices = useMemo(
    () =>
      (data?.invoices ?? []).filter(
        (r) =>
          !q ||
          r.guestName.toLowerCase().includes(q) ||
          r.guestPhone.toLowerCase().includes(q),
      ),
    [data, q],
  );
  const filteredPreInvoice = useMemo(
    () =>
      (data?.preInvoice ?? []).filter(
        (r) =>
          !q ||
          r.guestName.toLowerCase().includes(q) ||
          r.guestPhone.toLowerCase().includes(q),
      ),
    [data, q],
  );
  const filteredPending = useMemo(
    () =>
      (data?.pendingPayments ?? []).filter(
        (p) =>
          !q ||
          p.guestName.toLowerCase().includes(q) ||
          p.guestPhone.toLowerCase().includes(q),
      ),
    [data, q],
  );
  const filteredByGuest = useMemo(
    () =>
      (data?.byGuest ?? []).filter(
        (g) =>
          !q ||
          g.guestName.toLowerCase().includes(q) ||
          g.guestPhone.toLowerCase().includes(q),
      ),
    [data, q],
  );

  // Error branch first. `data` never arrives on a persistent 403 (this
  // endpoint needs view_revenue) or a 500, and the old `if (!data)` spinner
  // rendered that dead request as "still loading" forever — staff could not
  // tell whether the property was owed ₹0 or ₹2,00,000.
  if (outstandingQ.isError)
    return (
      <PageError
        error={outstandingQ.error}
        onRetry={() => void outstandingQ.refetch()}
        isRetrying={outstandingQ.isFetching}
        backTo="/"
        backLabel="Back to dashboard"
      />
    );
  if (!data) return <Loader label="Loading collections…" />;

  // Top KPIs — sum every kind of outstanding so the headline number
  // matches what the guest profile / dashboard say. The age buckets
  // use the oldest-debt date per guest so a guest with a 2-month-old
  // advance and a 1-day-old invoice is classified by the older debt.
  // Computed from the *filtered* guest list so the cards always describe
  // the rows actually on screen; with an empty search this equals the
  // server's totalOutstanding, which is the sum of byGuest balances.
  const totalAcrossStreams = filteredByGuest.reduce((s, g) => s + g.balance, 0);
  const ageCounts = filteredByGuest.reduce(
    (acc, g) => {
      const b = ageBucket(daysSince(g.oldest));
      acc[b] += g.balance;
      acc[`${b}_count`] = (acc[`${b}_count` as never] as number) + 1;
      return acc;
    },
    { fresh: 0, warm: 0, old: 0, fresh_count: 0, warm_count: 0, old_count: 0 } as Record<
      string,
      number
    >,
  );

  const totalGuestsOwing = filteredByGuest.length;
  const everyoneClear =
    filteredInvoices.length === 0 &&
    filteredPreInvoice.length === 0 &&
    filteredPending.length === 0 &&
    filteredByGuest.length === 0;

  return (
    <div className="space-y-5">
      <StickyBar>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">Collections</h1>
          <p className="text-sm text-textSecondary mt-1 max-w-xl">
            Money due from guests - issued invoices, advance pending on open
            stays, and "collect later" promises.
          </p>
        </div>
        <input
          className="input w-full sm:w-auto sm:max-w-xs"
          placeholder="Search guest name or phone…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      </StickyBar>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="card !rounded-[14px]">
          <div className="label">Total to collect</div>
          <Money
            value={totalAcrossStreams}
            className="block text-xl sm:text-2xl font-bold text-dangerFg font-mono mt-1.5 tabular-nums"
          />
          <div className="text-[11px] text-inkMuted mt-1">
            {totalGuestsOwing} guest{totalGuestsOwing === 1 ? "" : "s"} owing
          </div>
          {q && (
            <div className="text-[11px] text-inkFaint">
              matching "{search.trim()}"
            </div>
          )}
        </div>
        <div className="card !rounded-[14px]">
          <div className="label">Within 7 days</div>
          <Money
            value={ageCounts.fresh}
            className="block text-xl sm:text-2xl font-bold text-success font-mono mt-1.5 tabular-nums"
          />
          <div className="text-[11px] text-inkMuted mt-1">
            {ageCounts.fresh_count} guest{ageCounts.fresh_count === 1 ? "" : "s"}
          </div>
        </div>
        <div className="card !rounded-[14px]">
          <div className="label">8–30 days</div>
          <Money
            value={ageCounts.warm}
            className="block text-xl sm:text-2xl font-bold text-warnFg font-mono mt-1.5 tabular-nums"
          />
          <div className="text-[11px] text-inkMuted mt-1">
            {ageCounts.warm_count} guest{ageCounts.warm_count === 1 ? "" : "s"}
          </div>
        </div>
        <div className="card !rounded-[14px]">
          <div className="label">Over 30 days</div>
          <Money
            value={ageCounts.old}
            className="block text-xl sm:text-2xl font-bold text-dangerFg font-mono mt-1.5 tabular-nums"
          />
          <div className="text-[11px] text-inkMuted mt-1">
            {ageCounts.old_count} guest{ageCounts.old_count === 1 ? "" : "s"}
          </div>
        </div>
      </div>

      {everyoneClear ? (
        <div className="card flex flex-col items-center justify-center py-16 text-center text-textSecondary">
          <Wallet className="w-10 h-10 mb-3 opacity-40" />
          <div className="text-sm">
            {q
              ? "No guests with outstanding balance match this search."
              : "No pending collections. Everyone's paid up."}
          </div>
        </div>
      ) : (
        <>
          {/* Per-guest summary. Each row aggregates everything that
              guest owes (across all reservations + invoices) so staff
              can see "who owes me money" at a glance, regardless of
              how many open bookings each guest has. Click → guest
              profile to see the breakdown. */}
          {filteredByGuest.length > 0 && (
            <section>
              <SectionHeader
                icon={<User className="w-4 h-4" />}
                title="By guest"
                sub="Total balance per guest across every reservation and invoice."
                count={filteredByGuest.length}
              />
              <div className="card !p-0 overflow-hidden">
                <div className="hidden lg:grid grid-cols-[minmax(180px,1fr)_150px_210px_140px] gap-3 px-3 py-2.5 text-[10px] font-bold uppercase tracking-[0.06em] text-inkMuted bg-surfaceAlt border-b border-divider">
                  <div>Guest</div>
                  <div>Phone</div>
                  <div>Oldest debt</div>
                  <div className="text-right">Balance</div>
                </div>
                <ul className="divide-y divide-divider">
                  {filteredByGuest.map((g) => {
                    const ageDays = daysSince(g.oldest);
                    const bucket = ageBucket(ageDays);
                    const agePill = `px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider border ${
                      bucket === "fresh"
                        ? "bg-successBg text-success border-successBorder"
                        : bucket === "warm"
                          ? "bg-warnBg text-warnFg border-warnBorder"
                          : "bg-dangerBg text-dangerFg border-dangerBorder"
                    }`;
                    return (
                      <li
                        key={g.guestId}
                        role="button"
                        tabIndex={0}
                        className="cursor-pointer hover:bg-surfaceAlt transition-colors"
                        onClick={() => navigate(`/guests/${g.guestPhone}`)}
                      >
                        {/* DESKTOP */}
                        <div className="hidden lg:grid grid-cols-[minmax(180px,1fr)_150px_210px_140px] gap-3 items-center px-3 py-2.5">
                          <div className="min-w-0 text-ink font-semibold truncate">
                            {g.guestName}
                          </div>
                          <div className="font-mono text-xs text-inkMuted truncate">
                            {g.guestPhone}
                          </div>
                          <div className="text-xs">
                            {format(new Date(g.oldest), "dd MMM yyyy")}
                            <span className={`ml-1.5 ${agePill}`}>{ageDays}d</span>
                          </div>
                          <div className="text-right font-mono text-dangerFg font-bold">
                            {inr(g.balance)}
                          </div>
                        </div>

                        {/* MOBILE */}
                        <div className="lg:hidden flex items-start justify-between gap-2 px-3 py-3">
                          <div className="min-w-0 flex-1">
                            <div className="text-sm text-ink font-semibold truncate">
                              {g.guestName}
                            </div>
                            <div className="font-mono text-[11px] text-inkMuted mt-0.5 truncate">
                              {g.guestPhone}
                            </div>
                            <div className="text-[11px] text-inkFaint mt-1">
                              oldest {format(new Date(g.oldest), "dd MMM yyyy")}
                            </div>
                          </div>
                          <div className="text-right shrink-0">
                            <div className="font-mono text-sm text-dangerFg font-bold">
                              {inr(g.balance)}
                            </div>
                            <span className={`inline-block mt-1 ${agePill}`}>
                              {ageDays}d
                            </span>
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            </section>
          )}

          {/* Stream 2 — open advance / unissued invoices. Biggest bucket
              in practice and the one that was silently missing before. */}
          {filteredPreInvoice.length > 0 && (
            <section>
              <SectionHeader
                icon={<Wallet className="w-4 h-4" />}
                title="Advance pending · stays still open"
                sub="Bookings with a balance that haven't been checked out / invoiced yet."
                count={filteredPreInvoice.length}
              />
              <div className="card !p-0 overflow-hidden">
                <div className="hidden lg:grid grid-cols-[130px_minmax(160px,1fr)_170px_110px_110px_120px_120px] gap-3 px-3 py-2.5 text-[10px] font-bold uppercase tracking-[0.06em] text-inkMuted bg-surfaceAlt border-b border-divider">
                  <div>Reservation</div>
                  <div>Guest</div>
                  <div>Stay</div>
                  <div>Status</div>
                  <div className="text-right">Total</div>
                  <div className="text-right">Advance Paid</div>
                  <div className="text-right">Balance</div>
                </div>
                <ul className="divide-y divide-divider">
                  {filteredPreInvoice.map((r) => (
                    <li
                      key={r.reservationId}
                      role="button"
                      tabIndex={0}
                      className="cursor-pointer hover:bg-surfaceAlt transition-colors"
                      onClick={() =>
                        navigate(`/reservations/${r.reservationNumber}`)
                      }
                    >
                      {/* DESKTOP */}
                      <div className="hidden lg:grid grid-cols-[130px_minmax(160px,1fr)_170px_110px_110px_120px_120px] gap-3 items-center px-3 py-2.5">
                        <div className="font-mono text-xs font-semibold text-brand-deep hover:underline truncate">
                          {r.reservationNumber}
                        </div>
                        <div className="min-w-0">
                          <div className="text-ink font-medium truncate">
                            {r.guestName}
                          </div>
                          <div className="text-xs text-inkMuted font-mono truncate">
                            {r.guestPhone}
                          </div>
                        </div>
                        <div className="text-xs">
                          {format(new Date(r.checkInDate), "dd MMM")} →{" "}
                          {format(new Date(r.checkOutDate), "dd MMM yyyy")}
                          <div className="text-[10px] text-inkFaint">
                            booked {daysSince(r.createdAt)}d ago
                          </div>
                        </div>
                        <div className="text-xs capitalize">
                          {r.status.replace(/_/g, " ")}
                        </div>
                        <div className="text-right font-mono text-sm">
                          {inr(r.grandTotal)}
                        </div>
                        <div className="text-right font-mono text-sm text-success">
                          {inr(r.advancePaid)}
                        </div>
                        <div className="text-right font-mono text-sm text-dangerFg font-bold">
                          {inr(r.balanceDue)}
                        </div>
                      </div>

                      {/* MOBILE */}
                      <div className="lg:hidden px-3 py-3">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0 flex-1">
                            <div className="font-mono text-xs font-semibold text-brand-deep truncate">
                              {r.reservationNumber}
                            </div>
                            <div className="text-sm text-ink font-medium truncate mt-0.5">
                              {r.guestName}
                            </div>
                            <div className="text-[11px] text-inkMuted font-mono truncate">
                              {r.guestPhone}
                            </div>
                            <div className="text-[11px] text-inkFaint mt-1">
                              {format(new Date(r.checkInDate), "dd MMM")} →{" "}
                              {format(new Date(r.checkOutDate), "dd MMM yyyy")} ·
                              booked {daysSince(r.createdAt)}d ago
                            </div>
                          </div>
                          <div className="text-right shrink-0">
                            <div className="font-mono text-sm text-dangerFg font-bold">
                              {inr(r.balanceDue)}
                            </div>
                            <div className="text-[10px] text-inkMuted font-mono mt-0.5">
                              of {inr(r.grandTotal)}
                            </div>
                            <div className="text-[10px] text-success font-mono">
                              paid {inr(r.advancePaid)}
                            </div>
                          </div>
                        </div>
                        <div className="text-[11px] text-inkMuted capitalize mt-1.5">
                          {r.status.replace(/_/g, " ")}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            </section>
          )}

          {/* Stream 1 — invoices that have been issued but still have
              a balance. Includes partial and fully-unpaid issued. */}
          {filteredInvoices.length > 0 && (
            <section>
              <SectionHeader
                icon={<FileText className="w-4 h-4" />}
                title="Issued invoices · partial or unpaid"
                sub="Bills already printed. Age shown is days since the invoice was issued."
                count={filteredInvoices.length}
              />
              <div className="card !p-0 overflow-hidden">
                <div className="hidden lg:grid grid-cols-[140px_130px_minmax(160px,1fr)_140px_110px_120px_120px] gap-3 px-3 py-2.5 text-[10px] font-bold uppercase tracking-[0.06em] text-inkMuted bg-surfaceAlt border-b border-divider">
                  <div>Invoice</div>
                  <div>Reservation</div>
                  <div>Guest</div>
                  <div>Issued</div>
                  <div className="text-right">Total</div>
                  <div className="text-right">Paid</div>
                  <div className="text-right">Balance</div>
                </div>
                <ul className="divide-y divide-divider">
                  {filteredInvoices.map((r) => (
                    <li
                      key={r.invoiceId}
                      role="button"
                      tabIndex={0}
                      className="cursor-pointer hover:bg-surfaceAlt transition-colors"
                      onClick={() =>
                        navigate(`/reservations/${r.reservationNumber}`)
                      }
                    >
                      {/* DESKTOP */}
                      <div className="hidden lg:grid grid-cols-[140px_130px_minmax(160px,1fr)_140px_110px_120px_120px] gap-3 items-center px-3 py-2.5">
                        <div className="font-mono text-xs font-semibold text-brand-deep truncate">
                          {r.invoiceNumber}
                        </div>
                        <div className="font-mono text-xs text-accentBlue truncate">
                          {r.reservationNumber}
                        </div>
                        <div className="min-w-0">
                          <div className="text-ink font-medium truncate">
                            {r.guestName}
                          </div>
                          <div className="text-xs text-inkMuted font-mono truncate">
                            {r.guestPhone}
                          </div>
                        </div>
                        <div className="text-xs">
                          {format(new Date(r.issuedAt), "dd MMM yyyy")}
                          <div className="text-[10px] text-inkFaint">
                            {daysSince(r.issuedAt)}d ago
                          </div>
                        </div>
                        <div className="text-right font-mono text-sm">
                          {inr(r.grandTotal)}
                        </div>
                        <div className="text-right font-mono text-sm text-success">
                          {inr(r.totalPaid)}
                        </div>
                        <div className="text-right font-mono text-sm text-dangerFg font-bold">
                          {inr(r.balanceDue)}
                        </div>
                      </div>

                      {/* MOBILE */}
                      <div className="lg:hidden px-3 py-3">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0 flex-1">
                            <div className="font-mono text-xs font-semibold text-brand-deep truncate">
                              {r.invoiceNumber}
                            </div>
                            <div className="text-sm text-ink font-medium truncate mt-0.5">
                              {r.guestName}
                            </div>
                            <div className="text-[11px] text-inkMuted font-mono truncate">
                              {r.guestPhone}
                            </div>
                            <div className="font-mono text-[11px] text-accentBlue mt-1 truncate">
                              {r.reservationNumber}
                            </div>
                            <div className="text-[11px] text-inkFaint mt-0.5">
                              issued {format(new Date(r.issuedAt), "dd MMM yyyy")} ·{" "}
                              {daysSince(r.issuedAt)}d ago
                            </div>
                          </div>
                          <div className="text-right shrink-0">
                            <div className="font-mono text-sm text-dangerFg font-bold">
                              {inr(r.balanceDue)}
                            </div>
                            <div className="text-[10px] text-inkMuted font-mono mt-0.5">
                              of {inr(r.grandTotal)}
                            </div>
                            <div className="text-[10px] text-success font-mono">
                              paid {inr(r.totalPaid)}
                            </div>
                          </div>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            </section>
          )}

          {/* Stream 3 — explicit "collect later" promises. Has its own
              Mark Received button because each row is a single payment
              the staff can settle in one click. */}
          {filteredPending.length > 0 && (
            <section>
              <SectionHeader
                icon={<Receipt className="w-4 h-4" />}
                title='Pending payments · marked "collect later"'
                sub="Specific amounts the guest promised at check-out. Mark each as received once the cash arrives."
                count={filteredPending.length}
              />
              <div className="card !p-0 overflow-hidden">
                <div className="hidden lg:grid grid-cols-[120px_minmax(150px,1fr)_minmax(140px,1fr)_160px_110px_150px] gap-3 px-3 py-2.5 text-[10px] font-bold uppercase tracking-[0.06em] text-inkMuted bg-surfaceAlt border-b border-divider">
                  <div>Reservation</div>
                  <div>Guest</div>
                  <div>Reason</div>
                  <div>Promised</div>
                  <div className="text-right">Amount</div>
                  <div className="text-right">Action</div>
                </div>
                <ul className="divide-y divide-divider">
                  {filteredPending.map((p) => (
                    <li key={p.paymentId}>
                      {/* DESKTOP */}
                      <div className="hidden lg:grid grid-cols-[120px_minmax(150px,1fr)_minmax(140px,1fr)_160px_110px_150px] gap-3 items-center px-3 py-2.5">
                        <div className="min-w-0">
                          <button
                            className="font-mono text-xs font-semibold text-brand-deep hover:underline truncate block"
                            onClick={() =>
                              navigate(`/reservations/${p.reservationNumber}`)
                            }
                          >
                            {p.reservationNumber}
                          </button>
                        </div>
                        <div className="min-w-0">
                          <div className="text-ink font-semibold truncate">{p.guestName}</div>
                          <div className="text-xs text-inkMuted font-mono truncate">
                            {p.guestPhone}
                          </div>
                        </div>
                        <div className="text-xs text-inkMuted break-words">
                          {p.notes ?? ""}
                        </div>
                        <div className="text-sm">
                          {format(new Date(p.promisedAt), "dd MMM yyyy")}{" "}
                          <span className="text-xs text-inkFaint">
                            · {daysSince(p.promisedAt)}d ago
                          </span>
                        </div>
                        <div className="text-right font-mono text-dangerFg font-bold">
                          <Money value={p.amount} />
                        </div>
                        <div className="text-right">
                          <button
                            className="!h-7 !px-2.5 text-xs font-semibold rounded-sm bg-success text-white border border-success hover:opacity-90 disabled:opacity-50 inline-flex items-center gap-1"
                            onClick={() => askAndMarkReceived(p)}
                            disabled={markReceived.isPending}
                          >
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            Mark Received
                          </button>
                        </div>
                      </div>

                      {/* MOBILE */}
                      <div className="lg:hidden px-3 py-3">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0 flex-1">
                            <button
                              className="font-mono text-xs font-semibold text-brand-deep hover:underline inline-flex items-center min-h-[24px] truncate"
                              onClick={() =>
                                navigate(`/reservations/${p.reservationNumber}`)
                              }
                            >
                              {p.reservationNumber}
                            </button>
                            <div className="text-sm text-ink font-semibold truncate">
                              {p.guestName}
                            </div>
                            <div className="text-[11px] text-inkMuted font-mono truncate">
                              {p.guestPhone}
                            </div>
                            <div className="text-[11px] text-inkFaint mt-1">
                              promised {format(new Date(p.promisedAt), "dd MMM yyyy")} ·{" "}
                              {daysSince(p.promisedAt)}d ago
                            </div>
                            {p.notes && (
                              <div className="text-[11px] text-inkMuted mt-0.5 break-words">
                                {p.notes}
                              </div>
                            )}
                          </div>
                          <div className="text-right shrink-0 font-mono text-sm text-dangerFg font-bold">
                            <Money value={p.amount} />
                          </div>
                        </div>
                        <button
                          className="mt-2.5 w-full min-h-[44px] text-xs font-semibold rounded-sm bg-success text-white border border-success hover:opacity-90 disabled:opacity-50 inline-flex items-center justify-center gap-1.5"
                          onClick={() => askAndMarkReceived(p)}
                          disabled={markReceived.isPending}
                        >
                          <CheckCircle2 className="w-4 h-4" />
                          Mark Received
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}

function SectionHeader({
  icon,
  title,
  sub,
  count,
}: {
  icon: React.ReactNode;
  title: string;
  sub?: string;
  count: number;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 mb-2 flex-wrap">
      <div>
        <div className="text-[11px] font-bold uppercase tracking-[0.07em] text-inkMuted inline-flex items-center gap-1.5">
          {icon}
          {title}
        </div>
        {sub && (
          <div className="text-[11px] text-inkFaint mt-0.5">{sub}</div>
        )}
      </div>
      <div className="text-[11px] text-inkFaint">
        {count} row{count === 1 ? "" : "s"}
      </div>
    </div>
  );
}
