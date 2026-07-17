// 12-hour AM/PM time picker.
//
// Native <input type="time"> renders 24h or 12h based on the OS locale,
// which we can't control — on 24h-locale machines it shows "13, 14, 15…".
// This component always shows Hour (1–12) · Minute · AM/PM regardless of
// locale, while still storing/emitting the value as a 24-hour "HH:MM"
// string so every downstream consumer (receipt, invoice, DB) is unchanged.
//
// value: "" means unset (staff leaves it to hotel policy). Partial edits
// (hour picked but not AM/PM) are held internally and only emitted once a
// full, valid time exists.

import { useEffect, useRef, useState } from "react";

function parse24(hhmm: string): { h12: string; m: string; ap: "AM" | "PM" } | null {
  if (!hhmm) return null;
  const [hStr, mStr] = hhmm.split(":");
  const h = Number(hStr);
  const m = Number(mStr ?? "0");
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  const ap: "AM" | "PM" = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return { h12: String(h12), m: String(m).padStart(2, "0"), ap };
}

function to24(h12: string, m: string, ap: "AM" | "PM"): string {
  let h = Number(h12) % 12;
  if (ap === "PM") h += 12;
  return `${String(h).padStart(2, "0")}:${m.padStart(2, "0")}`;
}

const HOURS = Array.from({ length: 12 }, (_, i) => String(i + 1));
const MINUTES = Array.from({ length: 60 }, (_, i) => String(i).padStart(2, "0"));

export function TimePicker12h({
  value,
  onChange,
  className = "",
}: {
  value: string; // "HH:MM" 24-hour, or ""
  onChange: (v: string) => void;
  className?: string;
}) {
  const parsed = parse24(value);
  const [h12, setH12] = useState(parsed?.h12 ?? "");
  const [m, setM] = useState(parsed?.m ?? "");
  const [ap, setAp] = useState<"AM" | "PM" | "">(parsed?.ap ?? "");
  // Enter advances focus Hour → Minute → AM/PM once the current part has a
  // value: pick "10" (mouse or Enter-in-dropdown), press Enter again → next
  // box. Deliberately NOT on onChange — arrow-key browsing fires a change per
  // keypress and would yank focus away mid-selection. preventDefault stops
  // the surrounding form from treating the advance-Enter as a submit.
  const minuteRef = useRef<HTMLSelectElement>(null);
  const apRef = useRef<HTMLSelectElement>(null);
  const advanceOnEnter =
    (next: React.RefObject<HTMLSelectElement | null> | null) =>
    (e: React.KeyboardEvent<HTMLSelectElement>) => {
      if (e.key !== "Enter") return;
      if (!(e.target as HTMLSelectElement).value) return;
      e.preventDefault();
      next?.current?.focus();
    };

  // Keep local fields in sync when the parent value changes externally.
  useEffect(() => {
    const p = parse24(value);
    setH12(p?.h12 ?? "");
    setM(p?.m ?? "");
    setAp(p?.ap ?? "");
  }, [value]);

  function emit(nh: string, nm: string, nap: "AM" | "PM" | "") {
    if (nh && nm && nap) onChange(to24(nh, nm, nap));
    else if (!nh && !nm && !nap) onChange(""); // fully cleared
  }

  const sel = "input !w-auto min-w-[4.5rem]";

  return (
    <div className={`flex items-center gap-1.5 ${className}`}>
      <select
        className={sel}
        value={h12}
        onChange={(e) => {
          setH12(e.target.value);
          emit(e.target.value, m, ap);
        }}
        onKeyDown={advanceOnEnter(minuteRef)}
        aria-label="Hour"
      >
        <option value="">HH</option>
        {HOURS.map((h) => (
          <option key={h} value={h}>{h}</option>
        ))}
      </select>
      <span className="text-textSecondary">:</span>
      <select
        ref={minuteRef}
        className={sel}
        value={m}
        onChange={(e) => {
          setM(e.target.value);
          emit(h12, e.target.value, ap);
        }}
        onKeyDown={advanceOnEnter(apRef)}
        aria-label="Minute"
      >
        <option value="">MM</option>
        {MINUTES.map((mm) => (
          <option key={mm} value={mm}>{mm}</option>
        ))}
      </select>
      <select
        ref={apRef}
        className={sel}
        value={ap}
        onChange={(e) => {
          const nap = e.target.value as "AM" | "PM" | "";
          setAp(nap);
          emit(h12, m, nap);
        }}
        onKeyDown={advanceOnEnter(null)}
        aria-label="AM or PM"
      >
        <option value="">--</option>
        <option value="AM">AM</option>
        <option value="PM">PM</option>
      </select>
    </div>
  );
}
