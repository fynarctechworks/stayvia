// Compact preset toolbar for list pages with a date range. Shows
// Today / Week / Month / Year buttons and an optional Custom
// expansion. The parent owns the from/to state — this component is
// just a controlled trigger that calls onChange whenever the user
// picks a preset or edits the custom inputs.
//
// Used by Reservations, Invoices, Activity. Reports has its own
// near-identical bar because it pre-dates this component and lives
// inside a more complex tab layout — kept separate to avoid a risky
// touch in stable code.

import {
  endOfMonth,
  endOfWeek,
  endOfYear,
  format,
  startOfMonth,
  startOfWeek,
  startOfYear,
} from "date-fns";
import { ChevronDown } from "lucide-react";
import { useState } from "react";

export type DatePresetKey =
  | "today"
  | "week"
  | "month"
  | "year"
  | "custom"
  | "all";

interface PresetDef {
  key: DatePresetKey;
  label: string;
  range: () => { from: Date; to: Date };
}

const todayStart = (): Date => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};
const todayEnd = (): Date => {
  const d = new Date();
  d.setHours(23, 59, 59, 999);
  return d;
};

const PRESETS: PresetDef[] = [
  {
    key: "today",
    label: "Today",
    range: () => ({ from: todayStart(), to: todayEnd() }),
  },
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

export function rangeForPreset(
  key: DatePresetKey,
): { from: string; to: string } | null {
  if (key === "custom" || key === "all") return null;
  const def = PRESETS.find((p) => p.key === key);
  if (!def) return null;
  const r = def.range();
  return { from: format(r.from, "yyyy-MM-dd"), to: format(r.to, "yyyy-MM-dd") };
}

interface Props {
  preset: DatePresetKey;
  from: string;
  to: string;
  // Whether to include an "All" pill that clears both ends. Off by
  // default — most list pages want a bounded view to keep responses
  // small.
  allowAll?: boolean;
  onChange: (next: { preset: DatePresetKey; from: string; to: string }) => void;
}

export function DatePresetBar({
  preset,
  from,
  to,
  allowAll = false,
  onChange,
}: Props) {
  const [showCustom, setShowCustom] = useState(preset === "custom");

  function pick(key: DatePresetKey) {
    if (key === "all") {
      setShowCustom(false);
      onChange({ preset: "all", from: "", to: "" });
      return;
    }
    if (key === "custom") {
      setShowCustom(true);
      onChange({ preset: "custom", from, to });
      return;
    }
    setShowCustom(false);
    const r = rangeForPreset(key);
    if (r) onChange({ preset: key, from: r.from, to: r.to });
  }

  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="flex items-center gap-1 flex-wrap">
        {PRESETS.map((p) => {
          const active = preset === p.key;
          return (
            <button
              key={p.key}
              onClick={() => pick(p.key)}
              className={`px-3 h-8 text-xs font-semibold rounded-sm border transition-colors ${
                active
                  ? "bg-brand-dark text-cream border-brand-dark"
                  : "bg-surface text-textSecondary border-borderc hover:border-brand hover:text-brand"
              }`}
            >
              {p.label}
            </button>
          );
        })}
        <button
          onClick={() => pick("custom")}
          className={`px-3 h-8 text-xs font-semibold rounded-sm border transition-colors inline-flex items-center gap-1 ${
            preset === "custom"
              ? "bg-brand-dark text-cream border-brand-dark"
              : "bg-surface text-textSecondary border-borderc hover:border-brand hover:text-brand"
          }`}
        >
          Custom
          <ChevronDown
            className={`w-3 h-3 transition-transform ${showCustom ? "rotate-180" : ""}`}
          />
        </button>
        {allowAll && (
          <button
            onClick={() => pick("all")}
            className={`px-3 h-8 text-xs font-semibold rounded-sm border transition-colors ${
              preset === "all"
                ? "bg-brand-dark text-cream border-brand-dark"
                : "bg-surface text-textSecondary border-borderc hover:border-brand hover:text-brand"
            }`}
          >
            All
          </button>
        )}
      </div>

      {showCustom && (
        <div className="flex items-end gap-2">
          <div>
            <label className="label block mb-1 text-[10px]">From</label>
            <input
              type="date"
              className="input h-8 text-xs w-36"
              value={from}
              max={to || undefined}
              onChange={(e) =>
                onChange({ preset: "custom", from: e.target.value, to })
              }
            />
          </div>
          <div>
            <label className="label block mb-1 text-[10px]">To</label>
            <input
              type="date"
              className="input h-8 text-xs w-36"
              value={to}
              min={from || undefined}
              onChange={(e) =>
                onChange({ preset: "custom", from, to: e.target.value })
              }
            />
          </div>
        </div>
      )}
    </div>
  );
}
