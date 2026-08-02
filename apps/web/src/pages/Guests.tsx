import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bell,
  Ban,
  BadgeIndianRupee,
  Building2,
  CalendarDays,
  ChevronRight,
  IdCard,
  Mail,
  MapPin,
  Phone,
  Plus,
  RefreshCw,
  Search,
  Star,
  Tag,
  Users,
} from "@/lib/micons";
import type { LucideIcon } from "@/lib/micons";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { EmptyState, ListSkeleton } from "@/components/kit";
import { StickyBar } from "@/components/StickyBar";
import { Combobox } from "@/components/Combobox";
import { EmailInput } from "@/components/EmailInput";
import { getList, api } from "@/lib/api";
import { citiesForState } from "@/lib/indianCities";
import { INDIAN_STATES, INDIAN_UNION_TERRITORIES } from "@/lib/indianStates";
import { GUEST_TAGS, ID_PROOF_TYPES, type IdProofType } from "@stayvia/shared";

// Tag style registry. Each tag gets its own icon + tint triad so the card
// pills read at a glance instead of looking like a row of identical chips.
// Filter chips (icon + label) and card tag pills (tint) both consume this map.
interface TagStyle {
  label: string;
  icon: LucideIcon;
  // Tinted triad used on card tag pills.
  tintBg: string;
  tintText: string;
  tintBorder: string;
}

const TAG_STYLES: Record<string, TagStyle> = {
  first_time: {
    label: "First-time",
    icon: Star,
    tintBg: "bg-brand-soft",
    tintText: "text-brand-deep",
    tintBorder: "border-brand-tint",
  },
  vip: {
    label: "VIP",
    icon: Star,
    tintBg: "bg-warnBg",
    tintText: "text-warnFg",
    tintBorder: "border-warnBorder",
  },
  corporate: {
    label: "Corporate",
    icon: Building2,
    tintBg: "bg-infoBg",
    tintText: "text-info",
    tintBorder: "border-infoBorder",
  },
  repeat: {
    label: "Repeat",
    icon: RefreshCw,
    tintBg: "bg-brand-soft",
    tintText: "text-brand-deep",
    tintBorder: "border-brand-tint",
  },
  blacklist: {
    label: "Blacklist",
    icon: Ban,
    tintBg: "bg-dangerBg",
    tintText: "text-dangerFg",
    tintBorder: "border-dangerBorder",
  },
  long_stay: {
    label: "Long Stay",
    icon: CalendarDays,
    tintBg: "bg-infoBg",
    tintText: "text-reserved",
    tintBorder: "border-infoBorder",
  },
  high_value: {
    label: "High Value",
    icon: BadgeIndianRupee,
    tintBg: "bg-successBg",
    tintText: "text-success",
    tintBorder: "border-successBorder",
  },
};

const FALLBACK_TAG_STYLE: TagStyle = {
  label: "Tag",
  icon: Tag,
  tintBg: "bg-neutralBg",
  tintText: "text-inkMuted",
  tintBorder: "border-neutralBorder",
};

function tagStyle(key: string): TagStyle {
  return TAG_STYLES[key] ?? { ...FALLBACK_TAG_STYLE, label: key.replace(/_/g, " ") };
}

interface Guest {
  id: string;
  fullName: string;
  phone: string;
  email: string | null;
  idProofType: IdProofType;
  idProofLast4: string;
  idProofMasked?: string;
  idProofNumberEncrypted?: string;
  city: string | null;
  tags: string[];
  createdAt: string;
}

export default function Guests() {
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [tag, setTag] = useState<string>("");
  const [hasFollowup, setHasFollowup] = useState(false);
  const [page, setPage] = useState(1);
  const [showAdd, setShowAdd] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["guests", { search, tag, hasFollowup, page }],
    queryFn: () =>
      getList<Guest>("/guests", {
        search: search || undefined,
        tag: tag || undefined,
        has_followup: hasFollowup ? "true" : undefined,
        page,
        per_page: 25,
      }),
  });

  const guests = data?.data ?? [];
  const total = data?.meta.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / 25));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-textPrimary">Guests</h1>
          <p className="text-sm text-textSecondary mt-1">
            Everyone who's ever stayed. Search, filter and open a profile.
          </p>
        </div>
        <button onClick={() => setShowAdd(true)} className="btn-primary inline-flex items-center gap-2">
          <Plus className="w-4 h-4" /> Add Guest
        </button>
      </div>

      <StickyBar>
      <div className="card space-y-3">
        <div className="flex items-center gap-3 border-b border-divider pb-3">
          <Search className="w-4 h-4 text-inkFaint" />
          <input
            className="input flex-1 border-0 focus:ring-0"
            placeholder="Search by name, phone, ID last 4, email, company…"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-[0.08em] text-inkMuted font-bold pr-1">
            <Tag className="w-3.5 h-3.5" /> Filter
          </span>

          <FilterChip
            active={!tag}
            icon={Users}
            label="All"
            onClick={() => {
              setTag("");
              setPage(1);
            }}
          />

          {GUEST_TAGS.filter((t) => t !== "blacklist").map((t) => {
            const s = tagStyle(t);
            const active = tag === t;
            return (
              <button
                key={t}
                type="button"
                aria-pressed={active}
                onClick={() => {
                  setTag(t);
                  setPage(1);
                }}
                className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold border transition ${
                  active
                    ? "bg-brand text-white border-brand shadow-sm"
                    : "bg-surfaceAlt text-textSecondary border-borderControl hover:bg-surfaceSubtle"
                }`}
              >
                <s.icon className="w-3.5 h-3.5" />
                {s.label}
              </button>
            );
          })}

          <label className="ml-auto inline-flex items-center gap-2 text-xs cursor-pointer text-textSecondary hover:text-brand-dark">
            <input
              type="checkbox"
              checked={hasFollowup}
              onChange={(e) => {
                setHasFollowup(e.target.checked);
                setPage(1);
              }}
              className="accent-brand"
            />
            <Bell className="w-3.5 h-3.5" /> Pending follow-up
          </label>
        </div>
      </div>
      </StickyBar>

      {isLoading ? (
        <ListSkeleton rows={6} />
      ) : guests.length === 0 ? (
        <div className="card"><EmptyState title="No guests found" hint="Try a different name, phone or ID search." /></div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {guests.map((g) => (
            <GuestCard key={g.id} g={g} onOpen={() => navigate(`/guests/${g.phone}`)} />
          ))}
        </div>
      )}

      {pages > 1 && (
        <div className="flex items-center justify-between text-xs text-inkMuted">
          <div>{total} guests total</div>
          <div className="flex gap-2">
            <button
              className="btn-secondary h-8 text-xs"
              disabled={page === 1}
              onClick={() => setPage((p) => p - 1)}
            >
              Prev
            </button>
            <span className="self-center">
              {page} / {pages}
            </span>
            <button
              className="btn-secondary h-8 text-xs"
              disabled={page >= pages}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </button>
          </div>
        </div>
      )}

      {showAdd && <AddGuestModal onClose={() => setShowAdd(false)} />}
    </div>
  );
}

// Stable two-tone background for the avatar circle. We hash the guest's
// full name so the same guest always gets the same shade — useful for
// quick visual scanning of the grid without surfacing a real photo.
function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

function avatarTone(seed: string): string {
  const tones = [
    "bg-brand text-white",
    "bg-navy text-white",
    "bg-info text-white",
    "bg-gold text-white",
    "bg-dangerFg text-white",
    "bg-success text-white",
  ];
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return tones[h % tones.length]!;
}

function GuestCard({ g, onOpen }: { g: Guest; onOpen: () => void }) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      className="group card !p-4 cursor-pointer transition border border-borderc hover:border-borderControl hover:shadow-lift focus:outline-none focus:ring-2 focus:ring-brand/40"
    >
      <div className="flex items-start gap-3">
        <div
          className={`w-10 h-10 rounded-full grid place-items-center font-bold text-sm shrink-0 ${avatarTone(g.fullName)}`}
        >
          {initialsOf(g.fullName)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-base font-semibold text-textPrimary truncate">{g.fullName}</div>
          <div className="text-xs text-inkMuted font-mono flex items-center gap-1 mt-0.5">
            <Phone className="w-3 h-3" />
            {g.phone}
          </div>
        </div>
        <ChevronRight className="w-5 h-5 text-inkFaint group-hover:text-brand shrink-0 mt-1" />
      </div>

      {(g.tags ?? []).length > 0 && (
        <div className="flex flex-wrap gap-1 mt-2">
          {(g.tags ?? []).map((t) => {
            const s = tagStyle(t);
            return (
              <span
                key={t}
                className={`inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full border ${s.tintBg} ${s.tintText} ${s.tintBorder}`}
                title={s.label}
              >
                <s.icon className="w-2.5 h-2.5" />
                {s.label}
              </span>
            );
          })}
        </div>
      )}

      <div className="mt-3 pt-3 border-t border-divider space-y-1.5 text-xs">
        <div className="flex items-center gap-2 text-textSecondary">
          <Mail className="w-3.5 h-3.5 shrink-0 text-inkFaint" />
          <span className="truncate">{g.email ?? "-"}</span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-textSecondary min-w-0">
            <IdCard className="w-3.5 h-3.5 shrink-0 text-inkFaint" />
            <span className="capitalize truncate">{g.idProofType.replace("_", " ")}</span>
          </div>
          <span className="font-mono text-textSecondary shrink-0">
            {g.idProofMasked ?? `••••${g.idProofLast4}`}
          </span>
        </div>
        <div className="flex items-center gap-2 text-textSecondary">
          <MapPin className="w-3.5 h-3.5 shrink-0 text-inkFaint" />
          <span className="truncate">{g.city ?? "-"}</span>
        </div>
      </div>
    </div>
  );
}

function AddGuestModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [form, setForm] = useState({
    fullName: "",
    phone: "",
    email: "",
    gender: "" as "" | "male" | "female" | "other" | "prefer_not_to_say",
    idProofType: "aadhaar" as IdProofType,
    idProofNumber: "",
    address: "",
    city: "",
    state: "",
    nationality: "Indian",
    companyName: "",
    gstin: "",
    notes: "",
  });
  const [err, setErr] = useState<string | null>(null);
  // dupMatch carries the FIRST existing guest that already owns any of
  // the identifiers (phone / email / ID). The form blocks submit when
  // it's non-null and surfaces a "Use this guest" link so staff can
  // jump to the existing profile instead of creating a duplicate.
  type DupMatch = {
    id: string;
    fullName: string;
    phone: string;
    email: string | null;
    reasons: ("phone" | "email" | "id")[];
  };
  const [dupMatch, setDupMatch] = useState<DupMatch | null>(null);

  // Probe the API with whichever identifiers the staff has filled in
  // so far. Called on blur of phone / email / ID number. The API
  // returns ANY existing guest matching any one of the three; we keep
  // the first match and let the UI show a clickable suggestion.
  async function checkDup() {
    const phoneReady = form.phone.length === 10;
    const emailReady = form.email.trim().length > 0;
    const idReady = form.idProofNumber.trim().length >= 4;
    if (!phoneReady && !emailReady && !idReady) {
      setDupMatch(null);
      return;
    }
    try {
      const r = await api.get<{
        duplicate: boolean;
        matches: DupMatch[];
      }>("/guests/check-duplicate", {
        phone: phoneReady ? form.phone : undefined,
        email: emailReady ? form.email.trim() : undefined,
        id_type: idReady ? form.idProofType : undefined,
        id_number: idReady ? form.idProofNumber.trim() : undefined,
      });
      setDupMatch(r.duplicate ? r.matches[0] ?? null : null);
    } catch {
      // Probe failures are non-fatal — the server's create endpoint
      // will still reject true duplicates with a 409, so the worst
      // case is the staff sees the block at submit instead of inline.
    }
  }

  const create = useMutation({
    mutationFn: () => {
      if (!form.gender) throw new Error("Gender is required");
      return api.post("/guests", {
        ...form,
        email: form.email || undefined,
        city: form.city || undefined,
        state: form.state || undefined,
        address: form.address || undefined,
        companyName: form.companyName || undefined,
        gstin: form.gstin || undefined,
        notes: form.notes || undefined,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["guests"] });
      onClose();
    },
    onError: (e: Error) => setErr(e.message),
  });

  return (
    <div
      className="fixed inset-0 bg-inkDark/50 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-surface rounded-2xl shadow-modal w-full max-w-2xl p-6 space-y-4 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold text-textPrimary">Add Guest</h2>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Full Name" required>
            <input
              className="input"
              value={form.fullName}
              onChange={(e) => setForm({ ...form, fullName: e.target.value })}
              required
            />
          </Field>
          <Field label="Phone (10-digit)" required>
            <input
              className="input"
              type="tel"
              inputMode="numeric"
              maxLength={10}
              placeholder="9876543210"
              value={form.phone}
              onChange={(e) => {
                const next = e.target.value.replace(/\D/g, "").slice(0, 10);
                setForm({ ...form, phone: next });
                // Stale-warning cleanup: any edit drops the prior
                // duplicate match until the next probe completes.
                if (dupMatch) setDupMatch(null);
              }}
              onBlur={checkDup}
              required
            />
            {form.phone.length > 0 && form.phone.length < 10 && (
              <div className="text-[11px] text-danger mt-0.5">
                {10 - form.phone.length} more digit{10 - form.phone.length === 1 ? "" : "s"} needed
              </div>
            )}
          </Field>
          <Field label="Email">
            <EmailInput
              value={form.email}
              onChange={(v) => {
                setForm({ ...form, email: v });
                if (dupMatch) setDupMatch(null);
              }}
              onBlur={checkDup}
            />
          </Field>
          <Field label="ID Proof Type" required>
            <select
              className="input"
              value={form.idProofType}
              onChange={(e) => {
                setForm({ ...form, idProofType: e.target.value as IdProofType });
                // Pair changed → drop any stale match; the next blur
                // on the ID number will re-probe with the new type.
                if (dupMatch) setDupMatch(null);
              }}
            >
              {ID_PROOF_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t.replace("_", " ")}
                </option>
              ))}
            </select>
          </Field>
          <Field label="ID Proof Number" required>
            <input
              className="input"
              value={form.idProofNumber}
              onChange={(e) => {
                setForm({ ...form, idProofNumber: e.target.value });
                if (dupMatch) setDupMatch(null);
              }}
              onBlur={checkDup}
              required
            />
          </Field>
          <Field label="Nationality">
            <input
              className="input"
              value={form.nationality}
              onChange={(e) => setForm({ ...form, nationality: e.target.value })}
            />
          </Field>
          <Field label="Gender *">
            <select
              className="input"
              value={form.gender}
              onChange={(e) =>
                setForm({
                  ...form,
                  gender: e.target.value as typeof form.gender,
                })
              }
              required
            >
              <option value="">Select gender…</option>
              <option value="male">Male</option>
              <option value="female">Female</option>
              <option value="other">Other</option>
              <option value="prefer_not_to_say">Prefer not to say</option>
            </select>
          </Field>
          <Field label="State">
            <Combobox
              value={form.state}
              onChange={(v) =>
                setForm((prev) => ({
                  ...prev,
                  state: v,
                  // Wipe city when state changes — the old city was
                  // probably tied to the old state's list and would
                  // look out of place otherwise.
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
              onChange={(v) => setForm({ ...form, city: v })}
              options={citiesForState(form.state)}
              placeholder={
                form.state
                  ? `Type to search ${form.state} cities…`
                  : "Pick a state first, or type any city…"
              }
            />
          </Field>
          <div className="col-span-2">
            <Field label="Address">
              <input
                className="input"
                value={form.address}
                onChange={(e) => setForm({ ...form, address: e.target.value })}
              />
            </Field>
          </div>
          <Field label="Company">
            <input
              className="input"
              value={form.companyName}
              onChange={(e) => setForm({ ...form, companyName: e.target.value })}
            />
          </Field>
          <Field label="Company GSTIN">
            <input
              className="input"
              placeholder="22AAAAA0000A1Z5"
              value={form.gstin}
              onChange={(e) => setForm({ ...form, gstin: e.target.value.toUpperCase() })}
            />
            {form.gstin && !/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(form.gstin) && (
              <div className="text-[11px] text-danger mt-0.5">
                Enter a valid 15-character GSTIN (e.g. 22AAAAA0000A1Z5)
              </div>
            )}
          </Field>
        </div>

        {dupMatch && (
          <div className="text-warnFg bg-warnBg border border-warnBorder px-3 py-2 rounded-md text-xs space-y-1">
            <div>
              <strong>{dupMatch.fullName}</strong> already has this{" "}
              {dupMatch.reasons
                .map((r) => (r === "id" ? "ID number" : r))
                .join(" + ")}{" "}
              ({dupMatch.phone}
              {dupMatch.email ? ` · ${dupMatch.email}` : ""}).
            </div>
            <button
              type="button"
              className="text-brand-deep underline font-semibold"
              onClick={() => {
                onClose();
                navigate(`/guests/${dupMatch.phone}`);
              }}
            >
              Open existing guest →
            </button>
          </div>
        )}
        {err && <div className="text-danger text-xs">{err}</div>}

        <div className="flex justify-end gap-2 pt-2">
          <button className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn-primary"
            onClick={() => create.mutate()}
            disabled={
              create.isPending ||
              !form.fullName.trim() ||
              form.phone.length !== 10 ||
              !form.idProofNumber.trim() ||
              // Any matching existing guest (phone / email / ID) is a
              // hard block — the server enforces the same rule with a
              // 409, but blocking here avoids a wasted round-trip and
              // keeps the modal honest about the collision.
              !!dupMatch ||
              (!!form.gstin && !/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(form.gstin))
            }
          >
            {create.isPending ? "Saving…" : "Create Guest"}
          </button>
        </div>
      </div>
    </div>
  );
}

function FilterChip({
  active,
  icon: Icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: LucideIcon;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold border transition ${
        active
          ? "bg-brand text-white border-brand shadow-sm"
          : "bg-surfaceAlt text-textSecondary border-borderControl hover:bg-surfaceSubtle"
      }`}
    >
      <Icon className="w-3.5 h-3.5" />
      {label}
    </button>
  );
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div>
      <label className="label block mb-1">
        {label}
        {required && <span className="text-danger ml-0.5">*</span>}
      </label>
      {children}
    </div>
  );
}
