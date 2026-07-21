import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { BedDouble, Bell, CalendarPlus, CheckCircle2, ExternalLink, FileImage, Pencil, Plus, ShieldCheck, Trash2, Upload, Wallet, X } from "@/lib/micons";
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Can } from "@/auth/Can";
import { useAuth } from "@/auth/AuthContext";
import { useDialog } from "@/components/Dialog";
import { KycModal } from "@/components/KycModal";
import { Loader } from "@/components/Loader";
import { Combobox } from "@/components/Combobox";
import { EmailInput } from "@/components/EmailInput";
import { api } from "@/lib/api";
import { citiesForState } from "@/lib/indianCities";
import { INDIAN_STATES, INDIAN_UNION_TERRITORIES } from "@/lib/indianStates";
import { invalidateReservationData } from "@/lib/invalidate";
import { inr } from "@/lib/utils";

interface GuestStats {
  totalStays: number;
  completedStays: number;
  upcomingStays: number;
  inHouseStays: number;
  cancelledStays: number;
  firstStay: string | null;
  lastStay: string | null;
  firstBooking: string | null;
  totalSpent: number;
  balanceDue: number;
}

interface Guest {
  id: string;
  fullName: string;
  phone: string;
  email: string | null;
  gender: "male" | "female" | "other" | "prefer_not_to_say" | null;
  idProofType: string;
  idProofLast4: string;
  idProofMasked?: string;
  idProofNumberEncrypted?: string;
  address: string | null;
  city: string | null;
  state: string | null;
  nationality: string;
  dateOfBirth: string | null;
  companyName: string | null;
  gstin: string | null;
  notes: string | null;
  tags: string[];
  createdAt: string;
  photoUrl: string | null;
  walletBalance: number;
  stats?: GuestStats;
}

interface GuestNote {
  id: string;
  guestId: string;
  body: string;
  authorId: string | null;
  createdAt: string;
}

interface FollowUp {
  id: string;
  guestId: string;
  task: string;
  dueDate: string;
  status: "pending" | "done" | "cancelled";
  assignedTo: string | null;
  createdAt: string;
  completedAt: string | null;
}

type Tab = "profile" | "stays" | "notes" | "followups";

interface GuestReservation {
  id: string;
  reservationNumber: string;
  status: string;
  bookingSource: string;
  stayType: "overnight" | "short_stay";
  checkInDate: string;
  checkOutDate: string;
  numNights: number;
  grandTotal: string;
  balanceDue: string;
  role: "booker" | "occupant";
  rooms: {
    id: string;
    roomNumber: string;
    roomType: string;
    soldAsType: string | null;
    ratePerNight: string;
    status: string;
    isThisGuest: boolean;
  }[];
}

export default function GuestProfile() {
  const { id } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const dialog = useDialog();
  const { can } = useAuth();
  const [tab, setTab] = useState<Tab>("profile");
  const [editing, setEditing] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["guest", id],
    queryFn: () => api.get<Guest>(`/guests/${id}`),
    enabled: !!id,
  });

  // Delete a guest with no stay history. The server enforces the
  // "no stays" rule too; here we just rely on it returning 409 with
  // a clear message if anything has changed since the screen loaded.
  const remove = useMutation({
    mutationFn: () => api.del(`/guests/${data!.id}`),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["guests"] });
      qc.removeQueries({ queryKey: ["guest", id] });
      navigate("/guests");
    },
    onError: async (e: Error) => {
      await dialog.alert({
        title: "Can't delete this guest",
        message: e.message,
      });
    },
  });

  async function handleDelete() {
    if (!data) return;
    const ok = await dialog.confirm({
      title: `Delete ${data.fullName}?`,
      message:
        `This permanently removes the guest record + KYC photos. ` +
        `It cannot be undone. The server will refuse if any stays are linked.`,
      okLabel: "Delete",
      tone: "danger",
    });
    if (ok) remove.mutate();
  }

  // Old-phone redirect. The API resolver accepts both UUIDs and any
  // phone the guest has historically had (via guest_phone_history).
  // When the URL phone differs from the guest's CURRENT phone, swap
  // the URL in place so shared links update to the canonical handle
  // without ever 404'ing. UUIDs in the URL are also rewritten to the
  // phone form for consistency with the rest of the app.
  useEffect(() => {
    if (!data || !id) return;
    const want = data.phone;
    if (want && want !== id) {
      navigate(`/guests/${want}${window.location.search}`, { replace: true });
    }
  }, [data, id, navigate]);

  // The /reports/outstanding endpoint is revenue-gated. Frontdesk
  // without view_revenue would otherwise see a recurring 403 in the
  // console + a stuck-loading "Outstanding" panel; gate the query
  // so it just doesn't fire for them. The owing amount degrades to 0.
  const outstandingQ = useQuery({
    queryKey: ["outstanding"],
    queryFn: () =>
      api.get<{
        byGuest: { guestId: string; balance: number }[];
      }>("/reports/outstanding"),
    staleTime: 30_000,
    enabled: can("view_revenue"),
  });
  const outstanding = outstandingQ.data?.byGuest.find((g) => g.guestId === id)?.balance ?? 0;

  if (isLoading || !data) return <Loader size="lg" />;

  return (
    <div className="space-y-5 max-w-4xl">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-start gap-4">
          {data.photoUrl && (
            <img
              src={data.photoUrl}
              alt={data.fullName}
              className="w-20 h-24 object-cover rounded-md border border-borderc shrink-0"
            />
          )}
          <div>
          <h1 className="text-2xl font-bold text-brand-dark">{data.fullName}</h1>
          <div className="text-sm text-textSecondary font-mono mt-0.5">{data.phone}</div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {outstanding > 0 && (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-sm bg-danger/10 text-danger text-xs font-semibold">
                <span className="w-1.5 h-1.5 rounded-full bg-danger" />
                Outstanding {inr(outstanding)}
              </span>
            )}
            {data.walletBalance > 0 && (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-sm bg-success/10 text-success text-xs font-semibold">
                <span className="w-1.5 h-1.5 rounded-full bg-success" />
                Wallet credit {inr(data.walletBalance)}
              </span>
            )}
            <TagsEditor guestId={data.id} tags={data.tags ?? []} />
          </div>
          </div>
        </div>
        <div className="flex gap-2 shrink-0">
          <Can do="delete_guests">
            <button
              className="btn-secondary inline-flex items-center gap-2 text-danger hover:bg-danger/5 disabled:text-textSecondary disabled:hover:bg-transparent"
              onClick={handleDelete}
              // Only allow deletion of guests with no stay history.
              // The server enforces the same rule, but disabling here
              // avoids a round-trip + dialog for the obvious case.
              disabled={
                remove.isPending || (data.stats?.totalStays ?? 0) > 0
              }
              title={
                (data.stats?.totalStays ?? 0) > 0
                  ? "Guest has stay history - cancel or void those bookings first"
                  : "Delete this guest"
              }
            >
              <Trash2 className="w-4 h-4" />
              {remove.isPending ? "Deleting…" : "Delete"}
            </button>
          </Can>
          <button
            className="btn-secondary inline-flex items-center gap-2"
            onClick={() => setEditing(true)}
          >
            <Pencil className="w-4 h-4" /> Edit
          </button>
          <button
            className="btn-primary inline-flex items-center gap-2"
            onClick={() => navigate(`/reservations/new?guestId=${data.id}`)}
          >
            <CalendarPlus className="w-4 h-4" /> New Booking
          </button>
        </div>
      </div>

      {data.stats && <StatsRow stats={data.stats} />}
      {data.stats && data.stats.balanceDue > 0.009 && <BalanceBreakdown guestId={data.id} />}

      <div className="flex gap-1 border-b border-borderc">
        <TabBtn active={tab === "profile"} onClick={() => setTab("profile")}>
          Profile
        </TabBtn>
        <TabBtn active={tab === "stays"} onClick={() => setTab("stays")}>
          Stays {data.stats && data.stats.totalStays > 0 ? `(${data.stats.totalStays})` : ""}
        </TabBtn>
        <TabBtn active={tab === "notes"} onClick={() => setTab("notes")}>
          Notes
        </TabBtn>
        <TabBtn active={tab === "followups"} onClick={() => setTab("followups")}>
          Follow-ups
        </TabBtn>
      </div>

      {tab === "profile" && <ProfileTab g={data} />}
      {tab === "stays" && <StaysTab guestId={data.id} />}
      {tab === "notes" && <NotesTab guestId={data.id} />}
      {tab === "followups" && <FollowUpsTab guestId={data.id} />}

      {editing && <EditGuestModal guest={data} onClose={() => setEditing(false)} />}
    </div>
  );
}

function EditGuestModal({ guest, onClose }: { guest: Guest; onClose: () => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    fullName: guest.fullName,
    phone: guest.phone,
    email: guest.email ?? "",
    gender: (guest.gender ?? "") as
      | ""
      | "male"
      | "female"
      | "other"
      | "prefer_not_to_say",
    idProofType: guest.idProofType as
      | "aadhaar"
      | "pan"
      | "passport"
      | "driving_license"
      | "voter_id",
    // Empty by default — staff types a new ID number only when they
    // actually want to replace the existing one. Sent only when non-empty.
    idProofNumber: "",
    address: guest.address ?? "",
    city: guest.city ?? "",
    state: guest.state ?? "",
    nationality: guest.nationality,
    dateOfBirth: guest.dateOfBirth ? guest.dateOfBirth.slice(0, 10) : "",
    companyName: guest.companyName ?? "",
    gstin: guest.gstin ?? "",
    notes: guest.notes ?? "",
  });
  const [err, setErr] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () =>
      api.put(`/guests/${guest.id}`, {
        fullName: form.fullName,
        phone: form.phone,
        email: form.email || null,
        gender: form.gender || undefined,
        idProofType: form.idProofType,
        // Only send when staff entered a replacement — otherwise the
        // existing ID stays untouched.
        ...(form.idProofNumber ? { idProofNumber: form.idProofNumber } : {}),
        address: form.address || null,
        city: form.city || null,
        state: form.state || null,
        nationality: form.nationality || "Indian",
        dateOfBirth: form.dateOfBirth || null,
        companyName: form.companyName || null,
        gstin: form.gstin || null,
        notes: form.notes || null,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["guest", guest.id] });
      qc.invalidateQueries({ queryKey: ["guests"] });
      onClose();
    },
    onError: (e: Error) => setErr(e.message),
  });

  function set<K extends keyof typeof form>(k: K, v: (typeof form)[K]) {
    setForm({ ...form, [k]: v });
  }

  return (
    <div
      className="fixed inset-0 z-[150] grid place-items-center bg-brand-dark/40 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-2xl bg-surface rounded-md shadow-xl border border-borderc max-h-[90vh] overflow-hidden flex flex-col">
        <div className="flex items-center justify-between px-5 py-3 border-b border-borderc">
          <div className="font-semibold text-textPrimary">Edit Guest · {guest.fullName}</div>
          <button onClick={onClose} className="text-textSecondary hover:text-textPrimary">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 space-y-4 overflow-y-auto">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Full Name">
              <input
                className="input"
                value={form.fullName}
                onChange={(e) => set("fullName", e.target.value)}
              />
            </Field>
            <Field label="Phone">
              <input
                className="input font-mono"
                type="tel"
                inputMode="numeric"
                maxLength={10}
                placeholder="9876543210"
                value={form.phone}
                onChange={(e) => set("phone", e.target.value.replace(/\D/g, "").slice(0, 10))}
              />
            </Field>
            <Field label="Email">
              <EmailInput
                value={form.email}
                onChange={(v) => set("email", v)}
              />
            </Field>
            <Field label="Date of Birth">
              <input
                className="input"
                type="date"
                value={form.dateOfBirth}
                onChange={(e) => set("dateOfBirth", e.target.value)}
              />
            </Field>
            <Field label="Nationality">
              <input
                className="input"
                value={form.nationality}
                onChange={(e) => set("nationality", e.target.value)}
              />
            </Field>
            <Field label="Gender">
              <select
                className="input"
                value={form.gender}
                onChange={(e) =>
                  set("gender", e.target.value as typeof form.gender)
                }
              >
                <option value="">Select gender…</option>
                <option value="male">Male</option>
                <option value="female">Female</option>
                <option value="other">Other</option>
                <option value="prefer_not_to_say">Prefer not to say</option>
              </select>
            </Field>
            <Field label="ID Type">
              <select
                className="input"
                value={form.idProofType}
                onChange={(e) =>
                  set("idProofType", e.target.value as typeof form.idProofType)
                }
              >
                <option value="aadhaar">Aadhaar</option>
                <option value="pan">PAN</option>
                <option value="passport">Passport</option>
                <option value="driving_license">Driving License</option>
                <option value="voter_id">Voter ID</option>
              </select>
            </Field>
            <Field label={`ID Number (current ends ••••${guest.idProofLast4})`}>
              <input
                className="input font-mono"
                value={form.idProofNumber}
                placeholder="Leave blank to keep current"
                onChange={(e) => set("idProofNumber", e.target.value)}
              />
            </Field>
          </div>

          <div className="grid grid-cols-1 gap-3">
            <Field label="Address">
              <input
                className="input"
                value={form.address}
                placeholder="House / street / area"
                onChange={(e) => set("address", e.target.value)}
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="State">
                <Combobox
                  value={form.state}
                  onChange={(v) =>
                    setForm((prev) => ({
                      ...prev,
                      state: v,
                      // Clear city when state changes so the dropdown
                      // doesn't keep a city tied to the previous state.
                      city: prev.state === v ? prev.city : "",
                    }))
                  }
                  groups={[
                    { label: "States", options: INDIAN_STATES },
                    { label: "Union Territories", options: INDIAN_UNION_TERRITORIES },
                  ]}
                  placeholder="Type to search or pick from list…"
                />
              </Field>
              <Field label="City">
                <Combobox
                  value={form.city}
                  onChange={(v) => set("city", v)}
                  options={citiesForState(form.state)}
                  placeholder={
                    form.state
                      ? `Type to search ${form.state} cities…`
                      : "Pick a state first, or type any city…"
                  }
                />
              </Field>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Company">
              <input
                className="input"
                value={form.companyName}
                placeholder="If billed to a company"
                onChange={(e) => set("companyName", e.target.value)}
              />
            </Field>
            <Field label="GSTIN (optional)">
              <input
                className="input font-mono"
                value={form.gstin}
                placeholder="22AAAAA0000A1Z5"
                onChange={(e) => set("gstin", e.target.value)}
              />
            </Field>
          </div>

          <Field label="Notes">
            <textarea
              className="w-full border border-borderc bg-surface rounded-sm px-3 py-2 text-textPrimary outline-none transition-colors focus:border-brand focus:ring-2 focus:ring-brand/20 placeholder:text-textSecondary resize-none"
              rows={3}
              value={form.notes}
              placeholder="Allergies, preferences, anniversary etc."
              onChange={(e) => set("notes", e.target.value)}
            />
          </Field>

          {err && <div className="text-danger text-sm">{err}</div>}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-borderc bg-bg/50">
          <button
            onClick={onClose}
            className="px-4 h-9 text-sm font-semibold rounded-sm border-2 border-borderc text-textSecondary hover:border-textSecondary hover:text-textPrimary transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => save.mutate()}
            disabled={save.isPending || !form.fullName.trim() || !form.phone.trim()}
            className="px-4 h-9 text-sm font-semibold rounded-sm bg-brand-dark text-cream border-2 border-brand-dark hover:opacity-90 transition-opacity disabled:opacity-40"
          >
            {save.isPending ? "Saving…" : "Save changes"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="label block mb-1">{label}</label>
      {children}
    </div>
  );
}

function StatsRow({ stats }: { stats: GuestStats }) {
  // Build a compact human description of what those total-stays are made up of.
  const parts: string[] = [];
  if (stats.inHouseStays > 0) parts.push(`${stats.inHouseStays} in-house`);
  if (stats.upcomingStays > 0) parts.push(`${stats.upcomingStays} upcoming`);
  if (stats.completedStays > 0) parts.push(`${stats.completedStays} completed`);
  if (stats.cancelledStays > 0) parts.push(`${stats.cancelledStays} cancelled`);
  const totalSub = parts.length > 0 ? parts.join(" · ") : "-";

  // For "Last stay", only say "Since X" if there's at least one completed stay.
  // For brand-new guests with only future bookings, surface that instead so we
  // don't show contradictory "Never · Since May 2026" copy.
  const lastValue = stats.lastStay
    ? format(new Date(stats.lastStay), "dd MMM yyyy")
    : "Never";
  const lastSub = stats.lastStay
    ? `Since ${format(new Date(stats.firstStay ?? stats.lastStay), "MMM yyyy")}`
    : stats.firstBooking
      ? `First booking ${format(new Date(stats.firstBooking), "dd MMM yyyy")}`
      : "No bookings yet";

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
      <Stat label="Total stays" value={String(stats.totalStays)} sub={totalSub} />
      <Stat label="Last stay" value={lastValue} sub={lastSub} />
      <Stat label="Total paid" value={inr(stats.totalSpent)} sub="across all invoices" mono />
      <Stat
        label="Balance due"
        value={inr(stats.balanceDue)}
        sub={stats.balanceDue > 0 ? "Pending collection" : "All clear"}
        mono
        tone={stats.balanceDue > 0 ? "danger" : "success"}
      />
    </div>
  );
}

interface OutstandingResponse {
  total: number;
  count: number;
  pendingPromiseCount: number;
  invoices: {
    invoiceId: string;
    invoiceNumber: string;
    reservationId: string;
    reservationNumber: string;
    balanceDue: number;
    issuedAt: string;
  }[];
  preInvoiceReservations: {
    reservationId: string;
    reservationNumber: string;
    balanceDue: number;
    createdAt: string;
  }[];
}

function BalanceBreakdown({ guestId }: { guestId: string }) {
  const navigate = useNavigate();
  const { data, isLoading } = useQuery({
    queryKey: ["guest-outstanding", guestId],
    queryFn: () => api.get<OutstandingResponse>(`/guests/${guestId}/outstanding`),
    staleTime: 30_000,
  });

  if (isLoading || !data) return null;
  if (data.total <= 0.009) return null;

  const items: {
    key: string;
    label: string;
    sub: string;
    amount: number;
    href: string;
  }[] = [
    ...data.invoices.map((i) => ({
      key: `inv-${i.invoiceId}`,
      label: i.invoiceNumber,
      sub: `Issued ${format(new Date(i.issuedAt), "dd MMM yyyy")} · ${i.reservationNumber}`,
      amount: i.balanceDue,
      href: `/reservations/${i.reservationNumber}`,
    })),
    ...data.preInvoiceReservations.map((r) => ({
      key: `pre-${r.reservationId}`,
      label: r.reservationNumber,
      sub: `Advance pending · stay still open since ${format(new Date(r.createdAt), "dd MMM yyyy")}`,
      amount: r.balanceDue,
      href: `/reservations/${r.reservationNumber}`,
    })),
  ].sort((a, b) => b.amount - a.amount);

  return (
    <div className="card border-danger/30">
      <div className="flex items-center justify-between mb-3 pb-2 border-b border-borderc">
        <div className="text-[10px] uppercase tracking-[0.18em] text-danger font-bold">
          Balance due · breakdown
        </div>
        <div className="text-xs text-textSecondary">
          {data.count} unpaid item{data.count === 1 ? "" : "s"}
          {data.pendingPromiseCount > 0 && (
            <> · {data.pendingPromiseCount} payment promise{data.pendingPromiseCount === 1 ? "" : "s"} pending</>
          )}
        </div>
      </div>

      <div className="space-y-1.5">
        {items.map((it) => (
          <button
            key={it.key}
            onClick={() => navigate(it.href)}
            className="w-full flex items-center justify-between gap-3 py-2 px-2 -mx-2 rounded-sm hover:bg-bg text-left transition-colors"
          >
            <div className="min-w-0 flex-1">
              <div className="font-mono font-semibold text-brand-dark text-sm">{it.label}</div>
              <div className="text-xs text-textSecondary truncate">{it.sub}</div>
            </div>
            <div className="font-mono font-bold text-danger text-sm shrink-0">
              {inr(it.amount)}
            </div>
          </button>
        ))}
      </div>

      <div className="flex items-center justify-between mt-2 pt-2 border-t border-borderc text-sm">
        <strong>Total outstanding</strong>
        <strong className="font-mono text-danger">{inr(data.total)}</strong>
      </div>

      <div className="text-[11px] text-textSecondary mt-2 leading-tight">
        Collect alongside this guest's next check-out - the modal offers a "Collect previous
        balance" toggle that applies to these items in oldest-first order.
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  mono,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  mono?: boolean;
  tone?: "danger" | "success";
}) {
  const valueColor =
    tone === "danger" ? "text-danger" : tone === "success" ? "text-success" : "text-brand-dark";
  return (
    <div className="card">
      <div className="label">{label}</div>
      <div className={`text-xl font-bold mt-1 ${valueColor} ${mono ? "font-mono" : ""}`}>
        {value}
      </div>
      {sub && <div className="text-xs text-textSecondary mt-0.5">{sub}</div>}
    </div>
  );
}

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
        active
          ? "border-brand-dark text-brand-dark"
          : "border-transparent text-textSecondary hover:text-brand-dark"
      }`}
    >
      {children}
    </button>
  );
}

function ProfileTab({ g }: { g: Guest }) {
  const cityState = [g.city, g.state].filter(Boolean).join(", ");
  return (
    <div className="space-y-4">
      <KycSection guestId={g.id} idProofType={g.idProofType} />
      <WalletSection guestId={g.id} />

      <Section title="Contact">
        <Row label="Full Name" value={g.fullName} />
        <Row label="Phone" value={<span className="font-mono">{g.phone}</span>} />
        <Row label="Email" value={g.email} />
      </Section>

      <Section title="Identity">
        <Row
          label="ID Proof"
          value={
            <span className="capitalize">
              {g.idProofType.replace("_", " ")}{" "}
              <span className="font-mono">{g.idProofMasked ?? `••••${g.idProofLast4}`}</span>
            </span>
          }
        />
        <Row label="Nationality" value={g.nationality} />
        <Row
          label="Gender"
          value={
            g.gender
              ? g.gender === "prefer_not_to_say"
                ? "Prefer not to say"
                : g.gender.charAt(0).toUpperCase() + g.gender.slice(1)
              : null
          }
        />
        <Row
          label="Date of Birth"
          value={g.dateOfBirth ? format(new Date(g.dateOfBirth), "dd MMM yyyy") : null}
        />
      </Section>

      <Section title="Address">
        <Row label="Street" value={g.address} />
        <Row label="City / State" value={cityState || null} />
      </Section>

      <Section title="Business">
        <Row label="Company" value={g.companyName} />
        <Row label="GSTIN" value={g.gstin ? <span className="font-mono">{g.gstin}</span> : null} />
      </Section>

      <Section title="Other">
        <Row label="Added on" value={format(new Date(g.createdAt), "dd MMM yyyy")} />
        {g.notes && (
          <div className="col-span-full pt-2 border-t border-borderc mt-1">
            <div className="label">Notes</div>
            <div className="mt-1 whitespace-pre-wrap text-textPrimary text-sm">{g.notes}</div>
          </div>
        )}
      </Section>
    </div>
  );
}

interface KycStatus {
  verified: boolean;
  kycVerifiedAt: string | null;
  frontUrl: string | null;
  backUrl: string | null;
  photoUrl: string | null;
}

function KycSection({ guestId, idProofType }: { guestId: string; idProofType: string }) {
  const qc = useQueryClient();
  const dialog = useDialog();
  const [showUpload, setShowUpload] = useState(false);
  const [preview, setPreview] = useState<{ url: string; label: string } | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["kyc", guestId],
    queryFn: () => api.get<KycStatus>(`/guests/${guestId}/kyc`),
  });

  async function removeFile(field: "photo" | "front" | "back", label: string) {
    const ok = await dialog.confirm({
      title: `Remove ${label}?`,
      message: "This will permanently delete the uploaded file. You can re-upload a new one anytime.",
      okLabel: "Remove",
      cancelLabel: "Keep",
    });
    if (!ok) return;
    await api.del(`/guests/${guestId}/kyc/${field}`);
    qc.invalidateQueries({ queryKey: ["kyc", guestId] });
    qc.invalidateQueries({ queryKey: ["guest", guestId] });
  }

  const proofLabel = idProofType.replace("_", " ");

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-3 pb-2 border-b border-borderc">
        <div className="flex items-center gap-2">
          <div className="text-[10px] uppercase tracking-[0.18em] text-brand font-bold">
            KYC Documents
          </div>
          {data?.verified && (
            <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-success bg-success/10 px-1.5 py-0.5 rounded-sm">
              <ShieldCheck className="w-3 h-3" /> Verified
            </span>
          )}
        </div>
        <button
          onClick={() => setShowUpload(true)}
          className="text-xs font-semibold inline-flex items-center gap-1 px-2.5 py-1 rounded-sm border border-borderc text-textSecondary hover:border-brand-dark hover:text-brand-dark transition-colors"
        >
          <Upload className="w-3 h-3" />
          {data?.frontUrl ? "Replace" : "Upload"}
        </button>
      </div>

      {isLoading ? (
        <div className="text-sm text-textSecondary">Loading documents…</div>
      ) : !data?.frontUrl ? (
        <div className="flex items-center gap-3 py-4 text-sm text-textSecondary">
          <FileImage className="w-8 h-8 opacity-40 shrink-0" />
          <div>
            <div className="font-medium text-textPrimary">No KYC uploaded yet</div>
            <div className="text-xs mt-0.5">
              Capture {proofLabel} photos to complete verification.
            </div>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <KycThumb
            label="Customer Photo"
            url={data.photoUrl}
            onPreview={() =>
              data.photoUrl && setPreview({ url: data.photoUrl, label: "Customer Photo" })
            }
            onReplace={() => setShowUpload(true)}
            onRemove={() => removeFile("photo", "Customer Photo")}
          />
          <KycThumb
            label={`${proofLabel} · Front`}
            url={data.frontUrl}
            onPreview={() =>
              data.frontUrl &&
              setPreview({ url: data.frontUrl, label: `${proofLabel} · Front` })
            }
            onReplace={() => setShowUpload(true)}
            onRemove={() => removeFile("front", `${proofLabel} · Front`)}
          />
          <KycThumb
            label={`${proofLabel} · Back`}
            url={data.backUrl}
            onPreview={() =>
              data.backUrl && setPreview({ url: data.backUrl, label: `${proofLabel} · Back` })
            }
            onReplace={() => setShowUpload(true)}
            onRemove={() => removeFile("back", `${proofLabel} · Back`)}
          />
        </div>
      )}

      {data?.kycVerifiedAt && (
        <div className="text-[11px] text-textSecondary mt-3">
          Verified on {format(new Date(data.kycVerifiedAt), "dd MMM yyyy · HH:mm")}
        </div>
      )}

      {showUpload && (
        <KycModal
          guestId={guestId}
          onClose={() => setShowUpload(false)}
          onUploaded={() => {
            qc.invalidateQueries({ queryKey: ["kyc", guestId] });
            qc.invalidateQueries({ queryKey: ["guest", guestId] });
          }}
        />
      )}

      {preview && (
        <ImagePreview
          url={preview.url}
          label={preview.label}
          onClose={() => setPreview(null)}
          onReplace={() => setShowUpload(true)}
        />
      )}
    </div>
  );
}

function KycThumb({
  label,
  url,
  onPreview,
  onReplace,
  onRemove,
}: {
  label: string;
  url: string | null;
  onPreview: () => void;
  onReplace: () => void;
  onRemove?: () => void;
}) {
  if (!url) {
    return (
      <button
        onClick={onReplace}
        className="border-2 border-dashed border-borderc rounded-sm p-4 flex items-center gap-2 text-textSecondary text-xs hover:border-brand-dark hover:text-brand-dark transition-colors w-full text-left"
      >
        <Upload className="w-4 h-4 opacity-70" />
        <span>{label} - click to upload</span>
      </button>
    );
  }
  return (
    <div className="group relative block border border-borderc rounded-sm overflow-hidden bg-bg hover:border-brand-dark transition-colors">
      <button
        onClick={onPreview}
        className="block w-full text-left"
        title="Click to enlarge"
      >
        <div className="aspect-[3/2] bg-bg overflow-hidden">
          <img
            src={url}
            alt={label}
            className="w-full h-full object-cover group-hover:scale-[1.02] transition-transform"
          />
        </div>
        <div className="px-2 py-1.5 text-[11px] font-semibold text-textSecondary group-hover:text-brand-dark">
          {label}
        </div>
      </button>
      <div className="absolute top-1.5 right-1.5 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        {onRemove && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
            className="inline-flex items-center justify-center w-6 h-6 rounded-sm bg-danger/90 text-white backdrop-blur-sm hover:bg-danger"
            title="Remove this document"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
        <button
          onClick={(e) => {
            e.stopPropagation();
            onReplace();
          }}
          className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 h-6 rounded-sm bg-brand-dark/90 text-cream backdrop-blur-sm hover:bg-brand-dark"
          title="Replace this document"
        >
          <Pencil className="w-3 h-3" /> Edit
        </button>
      </div>
    </div>
  );
}

function ImagePreview({
  url,
  label,
  onClose,
  onReplace,
}: {
  url: string;
  label?: string;
  onClose: () => void;
  onReplace?: () => void;
}) {
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
      else if (e.key === "+" || e.key === "=") setZoom((z) => Math.min(z + 0.25, 4));
      else if (e.key === "-") setZoom((z) => Math.max(z - 0.25, 0.25));
      else if (e.key === "0") {
        setZoom(1);
        setRotation(0);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[160] grid place-items-center bg-brand-dark/60 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-4xl h-[90vh] bg-surface rounded-md shadow-2xl border border-borderc flex flex-col overflow-hidden">
        <div className="flex items-center justify-between gap-3 px-5 py-3 border-b border-borderc bg-bg/50">
          <div className="font-semibold text-brand-dark truncate">{label ?? "KYC document"}</div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setZoom((z) => Math.max(z - 0.25, 0.25))}
              className="text-textSecondary hover:text-brand-dark px-2 h-8 inline-flex items-center font-mono text-sm"
              title="Zoom out (-)"
            >
              −
            </button>
            <span className="text-xs font-mono text-textSecondary min-w-[3rem] text-center">
              {Math.round(zoom * 100)}%
            </span>
            <button
              onClick={() => setZoom((z) => Math.min(z + 0.25, 4))}
              className="text-textSecondary hover:text-brand-dark px-2 h-8 inline-flex items-center font-mono text-sm"
              title="Zoom in (+)"
            >
              +
            </button>
            <button
              onClick={() => setRotation((r) => (r + 90) % 360)}
              className="text-textSecondary hover:text-brand-dark px-2 h-8 inline-flex items-center text-xs font-semibold"
              title="Rotate"
            >
              Rotate
            </button>
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs font-semibold inline-flex items-center gap-1.5 px-2.5 h-8 rounded-sm border-2 border-borderc text-textSecondary hover:border-brand-dark hover:text-brand-dark transition-colors"
              title="Open in new tab"
            >
              <ExternalLink className="w-3.5 h-3.5" /> New tab
            </a>
            {onReplace && (
              <button
                onClick={() => {
                  onReplace();
                  onClose();
                }}
                className="text-xs font-semibold inline-flex items-center gap-1.5 px-2.5 h-8 rounded-sm bg-brand-dark text-cream border-2 border-brand-dark hover:opacity-90 transition-opacity"
                title="Replace this document"
              >
                <Upload className="w-3.5 h-3.5" /> Replace
              </button>
            )}
            <button
              onClick={onClose}
              className="ml-1 text-textSecondary hover:text-textPrimary"
              title="Close (Esc)"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div className="flex-1 bg-bg overflow-auto grid place-items-center p-4">
          <img
            src={url}
            alt={label ?? "KYC document"}
            style={{
              transform: `scale(${zoom}) rotate(${rotation}deg)`,
              transition: "transform 120ms ease",
            }}
            className="max-w-full max-h-full object-contain shadow-md rounded-sm bg-white"
            onMouseDown={(e) => e.stopPropagation()}
          />
        </div>
      </div>
    </div>
  );
}

interface LedgerEntry {
  id: string;
  entryType: "credit_issued" | "credit_used" | "cashout" | "adjustment";
  amount: string;
  reservationId: string | null;
  note: string | null;
  createdAt: string;
}

function WalletSection({ guestId }: { guestId: string }) {
  const qc = useQueryClient();
  const [showCashout, setShowCashout] = useState(false);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const { data } = useQuery({
    queryKey: ["ledger", guestId],
    queryFn: () => api.get<{ balance: number; entries: LedgerEntry[] }>(`/guests/${guestId}/ledger`),
  });

  const cashout = useMutation({
    mutationFn: () =>
      api.post(`/guests/${guestId}/ledger/cashout`, {
        amount: Number(amount),
        note: note || undefined,
      }),
    onSuccess: () => {
      setShowCashout(false);
      setAmount("");
      setNote("");
      // Cashout affects guest wallet balance (used in ledger view), the
      // guest's running totals, and any aggregated views downstream.
      invalidateReservationData(qc, { guestId });
    },
    onError: (e: Error) => setErr(e.message),
  });

  const balance = data?.balance ?? 0;

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-3 pb-2 border-b border-borderc">
        <div className="flex items-center gap-2">
          <Wallet className="w-4 h-4 text-brand" />
          <div className="text-[10px] uppercase tracking-[0.18em] text-brand font-bold">
            Wallet Credit
          </div>
        </div>
        {balance > 0 && (
          <button
            className="text-xs font-semibold inline-flex items-center gap-1 px-2.5 py-1 rounded-sm border border-borderc text-textSecondary hover:border-brand-dark hover:text-brand-dark transition-colors"
            onClick={() => setShowCashout(true)}
          >
            Cash out
          </button>
        )}
      </div>

      <div className="text-2xl font-bold text-brand-dark">{inr(balance)}</div>
      <div className="text-xs text-textSecondary mt-0.5">Available for future bookings - no expiry</div>

      {data?.entries && data.entries.length > 0 && (
        <div className="mt-4">
          <div className="text-[10px] uppercase tracking-wider text-textSecondary font-semibold mb-2">
            History
          </div>
          <div className="space-y-1.5 max-h-60 overflow-y-auto">
            {data.entries.map((e) => {
              const signed = e.entryType === "credit_issued" || e.entryType === "adjustment";
              return (
                <div key={e.id} className="flex items-center justify-between text-xs py-1.5 border-b border-borderc/40 last:border-0">
                  <div className="min-w-0">
                    <div className="font-medium capitalize text-textPrimary">
                      {e.entryType.replace("_", " ")}
                    </div>
                    {e.note && <div className="text-textSecondary truncate">{e.note}</div>}
                    <div className="text-textSecondary">{format(new Date(e.createdAt), "dd MMM yyyy · HH:mm")}</div>
                  </div>
                  <div className={`font-mono font-semibold shrink-0 ml-3 ${signed ? "text-success" : "text-danger"}`}>
                    {signed ? "+" : "−"}{inr(Number(e.amount))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {showCashout && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setShowCashout(false)}>
          <div className="bg-surface rounded-md w-full max-w-md p-6 space-y-1" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-navy mb-4">Cash out wallet credit</h3>
            <div className="text-sm text-textSecondary mb-3">Available: <strong>{inr(balance)}</strong></div>
            <div className="space-y-3">
              <div>
                <label className="label block mb-1">Amount</label>
                <input
                  className="input"
                  type="number"
                  min={0}
                  max={balance}
                  step="0.01"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
              </div>
              <div>
                <label className="label block mb-1">Note (optional)</label>
                <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Cash refund handed at front desk" />
              </div>
              {err && <div className="text-danger text-sm">{err}</div>}
              <div className="flex justify-end gap-2">
                <button className="btn-secondary" onClick={() => setShowCashout(false)}>Cancel</button>
                <button
                  className="btn-primary"
                  disabled={!amount || Number(amount) <= 0 || Number(amount) > balance + 0.009 || cashout.isPending}
                  onClick={() => cashout.mutate()}
                >
                  {cashout.isPending ? "Processing…" : "Confirm cash out"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="card">
      <div className="text-[10px] uppercase tracking-[0.18em] text-brand font-bold mb-3 pb-2 border-b border-borderc">
        {title}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4 text-sm">{children}</div>
    </div>
  );
}

// Lifecycle tags are computed server-side from stay count + spend
// (see apps/api/src/lib/guestTags.ts) so they can't drift from the
// underlying numbers. The UI is display-only — no edit affordance,
// no add-custom input. System-managed names render in the brand
// colour; anything else (legacy manual tag) renders muted so it's
// visually obvious which pills the system owns.
const SYSTEM_TAG_SET = new Set([
  "first time",
  "new customer",
  "repeat",
  "vip",
  "high value",
  "corporate",
  "blacklist",
]);

function TagsEditor({ tags }: { guestId: string; tags: string[] }) {
  if (tags.length === 0) {
    return (
      <div className="text-xs text-textSecondary italic">
        No tags yet - they appear automatically after the first stay.
      </div>
    );
  }
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {tags.map((t) => {
        const isSystem = SYSTEM_TAG_SET.has(t.trim().toLowerCase());
        return (
          <span
            key={t}
            className={`text-xs font-semibold px-2 py-1 rounded-sm capitalize ${
              isSystem
                ? "bg-brand-soft text-brand-dark"
                : "bg-cream text-textSecondary border border-borderc"
            }`}
            title={isSystem ? "Set automatically by stay history" : "Custom tag"}
          >
            {t.replace("_", " ")}
          </span>
        );
      })}
    </div>
  );
}

function StaysTab({ guestId }: { guestId: string }) {
  const navigate = useNavigate();
  const { data, isLoading } = useQuery({
    queryKey: ["guest-reservations", guestId],
    queryFn: () => api.get<GuestReservation[]>(`/guests/${guestId}/reservations`),
  });

  if (isLoading) return <Loader />;
  if (!data || data.length === 0) {
    return (
      <div className="card text-textSecondary text-sm flex items-center gap-3 py-6">
        <BedDouble className="w-8 h-8 opacity-40 shrink-0" />
        <div>
          <div className="font-medium text-textPrimary">No bookings yet</div>
          <div className="text-xs mt-0.5">
            Reservations this guest is on will appear here once they're created.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {data.map((r) => (
        <StayCard
          key={r.id}
          r={r}
          onOpen={() => navigate(`/reservations/${r.reservationNumber}`)}
        />
      ))}
    </div>
  );
}

function StayCard({ r, onOpen }: { r: GuestReservation; onOpen: () => void }) {
  const statusTone =
    r.status === "checked_in"
      ? "bg-success/10 text-success"
      : r.status === "checked_out"
        ? "bg-textSecondary/15 text-textSecondary"
        : r.status === "cancelled" || r.status === "no_show"
          ? "bg-danger/10 text-danger"
          : "bg-brand/10 text-brand-dark";
  const balance = Number(r.balanceDue);

  return (
    <button
      onClick={onOpen}
      className="card w-full text-left hover:border-brand-dark transition-colors"
    >
      <div className="flex items-center justify-between gap-3 mb-3 pb-2 border-b border-borderc">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-mono font-bold text-brand-dark">{r.reservationNumber}</span>
          <span
            className={`text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-sm ${statusTone}`}
          >
            {r.status.replace("_", " ")}
          </span>
          {r.bookingSource === "complimentary" && (
            <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-sm bg-brass/10 text-[#157f5f]">
              Complimentary
            </span>
          )}
          {r.role === "occupant" && (
            <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-sm bg-bg text-textSecondary">
              Stayed in room
            </span>
          )}
        </div>
        <ExternalLink className="w-4 h-4 text-textSecondary shrink-0" />
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
        <div>
          <div className="label">Check-in</div>
          <div className="font-medium text-textPrimary mt-0.5">
            {format(new Date(r.checkInDate), "dd MMM yyyy")}
          </div>
        </div>
        <div>
          <div className="label">Check-out</div>
          <div className="font-medium text-textPrimary mt-0.5">
            {format(new Date(r.checkOutDate), "dd MMM yyyy")}
          </div>
        </div>
        <div>
          <div className="label">{r.stayType === "short_stay" ? "Duration" : "Nights"}</div>
          <div className="font-medium text-textPrimary mt-0.5">
            {r.stayType === "short_stay" ? "Day use" : `${r.numNights} night${r.numNights === 1 ? "" : "s"}`}
          </div>
        </div>
        <div>
          <div className="label">Total · balance</div>
          <div className="font-mono font-medium text-textPrimary mt-0.5">
            {inr(Number(r.grandTotal))}{" "}
            {balance > 0.009 ? (
              <span className="text-danger">· {inr(balance)} due</span>
            ) : (
              <span className="text-success">· paid</span>
            )}
          </div>
        </div>
      </div>

      <div className="mt-3 pt-3 border-t border-borderc">
        <div className="label mb-1.5">Rooms</div>
        <div className="flex flex-wrap gap-2">
          {r.rooms.map((rm) => (
            <span
              key={rm.id}
              className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-sm text-xs border ${
                rm.isThisGuest
                  ? "border-brand-dark bg-brand-soft text-brand-dark font-semibold"
                  : "border-borderc bg-bg text-textSecondary"
              }`}
              title={rm.isThisGuest ? "This guest stayed here" : "Another occupant"}
            >
              <BedDouble className="w-3 h-3" />
              <span className="font-mono">{rm.roomNumber}</span>
              <span className="capitalize">· {(rm.soldAsType ?? rm.roomType).replace(/_/g, " ")}</span>
              <span className="font-mono text-textSecondary">· ₹{Number(rm.ratePerNight).toFixed(0)}/n</span>
            </span>
          ))}
        </div>
      </div>
    </button>
  );
}

function NotesTab({ guestId }: { guestId: string }) {
  const qc = useQueryClient();
  const [body, setBody] = useState("");

  const { data: notes = [], isLoading } = useQuery({
    queryKey: ["guest-notes", guestId],
    queryFn: () => api.get<GuestNote[]>(`/guests/${guestId}/notes`),
  });

  const add = useMutation({
    mutationFn: () => api.post(`/guests/${guestId}/notes`, { body }),
    onSuccess: () => {
      setBody("");
      qc.invalidateQueries({ queryKey: ["guest-notes", guestId] });
    },
  });

  return (
    <div className="space-y-3">
      <div className="card space-y-2">
        <label className="label">Add Note</label>
        <textarea
          className="input min-h-[80px]"
          placeholder="Guest preferred late check-in, mentioned anniversary on 12 May…"
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
        <div className="flex justify-end">
          <button
            className="btn-primary inline-flex items-center gap-1.5"
            disabled={!body.trim() || add.isPending}
            onClick={() => add.mutate()}
          >
            <Plus className="w-4 h-4" /> {add.isPending ? "Saving…" : "Add Note"}
          </button>
        </div>
      </div>

      {isLoading ? (
        <Loader />
      ) : notes.length === 0 ? (
        <div className="card text-textSecondary text-sm">No notes yet.</div>
      ) : (
        <div className="space-y-2">
          {notes.map((n) => (
            <div key={n.id} className="card">
              <div className="text-sm whitespace-pre-wrap">{n.body}</div>
              <div className="text-xs text-textSecondary mt-2">
                {format(new Date(n.createdAt), "dd MMM yyyy HH:mm")}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function FollowUpsTab({ guestId }: { guestId: string }) {
  const qc = useQueryClient();
  const [task, setTask] = useState("");
  // Desk-local day. toISOString() is the UTC day, which during 00:00-05:30
  // IST is yesterday — the follow-up seeded a past due date and the row
  // rendered "Overdue" the instant it was created.
  const [dueDate, setDueDate] = useState(format(new Date(), "yyyy-MM-dd"));

  const { data: items = [], isLoading } = useQuery({
    queryKey: ["guest-followups", guestId],
    queryFn: () => api.get<FollowUp[]>(`/guests/${guestId}/follow-ups`),
  });

  const add = useMutation({
    mutationFn: () => api.post(`/guests/${guestId}/follow-ups`, { task, dueDate }),
    onSuccess: () => {
      setTask("");
      qc.invalidateQueries({ queryKey: ["guest-followups", guestId] });
    },
  });

  const patch = useMutation({
    mutationFn: (vars: { id: string; status: "done" | "cancelled" | "pending" }) =>
      api.patch(`/guests/${guestId}/follow-ups/${vars.id}`, { status: vars.status }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["guest-followups", guestId] }),
  });

  const pending = items.filter((i) => i.status === "pending");
  const done = items.filter((i) => i.status !== "pending");

  return (
    <div className="space-y-3">
      <div className="card space-y-2">
        <label className="label">Add Follow-up</label>
        <div className="grid grid-cols-[1fr_auto_auto] gap-2">
          <input
            className="input"
            placeholder="Call guest for feedback, send anniversary offer…"
            value={task}
            onChange={(e) => setTask(e.target.value)}
          />
          <input
            className="input w-40"
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
          />
          <button
            className="btn-primary inline-flex items-center gap-1.5"
            disabled={!task.trim() || add.isPending}
            onClick={() => add.mutate()}
          >
            <Plus className="w-4 h-4" /> {add.isPending ? "…" : "Add"}
          </button>
        </div>
      </div>

      {isLoading ? (
        <Loader />
      ) : (
        <>
          {pending.length > 0 && (
            <div className="card p-0">
              <div className="px-4 py-2 border-b flex items-center gap-2 text-sm font-semibold text-brand-dark">
                <Bell className="w-4 h-4" /> Pending ({pending.length})
              </div>
              <ul>
                {pending.map((f) => (
                  <FollowUpRow
                    key={f.id}
                    item={f}
                    onDone={() => patch.mutate({ id: f.id, status: "done" })}
                    onCancel={() => patch.mutate({ id: f.id, status: "cancelled" })}
                  />
                ))}
              </ul>
            </div>
          )}
          {done.length > 0 && (
            <div className="card p-0">
              <div className="px-4 py-2 border-b text-sm font-semibold text-textSecondary">
                History
              </div>
              <ul>
                {done.map((f) => (
                  <FollowUpRow key={f.id} item={f} />
                ))}
              </ul>
            </div>
          )}
          {items.length === 0 && (
            <div className="card text-textSecondary text-sm">No follow-ups.</div>
          )}
        </>
      )}
    </div>
  );
}

function FollowUpRow({
  item,
  onDone,
  onCancel,
}: {
  item: FollowUp;
  onDone?: () => void;
  onCancel?: () => void;
}) {
  const overdue =
    item.status === "pending" && new Date(item.dueDate) < new Date(new Date().toDateString());
  return (
    <li className="px-4 py-3 border-b last:border-b-0 flex items-center justify-between gap-3">
      <div className="flex-1 min-w-0">
        <div className={`text-sm ${item.status === "cancelled" ? "line-through text-textSecondary" : ""}`}>
          {item.task}
        </div>
        <div className={`text-xs ${overdue ? "text-danger font-semibold" : "text-textSecondary"}`}>
          Due {format(new Date(item.dueDate), "dd MMM yyyy")}
          {overdue && " · Overdue"}
          {item.status === "done" &&
            item.completedAt &&
            ` · Done ${format(new Date(item.completedAt), "dd MMM")}`}
          {item.status === "cancelled" && " · Cancelled"}
        </div>
      </div>
      {onDone && onCancel && (
        <div className="flex gap-1">
          <button
            onClick={onDone}
            className="btn-secondary !h-8 !px-2 inline-flex items-center gap-1 text-xs"
            title="Mark done"
          >
            <CheckCircle2 className="w-3.5 h-3.5" /> Done
          </button>
          <button
            onClick={onCancel}
            className="btn-secondary !h-8 !px-2 text-xs text-danger"
            title="Cancel"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
    </li>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  const isEmpty =
    value === null ||
    value === undefined ||
    value === "" ||
    (typeof value === "string" && value.trim() === "");
  return (
    <div>
      <div className="label">{label}</div>
      <div
        className={`mt-0.5 ${isEmpty ? "text-textSecondary/60 italic" : "text-textPrimary"}`}
      >
        {isEmpty ? "Not provided" : value}
      </div>
    </div>
  );
}
