import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  endOfMonth,
  endOfWeek,
  endOfYear,
  format,
  startOfMonth,
  startOfWeek,
  startOfYear,
} from "date-fns";
import {
  AlertTriangle,
  BedDouble,
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  Coins,
  Download,
  Gift,
  Hourglass,
  Inbox,
  MoreHorizontal,
  Percent,
  Receipt,
  TrendingUp,
  Users,
  Wallet,
} from "@/lib/micons";
import Papa from "papaparse";
import {
  Fragment,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { useNavigate } from "react-router-dom";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useDialog } from "@/components/Dialog";
import { Loader } from "@/components/Loader";
import { useToast } from "@/components/Toast";
import { api, getList } from "@/lib/api";
import { inr } from "@/lib/utils";

type Tab =
  | "occupancy"
  | "daily"
  | "revenue"
  | "invoices"
  | "collections"
  | "gst"
  | "outstanding"
  | "rooms"
  | "guests"
  | "credit";

interface TabDef {
  id: Tab;
  label: string;
  caption: string;
  Icon: typeof Percent;
}

// Tabs split into two groups. PRIMARY_TABS always render in the strip;
// SECONDARY_TABS live behind a "More" dropdown so rarely-used reports
// (like Complimentary, where comping is an exception not a routine)
// don't clutter the bar. The split is purely UX — every tab is still
// reachable via the URL (?tab=credit) and via the dropdown.
const PRIMARY_TABS: TabDef[] = [
  { id: "occupancy", label: "Occupancy", caption: "Daily room fill rate", Icon: Percent },
  { id: "daily", label: "Daily Report", caption: "Day book - rooms, money in & out", Icon: CalendarDays },
  { id: "revenue", label: "Revenue", caption: "Earnings + room-type mix", Icon: TrendingUp },
  { id: "invoices", label: "Invoices", caption: "Every tax invoice on the property", Icon: Receipt },
  { id: "collections", label: "Collections", caption: "Money received by method", Icon: Coins },
  { id: "gst", label: "GST", caption: "CGST / SGST summary", Icon: Receipt },
  { id: "outstanding", label: "Outstanding", caption: "Unpaid invoices & promises", Icon: AlertTriangle },
  { id: "rooms", label: "Rooms", caption: "Per-room bookings & revenue", Icon: BedDouble },
  { id: "guests", label: "Top Guests", caption: "Most-frequent stayers", Icon: Users },
];

const SECONDARY_TABS: TabDef[] = [
  { id: "credit", label: "Complimentary", caption: "Comp & credit bookings", Icon: Gift },
];

// Full list — used for caption lookup ("Reports → Comp & credit
// bookings · 01 Jan → 31 Dec") regardless of which group the tab is in.
const TABS: TabDef[] = [...PRIMARY_TABS, ...SECONDARY_TABS];

// ============================================================
// Date presets
// ============================================================

type PresetKey = "week" | "month" | "year" | "custom";

interface Preset {
  key: PresetKey;
  label: string;
  range: () => { from: Date; to: Date };
}

const PRESETS: Preset[] = [
  {
    key: "week",
    label: "Week",
    range: () => ({
      from: startOfWeek(new Date(), { weekStartsOn: 1 }),
      to: endOfWeek(new Date(), { weekStartsOn: 1 }),
    }),
  },
  {
    key: "month",
    label: "Month",
    range: () => ({ from: startOfMonth(new Date()), to: endOfMonth(new Date()) }),
  },
  {
    key: "year",
    label: "Year",
    range: () => ({ from: startOfYear(new Date()), to: endOfYear(new Date()) }),
  },
];

function fmtDate(d: Date): string {
  return format(d, "yyyy-MM-dd");
}

// Generic "type the access code" prompt. The labels deliberately
// don't mention what's behind the gate — same reason the API endpoint
// is named "verify-access-code" rather than "unlock-complimentary".
// Used by the Reports tab strip's More button.
function AccessCodePrompt({
  onSuccess,
  onClose,
}: {
  onSuccess: () => void;
  onClose: () => void;
}) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!code.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.post("/settings/verify-access-code", { code: code.trim() });
      onSuccess();
    } catch (e) {
      // Generic error — we deliberately don't differentiate "no code
      // configured" from "wrong code" so a sniffer can't probe the
      // state of the gate.
      setError(e instanceof Error ? e.message : "Incorrect code");
    } finally {
      setBusy(false);
    }
  }

  // Esc closes, Enter submits. Listeners only attach while mounted
  // so we never trap focus globally.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[100] grid place-items-center bg-brand-dark/50 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-sm bg-surface rounded-2xl shadow-modal border border-borderc overflow-hidden">
        <div className="px-5 py-3 border-b border-divider bg-surfaceAlt font-semibold text-ink">
          Authorisation required
        </div>
        <div className="p-5 space-y-3">
          <p className="text-sm text-textSecondary">
            Enter the access code to continue.
          </p>
          <input
            autoFocus
            type="password"
            inputMode="numeric"
            className="input font-mono"
            value={code}
            onChange={(e) => {
              setCode(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
            placeholder="Code"
          />
          {error && (
            <div className="text-xs text-danger" role="alert">
              {error}
            </div>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              className="btn-secondary !h-11 sm:!h-8 text-xs"
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary !h-11 sm:!h-8 text-xs"
              disabled={busy || !code.trim()}
              onClick={submit}
            >
              {busy ? "Checking…" : "Continue"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function Reports() {
  const [tab, setTab] = useState<Tab>("occupancy");

  const initial = PRESETS.find((p) => p.key === "month")!.range();
  const [from, setFrom] = useState(fmtDate(initial.from));
  const [to, setTo] = useState(fmtDate(initial.to));
  const [preset, setPreset] = useState<PresetKey>("month");
  const [showCustom, setShowCustom] = useState(false);

  // Access gate for the secondary tabs (Complimentary). When the gate
  // is configured server-side, clicking the More toggle opens the
  // generic auth prompt; only after the code verifies does the row
  // expand. Re-clicking the toggle (now "Hide") locks immediately —
  // staff has to re-enter the code next time. By design ephemeral:
  // navigating away or reloading drops the state.
  const [secondaryUnlocked, setSecondaryUnlocked] = useState(false);
  const [showAuthPrompt, setShowAuthPrompt] = useState(false);
  // Does the property even have a code configured? If not, the toggle
  // behaves like the previous "show/hide" without any prompt. Pulled
  // from /settings/public so even non-admins can know whether to ask
  // staff for a code.
  const settingsPublic = useQuery({
    queryKey: ["settings-public"],
    queryFn: () =>
      api.get<{ complimentaryGateEnabled?: boolean; hideComplimentary?: boolean }>(
        "/settings/public",
      ),
    staleTime: 60_000,
  });
  const gateEnabled = !!settingsPublic.data?.complimentaryGateEnabled;
  // Hiding off = complimentary bookings are public in every normal view, so
  // the dedicated Complimentary report is redundant — drop the More toggle
  // and its tabs entirely. Defaults to the hidden-mode layout until the
  // settings load.
  const compPublic = settingsPublic.data?.hideComplimentary === false;
  const secondaryTabs = compPublic ? [] : SECONDARY_TABS;

  // If the comp report disappears while staff is ON it (toggle flipped in
  // another tab), snap back to the first primary report.
  useEffect(() => {
    if (compPublic && SECONDARY_TABS.some((t) => t.id === tab)) {
      setTab(PRIMARY_TABS[0]!.id);
    }
  }, [compPublic, tab]);

  function applyPreset(p: Preset) {
    const r = p.range();
    setFrom(fmtDate(r.from));
    setTo(fmtDate(r.to));
    setPreset(p.key);
    setShowCustom(false);
  }

  const rangeLabel = useMemo(() => {
    const f = format(new Date(from), "dd MMM yyyy");
    const t = format(new Date(to), "dd MMM yyyy");
    return f === t ? f : `${f} → ${t}`;
  }, [from, to]);

  const activeTab = TABS.find((t) => t.id === tab)!;

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-[clamp(22px,3vw,28px)] font-semibold tracking-[-0.5px] text-ink">
            Reports
          </h1>
          <p className="text-sm text-textSecondary mt-1">
            {activeTab.caption} · <span className="font-semibold text-inkBody">{rangeLabel}</span>
          </p>
        </div>
      </div>

      <DateToolbar
        from={from}
        to={to}
        preset={preset}
        showCustom={showCustom}
        onPreset={(p) => applyPreset(p)}
        onCustom={() => {
          setShowCustom((v) => !v);
          setPreset("custom");
        }}
        onFromChange={(v) => {
          setFrom(v);
          setPreset("custom");
        }}
        onToChange={(v) => {
          setTo(v);
          setPreset("custom");
        }}
      />

      <TabBar
        primary={PRIMARY_TABS}
        secondary={secondaryTabs}
        active={tab}
        onChange={setTab}
        secondaryVisible={secondaryUnlocked}
        onAttemptShow={() => {
          // No gate configured? Just reveal the row without prompting
          // — same behaviour as the previous show/hide toggle. This
          // path is the default for fresh installs and any property
          // that hasn't opted into the gate.
          if (!gateEnabled) {
            setSecondaryUnlocked(true);
            return;
          }
          setShowAuthPrompt(true);
        }}
        onHide={() => {
          // Re-lock immediately and snap off any secondary tab so
          // staff aren't stranded on an invisible view. Conservative
          // default — staff explicitly chose to hide.
          setSecondaryUnlocked(false);
          if (SECONDARY_TABS.some((t) => t.id === tab) && PRIMARY_TABS.length > 0) {
            setTab(PRIMARY_TABS[0]!.id);
          }
        }}
      />

      {/* Generic authorisation prompt — see AccessCodePrompt for why
          the wording deliberately avoids naming Complimentary. */}
      {showAuthPrompt && (
        <AccessCodePrompt
          onClose={() => setShowAuthPrompt(false)}
          onSuccess={() => {
            setSecondaryUnlocked(true);
            setShowAuthPrompt(false);
          }}
        />
      )}

      {tab === "occupancy" && <OccupancyTab from={from} to={to} />}
      {tab === "daily" && <DailyLedgerTab from={from} to={to} />}
      {tab === "revenue" && <RevenueTab from={from} to={to} />}
      {tab === "invoices" && <InvoicesTab from={from} to={to} />}
      {tab === "collections" && <CollectionsTab from={from} to={to} />}
      {tab === "gst" && <GstTab from={from} to={to} />}
      {tab === "outstanding" && <OutstandingTab />}
      {tab === "rooms" && <RoomsTab from={from} to={to} />}
      {tab === "guests" && <GuestsTab from={from} to={to} />}
      {tab === "credit" && <CreditTab from={from} to={to} />}
    </div>
  );
}

// ============================================================
// Toolbar + tabs
// ============================================================

function DateToolbar({
  from,
  to,
  preset,
  showCustom,
  onPreset,
  onCustom,
  onFromChange,
  onToChange,
}: {
  from: string;
  to: string;
  preset: PresetKey;
  showCustom: boolean;
  onPreset: (p: Preset) => void;
  onCustom: () => void;
  onFromChange: (v: string) => void;
  onToChange: (v: string) => void;
}) {
  return (
    <div className="card !p-3 !rounded-[14px]">
      <div className="flex items-center gap-2.5 flex-wrap">
        <CalendarDays className="w-4 h-4 text-brand-deep shrink-0" />
        <div className="flex items-center gap-1.5 flex-wrap">
          {PRESETS.map((p) => {
            const active = preset === p.key;
            return (
              <button
                key={p.key}
                onClick={() => onPreset(p)}
                className={`px-3.5 h-11 sm:h-[34px] text-xs font-semibold rounded-[8px] border transition-colors ${
                  active
                    ? "bg-brand text-white border-brand"
                    : "bg-surface text-textSecondary border-borderControl hover:border-brand hover:text-brand"
                }`}
              >
                {p.label}
              </button>
            );
          })}
          <button
            onClick={onCustom}
            className={`px-3.5 h-11 sm:h-[34px] text-xs font-semibold rounded-[8px] border transition-colors inline-flex items-center gap-1 ${
              preset === "custom"
                ? "bg-brand text-white border-brand"
                : "bg-surface text-textSecondary border-borderControl hover:border-brand hover:text-brand"
            }`}
          >
            Custom
            <ChevronDown
              className={`w-3 h-3 transition-transform ${showCustom ? "rotate-180" : ""}`}
            />
          </button>
        </div>
      </div>

      {showCustom && (
        <div className="flex flex-wrap items-end gap-3 mt-3 pt-3 border-t border-divider">
          <div className="flex-1 min-w-[140px] sm:flex-none">
            <label className="label block mb-1">From</label>
            <input
              className="input w-full sm:w-44"
              type="date"
              value={from}
              max={to}
              onChange={(e) => onFromChange(e.target.value)}
            />
          </div>
          <div className="flex-1 min-w-[140px] sm:flex-none">
            <label className="label block mb-1">To</label>
            <input
              className="input w-full sm:w-44"
              type="date"
              value={to}
              min={from}
              onChange={(e) => onToChange(e.target.value)}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function TabBar({
  primary,
  secondary,
  active,
  onChange,
  secondaryVisible,
  onAttemptShow,
  onHide,
}: {
  primary: TabDef[];
  secondary: TabDef[];
  active: Tab;
  onChange: (t: Tab) => void;
  // Controlled visibility for the secondary tabs. The parent owns
  // this state so it can interpose an auth prompt before flipping
  // it on. `onAttemptShow` fires when staff clicks the (currently
  // closed) More button; `onHide` fires when they click "Hide".
  secondaryVisible: boolean;
  onAttemptShow: () => void;
  onHide: () => void;
}) {
  function toggleSecondary() {
    if (secondaryVisible) {
      onHide();
    } else {
      onAttemptShow();
    }
  }

  // Ten icon pills wrap into a four-row block on a 390px phone, which
  // pushes the report itself below the fold. Below lg the strip becomes a
  // single no-wrap row that scrolls sideways (bleeding into the shell's
  // 16px gutter on phones so it reads as swipeable) — the tablet band
  // (md, ~480px next to the expanded sidebar) would otherwise wrap into
  // three rows; lg+ keeps the wrapping layout.
  return (
    <div className="flex gap-2 items-center overflow-x-auto no-scrollbar -mx-4 px-4 pb-0.5 sm:mx-0 sm:px-0 lg:flex-wrap lg:overflow-x-visible">
      {primary.map((t) => {
        const on = t.id === active;
        return (
          <button
            key={t.id}
            onClick={() => onChange(t.id)}
            title={t.caption}
            className={`inline-flex shrink-0 whitespace-nowrap items-center gap-1.5 px-3 h-11 lg:h-[38px] text-[13px] font-semibold rounded-[9px] border transition-colors ${
              on
                ? "bg-brand text-white border-brand"
                : "bg-surface text-textSecondary border-borderControl hover:border-brand hover:text-brand"
            }`}
          >
            <t.Icon className="w-4 h-4" />
            {t.label}
          </button>
        );
      })}

      {/* Show / hide toggle for the secondary row. Click reveals the
          rarely-used tabs (currently just Complimentary) inline; click
          again hides them. */}
      {secondary.length > 0 && (
        <button
          onClick={toggleSecondary}
          title={
            secondaryVisible
              ? "Hide rarely-used reports"
              : "Show more reports (Complimentary, etc.)"
          }
          aria-pressed={secondaryVisible}
          className={`inline-flex shrink-0 whitespace-nowrap items-center gap-1.5 px-3 h-11 lg:h-[38px] text-[13px] font-semibold rounded-[9px] border transition-colors ${
            secondaryVisible
              ? "bg-parchment text-inkDark border-borderControl"
              : "bg-surface text-textSecondary border-borderControl hover:border-brand hover:text-brand"
          }`}
        >
          <MoreHorizontal className="w-4 h-4" />
          {secondaryVisible ? "Hide" : "More"}
        </button>
      )}

      {/* Secondary tabs render as siblings only when the toggle is on.
          Once on, they behave exactly like primary pills. */}
      {secondaryVisible &&
        secondary.map((t) => {
          const on = t.id === active;
          return (
            <button
              key={t.id}
              onClick={() => onChange(t.id)}
              title={t.caption}
              className={`inline-flex shrink-0 whitespace-nowrap items-center gap-1.5 px-3 h-11 lg:h-[38px] text-[13px] font-semibold rounded-[9px] border transition-colors ${
                on
                  ? "bg-brand text-white border-brand"
                  : "bg-surface text-textSecondary border-borderControl hover:border-brand hover:text-brand"
              }`}
            >
              <t.Icon className="w-4 h-4" />
              {t.label}
            </button>
          );
        })}
    </div>
  );
}

// ============================================================
// Shared chrome: KPI card, section header, export, empty state
// ============================================================

function Kpi({
  label,
  value,
  Icon,
  tone = "default",
  hint,
}: {
  label: string;
  value: ReactNode;
  Icon: typeof Percent;
  tone?: "default" | "danger" | "warning" | "success";
  hint?: string;
}) {
  const toneClasses: Record<typeof tone, string> = {
    default: "text-ink",
    danger: "text-dangerFg",
    warning: "text-warnFg",
    success: "text-success",
  };
  const iconBg: Record<typeof tone, string> = {
    default: "bg-brand-soft text-brand-deep",
    danger: "bg-dangerBg text-dangerFg",
    warning: "bg-warnBg text-warnFg",
    success: "bg-successBg text-success",
  };
  // Phone stacks icon → label → value so a long ₹ figure gets the full
  // card width; two-up KPI grids are only ~140px of inner space, which a
  // side-by-side icon would eat. sm+ keeps the original icon-left row.
  return (
    <div className="card !p-3 sm:!p-4 !rounded-[14px] sm:flex sm:items-start sm:gap-3">
      <div
        className={`w-9 h-9 sm:w-10 sm:h-10 rounded-[9px] grid place-items-center shrink-0 mb-2 sm:mb-0 ${iconBg[tone]}`}
      >
        <Icon className="w-5 h-5" />
      </div>
      <div className="min-w-0 sm:flex-1">
        <div className="label">{label}</div>
        <div
          className={`text-lg sm:text-2xl font-bold font-mono tabular-nums mt-0.5 break-words ${toneClasses[tone]}`}
        >
          {value}
        </div>
        {hint && <div className="text-[11px] text-inkMuted mt-0.5">{hint}</div>}
      </div>
    </div>
  );
}

function SectionHeader({
  title,
  subtitle,
  right,
}: {
  title: string;
  subtitle?: string;
  right?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-2 sm:gap-3 mb-2">
      <div className="min-w-0">
        <div className="text-[11px] uppercase tracking-[0.1em] text-inkMuted font-bold">
          {title}
        </div>
        {subtitle && <div className="text-[11px] text-inkMuted mt-0.5">{subtitle}</div>}
      </div>
      {right}
    </div>
  );
}

// Phone cards are whole-row tap targets. Same convention the reservation
// and invoice lists use: role="button" on the row element (a real <button>
// can't legally wrap the stacked block layout) plus Enter/Space handling.
const MOBILE_ROW =
  "block w-full text-left px-3 py-3 min-h-[44px] cursor-pointer active:bg-surfaceAlt focus:outline-none focus-visible:bg-surfaceAlt";

function rowKeyActivate(fn: () => void) {
  return (e: ReactKeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fn();
    }
  };
}

function exportCsv(filename: string, rows: Record<string, unknown>[]) {
  const csv = Papa.unparse(rows);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function ExportBtn({
  onClick,
  disabled,
  label,
}: {
  onClick: () => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <button
      className="inline-flex items-center justify-center gap-1.5 px-3.5 h-11 sm:h-[34px] text-xs font-semibold rounded-[9px] border border-borderControl bg-surface text-textSecondary hover:border-brand hover:text-brand transition-colors disabled:opacity-40 disabled:hover:border-borderControl disabled:hover:text-textSecondary shrink-0"
      onClick={onClick}
      disabled={disabled}
    >
      <Download className="w-3.5 h-3.5" /> {label ?? "Export CSV"}
    </button>
  );
}

function EmptyState({
  Icon,
  title,
  hint,
}: {
  Icon: typeof Percent;
  title: string;
  hint?: string;
}) {
  return (
    <div className="p-10 text-center">
      <div className="w-12 h-12 mx-auto rounded-full bg-brand-soft/60 grid place-items-center mb-3">
        <Icon className="w-5 h-5 text-brand" />
      </div>
      <div className="text-sm font-semibold text-ink">{title}</div>
      {hint && <div className="text-xs text-textSecondary mt-1">{hint}</div>}
    </div>
  );
}

function ChartCard({
  title,
  subtitle,
  children,
  height = 280,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  height?: number;
}) {
  // Charts get a shorter fixed height on phone — the requested height is
  // handed to CSS as a variable so sm+ keeps the original proportions
  // without a second inline style. ResponsiveContainer sizes to this box,
  // so the SVG can never push the page wider than the viewport.
  return (
    <div className="card">
      <SectionHeader title={title} subtitle={subtitle} />
      <div
        className="w-full h-[220px] sm:h-[var(--chart-h)]"
        style={{ "--chart-h": `${height}px` } as CSSProperties}
      >
        {children}
      </div>
    </div>
  );
}

// ============================================================
// Tabs
// ============================================================

function OccupancyTab({ from, to }: { from: string; to: string }) {
  const { data } = useQuery({
    queryKey: ["rpt-occ", from, to],
    queryFn: () =>
      api.get<{
        totalRooms: number;
        avgOccupancy: number;
        daily: { day: string; occupied: number; total: number; percentage: number }[];
      }>("/reports/occupancy", { date_from: from, date_to: to }),
  });
  if (!data) return <Loader />;

  const peak = data.daily.reduce((m, d) => (d.percentage > m ? d.percentage : m), 0);
  const low = data.daily.reduce(
    (m, d) => (d.percentage < m || m === -1 ? d.percentage : m),
    -1,
  );

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-3 md:grid-cols-2 lg:grid-cols-3 gap-3">
        <Kpi
          label="Average occupancy"
          value={`${data.avgOccupancy}%`}
          Icon={Percent}
          hint={`${data.totalRooms} room${data.totalRooms === 1 ? "" : "s"} total`}
        />
        <Kpi
          label="Peak day"
          value={`${peak}%`}
          Icon={TrendingUp}
          tone="success"
        />
        <Kpi
          label="Lowest day"
          value={low < 0 ? "-" : `${low}%`}
          Icon={Hourglass}
          tone="warning"
        />
      </div>

      <ChartCard
        title="Daily occupancy"
        subtitle="Percentage of rooms occupied each night in the selected range"
        height={300}
      >
        <ResponsiveContainer>
          <LineChart data={data.daily} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#EFEDE7" />
            {/* minTickGap thins the day labels out on a phone-width axis
                instead of letting them collide into a grey smear. */}
            <XAxis
              dataKey="day"
              fontSize={10}
              stroke="#8A9088"
              interval="preserveStartEnd"
              minTickGap={28}
              tickMargin={4}
            />
            <YAxis domain={[0, 100]} fontSize={10} stroke="#8A9088" unit="%" width={40} />
            <Tooltip
              formatter={(v: number) => [`${v}%`, "Occupancy"]}
              contentStyle={{ borderRadius: 10, border: "1px solid #E9E6DE", fontSize: 12 }}
            />
            <Line
              type="monotone"
              dataKey="percentage"
              stroke="#0F6E52"
              strokeWidth={2.5}
              dot={{ r: 3.5, fill: "#fff", stroke: "#0F6E52", strokeWidth: 2 }}
            />
          </LineChart>
        </ResponsiveContainer>
      </ChartCard>

      <div className="flex justify-end">
        <ExportBtn onClick={() => exportCsv(`occupancy-${from}-${to}.csv`, data.daily)} />
      </div>
    </div>
  );
}

function RevenueTab({ from, to }: { from: string; to: string }) {
  const { data } = useQuery({
    queryKey: ["rpt-rev", from, to],
    queryFn: () =>
      api.get<{
        totalRevenue: number;
        daily: { day: string; total: string; count: number }[];
        byRoomType: { roomType: string; total: string }[];
        byStayType?: { stayType: string; bookings: number; total: string }[];
        bySource?: { source: string; bookings: number; total: string }[];
      }>("/reports/revenue", { date_from: from, date_to: to }),
  });
  // Reuse the collections endpoint for the by-payment-method split so the
  // Revenue tab can show how the money came in (Cash / UPI / Card …) for
  // the same range — no separate trip to the Collections tab.
  const { data: collections } = useQuery({
    queryKey: ["rpt-rev-collections", from, to],
    queryFn: () =>
      api.get<{
        byMethod: { method: string; count: number; total: string }[];
      }>("/reports/collections", { date_from: from, date_to: to }),
  });
  if (!data) return <Loader />;

  const dailyChart = data.daily.map((d) => ({
    day: d.day,
    total: Number(d.total),
    count: d.count,
  }));
  const typeChart = data.byRoomType.map((t) => ({ ...t, total: Number(t.total) }));
  const totalBookings = data.daily.reduce((s, d) => s + d.count, 0);
  const avgPerBooking = totalBookings ? data.totalRevenue / totalBookings : 0;
  const stayTypeRows = (data.byStayType ?? []).map((s) => ({
    stayType: s.stayType,
    bookings: s.bookings,
    revenue: Number(s.total),
  }));
  const overnight = stayTypeRows.find((s) => s.stayType === "overnight");
  const shortStay = stayTypeRows.find((s) => s.stayType === "short_stay");

  // Channel split - is the front-desk QR actually earning its frame?
  const sourceLabels: Record<string, string> = {
    walkin: "Walk-in",
    phone_whatsapp: "Phone / WhatsApp",
    qr: "QR self-booking",
  };
  const sourceOrder = ["walkin", "phone_whatsapp", "qr"];
  const sourceRows = (data.bySource ?? [])
    .map((r) => ({
      source: r.source,
      label: sourceLabels[r.source] ?? r.source,
      bookings: r.bookings,
      revenue: Number(r.total),
    }))
    .sort((a, b) => sourceOrder.indexOf(a.source) - sourceOrder.indexOf(b.source));
  const sourceGrand = sourceRows.reduce((t, r) => t + r.revenue, 0);

  // Payment-method split for the selected range, ordered Cash → UPI →
  // Card → Bank transfer → Cheque (any future method falls to the end).
  const methodOrder = ["cash", "upi", "card", "bank_transfer", "cheque"];
  const methodLabels: Record<string, string> = {
    cash: "Cash",
    upi: "UPI",
    card: "Card",
    bank_transfer: "Bank Transfer",
    cheque: "Cheque",
  };
  const byMethod = (collections?.byMethod ?? [])
    .filter((m) => Number(m.total) !== 0 || m.count > 0)
    .map((m) => ({ method: m.method, count: m.count, total: Number(m.total) }))
    .sort((a, b) => methodOrder.indexOf(a.method) - methodOrder.indexOf(b.method));
  const methodGrand = byMethod.reduce((s, m) => s + m.total, 0);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-3 md:grid-cols-2 lg:grid-cols-3 gap-3">
        <Kpi
          label="Total revenue"
          value={inr(data.totalRevenue)}
          Icon={TrendingUp}
        />
        <Kpi
          label="Bookings"
          value={totalBookings}
          Icon={CheckCircle2}
          hint="Reservations that contributed to revenue"
        />
        <Kpi
          label="Avg per booking"
          value={inr(avgPerBooking)}
          Icon={Wallet}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ChartCard title="Daily revenue" subtitle="Earnings per day in the selected range">
          <ResponsiveContainer>
            <BarChart data={dailyChart} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#EFEDE7" />
              <XAxis
                dataKey="day"
                fontSize={10}
                stroke="#8A9088"
                interval="preserveStartEnd"
                minTickGap={28}
                tickMargin={4}
              />
              <YAxis fontSize={10} stroke="#8A9088" width={48} />
              <Tooltip
                formatter={(v: number) => [inr(v), "Revenue"]}
                contentStyle={{ borderRadius: 10, border: "1px solid #E9E6DE", fontSize: 12 }}
              />
              <Bar dataKey="total" fill="#0F6E52" radius={[7, 7, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
        <ChartCard title="By room type" subtitle="Which categories are pulling the weight">
          <ResponsiveContainer>
            <BarChart data={typeChart} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#EFEDE7" />
              <XAxis
                dataKey="roomType"
                fontSize={10}
                stroke="#8A9088"
                interval="preserveStartEnd"
                minTickGap={12}
                tickMargin={4}
              />
              <YAxis fontSize={10} stroke="#8A9088" width={48} />
              <Tooltip
                formatter={(v: number) => [inr(v), "Revenue"]}
                contentStyle={{ borderRadius: 10, border: "1px solid #E9E6DE", fontSize: 12 }}
              />
              <Bar dataKey="total" fill="#0F6E52" radius={[7, 7, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      {stayTypeRows.length > 0 && (
        <div className="card">
          <div className="text-sm font-semibold text-ink mb-2">Booking types</div>
          {/* Two-row numeric breakdown — stays a table, but scrolls inside
              its own box so the page never moves sideways. */}
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[320px]">
              <thead>
                <tr className="text-left text-[10.5px] uppercase tracking-[0.05em] text-inkMuted border-b border-divider">
                  <th className="py-2 font-bold">Type</th>
                  <th className="py-2 font-bold text-right">Bookings</th>
                  <th className="py-2 font-bold text-right">Revenue</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-b border-divider">
                  <td className="py-2">Full Day</td>
                  <td className="py-2 text-right font-mono tabular-nums">
                    {overnight?.bookings ?? 0}
                  </td>
                  <td className="py-2 text-right font-mono tabular-nums">
                    {inr(overnight?.revenue ?? 0)}
                  </td>
                </tr>
                <tr>
                  <td className="py-2">Day use (short stay)</td>
                  <td className="py-2 text-right font-mono tabular-nums">
                    {shortStay?.bookings ?? 0}
                  </td>
                  <td className="py-2 text-right font-mono tabular-nums">
                    {inr(shortStay?.revenue ?? 0)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}

      {sourceRows.length > 0 && (
        <div className="card">
          <div className="text-sm font-semibold text-ink mb-2">By booking source</div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[360px]">
              <thead>
                <tr className="text-left text-[10.5px] uppercase tracking-[0.05em] text-inkMuted border-b border-divider">
                  <th className="py-2 font-bold">Source</th>
                  <th className="py-2 font-bold text-right">Bookings</th>
                  <th className="py-2 font-bold text-right">Revenue</th>
                  <th className="py-2 font-bold text-right">Share</th>
                </tr>
              </thead>
              <tbody>
                {sourceRows.map((r) => (
                  <tr key={r.source} className="border-b border-divider last:border-0">
                    <td className="py-2">{r.label}</td>
                    <td className="py-2 text-right font-mono tabular-nums">{r.bookings}</td>
                    <td className="py-2 text-right font-mono tabular-nums">{inr(r.revenue)}</td>
                    <td className="py-2 text-right font-mono tabular-nums">
                      {sourceGrand > 0 ? `${Math.round((r.revenue / sourceGrand) * 100)}%` : "0%"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Collections by payment method for this range — how the revenue
          was actually received. Mirrors the Collections tab so the owner
          sees the money split right here on the Revenue page. */}
      <div className="card">
        <div className="text-sm font-semibold text-ink mb-2">
          Collections by payment method
        </div>
        {byMethod.length === 0 ? (
          <div className="text-sm text-textSecondary py-1">
            No payments received in this range.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[320px]">
              <thead>
                <tr className="text-left text-[10.5px] uppercase tracking-[0.05em] text-inkMuted border-b border-divider">
                  <th className="py-2 font-bold">Method</th>
                  <th className="py-2 font-bold text-right">Payments</th>
                  <th className="py-2 font-bold text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {byMethod.map((m) => (
                  <tr key={m.method} className="border-b border-divider">
                    <td className="py-2">{methodLabels[m.method] ?? m.method}</td>
                    <td className="py-2 text-right font-mono tabular-nums">{m.count}</td>
                    <td className="py-2 text-right font-mono tabular-nums">{inr(m.total)}</td>
                  </tr>
                ))}
                <tr className="font-semibold text-ink">
                  <td className="py-2">Total</td>
                  <td className="py-2 text-right font-mono tabular-nums">
                    {byMethod.reduce((s, m) => s + m.count, 0)}
                  </td>
                  <td className="py-2 text-right font-mono tabular-nums">{inr(methodGrand)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="flex justify-end">
        <ExportBtn onClick={() => exportCsv(`revenue-${from}-${to}.csv`, data.daily)} />
      </div>
    </div>
  );
}

// Full invoice ledger — every tax invoice on the property within the
// active date range, plus per-status / per-scope filters and a free-text
// search that hits invoice #, guest name, GSTIN, and reservation #.
// Rows link to the reservation detail page so staff can drill in.
type InvoiceStatusFilter = "all" | "issued" | "partial" | "paid" | "voided";
type InvoiceScopeFilter = "all" | "room" | "combined" | "partial";

interface InvoiceListRow {
  id: string;
  invoiceNumber: string;
  reservationId: string;
  reservationNumber: string | null;
  guestId: string;
  guestName: string;
  guestGstin: string | null;
  subtotal: string;
  grandTotal: string;
  totalPaid: string;
  balanceDue: string;
  status: "issued" | "partial" | "paid" | "voided";
  scope: "room" | "combined" | "partial";
  scopeRoomIds: string[] | null;
  createdAt: string;
}

// Pill tones shared by the desktop table and the phone card list so the
// two presentations of the same row can never drift apart.
const PILL_BASE =
  "text-[10px] uppercase tracking-wider font-semibold px-2 py-0.5 rounded-full border";

function invScopeTone(scope: InvoiceListRow["scope"]): string {
  if (scope === "room") return "bg-brand-soft text-brand-deep border-brand-tint";
  if (scope === "combined") return "bg-infoBg text-info border-infoBorder";
  return "bg-neutralBg text-inkMuted border-neutralBorder";
}

function invStatusTone(status: InvoiceListRow["status"]): string {
  if (status === "paid") return "bg-successBg text-success border-successBorder";
  if (status === "partial") return "bg-warnBg text-warnFg border-warnBorder";
  if (status === "voided")
    return "bg-neutralBg text-inkMuted border-neutralBorder line-through";
  return "bg-dangerBg text-dangerFg border-dangerBorder";
}

function InvoicesTab({ from, to }: { from: string; to: string }) {
  const navigate = useNavigate();
  const [status, setStatus] = useState<InvoiceStatusFilter>("all");
  const [scope, setScope] = useState<InvoiceScopeFilter>("all");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  // Reset to page 1 whenever any filter changes — otherwise we'd land on
  // an empty page after narrowing the result set. useEffect (not
  // useMemo) is the right hook for a pure side-effect like this.
  useEffect(() => {
    setPage(1);
  }, [status, scope, q, from, to]);

  const { data, isLoading } = useQuery({
    queryKey: ["rpt-invoices", from, to, status, scope, q, page],
    queryFn: () =>
      getList<InvoiceListRow>("/invoices", {
        date_from: from,
        date_to: to,
        ...(status !== "all" ? { status } : {}),
        ...(scope !== "all" ? { scope } : {}),
        ...(q.trim() ? { q: q.trim() } : {}),
        page,
        per_page: 50,
      }).then((d) => ({ rows: d.data, meta: d.meta })),
  });

  // Totals across the full filtered result set (not just the current
  // page). Page-only sums lied — billed/collected/outstanding now match
  // every invoice the filters match. Voided invoices are excluded from
  // every money column so the identity holds:
  //   gross = paid + walletCredit + owing
  const summaryQ = useQuery({
    queryKey: ["rpt-invoices-summary", from, to, status, scope, q],
    queryFn: () =>
      api.get<{
        count: number;
        countVoided: number;
        gross: string;
        paid: string;
        walletCredit: string;
        owing: string;
      }>("/invoices/summary", {
        date_from: from,
        date_to: to,
        ...(status !== "all" ? { status } : {}),
        ...(scope !== "all" ? { scope } : {}),
        ...(q.trim() ? { q: q.trim() } : {}),
      }),
  });

  const rows = data?.rows ?? [];
  const total = data?.meta?.total ?? 0;
  const perPage = data?.meta?.per_page ?? 50;
  const totalPages = Math.max(1, Math.ceil(total / perPage));

  const sums = {
    gross: Number(summaryQ.data?.gross ?? 0),
    paid: Number(summaryQ.data?.paid ?? 0),
    walletCredit: Number(summaryQ.data?.walletCredit ?? 0),
    owing: Number(summaryQ.data?.owing ?? 0),
  };
  // "Settled" = everything that's cleared the bill (cash payments +
  // wallet credit redeemed). This is what staff want when they ask
  // "how much have we collected?" and it can never exceed gross.
  const settled = sums.paid + sums.walletCredit;

  // Full export across the entire filtered result set (every page), with
  // every invoice field a CA might ask for: reservation + guest + rooms
  // + GST breakdown + per-line aggregates + payment history + audit.
  // Hits the server-side /invoices/export so the heavy joins live in
  // Postgres, not the browser.
  const [exporting, setExporting] = useState(false);
  async function exportAll() {
    setExporting(true);
    try {
      const out = await api.get<{
        rows: Record<string, unknown>[];
        count: number;
      }>("/invoices/export", {
        date_from: from,
        date_to: to,
        ...(status !== "all" ? { status } : {}),
        ...(scope !== "all" ? { scope } : {}),
        ...(q.trim() ? { q: q.trim() } : {}),
      });
      if (out.rows.length === 0) return;
      const csv = Papa.unparse(out.rows);
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `invoices-${from}-${to}-full.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Kpi label="Invoices" value={total} Icon={Receipt} />
        <Kpi label="Gross billed" value={inr(sums.gross)} Icon={TrendingUp} />
        <Kpi
          label="Settled"
          value={inr(settled)}
          Icon={Wallet}
          tone="success"
        />
        <Kpi
          label="Outstanding"
          value={inr(sums.owing)}
          Icon={AlertTriangle}
          tone={sums.owing > 0.009 ? "danger" : undefined}
        />
      </div>

      <div className="card !p-3 flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1">
          {(["all", "issued", "partial", "paid", "voided"] as InvoiceStatusFilter[]).map((s) => (
            <button
              key={s}
              onClick={() => setStatus(s)}
              className={`px-3 h-11 sm:h-8 text-xs font-semibold rounded-sm border transition-colors capitalize ${
                status === s
                  ? "bg-inkDark text-cream border-inkDark"
                  : "bg-surface border-borderControl text-textSecondary hover:border-brand hover:text-brand"
              }`}
            >
              {s}
            </button>
          ))}
        </div>
        <div className="hidden sm:block h-6 w-px bg-borderControl mx-1" />
        <div className="flex flex-wrap gap-1">
          {(
            [
              { id: "all", label: "All scopes" },
              { id: "combined", label: "Combined" },
              { id: "room", label: "Per room" },
              { id: "partial", label: "Partial" },
            ] as { id: InvoiceScopeFilter; label: string }[]
          ).map((s) => (
            <button
              key={s.id}
              onClick={() => setScope(s.id)}
              className={`px-3 h-11 sm:h-8 text-xs font-semibold rounded-sm border transition-colors ${
                scope === s.id
                  ? "bg-inkDark text-cream border-inkDark"
                  : "bg-surface border-borderControl text-textSecondary hover:border-brand hover:text-brand"
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
        <div className="w-full sm:flex-1 sm:min-w-[180px]">
          <input
            className="input sm:h-8 text-sm"
            placeholder="Search invoice #, guest, GSTIN, reservation #…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <ExportBtn
          onClick={exportAll}
          disabled={total === 0 || exporting}
          label={exporting ? "Exporting…" : "Export CSV"}
        />
      </div>

      {isLoading ? (
        <Loader />
      ) : rows.length === 0 ? (
        <EmptyState
          Icon={Inbox}
          title="No invoices match these filters"
          hint="Try widening the date range or clearing the status / scope filter."
        />
      ) : (
        <div className="card !p-0 overflow-hidden">
          {/* DESKTOP */}
          <div className="hidden md:block overflow-x-auto">
            <table className="table-base">
              <thead>
                <tr>
                  <th>Invoice #</th>
                  <th>Issued</th>
                  <th>Reservation · Guest</th>
                  <th>Scope</th>
                  <th>Status</th>
                  <th className="!text-right">Grand Total</th>
                  <th className="!text-right">Paid</th>
                  <th className="!text-right">Balance</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((inv) => {
                  const balance = Number(inv.balanceDue);
                  return (
                    <tr
                      key={inv.id}
                      className="cursor-pointer"
                      onClick={() =>
                        navigate(
                          `/reservations/${inv.reservationNumber ?? inv.reservationId}`,
                        )
                      }
                    >
                      <td className="font-mono font-semibold text-ink">
                        {inv.invoiceNumber}
                      </td>
                      <td className="text-xs text-textSecondary">
                        {format(new Date(inv.createdAt), "dd MMM yyyy · HH:mm")}
                      </td>
                      <td>
                        <div className="font-mono text-xs text-textSecondary">
                          {inv.reservationNumber ?? "-"}
                        </div>
                        <div className="text-sm font-medium text-ink truncate max-w-[18ch]">
                          {inv.guestName}
                        </div>
                      </td>
                      <td>
                        <span className={`${PILL_BASE} ${invScopeTone(inv.scope)}`}>
                          {inv.scope === "room" ? "Per room" : inv.scope}
                        </span>
                      </td>
                      <td>
                        <span className={`${PILL_BASE} ${invStatusTone(inv.status)}`}>
                          {inv.status}
                        </span>
                      </td>
                      <td className="text-right font-mono tabular-nums">
                        {inr(inv.grandTotal)}
                      </td>
                      <td className="text-right font-mono tabular-nums text-success">
                        {inr(inv.totalPaid)}
                      </td>
                      <td
                        className={`text-right font-mono tabular-nums ${
                          balance > 0.009 ? "text-dangerFg font-semibold" : "text-textSecondary"
                        }`}
                      >
                        {inr(balance)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* MOBILE */}
          <ul className="md:hidden divide-y divide-divider">
            {rows.map((inv) => {
              const balance = Number(inv.balanceDue);
              const open = () =>
                navigate(`/reservations/${inv.reservationNumber ?? inv.reservationId}`);
              return (
                <li
                  key={inv.id}
                  role="button"
                  tabIndex={0}
                  className={MOBILE_ROW}
                  onClick={open}
                  onKeyDown={rowKeyActivate(open)}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="font-mono text-xs font-semibold text-ink truncate">
                        {inv.invoiceNumber}
                      </div>
                      <div className="text-sm font-medium text-ink truncate mt-0.5">
                        {inv.guestName}
                      </div>
                      <div className="font-mono text-[10px] text-textSecondary truncate mt-0.5">
                        {inv.reservationNumber ?? "-"}
                      </div>
                      <div className="text-[10px] text-inkMuted mt-1">
                        {format(new Date(inv.createdAt), "dd MMM yyyy · HH:mm")}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-sm font-mono font-semibold text-ink tabular-nums">
                        {inr(inv.grandTotal)}
                      </div>
                      <div className="text-[11px] font-mono text-success tabular-nums mt-0.5">
                        {inr(inv.totalPaid)} paid
                      </div>
                      {balance > 0.009 && (
                        <div className="text-[11px] font-mono font-semibold text-dangerFg tabular-nums mt-0.5">
                          {inr(balance)} due
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    <span className={`${PILL_BASE} ${invStatusTone(inv.status)}`}>
                      {inv.status}
                    </span>
                    <span className={`${PILL_BASE} ${invScopeTone(inv.scope)}`}>
                      {inv.scope === "room" ? "Per room" : inv.scope}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {total > perPage && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-textSecondary">
          <span>
            Showing {(page - 1) * perPage + 1}–{Math.min(page * perPage, total)} of {total}
          </span>
          <div className="flex gap-1">
            <button
              className="px-4 h-11 sm:px-2.5 sm:h-7 rounded-sm border border-borderControl bg-surface disabled:opacity-40"
              disabled={page === 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              Prev
            </button>
            <button
              className="px-4 h-11 sm:px-2.5 sm:h-7 rounded-sm border border-borderControl bg-surface disabled:opacity-40"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function CollectionsTab({ from, to }: { from: string; to: string }) {
  const { data } = useQuery({
    queryKey: ["rpt-col", from, to],
    queryFn: () =>
      api.get<{
        byMethod: { method: string; count: number; total: string }[];
        payments: { id: string; amount: string; paymentMethod: string; paymentDate: string }[];
      }>("/reports/collections", { date_from: from, date_to: to }),
  });
  if (!data) return <Loader />;

  const grand = data.byMethod.reduce((s, m) => s + Number(m.total), 0);
  const txns = data.byMethod.reduce((s, m) => s + m.count, 0);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Kpi label="Total collected" value={inr(grand)} Icon={Coins} tone="success" />
        <Kpi label="Transactions" value={txns} Icon={Receipt} />
      </div>

      <div>
        <SectionHeader
          title="By payment method"
          subtitle="Cash, UPI, card, bank transfers - how the money came in"
          right={
            <ExportBtn
              onClick={() => exportCsv(`collections-${from}-${to}.csv`, data.payments)}
              disabled={!data.payments.length}
            />
          }
        />
        <div className="card !p-0 overflow-hidden">
          {data.byMethod.length === 0 ? (
            <EmptyState
              Icon={Inbox}
              title="No payments collected"
              hint="Once you record a payment in this date range it'll show up here."
            />
          ) : (
            <>
              {/* DESKTOP */}
              <div className="hidden md:block overflow-x-auto">
                <table className="table-base">
                  <thead>
                    <tr>
                      <th>Method</th>
                      <th className="!text-right">Transactions</th>
                      <th className="!text-right">Total collected</th>
                      <th className="!text-right">Share</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.byMethod.map((m) => {
                      const share = grand > 0 ? (Number(m.total) / grand) * 100 : 0;
                      return (
                        <tr key={m.method}>
                          <td className="capitalize font-medium text-ink">
                            {m.method.replace(/_/g, " ")}
                          </td>
                          <td className="text-right tabular-nums">{m.count}</td>
                          <td className="text-right font-mono tabular-nums">{inr(m.total)}</td>
                          <td className="text-right">
                            <div className="inline-flex items-center gap-2">
                              <div className="w-20 h-1.5 rounded-full bg-surfaceSubtle overflow-hidden">
                                <div
                                  className="h-full bg-brand"
                                  style={{ width: `${share}%` }}
                                />
                              </div>
                              <span className="text-[11px] font-mono text-textSecondary w-10 text-right">
                                {share.toFixed(0)}%
                              </span>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="bg-surfaceAlt">
                      <td className="font-semibold text-ink">Total</td>
                      <td className="text-right font-semibold tabular-nums">{txns}</td>
                      <td className="text-right font-mono font-bold tabular-nums">{inr(grand)}</td>
                      <td></td>
                    </tr>
                  </tfoot>
                </table>
              </div>

              {/* MOBILE */}
              <ul className="md:hidden divide-y divide-divider">
                {data.byMethod.map((m) => {
                  const share = grand > 0 ? (Number(m.total) / grand) * 100 : 0;
                  return (
                    <li key={m.method} className="px-3 py-3">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="capitalize font-medium text-ink truncate">
                          {m.method.replace(/_/g, " ")}
                        </span>
                        <span className="font-mono font-semibold text-ink tabular-nums shrink-0">
                          {inr(m.total)}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 mt-1.5">
                        <div className="flex-1 h-1.5 rounded-full bg-surfaceSubtle overflow-hidden">
                          <div className="h-full bg-brand" style={{ width: `${share}%` }} />
                        </div>
                        <span className="text-[11px] font-mono text-textSecondary shrink-0">
                          {share.toFixed(0)}%
                        </span>
                      </div>
                      <div className="text-[11px] text-inkMuted mt-1">
                        {m.count} transaction{m.count === 1 ? "" : "s"}
                      </div>
                    </li>
                  );
                })}
                <li className="px-3 py-3 bg-surfaceAlt flex items-baseline justify-between gap-2">
                  <span className="font-semibold text-ink">
                    Total · {txns} transaction{txns === 1 ? "" : "s"}
                  </span>
                  <span className="font-mono font-bold text-ink tabular-nums shrink-0">
                    {inr(grand)}
                  </span>
                </li>
              </ul>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function GstTab({ from, to }: { from: string; to: string }) {
  const { data } = useQuery({
    queryKey: ["rpt-gst", from, to],
    queryFn: () =>
      api.get<{
        month: string;
        byStatus: {
          status: string;
          subtotal: string;
          cgst: string;
          sgst: string;
          total: string;
          count: number;
        }[];
        creditNotes?: {
          count: number;
          subtotal: string;
          cgst: string;
          sgst: string;
          total: string;
        };
      }>("/reports/gst-summary", { date_from: from, date_to: to }),
  });
  if (!data) return <Loader />;

  const cn = data.creditNotes;
  const hasCreditNotes = !!cn && cn.count > 0;
  // Invoice subtotals already exclude credit notes (the API splits them
  // out). NET = invoices + credit notes (the CN amounts are negative),
  // which is the figure that actually gets filed.
  const invTotals = data.byStatus.reduce(
    (acc, r) => ({
      subtotal: acc.subtotal + Number(r.subtotal),
      cgst: acc.cgst + Number(r.cgst),
      sgst: acc.sgst + Number(r.sgst),
      total: acc.total + Number(r.total),
      count: acc.count + r.count,
    }),
    { subtotal: 0, cgst: 0, sgst: 0, total: 0, count: 0 },
  );
  const totals = {
    subtotal: invTotals.subtotal + Number(cn?.subtotal ?? 0),
    cgst: invTotals.cgst + Number(cn?.cgst ?? 0),
    sgst: invTotals.sgst + Number(cn?.sgst ?? 0),
    total: invTotals.total + Number(cn?.total ?? 0),
    count: invTotals.count,
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-2 lg:grid-cols-4 gap-3">
        <Kpi label="Invoices" value={totals.count} Icon={Receipt} />
        <Kpi label="Subtotal" value={inr(totals.subtotal)} Icon={Wallet} />
        <Kpi
          label={hasCreditNotes ? "Net tax (CGST + SGST)" : "Tax (CGST + SGST)"}
          value={inr(totals.cgst + totals.sgst)}
          Icon={Percent}
          hint={hasCreditNotes ? "after credit notes" : undefined}
        />
        <Kpi
          label={hasCreditNotes ? "Net grand total" : "Grand total"}
          value={inr(totals.total)}
          Icon={TrendingUp}
          tone="success"
        />
      </div>

      <div>
        <SectionHeader
          title={`GST summary - ${data.month}`}
          subtitle="Driven by invoice issued-date. Adjust the range with the date picker."
          right={
            <ExportBtn
              onClick={() => exportCsv(`gst-${data.month}.csv`, data.byStatus)}
              disabled={!data.byStatus.length}
            />
          }
        />
        {/* Genuine numeric matrix (four money columns) — stays a table and
            scrolls inside the card rather than folding into cards, so the
            CGST/SGST figures stay comparable row to row. */}
        <div className="card !p-0 overflow-x-auto">
          {data.byStatus.length === 0 ? (
            <EmptyState
              Icon={Inbox}
              title="No invoices in this range"
              hint="Adjust the date picker above."
            />
          ) : (
            <table className="table-base min-w-[700px]">
              <thead>
                <tr>
                  <th>Status</th>
                  <th className="!text-right">Count</th>
                  <th className="!text-right">Subtotal</th>
                  <th className="!text-right">CGST</th>
                  <th className="!text-right">SGST</th>
                  <th className="!text-right">Grand total</th>
                </tr>
              </thead>
              <tbody>
                {data.byStatus.map((r) => (
                  <tr key={r.status}>
                    <td className="capitalize font-medium text-ink">{r.status}</td>
                    <td className="text-right tabular-nums">{r.count}</td>
                    <td className="text-right font-mono tabular-nums">{inr(r.subtotal)}</td>
                    <td className="text-right font-mono tabular-nums">{inr(r.cgst)}</td>
                    <td className="text-right font-mono tabular-nums">{inr(r.sgst)}</td>
                    <td className="text-right font-mono font-bold tabular-nums">{inr(r.total)}</td>
                  </tr>
                ))}
                {hasCreditNotes && (
                  <tr className="text-dangerFg">
                    <td className="font-medium">Credit notes</td>
                    <td className="text-right tabular-nums">{cn!.count}</td>
                    <td className="text-right font-mono tabular-nums">{inr(cn!.subtotal)}</td>
                    <td className="text-right font-mono tabular-nums">{inr(cn!.cgst)}</td>
                    <td className="text-right font-mono tabular-nums">{inr(cn!.sgst)}</td>
                    <td className="text-right font-mono font-bold tabular-nums">{inr(cn!.total)}</td>
                  </tr>
                )}
              </tbody>
              <tfoot>
                <tr className="bg-surfaceAlt">
                  <td className="font-semibold text-ink">
                    {hasCreditNotes ? "Net total" : "Total"}
                  </td>
                  <td className="text-right font-semibold tabular-nums">{totals.count}</td>
                  <td className="text-right font-mono font-semibold tabular-nums">
                    {inr(totals.subtotal)}
                  </td>
                  <td className="text-right font-mono font-semibold tabular-nums">
                    {inr(totals.cgst)}
                  </td>
                  <td className="text-right font-mono font-semibold tabular-nums">
                    {inr(totals.sgst)}
                  </td>
                  <td className="text-right font-mono font-bold tabular-nums">
                    {inr(totals.total)}
                  </td>
                </tr>
              </tfoot>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

interface OutstandingResp {
  invoices: {
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
  }[];
  pendingPayments: {
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
  }[];
  byGuest: {
    guestId: string;
    guestName: string;
    guestPhone: string;
    balance: number;
    oldest: string;
  }[];
  totalOutstanding: number;
}

function daysSince(iso: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86400000));
}

function AgeBadge({ days }: { days: number }) {
  const tone =
    days >= 30
      ? "bg-dangerBg text-dangerFg"
      : days >= 14
        ? "bg-warnBg text-warnFg"
        : "bg-neutralBg text-inkMuted";
  return (
    <span className={`inline-block px-1.5 py-0.5 rounded-[5px] text-[10px] font-bold ${tone}`}>
      {days}d
    </span>
  );
}

function OutstandingTab() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const dialog = useDialog();
  const { toast } = useToast();
  const { data } = useQuery({
    queryKey: ["rpt-out"],
    queryFn: () => api.get<OutstandingResp>("/reports/outstanding"),
    refetchInterval: 30_000,
  });

  const markReceived = useMutation({
    mutationFn: ({ id, method }: { id: string; method: string }) =>
      api.post(`/payments/${id}/mark-received`, { paymentMethod: method }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["rpt-out"] });
      qc.invalidateQueries({ queryKey: ["outstanding"] });
    },
    onError: (e: Error) => toast(e.message, "error"),
  });

  // Shared by the desktop row button and the phone card button so the
  // confirm dialog and mutation stay in exactly one place.
  async function promptMarkReceived(p: OutstandingResp["pendingPayments"][number]) {
    const chosen = await dialog.prompt({
      title: "Mark payment received",
      message: `Confirm collection of ${inr(p.amount)} from ${p.guestName}.`,
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
    if (chosen) markReceived.mutate({ id: p.paymentId, method: chosen });
  }

  if (!data) return <Loader />;
  const { invoices, pendingPayments, byGuest, totalOutstanding } = data;

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
        <Kpi
          label="Total outstanding"
          value={inr(totalOutstanding)}
          Icon={AlertTriangle}
          tone="danger"
        />
        <Kpi
          label="Guests with balance"
          value={byGuest.length}
          Icon={Users}
        />
        <Kpi
          label="Pending payments"
          value={pendingPayments.length}
          Icon={Hourglass}
          tone="warning"
          hint="Promised collections waiting to be marked received"
        />
      </div>

      {byGuest.length > 0 && (
        <section>
          <SectionHeader
            title="By guest"
            subtitle="Click a row to open the guest profile"
          />
          <div className="card !p-0 overflow-hidden">
            {/* DESKTOP */}
            <div className="hidden md:block overflow-x-auto">
              <table className="table-base">
                <thead>
                  <tr>
                    <th>Guest</th>
                    <th>Phone</th>
                    <th>Oldest invoice</th>
                    <th className="!text-right">Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {byGuest.map((g) => (
                    <tr
                      key={g.guestId}
                      className="cursor-pointer"
                      onClick={() => navigate(`/guests/${g.guestPhone}`)}
                    >
                      <td className="font-medium text-ink">{g.guestName}</td>
                      <td className="font-mono text-textSecondary text-xs">{g.guestPhone}</td>
                      <td>
                        <div className="inline-flex items-center gap-2">
                          <span>{format(new Date(g.oldest), "dd MMM yyyy")}</span>
                          <AgeBadge days={daysSince(g.oldest)} />
                        </div>
                      </td>
                      <td className="text-right font-mono text-dangerFg font-semibold tabular-nums">
                        {inr(g.balance)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* MOBILE */}
            <ul className="md:hidden divide-y divide-divider">
              {byGuest.map((g) => (
                <li
                  key={g.guestId}
                  role="button"
                  tabIndex={0}
                  className={MOBILE_ROW}
                  onClick={() => navigate(`/guests/${g.guestPhone}`)}
                  onKeyDown={rowKeyActivate(() => navigate(`/guests/${g.guestPhone}`))}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="font-medium text-ink truncate">{g.guestName}</div>
                      <div className="font-mono text-xs text-textSecondary truncate mt-0.5">
                        {g.guestPhone}
                      </div>
                    </div>
                    <div className="font-mono text-dangerFg font-semibold tabular-nums shrink-0">
                      {inr(g.balance)}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 mt-1.5 text-[11px] text-inkMuted">
                    <span>Oldest {format(new Date(g.oldest), "dd MMM yyyy")}</span>
                    <AgeBadge days={daysSince(g.oldest)} />
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}

      {pendingPayments.length > 0 && (
        <section>
          <SectionHeader
            title="Pending payments"
            subtitle="Promised collections - mark them received once the money's in"
          />
          <div className="card !p-0 overflow-hidden">
            {/* DESKTOP */}
            <div className="hidden md:block overflow-x-auto">
              <table className="table-base">
                <thead>
                  <tr>
                    <th>Reservation</th>
                    <th>Guest</th>
                    <th>Notes</th>
                    <th>Promised</th>
                    <th className="!text-right">Amount</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {pendingPayments.map((p) => (
                    <tr key={p.paymentId}>
                      <td className="font-mono text-xs">{p.reservationNumber}</td>
                      <td>
                        <div className="font-medium text-ink">{p.guestName}</div>
                        <div className="text-[11px] text-textSecondary font-mono">
                          {p.guestPhone}
                        </div>
                      </td>
                      <td className="text-xs text-textSecondary">{p.notes ?? ""}</td>
                      <td>
                        <div className="inline-flex items-center gap-2">
                          <span>{format(new Date(p.promisedAt), "dd MMM yyyy")}</span>
                          <AgeBadge days={daysSince(p.promisedAt)} />
                        </div>
                      </td>
                      <td className="text-right font-mono text-dangerFg font-semibold tabular-nums">
                        {inr(p.amount)}
                      </td>
                      <td className="text-right">
                        <button
                          className="!h-7 !px-2 text-xs font-semibold rounded-sm bg-success text-white border border-success hover:opacity-90 inline-flex items-center gap-1"
                          onClick={() => promptMarkReceived(p)}
                          disabled={markReceived.isPending}
                        >
                          <CheckCircle2 className="w-3 h-3" />
                          Received
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* MOBILE */}
            <ul className="md:hidden divide-y divide-divider">
              {pendingPayments.map((p) => (
                <li key={p.paymentId} className="px-3 py-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="font-mono text-xs text-textSecondary truncate">
                        {p.reservationNumber}
                      </div>
                      <div className="font-medium text-ink truncate mt-0.5">{p.guestName}</div>
                      <div className="text-[11px] text-textSecondary font-mono truncate">
                        {p.guestPhone}
                      </div>
                    </div>
                    <div className="font-mono text-dangerFg font-semibold tabular-nums shrink-0">
                      {inr(p.amount)}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 mt-1.5 text-[11px] text-inkMuted">
                    <span>Promised {format(new Date(p.promisedAt), "dd MMM yyyy")}</span>
                    <AgeBadge days={daysSince(p.promisedAt)} />
                  </div>
                  {p.notes && (
                    <div className="text-xs text-textSecondary mt-1 break-words">{p.notes}</div>
                  )}
                  <button
                    className="w-full mt-2 h-11 text-xs font-semibold rounded-sm bg-success text-white border border-success inline-flex items-center justify-center gap-1 disabled:opacity-40"
                    onClick={() => promptMarkReceived(p)}
                    disabled={markReceived.isPending}
                  >
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    Received
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}

      <section>
        <SectionHeader
          title="All unpaid invoices"
          subtitle="Sorted by oldest first - chase these"
          right={
            <ExportBtn
              onClick={() => exportCsv(`outstanding.csv`, invoices)}
              disabled={!invoices.length}
            />
          }
        />
        <div className="card !p-0 overflow-hidden">
          {invoices.length === 0 ? (
            <EmptyState
              Icon={CheckCircle2}
              title="Nothing outstanding"
              hint="Every issued invoice has been paid. Nice."
            />
          ) : (
            <>
              {/* DESKTOP */}
              <div className="hidden md:block overflow-x-auto">
                <table className="table-base">
                  <thead>
                    <tr>
                      <th>Invoice</th>
                      <th>Reservation</th>
                      <th>Guest</th>
                      <th>Issued</th>
                      <th>Status</th>
                      <th className="!text-right">Total</th>
                      <th className="!text-right">Balance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {invoices.map((r) => (
                      <tr
                        key={r.invoiceId}
                        className="cursor-pointer"
                        onClick={() => navigate(`/reservations/${r.reservationNumber}`)}
                      >
                        <td className="font-mono text-xs">{r.invoiceNumber}</td>
                        <td className="font-mono text-textSecondary text-xs">
                          {r.reservationNumber}
                        </td>
                        <td className="font-medium text-ink">{r.guestName}</td>
                        <td>
                          <div className="inline-flex items-center gap-2">
                            <span>{format(new Date(r.issuedAt), "dd MMM yyyy")}</span>
                            <AgeBadge days={daysSince(r.issuedAt)} />
                          </div>
                        </td>
                        <td className="capitalize">{r.status}</td>
                        <td className="text-right font-mono tabular-nums">{inr(r.grandTotal)}</td>
                        <td className="text-right font-mono text-dangerFg font-semibold tabular-nums">
                          {inr(r.balanceDue)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* MOBILE */}
              <ul className="md:hidden divide-y divide-divider">
                {invoices.map((r) => (
                  <li
                    key={r.invoiceId}
                    role="button"
                    tabIndex={0}
                    className={MOBILE_ROW}
                    onClick={() => navigate(`/reservations/${r.reservationNumber}`)}
                    onKeyDown={rowKeyActivate(() =>
                      navigate(`/reservations/${r.reservationNumber}`),
                    )}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="font-mono text-xs font-semibold text-ink truncate">
                          {r.invoiceNumber}
                        </div>
                        <div className="font-medium text-ink truncate mt-0.5">{r.guestName}</div>
                        <div className="font-mono text-[10px] text-textSecondary truncate mt-0.5">
                          {r.reservationNumber}
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className="font-mono text-dangerFg font-semibold tabular-nums">
                          {inr(r.balanceDue)}
                        </div>
                        <div className="font-mono text-[11px] text-textSecondary tabular-nums mt-0.5">
                          of {inr(r.grandTotal)}
                        </div>
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-1.5 text-[11px] text-inkMuted">
                      <span className="capitalize">{r.status}</span>
                      <span>·</span>
                      <span>Issued {format(new Date(r.issuedAt), "dd MMM yyyy")}</span>
                      <AgeBadge days={daysSince(r.issuedAt)} />
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </section>
    </div>
  );
}

// Day book — one row per calendar day: rooms occupied that night (who
// and at what price), money collected, expenses paid out, and the net.
// The "everything in one place" report for close-of-day and accountant
// handovers. Two exports: per-day summary and per-room-night detail.
function DailyLedgerTab({ from, to }: { from: string; to: string }) {
  interface LedgerRoom {
    roomNumber: string;
    guestName: string;
    reservationNumber: string;
    rate: number;
    complimentary: boolean;
  }
  interface LedgerDay {
    day: string;
    roomsOccupied: number;
    roomNumbers: string;
    roomCharges: number;
    collected: number;
    expenses: number;
    net: number;
    rooms: LedgerRoom[];
  }
  const { data, isLoading } = useQuery({
    queryKey: ["rpt-daily-ledger", from, to],
    queryFn: () =>
      api.get<{
        daily: LedgerDay[];
        totals: {
          roomNights: number;
          roomCharges: number;
          collected: number;
          expenses: number;
          net: number;
        };
      }>("/reports/daily-ledger", { date_from: from, date_to: to }),
  });
  const [expanded, setExpanded] = useState<string | null>(null);

  const daily = data?.daily ?? [];
  const totals = data?.totals;
  // Hide leading/trailing dead days only when the range is long; a
  // week view keeps every day so gaps are visible.
  const hasAnything = (d: LedgerDay) =>
    d.roomsOccupied > 0 || d.collected > 0.009 || d.expenses > 0.009;
  // Computed once — the desktop table and the phone card list render the
  // same filtered set.
  const visibleDays = daily.filter(hasAnything);

  if (isLoading) return <Loader label="Building the day book…" />;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Kpi label="Room nights sold" value={totals?.roomNights ?? 0} Icon={BedDouble} />
        <Kpi
          label="Collected"
          value={inr(totals?.collected ?? 0)}
          Icon={Coins}
          tone="success"
        />
        <Kpi
          label="Expenses"
          value={inr(totals?.expenses ?? 0)}
          Icon={Wallet}
          tone="danger"
        />
        <Kpi
          label="Net"
          value={inr(totals?.net ?? 0)}
          Icon={TrendingUp}
          tone={(totals?.net ?? 0) >= 0 ? "success" : "danger"}
        />
      </div>

      <div>
        <SectionHeader
          title="Day book"
          subtitle="Click a day to see each room, guest and nightly price"
          right={
            <div className="flex flex-wrap items-center gap-2">
              <ExportBtn
                label="Export days CSV"
                disabled={!daily.length}
                onClick={() =>
                  exportCsv(
                    `daily-report-${from}-${to}.csv`,
                    daily.map((d) => ({
                      date: d.day,
                      rooms_occupied: d.roomsOccupied,
                      room_numbers: d.roomNumbers,
                      room_charges: d.roomCharges,
                      collected: d.collected,
                      expenses: d.expenses,
                      net: d.net,
                    })),
                  )
                }
              />
              <ExportBtn
                label="Export detail CSV"
                disabled={!daily.length}
                onClick={() =>
                  exportCsv(
                    `daily-report-detail-${from}-${to}.csv`,
                    daily.flatMap((d) =>
                      d.rooms.map((r) => ({
                        date: d.day,
                        room: r.roomNumber,
                        guest: r.guestName,
                        reservation: r.reservationNumber,
                        price_per_night: r.rate,
                        complimentary: r.complimentary ? "yes" : "no",
                        collected_that_day: d.collected,
                        expenses_that_day: d.expenses,
                      })),
                    ),
                  )
                }
              />
            </div>
          }
        />
        <div className="card !p-0 overflow-hidden">
          {visibleDays.length === 0 ? (
            <EmptyState Icon={Inbox} title="Nothing recorded in this range" />
          ) : (
            <>
            {/* DESKTOP */}
            <div className="hidden md:block overflow-x-auto">
              <table className="table-base min-w-[880px]">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th className="!text-right">Rooms</th>
                    <th>Room numbers</th>
                    <th className="!text-right">Room charges</th>
                    <th className="!text-right">Collected</th>
                    <th className="!text-right">Expenses</th>
                    <th className="!text-right">Net</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleDays.map((d) => {
                    const open = expanded === d.day;
                    return (
                      <Fragment key={d.day}>
                        <tr
                          className={`cursor-pointer hover:bg-surfaceAlt ${open ? "bg-brand-soft/30" : ""}`}
                          onClick={() => setExpanded(open ? null : d.day)}
                        >
                          <td className="font-mono font-semibold text-ink whitespace-nowrap">
                            {format(new Date(d.day), "dd MMM yyyy")}
                            <span className="ml-1.5 text-[10px] font-sans font-normal text-textSecondary">
                              {format(new Date(d.day), "EEE")}
                            </span>
                          </td>
                          <td className="text-right tabular-nums">{d.roomsOccupied}</td>
                          <td className="max-w-[220px] truncate text-textSecondary text-xs font-mono">
                            {d.roomNumbers || "-"}
                          </td>
                          <td className="text-right font-mono tabular-nums">{inr(d.roomCharges)}</td>
                          <td className="text-right font-mono tabular-nums text-success">
                            {inr(d.collected)}
                          </td>
                          <td className="text-right font-mono tabular-nums text-dangerFg">
                            {d.expenses > 0.009 ? `− ${inr(d.expenses)}` : inr(0)}
                          </td>
                          <td
                            className={`text-right font-mono font-semibold tabular-nums ${
                              d.net >= 0 ? "text-ink" : "text-dangerFg"
                            }`}
                          >
                            {inr(d.net)}
                          </td>
                        </tr>
                        {open && d.rooms.length > 0 && (
                          <tr>
                            <td colSpan={7} className="!p-0 bg-surfaceAlt">
                              <table className="w-full text-xs">
                                <tbody>
                                  {d.rooms.map((r, i) => (
                                    <tr key={`${d.day}-${r.roomNumber}-${i}`} className="border-b border-divider last:border-0">
                                      <td className="pl-10 py-1.5 font-mono font-semibold text-ink w-24">
                                        {r.roomNumber}
                                      </td>
                                      <td className="py-1.5">
                                        {r.guestName}
                                        {r.complimentary && (
                                          <span className="ml-1.5 text-[10px] text-success">Comp</span>
                                        )}
                                      </td>
                                      <td className="py-1.5 font-mono text-textSecondary">
                                        {r.reservationNumber}
                                      </td>
                                      <td className="py-1.5 pr-4 text-right font-mono tabular-nums">
                                        {inr(r.rate)}/night
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="bg-surfaceAlt">
                    <td className="font-semibold text-ink">Total</td>
                    <td className="text-right font-semibold tabular-nums">
                      {totals?.roomNights ?? 0}
                    </td>
                    <td></td>
                    <td className="text-right font-mono font-bold tabular-nums">
                      {inr(totals?.roomCharges ?? 0)}
                    </td>
                    <td className="text-right font-mono font-bold tabular-nums text-success">
                      {inr(totals?.collected ?? 0)}
                    </td>
                    <td className="text-right font-mono font-bold tabular-nums text-dangerFg">
                      − {inr(totals?.expenses ?? 0)}
                    </td>
                    <td className="text-right font-mono font-bold tabular-nums">
                      {inr(totals?.net ?? 0)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>

            {/* MOBILE — same day rows as stacked cards; tapping one opens
                the per-room detail, exactly like the desktop expander. */}
            <ul className="md:hidden divide-y divide-divider">
              {visibleDays.map((d) => {
                const open = expanded === d.day;
                return (
                  <li key={d.day}>
                    <div
                      role="button"
                      tabIndex={0}
                      aria-expanded={open}
                      className={`${MOBILE_ROW} ${open ? "bg-brand-soft/30" : ""}`}
                      onClick={() => setExpanded(open ? null : d.day)}
                      onKeyDown={rowKeyActivate(() => setExpanded(open ? null : d.day))}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="font-mono font-semibold text-ink">
                            {format(new Date(d.day), "dd MMM yyyy")}
                            <span className="ml-1.5 text-[10px] font-sans font-normal text-textSecondary">
                              {format(new Date(d.day), "EEE")}
                            </span>
                          </div>
                          <div className="text-[11px] text-inkMuted mt-0.5">
                            {d.roomsOccupied} room{d.roomsOccupied === 1 ? "" : "s"} ·{" "}
                            {inr(d.roomCharges)} charges
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                          <span
                            className={`font-mono font-semibold tabular-nums ${
                              d.net >= 0 ? "text-ink" : "text-dangerFg"
                            }`}
                          >
                            {inr(d.net)}
                          </span>
                          <ChevronDown
                            className={`w-4 h-4 text-textSecondary transition-transform ${
                              open ? "rotate-180" : ""
                            }`}
                          />
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1.5 text-[11px] font-mono tabular-nums">
                        <span className="text-success">{inr(d.collected)} collected</span>
                        <span className="text-dangerFg">
                          {d.expenses > 0.009 ? `− ${inr(d.expenses)}` : inr(0)} expenses
                        </span>
                      </div>
                      {d.roomNumbers && (
                        <div className="text-[11px] font-mono text-textSecondary mt-1 break-words">
                          {d.roomNumbers}
                        </div>
                      )}
                    </div>
                    {open && d.rooms.length > 0 && (
                      <ul className="bg-surfaceAlt border-t border-divider divide-y divide-divider">
                        {d.rooms.map((r, i) => (
                          <li
                            key={`${d.day}-${r.roomNumber}-${i}`}
                            className="px-3 py-2 flex items-start justify-between gap-2"
                          >
                            <div className="min-w-0">
                              <div className="text-xs">
                                <span className="font-mono font-semibold text-ink">
                                  {r.roomNumber}
                                </span>
                                <span className="ml-2">{r.guestName}</span>
                                {r.complimentary && (
                                  <span className="ml-1.5 text-[10px] text-success">Comp</span>
                                )}
                              </div>
                              <div className="text-[10px] font-mono text-textSecondary truncate">
                                {r.reservationNumber}
                              </div>
                            </div>
                            <div className="text-xs font-mono tabular-nums shrink-0">
                              {inr(r.rate)}/night
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                );
              })}
              <li className="px-3 py-3 bg-surfaceAlt">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-semibold text-ink">
                    Total · {totals?.roomNights ?? 0} room night
                    {(totals?.roomNights ?? 0) === 1 ? "" : "s"}
                  </span>
                  <span className="font-mono font-bold text-ink tabular-nums shrink-0">
                    {inr(totals?.net ?? 0)}
                  </span>
                </div>
                <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1 text-[11px] font-mono tabular-nums">
                  <span className="text-textSecondary">
                    {inr(totals?.roomCharges ?? 0)} charges
                  </span>
                  <span className="text-success">{inr(totals?.collected ?? 0)} collected</span>
                  <span className="text-dangerFg">− {inr(totals?.expenses ?? 0)} expenses</span>
                </div>
              </li>
            </ul>
            </>
          )}
        </div>
        <p className="text-[11px] text-textSecondary mt-2 leading-snug">
          Room charges = sum of nightly rates of occupied rooms (the night belongs to the
          check-in day; checkout day isn't billed). Collected = payments received that day
          across all bookings. Net = collected − expenses.
        </p>
      </div>
    </div>
  );
}

function RoomsTab({ from, to }: { from: string; to: string }) {
  const { data = [] } = useQuery({
    queryKey: ["rpt-rooms", from, to],
    queryFn: () =>
      api.get<
        {
          roomId: string;
          roomNumber: string;
          roomType: string;
          baseRate: string;
          bookings: number;
          // Day-use vs overnight split per room (added 2026 day-use feature).
          // Optional so old API responses still type-check.
          overnightBookings?: number;
          shortStayBookings?: number;
          revenue: string;
        }[]
      >("/reports/room-performance", { date_from: from, date_to: to }),
  });

  const total = data.reduce((s, r) => s + Number(r.revenue), 0);
  const totalBookings = data.reduce((s, r) => s + r.bookings, 0);
  const top = [...data].sort((a, b) => Number(b.revenue) - Number(a.revenue))[0];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-3 md:grid-cols-2 lg:grid-cols-3 gap-3">
        <Kpi label="Active rooms" value={data.length} Icon={BedDouble} />
        <Kpi label="Total bookings" value={totalBookings} Icon={CheckCircle2} />
        <Kpi
          label="Top performer"
          value={top ? `Room ${top.roomNumber}` : "-"}
          Icon={TrendingUp}
          tone="success"
          hint={top ? inr(top.revenue) : undefined}
        />
      </div>

      <div>
        <SectionHeader
          title="Per-room performance"
          subtitle="Bookings and revenue for each room in the selected range"
          right={
            <ExportBtn
              onClick={() => exportCsv(`room-performance-${from}-${to}.csv`, data)}
              disabled={!data.length}
            />
          }
        />
        <div className="card !p-0 overflow-hidden">
          {data.length === 0 ? (
            <EmptyState Icon={Inbox} title="No room activity in this range" />
          ) : (
            <>
              {/* DESKTOP */}
              <div className="hidden md:block overflow-x-auto">
                <table className="table-base">
                  <thead>
                    <tr>
                      <th>Room</th>
                      <th>Type</th>
                      <th className="!text-right">Base rate</th>
                      <th className="!text-right">Bookings</th>
                      <th className="!text-right">Day use</th>
                      <th className="!text-right">Revenue</th>
                      <th className="!text-right">Share</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.map((r) => {
                      const share = total > 0 ? (Number(r.revenue) / total) * 100 : 0;
                      return (
                        <tr key={r.roomId}>
                          <td className="font-mono font-semibold text-ink">{r.roomNumber}</td>
                          <td className="capitalize">{r.roomType}</td>
                          <td className="text-right font-mono tabular-nums">{inr(r.baseRate)}</td>
                          <td className="text-right tabular-nums">{r.bookings}</td>
                          <td className="text-right tabular-nums">{r.shortStayBookings ?? 0}</td>
                          <td className="text-right font-mono tabular-nums">{inr(r.revenue)}</td>
                          <td className="text-right">
                            <div className="inline-flex items-center gap-2">
                              <div className="w-16 h-1.5 rounded-full bg-surfaceSubtle overflow-hidden">
                                <div
                                  className="h-full bg-brand"
                                  style={{ width: `${share}%` }}
                                />
                              </div>
                              <span className="text-[11px] font-mono text-textSecondary w-9 text-right">
                                {share.toFixed(0)}%
                              </span>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="bg-surfaceAlt">
                      <td className="font-semibold text-ink" colSpan={3}>
                        Total
                      </td>
                      <td className="text-right font-semibold tabular-nums">{totalBookings}</td>
                      <td className="text-right font-semibold tabular-nums">
                        {data.reduce((s, r) => s + (r.shortStayBookings ?? 0), 0)}
                      </td>
                      <td className="text-right font-mono font-bold tabular-nums">{inr(total)}</td>
                      <td></td>
                    </tr>
                  </tfoot>
                </table>
              </div>

              {/* MOBILE */}
              <ul className="md:hidden divide-y divide-divider">
                {data.map((r) => {
                  const share = total > 0 ? (Number(r.revenue) / total) * 100 : 0;
                  return (
                    <li key={r.roomId} className="px-3 py-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="font-mono font-semibold text-ink">{r.roomNumber}</div>
                          <div className="text-[11px] text-inkMuted capitalize mt-0.5">
                            {r.roomType} · base {inr(r.baseRate)}
                          </div>
                        </div>
                        <div className="font-mono font-semibold text-ink tabular-nums shrink-0">
                          {inr(r.revenue)}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 mt-1.5">
                        <div className="flex-1 h-1.5 rounded-full bg-surfaceSubtle overflow-hidden">
                          <div className="h-full bg-brand" style={{ width: `${share}%` }} />
                        </div>
                        <span className="text-[11px] font-mono text-textSecondary shrink-0">
                          {share.toFixed(0)}%
                        </span>
                      </div>
                      <div className="text-[11px] text-inkMuted mt-1">
                        {r.bookings} booking{r.bookings === 1 ? "" : "s"} ·{" "}
                        {r.shortStayBookings ?? 0} day use
                      </div>
                    </li>
                  );
                })}
                <li className="px-3 py-3 bg-surfaceAlt">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="font-semibold text-ink">Total</span>
                    <span className="font-mono font-bold text-ink tabular-nums shrink-0">
                      {inr(total)}
                    </span>
                  </div>
                  <div className="text-[11px] text-inkMuted mt-1">
                    {totalBookings} booking{totalBookings === 1 ? "" : "s"} ·{" "}
                    {data.reduce((s, r) => s + (r.shortStayBookings ?? 0), 0)} day use
                  </div>
                </li>
              </ul>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function CreditTab({ from, to }: { from: string; to: string }) {
  const navigate = useNavigate();
  const { data } = useQuery({
    queryKey: ["rpt-credit", from, to],
    queryFn: () =>
      api.get<{
        totals: {
          count: number;
          grandTotal: number;
          balanceDue: number;
          totalPaid: number;
          complimentary: number;
        };
        rows: {
          id: string;
          reservationNumber: string;
          guestName: string;
          guestPhone: string;
          bookingSource: string;
          checkInDate: string;
          checkOutDate: string;
          numNights: number;
          grandTotal: string;
          balanceDue: string;
          // Sum of received non-voided payments — money already collected
          // on this booking before/after it was reclassified as comp.
          totalPaid: string;
          status: string;
          creditNotes: string | null;
          createdAt: string;
        }[];
      }>("/reports/credit-bookings", { date_from: from, date_to: to }),
  });
  if (!data) return <Loader />;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-2 lg:grid-cols-4 gap-3">
        <Kpi label="Total bookings" value={data.totals.count} Icon={Gift} />
        <Kpi
          label="Complimentary value"
          value={inr(data.totals.complimentary)}
          Icon={Wallet}
          hint="Total billed value of comped stays"
        />
        <Kpi
          label="Already paid"
          value={inr(data.totals.totalPaid)}
          Icon={CheckCircle2}
          tone="success"
          hint="Money collected before/after comping"
        />
        <Kpi
          label="Balance due"
          value={inr(data.totals.balanceDue)}
          Icon={AlertTriangle}
          tone="danger"
        />
      </div>

      <div>
        <SectionHeader
          title="Complimentary & credit bookings"
          subtitle="Bookings with credit notes or comp adjustments"
          right={
            <ExportBtn
              onClick={() =>
                exportCsv(
                  `credit-bookings-${from}-${to}.csv`,
                  data.rows as unknown as Record<string, unknown>[],
                )
              }
              disabled={!data.rows.length}
            />
          }
        />
        <div className="card !p-0 overflow-hidden">
          {data.rows.length === 0 ? (
            <EmptyState
              Icon={Inbox}
              title="No credit bookings in this range"
              hint="Bookings marked as complimentary or carrying credit notes show up here."
            />
          ) : (
            <>
              {/* DESKTOP */}
              <div className="hidden md:block overflow-x-auto">
                <table className="table-base min-w-[1000px]">
                  <thead>
                    <tr>
                      <th>Reservation</th>
                      <th>Guest</th>
                      <th>Source</th>
                      <th>Check-in</th>
                      <th>Check-out</th>
                      <th className="!text-right">Nights</th>
                      <th className="!text-right">Total</th>
                      <th className="!text-right">Paid</th>
                      <th className="!text-right">Balance</th>
                      <th>Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.map((r) => (
                      <tr
                        key={r.id}
                        role="button"
                        tabIndex={0}
                        onClick={() => navigate(`/reservations/${r.reservationNumber}`)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            navigate(`/reservations/${r.reservationNumber}`);
                          }
                        }}
                        className="cursor-pointer hover:bg-brand-soft/30 focus:outline-none focus:bg-brand-soft/30"
                      >
                        <td className="font-mono text-accentBlue text-xs">
                          {r.reservationNumber}
                        </td>
                        <td>
                          <div className="font-medium text-ink">{r.guestName}</div>
                          <div className="text-[11px] text-textSecondary font-mono">
                            {r.guestPhone}
                          </div>
                        </td>
                        <td className="capitalize text-xs">
                          {r.bookingSource
                            .replace(/_/g, " ")
                            .replace("phone whatsapp", "Phone / WhatsApp")}
                        </td>
                        <td>{format(new Date(r.checkInDate), "dd MMM yyyy")}</td>
                        <td>{format(new Date(r.checkOutDate), "dd MMM yyyy")}</td>
                        <td className="text-right tabular-nums">{r.numNights}</td>
                        <td className="text-right font-mono tabular-nums">{inr(r.grandTotal)}</td>
                        <td className="text-right font-mono text-success tabular-nums">
                          {inr(r.totalPaid)}
                        </td>
                        <td className="text-right font-mono text-dangerFg tabular-nums">
                          {inr(r.balanceDue)}
                        </td>
                        <td className="text-xs text-textSecondary">{r.creditNotes ?? "-"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* MOBILE */}
              <ul className="md:hidden divide-y divide-divider">
                {data.rows.map((r) => (
                  <li
                    key={r.id}
                    role="button"
                    tabIndex={0}
                    className={MOBILE_ROW}
                    onClick={() => navigate(`/reservations/${r.reservationNumber}`)}
                    onKeyDown={rowKeyActivate(() =>
                      navigate(`/reservations/${r.reservationNumber}`),
                    )}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="font-mono text-accentBlue text-xs truncate">
                          {r.reservationNumber}
                        </div>
                        <div className="font-medium text-ink truncate mt-0.5">{r.guestName}</div>
                        <div className="text-[11px] text-textSecondary font-mono truncate">
                          {r.guestPhone}
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className="font-mono font-semibold text-ink tabular-nums">
                          {inr(r.grandTotal)}
                        </div>
                        <div className="font-mono text-[11px] text-success tabular-nums mt-0.5">
                          {inr(r.totalPaid)} paid
                        </div>
                        <div className="font-mono text-[11px] text-dangerFg tabular-nums mt-0.5">
                          {inr(r.balanceDue)} due
                        </div>
                      </div>
                    </div>
                    <div className="text-[11px] text-inkMuted mt-1.5">
                      {format(new Date(r.checkInDate), "dd MMM yyyy")} →{" "}
                      {format(new Date(r.checkOutDate), "dd MMM yyyy")} · {r.numNights} night
                      {r.numNights === 1 ? "" : "s"}
                    </div>
                    <div className="text-[11px] text-inkMuted capitalize mt-0.5">
                      {r.bookingSource
                        .replace(/_/g, " ")
                        .replace("phone whatsapp", "Phone / WhatsApp")}
                    </div>
                    {r.creditNotes && (
                      <div className="text-xs text-textSecondary mt-1 break-words">
                        {r.creditNotes}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function GuestsTab({ from, to }: { from: string; to: string }) {
  const { data = [] } = useQuery({
    queryKey: ["rpt-guests", from, to],
    queryFn: () =>
      api.get<
        {
          guestId: string;
          fullName: string;
          phone: string;
          stays: number;
          revenue: string;
        }[]
      >("/reports/guests", { date_from: from, date_to: to }),
  });

  const navigate = useNavigate();
  const top = data[0];
  const totalRevenue = data.reduce((s, g) => s + Number(g.revenue), 0);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-3 md:grid-cols-2 lg:grid-cols-3 gap-3">
        <Kpi label="Guests" value={data.length} Icon={Users} />
        <Kpi
          label="Top guest"
          value={top?.fullName ?? "-"}
          Icon={TrendingUp}
          tone="success"
          hint={top ? `${top.stays} stay${top.stays === 1 ? "" : "s"} · ${inr(top.revenue)}` : undefined}
        />
        <Kpi label="Revenue from list" value={inr(totalRevenue)} Icon={Wallet} />
      </div>

      <div>
        <SectionHeader
          title="Top guests"
          subtitle="Most stays in the selected range. Click a row for the full profile."
          right={
            <ExportBtn
              onClick={() => exportCsv(`top-guests-${from}-${to}.csv`, data)}
              disabled={!data.length}
            />
          }
        />
        <div className="card !p-0 overflow-hidden">
          {data.length === 0 ? (
            <EmptyState Icon={Inbox} title="No guests in this range yet" />
          ) : (
            <>
              {/* DESKTOP */}
              <div className="hidden md:block overflow-x-auto">
                <table className="table-base">
                  <thead>
                    <tr>
                      <th>Guest</th>
                      <th>Phone</th>
                      <th className="!text-right">Stays</th>
                      <th className="!text-right">Revenue</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.map((g) => (
                      <tr
                        key={g.guestId}
                        className="cursor-pointer"
                        onClick={() => navigate(`/guests/${g.phone}`)}
                      >
                        <td className="font-medium text-ink">{g.fullName}</td>
                        <td className="font-mono text-textSecondary text-xs">{g.phone}</td>
                        <td className="text-right tabular-nums">{g.stays}</td>
                        <td className="text-right font-mono tabular-nums">{inr(g.revenue)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* MOBILE */}
              <ul className="md:hidden divide-y divide-divider">
                {data.map((g) => (
                  <li
                    key={g.guestId}
                    role="button"
                    tabIndex={0}
                    className={MOBILE_ROW}
                    onClick={() => navigate(`/guests/${g.phone}`)}
                    onKeyDown={rowKeyActivate(() => navigate(`/guests/${g.phone}`))}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="font-medium text-ink truncate">{g.fullName}</div>
                        <div className="font-mono text-xs text-textSecondary truncate mt-0.5">
                          {g.phone}
                        </div>
                        <div className="text-[11px] text-inkMuted mt-1">
                          {g.stays} stay{g.stays === 1 ? "" : "s"}
                        </div>
                      </div>
                      <div className="font-mono font-semibold text-ink tabular-nums shrink-0">
                        {inr(g.revenue)}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
