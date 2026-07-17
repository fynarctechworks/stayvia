import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { Plus, Search, Wallet, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/auth/AuthContext";
import { useDialog } from "@/components/Dialog";
import { Loader } from "@/components/Loader";
import { StickyBar } from "@/components/StickyBar";
import { useToast } from "@/components/Toast";
import { ApiError, api, getList, newIdempotencyKey } from "@/lib/api";
import { invalidateReservationData } from "@/lib/invalidate";
import { inr } from "@/lib/utils";

interface CreditGuest {
  guestId: string;
  fullName: string;
  phone: string;
  email: string | null;
  balance: number;
  lastActivityAt: string | null;
  entryCount: number;
}

interface CreditsResp {
  guests: CreditGuest[];
  totalCredit: number;
  guestCount: number;
}

export default function Credits() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const dialog = useDialog();
  const qc = useQueryClient();
  const { can } = useAuth();
  const canAddCredit = can("manage_settings");
  const [search, setSearch] = useState("");
  const [cashoutFor, setCashoutFor] = useState<CreditGuest | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["credits", "guests"],
    queryFn: () => api.get<CreditsResp>("/credits/guests"),
    refetchInterval: 60_000,
  });

  const filtered = useMemo(() => {
    const list = data?.guests ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (g) =>
        g.fullName.toLowerCase().includes(q) ||
        g.phone.toLowerCase().includes(q) ||
        (g.email ?? "").toLowerCase().includes(q),
    );
  }, [data, search]);

  // One idempotency key per cashout intent (= one modal open). Regenerated
  // whenever a new cashout modal is opened, so retries of the same submit
  // share a key but two separate cashouts use different keys.
  const cashoutKey = useMemo(() => (cashoutFor ? newIdempotencyKey() : null), [cashoutFor]);

  const cashout = useMutation({
    mutationFn: ({ guestId, amount, note }: { guestId: string; amount: number; note?: string }) =>
      api.post(
        `/guests/${guestId}/ledger/cashout`,
        { amount, note },
        cashoutKey ? { idempotencyKey: cashoutKey } : undefined,
      ),
    onSuccess: (_data, vars) => {
      toast("Cashout recorded", "success");
      setCashoutFor(null);
      qc.invalidateQueries({ queryKey: ["credits", "guests"] });
      invalidateReservationData(qc, { guestId: vars.guestId });
    },
    onError: (e: unknown) => {
      const msg = e instanceof ApiError ? e.message : e instanceof Error ? e.message : "Failed";
      toast(msg, "error");
    },
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-brand-dark flex items-center gap-2">
            <Wallet className="w-6 h-6 text-brand" />
            Wallet Credits
          </h1>
          <div className="text-xs text-textSecondary mt-0.5">
            {data
              ? `${data.guestCount} guest${data.guestCount === 1 ? "" : "s"} with positive balance · ${inr(data.totalCredit)} total outstanding`
              : "Loading…"}
          </div>
        </div>
        {canAddCredit && (
          <button
            onClick={() => setShowAdd(true)}
            className="btn-primary inline-flex items-center gap-2"
          >
            <Plus className="w-4 h-4" /> Add credit
          </button>
        )}
      </div>

      <StickyBar>
      <div className="card">
        <div className="flex items-center gap-3">
          <Search className="w-4 h-4 text-textSecondary shrink-0" />
          <input
            className="input flex-1 border-0 focus:ring-0"
            placeholder="Search by name, phone, or email…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {search && (
            <button
              onClick={() => setSearch("")}
              className="text-xs text-textSecondary hover:text-danger"
              aria-label="Clear search"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>
      </StickyBar>

      <div className="card p-0 overflow-x-auto">
        {isLoading ? (
          <Loader />
        ) : filtered.length === 0 ? (
          <div className="p-8 text-center text-textSecondary">
            {data && data.guestCount === 0 ? (
              <>
                <Wallet className="w-10 h-10 mx-auto text-textSecondary/40 mb-2" />
                No guests have wallet credit at the moment. Credits are issued automatically when
                guests overpay at checkout (with refund mode = credit), or manually by an admin.
              </>
            ) : (
              "No guests match this search."
            )}
          </div>
        ) : (
          <table className="table-base">
            <thead>
              <tr>
                <th>Guest</th>
                <th>Phone</th>
                <th className="tabular-nums">Balance</th>
                <th>Last activity</th>
                <th className="text-right"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((g) => (
                <tr
                  key={g.guestId}
                  className="cursor-pointer"
                  onClick={() => navigate(`/guests/${g.phone}`)}
                >
                  <td>
                    <div className="font-semibold text-brand-dark">{g.fullName}</div>
                    {g.email && (
                      <div className="text-[10px] text-textSecondary">{g.email}</div>
                    )}
                  </td>
                  <td className="font-mono">{g.phone}</td>
                  <td className="font-mono tabular-nums font-bold text-brand-dark">
                    {inr(g.balance)}
                  </td>
                  <td className="text-textSecondary text-xs">
                    {g.lastActivityAt
                      ? formatDistanceToNow(new Date(g.lastActivityAt), { addSuffix: true })
                      : "—"}
                    <div className="text-[10px]">
                      {g.entryCount} ledger entr{g.entryCount === 1 ? "y" : "ies"}
                    </div>
                  </td>
                  <td
                    className="text-right"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div className="inline-flex gap-1">
                      <button
                        className="btn-secondary !h-7 !px-2 text-xs"
                        onClick={() => navigate(`/guests/${g.phone}`)}
                      >
                        Open
                      </button>
                      <button
                        className="btn-secondary !h-7 !px-2 text-xs"
                        onClick={() => setCashoutFor(g)}
                        disabled={cashout.isPending}
                      >
                        Cashout
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {cashoutFor && (
        <CashoutModal
          guest={cashoutFor}
          onClose={() => setCashoutFor(null)}
          onSubmit={async (amount, note) => {
            const ok = await dialog.confirm({
              title: "Confirm cashout",
              message: `Pay ${inr(amount)} cash to ${cashoutFor.fullName}? This deducts the amount from their wallet and creates a ledger entry.`,
              okLabel: "Confirm cashout",
              tone: "danger",
            });
            if (!ok) return;
            cashout.mutate({ guestId: cashoutFor.guestId, amount, note });
          }}
          pending={cashout.isPending}
        />
      )}

      {showAdd && (
        <AddCreditModal
          onClose={() => setShowAdd(false)}
          onAdded={(guestId, amount) => {
            toast(`Added ${inr(amount)} credit`, "success");
            setShowAdd(false);
            qc.invalidateQueries({ queryKey: ["credits", "guests"] });
            invalidateReservationData(qc, { guestId });
          }}
        />
      )}
    </div>
  );
}

// Search-with-debounce against the existing /guests endpoint. Picks a guest,
// then collects an amount + reason note. Hits the admin-only ledger/adjust
// endpoint; on success the parent invalidates caches.
interface MinimalGuest {
  id: string;
  fullName: string;
  phone: string;
  email: string | null;
}

function AddCreditModal({
  onClose,
  onAdded,
}: {
  onClose: () => void;
  onAdded: (guestId: string, amount: number) => void;
}) {
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [selected, setSelected] = useState<MinimalGuest | null>(null);
  const [amount, setAmount] = useState<number>(0);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  // One key per modal lifetime — survives re-renders, regenerated only on
  // re-mount. Retry submits get the same key (server replays the cached
  // response); next modal open gets a fresh key.
  const idempotencyKey = useMemo(() => newIdempotencyKey(), []);

  // 250ms debounce so we don't fire /guests on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  // Lock background scroll + Escape closes.
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

  const guestsQ = useQuery({
    queryKey: ["credits-add-search", debouncedQuery],
    queryFn: () =>
      getList<MinimalGuest>("/guests", { search: debouncedQuery, per_page: 8 }),
    enabled: debouncedQuery.length >= 2 && !selected,
  });

  const add = useMutation({
    mutationFn: () =>
      api.post(
        `/guests/${selected!.id}/ledger/adjust`,
        { amount, note: note.trim() },
        { idempotencyKey },
      ),
    onSuccess: () => onAdded(selected!.id, amount),
    onError: (e: unknown) => {
      setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : "Failed");
    },
  });

  const invalid =
    !selected || amount <= 0.009 || note.trim().length === 0 || add.isPending;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-brand-dark/40 p-4">
      <div
        className="my-auto w-full max-w-md bg-white rounded-md shadow-xl border border-borderc"
        role="dialog"
        aria-modal="true"
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-borderc bg-brand-soft">
          <div className="flex items-center gap-2">
            <Plus className="w-4 h-4 text-brand" />
            <div className="font-semibold text-brand-dark">Add wallet credit</div>
          </div>
          <button onClick={onClose} className="text-textSecondary hover:text-textPrimary">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-5 py-4 text-[13px] text-textPrimary space-y-3">
          {/* Step 1: pick a guest */}
          <div>
            <label className="label block mb-1">Guest</label>
            {selected ? (
              <div className="flex items-center justify-between border border-borderc rounded-sm bg-cream/40 px-3 py-2">
                <div>
                  <div className="font-semibold text-brand-dark">{selected.fullName}</div>
                  <div className="font-mono text-xs text-textSecondary">
                    {selected.phone}
                    {selected.email ? ` · ${selected.email}` : ""}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setSelected(null);
                    setQuery("");
                  }}
                  className="text-xs text-textSecondary hover:text-danger"
                >
                  Change
                </button>
              </div>
            ) : (
              <>
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-textSecondary" />
                  <input
                    className="input pl-9"
                    placeholder="Search by name or phone (min 2 chars)…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    autoFocus
                  />
                </div>
                {debouncedQuery.length >= 2 && (
                  <div className="mt-2 border border-borderc rounded-sm max-h-48 overflow-y-auto">
                    {guestsQ.isLoading ? (
                      <div className="px-3 py-2 text-textSecondary text-xs">Searching…</div>
                    ) : (guestsQ.data?.data ?? []).length === 0 ? (
                      <div className="px-3 py-2 text-textSecondary text-xs">
                        No guests match "{debouncedQuery}".
                      </div>
                    ) : (
                      (guestsQ.data?.data ?? []).map((g) => (
                        <button
                          key={g.id}
                          type="button"
                          onClick={() => setSelected(g)}
                          className="w-full text-left px-3 py-2 hover:bg-brand-soft border-b border-borderc/60 last:border-b-0"
                        >
                          <div className="font-semibold text-brand-dark text-xs">
                            {g.fullName}
                          </div>
                          <div className="font-mono text-[11px] text-textSecondary">
                            {g.phone}
                            {g.email ? ` · ${g.email}` : ""}
                          </div>
                        </button>
                      ))
                    )}
                  </div>
                )}
              </>
            )}
          </div>

          {/* Step 2: amount + note (enabled once a guest is picked) */}
          <div>
            <label className="label block mb-1">Amount (₹)</label>
            <input
              type="number"
              className="input"
              min={0}
              step="0.01"
              value={amount || ""}
              onChange={(e) => setAmount(Number(e.target.value))}
              disabled={!selected}
              placeholder="0.00"
            />
          </div>

          <div>
            <label className="label block mb-1">
              Reason / note <span className="text-danger">*</span>
            </label>
            <input
              className="input"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. Goodwill for AC issue, prepaid voucher, etc."
              maxLength={500}
              disabled={!selected}
            />
            <div className="text-[10px] text-textSecondary mt-1">
              Recorded in the audit log. Required by policy.
            </div>
          </div>

          {error && (
            <div className="p-2 rounded-sm bg-danger/10 text-danger text-[12px]">{error}</div>
          )}
        </div>

        <div className="flex justify-end gap-2 px-5 py-3 border-t border-borderc bg-bg">
          <button onClick={onClose} className="btn-secondary">
            Cancel
          </button>
          <button
            onClick={() => add.mutate()}
            disabled={invalid}
            className="btn-primary"
          >
            {add.isPending ? "Adding…" : `Add ${amount ? inr(amount) : "credit"}`}
          </button>
        </div>
      </div>
    </div>
  );
}

function CashoutModal({
  guest,
  onClose,
  onSubmit,
  pending,
}: {
  guest: CreditGuest;
  onClose: () => void;
  onSubmit: (amount: number, note?: string) => void;
  pending: boolean;
}) {
  const [amount, setAmount] = useState<number>(guest.balance);
  const [note, setNote] = useState("");
  const overMax = amount > guest.balance + 0.009;
  const invalid = amount <= 0.009 || overMax;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-brand-dark/40 p-4">
      <div
        className="my-auto w-full max-w-md bg-white rounded-md shadow-xl border border-borderc"
        role="dialog"
        aria-modal="true"
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-borderc bg-brand-soft">
          <div className="flex items-center gap-2">
            <Wallet className="w-4 h-4 text-brand" />
            <div className="font-semibold text-brand-dark">Cashout wallet credit</div>
          </div>
          <button onClick={onClose} className="text-textSecondary hover:text-textPrimary">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-5 py-4 text-[13px] text-textPrimary space-y-3">
          <div>
            <div className="font-semibold text-brand-dark">{guest.fullName}</div>
            <div className="font-mono text-xs">{guest.phone}</div>
          </div>

          <div className="border border-borderc rounded-sm p-3">
            <div className="text-[10px] uppercase tracking-wider text-textSecondary font-semibold">
              Available balance
            </div>
            <div className="font-mono text-lg font-bold text-brand-dark mt-0.5">
              {inr(guest.balance)}
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="label">Amount to pay out (₹)</label>
              <button
                type="button"
                onClick={() => setAmount(guest.balance)}
                className="text-[11px] text-brand hover:underline"
              >
                Full balance
              </button>
            </div>
            <input
              type="number"
              className="input"
              min={0}
              max={guest.balance}
              step="0.01"
              value={amount || ""}
              onChange={(e) => setAmount(Number(e.target.value))}
            />
            {overMax && (
              <div className="text-[11px] text-danger mt-1">
                Exceeds available balance.
              </div>
            )}
          </div>

          <div>
            <label className="label block mb-1">Note (optional)</label>
            <input
              className="input"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. Cash refund handed at front desk"
              maxLength={500}
            />
          </div>

          <div className="text-[11px] text-textSecondary">
            This creates a <code className="font-mono bg-bg px-1 rounded">cashout</code> ledger
            entry. The guest's wallet balance drops by this amount. Hand the cash over to the
            guest after confirming.
          </div>
        </div>

        <div className="flex justify-end gap-2 px-5 py-3 border-t border-borderc bg-bg">
          <button onClick={onClose} className="btn-secondary">
            Cancel
          </button>
          <button
            onClick={() => onSubmit(amount, note.trim() || undefined)}
            disabled={invalid || pending}
            className="btn-primary"
          >
            {pending ? "Processing…" : `Pay out ${inr(amount)}`}
          </button>
        </div>
      </div>
    </div>
  );
}
