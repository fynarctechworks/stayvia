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
import { CheckCircle2, FileText, Receipt, User, Wallet } from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useDialog } from "@/components/Dialog";
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

  const { data } = useQuery({
    queryKey: ["collections"],
    queryFn: () => api.get<OutstandingResp>("/reports/outstanding"),
    refetchInterval: 30_000,
  });

  const markReceived = useMutation({
    mutationFn: ({ id, method }: { id: string; method: string }) =>
      api.post(`/payments/${id}/mark-received`, { paymentMethod: method }),
    onSuccess: () => {
      invalidateReservationData(qc);
      toast("Marked as received", "success");
    },
    onError: (e: Error) => toast(e.message, "error"),
  });

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

  if (!data) return <Loader label="Loading collections…" />;

  // Top KPIs — sum every kind of outstanding so the headline number
  // matches what the guest profile / dashboard say. The age buckets
  // use the oldest-debt date per guest so a guest with a 2-month-old
  // advance and a 1-day-old invoice is classified by the older debt.
  const totalAcrossStreams = data.totalOutstanding;
  const ageCounts = data.byGuest.reduce(
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

  const totalGuestsOwing = data.byGuest.length;
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
          <h1 className="text-2xl font-bold text-brand-dark">Collections</h1>
          <p className="text-sm text-textSecondary mt-0.5">
            Money due from guests — issued invoices, advance pending on open
            stays, and "collect later" promises.
          </p>
        </div>
        <input
          className="input max-w-xs"
          placeholder="Search guest name or phone…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      </StickyBar>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="card">
          <div className="label">Total to collect</div>
          <Money
            value={totalAcrossStreams}
            className="block text-2xl font-bold text-danger font-mono mt-1"
          />
          <div className="text-xs text-textSecondary mt-0.5">
            {totalGuestsOwing} guest{totalGuestsOwing === 1 ? "" : "s"} owing
          </div>
        </div>
        <div className="card">
          <div className="label">Within 7 days</div>
          <Money
            value={ageCounts.fresh}
            className="block text-2xl font-bold text-success font-mono mt-1"
          />
          <div className="text-xs text-textSecondary mt-0.5">
            {ageCounts.fresh_count} guest(s)
          </div>
        </div>
        <div className="card">
          <div className="label">8–30 days</div>
          <Money
            value={ageCounts.warm}
            className="block text-2xl font-bold text-warning font-mono mt-1"
          />
          <div className="text-xs text-textSecondary mt-0.5">
            {ageCounts.warm_count} guest(s)
          </div>
        </div>
        <div className="card">
          <div className="label">Over 30 days</div>
          <Money
            value={ageCounts.old}
            className="block text-2xl font-bold text-danger font-mono mt-1"
          />
          <div className="text-xs text-textSecondary mt-0.5">
            {ageCounts.old_count} guest(s)
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
              <div className="card !p-0 overflow-x-auto">
                <table className="table-base">
                  <thead>
                    <tr>
                      <th>Guest</th>
                      <th>Phone</th>
                      <th>Oldest debt</th>
                      <th className="text-right">Balance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredByGuest.map((g) => {
                      const ageDays = daysSince(g.oldest);
                      const bucket = ageBucket(ageDays);
                      return (
                        <tr
                          key={g.guestId}
                          role="button"
                          tabIndex={0}
                          className="cursor-pointer hover:bg-brand-soft/30"
                          onClick={() => navigate(`/guests/${g.guestPhone}`)}
                        >
                          <td>
                            <div className="text-brand-dark font-semibold">
                              {g.guestName}
                            </div>
                          </td>
                          <td>
                            <div className="font-mono text-xs text-textSecondary">
                              {g.guestPhone}
                            </div>
                          </td>
                          <td className="text-xs">
                            {format(new Date(g.oldest), "dd MMM yyyy")}
                            <span
                              className={`ml-1.5 px-1.5 py-0.5 rounded-sm text-[10px] font-bold uppercase tracking-wider border ${
                                bucket === "fresh"
                                  ? "bg-success/15 text-success border-success/30"
                                  : bucket === "warm"
                                    ? "bg-warning/15 text-warning border-warning/30"
                                    : "bg-danger/15 text-danger border-danger/30"
                              }`}
                            >
                              {ageDays}d
                            </span>
                          </td>
                          <td className="text-right font-mono text-danger font-bold">
                            {inr(g.balance)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
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
              <div className="card !p-0 overflow-x-auto">
                <table className="table-base">
                  <thead>
                    <tr>
                      <th>Reservation</th>
                      <th>Guest</th>
                      <th>Stay</th>
                      <th>Status</th>
                      <th className="text-right">Total</th>
                      <th className="text-right">Advance Paid</th>
                      <th className="text-right">Balance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredPreInvoice.map((r) => (
                      <tr
                        key={r.reservationId}
                        role="button"
                        tabIndex={0}
                        className="cursor-pointer hover:bg-brand-soft/30"
                        onClick={() =>
                          navigate(`/reservations/${r.reservationNumber}`)
                        }
                      >
                        <td>
                          <span className="font-mono text-brand hover:underline">
                            {r.reservationNumber}
                          </span>
                        </td>
                        <td>
                          <div className="text-brand-dark font-medium">
                            {r.guestName}
                          </div>
                          <div className="text-xs text-textSecondary font-mono">
                            {r.guestPhone}
                          </div>
                        </td>
                        <td className="text-xs">
                          {format(new Date(r.checkInDate), "dd MMM")} →{" "}
                          {format(new Date(r.checkOutDate), "dd MMM yyyy")}
                          <div className="text-[10px] text-textSecondary">
                            booked {daysSince(r.createdAt)}d ago
                          </div>
                        </td>
                        <td className="text-xs capitalize">
                          {r.status.replace(/_/g, " ")}
                        </td>
                        <td className="text-right font-mono">
                          {inr(r.grandTotal)}
                        </td>
                        <td className="text-right font-mono text-success">
                          {inr(r.advancePaid)}
                        </td>
                        <td className="text-right font-mono text-danger font-semibold">
                          {inr(r.balanceDue)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
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
                sub="Bills already printed. Older than 7 days = warm; older than 30 = stale."
                count={filteredInvoices.length}
              />
              <div className="card !p-0 overflow-x-auto">
                <table className="table-base">
                  <thead>
                    <tr>
                      <th>Invoice</th>
                      <th>Reservation</th>
                      <th>Guest</th>
                      <th>Issued</th>
                      <th className="text-right">Total</th>
                      <th className="text-right">Paid</th>
                      <th className="text-right">Balance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredInvoices.map((r) => (
                      <tr
                        key={r.invoiceId}
                        role="button"
                        tabIndex={0}
                        className="cursor-pointer hover:bg-brand-soft/30"
                        onClick={() =>
                          navigate(`/reservations/${r.reservationNumber}`)
                        }
                      >
                        <td>
                          <span className="font-mono text-brand">
                            {r.invoiceNumber}
                          </span>
                        </td>
                        <td>
                          <span className="font-mono text-xs text-accentBlue">
                            {r.reservationNumber}
                          </span>
                        </td>
                        <td>
                          <div className="text-brand-dark font-medium">
                            {r.guestName}
                          </div>
                          <div className="text-xs text-textSecondary font-mono">
                            {r.guestPhone}
                          </div>
                        </td>
                        <td className="text-xs">
                          {format(new Date(r.issuedAt), "dd MMM yyyy")}
                          <div className="text-[10px] text-textSecondary">
                            {daysSince(r.issuedAt)}d ago
                          </div>
                        </td>
                        <td className="text-right font-mono">
                          {inr(r.grandTotal)}
                        </td>
                        <td className="text-right font-mono text-success">
                          {inr(r.totalPaid)}
                        </td>
                        <td className="text-right font-mono text-danger font-semibold">
                          {inr(r.balanceDue)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
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
              <div className="card !p-0 overflow-x-auto">
                <table className="table-base">
                  <thead>
                    <tr>
                      <th>Reservation</th>
                      <th>Guest</th>
                      <th>Reason</th>
                      <th>Promised</th>
                      <th className="text-right">Amount</th>
                      <th className="text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredPending.map((p) => (
                      <tr key={p.paymentId}>
                        <td>
                          <button
                            className="font-mono text-brand hover:underline"
                            onClick={() =>
                              navigate(`/reservations/${p.reservationNumber}`)
                            }
                          >
                            {p.reservationNumber}
                          </button>
                        </td>
                        <td>
                          <div>{p.guestName}</div>
                          <div className="text-xs text-textSecondary font-mono">
                            {p.guestPhone}
                          </div>
                        </td>
                        <td className="text-xs text-textSecondary">
                          {p.notes ?? ""}
                        </td>
                        <td>
                          {format(new Date(p.promisedAt), "dd MMM yyyy")}{" "}
                          <span className="text-xs text-textSecondary">
                            · {daysSince(p.promisedAt)}d ago
                          </span>
                        </td>
                        <td className="text-right font-mono text-danger font-semibold">
                          <Money value={p.amount} />
                        </td>
                        <td className="text-right">
                          <button
                            className="!h-7 !px-2 text-xs font-semibold rounded-sm bg-success text-white border-2 border-success hover:opacity-90 inline-flex items-center gap-1"
                            onClick={async () => {
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
                                  {
                                    value: "bank_transfer",
                                    label: "Bank transfer",
                                  },
                                ],
                              });
                              if (!chosen) return;
                              markReceived.mutate({
                                id: p.paymentId,
                                method: chosen,
                              });
                            }}
                            disabled={markReceived.isPending}
                          >
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            Mark Received
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
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
        <div className="text-xs uppercase tracking-wider text-textSecondary font-semibold inline-flex items-center gap-1.5">
          {icon}
          {title}
        </div>
        {sub && (
          <div className="text-[11px] text-textSecondary mt-0.5">{sub}</div>
        )}
      </div>
      <div className="text-[11px] text-textSecondary">
        {count} row{count === 1 ? "" : "s"}
      </div>
    </div>
  );
}
