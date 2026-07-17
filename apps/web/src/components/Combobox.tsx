import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Check, X } from "lucide-react";

// Search-as-you-type combobox with optional grouped options and a
// "use custom value" affordance. Built for our state picker but
// general enough that any "pick from a list OR type your own" field
// can reuse it. No external dependency — pure local state.
//
// Behaviour:
//   - Typing filters the visible options (case-insensitive substring).
//   - When the typed text doesn't match an existing option, a "Use
//     'foo' as custom value" row appears at the top of the popover so
//     staff can confirm freeform input.
//   - Arrow keys + Enter navigate; Escape closes.
//   - Click outside closes.

export interface ComboboxGroup {
  label: string;
  options: readonly string[];
}

interface Props {
  value: string;
  onChange: (next: string) => void;
  // Either flat options or grouped — pass whichever fits. Grouped
  // renders with optgroup-style headers in the popover.
  options?: readonly string[];
  groups?: readonly ComboboxGroup[];
  placeholder?: string;
  // Disable freeform entry — i.e. revert to strict picklist behaviour.
  // Default is to allow custom values via the "Use … as custom value"
  // row, which is the whole reason this component exists.
  allowCustom?: boolean;
  // Optional id forwarded to the trigger input. Useful when an
  // external <label htmlFor=...> needs to focus the field.
  inputId?: string;
  className?: string;
}

export function Combobox({
  value,
  onChange,
  options,
  groups,
  placeholder = "Select…",
  allowCustom = true,
  inputId,
  className,
}: Props) {
  const generatedId = useId();
  const id = inputId ?? generatedId;
  const [open, setOpen] = useState(false);
  // Draft is what's in the text box. We commit to onChange only when
  // the user picks an option or blurs with a custom value.
  const [draft, setDraft] = useState(value);
  const [highlight, setHighlight] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  // Open the popover above the input when there isn't enough room
  // below (e.g. the State field near the bottom of a constrained
  // modal). Recomputed on open + window resize.
  const [placement, setPlacement] = useState<"below" | "above">("below");
  // Cap popover height to whichever side has space. 256px is the
  // design baseline; we shrink if a smaller window is all that's
  // available.
  const [maxListPx, setMaxListPx] = useState(256);

  // Keep draft in sync when the parent value changes externally (e.g.
  // initial form load, programmatic reset).
  useEffect(() => {
    setDraft(value);
  }, [value]);

  // Flat list of [groupLabel | null, option] tuples for filtered
  // rendering + arrow-key navigation. When options is used (flat),
  // groupLabel is null on every row.
  type Row = { kind: "option"; group: string | null; value: string };
  type HeaderRow = { kind: "header"; label: string };
  type CustomRow = { kind: "custom"; value: string };
  type AnyRow = Row | HeaderRow | CustomRow;

  const filteredRows: AnyRow[] = useMemo(() => {
    const needle = draft.trim().toLowerCase();
    const rows: AnyRow[] = [];

    // Custom-value affordance sits at the top of the popover whenever
    // the typed text is non-empty AND doesn't exactly match any option.
    if (allowCustom && needle) {
      const flat = groups
        ? groups.flatMap((g) => g.options)
        : (options ?? []);
      const exact = flat.some((o) => o.toLowerCase() === needle);
      if (!exact) {
        rows.push({ kind: "custom", value: draft.trim() });
      }
    }

    if (groups) {
      for (const g of groups) {
        const matches = g.options.filter((o) =>
          needle ? o.toLowerCase().includes(needle) : true,
        );
        if (matches.length === 0) continue;
        rows.push({ kind: "header", label: g.label });
        for (const o of matches) {
          rows.push({ kind: "option", group: g.label, value: o });
        }
      }
    } else if (options) {
      for (const o of options) {
        if (!needle || o.toLowerCase().includes(needle)) {
          rows.push({ kind: "option", group: null, value: o });
        }
      }
    }

    return rows;
  }, [draft, groups, options, allowCustom]);

  // Indexable list of selectable rows (skip headers) — what arrow keys
  // walk through and what Enter commits.
  const selectable = filteredRows.filter(
    (r) => r.kind === "option" || r.kind === "custom",
  );

  // Reset highlight whenever the filtered list changes so we don't
  // point at a stale index.
  useEffect(() => {
    setHighlight(0);
  }, [filteredRows.length, open]);

  // Tracks whether the highlight changed because of keyboard navigation
  // (in which case we want to scroll the row into view) or because the
  // popover just opened / list re-filtered (in which case we DON'T —
  // an autoscroll on first open can otherwise drag the parent modal's
  // scroll position around and make it look like the dropdown landed
  // halfway through the list).
  const keyNavRef = useRef(false);

  // Always start the listbox at the top whenever it (re)opens. This
  // overrides the browser's tendency to remember the last scroll
  // position of the absolutely-positioned <ul>.
  useLayoutEffect(() => {
    if (open && listRef.current) {
      listRef.current.scrollTop = 0;
    }
    if (!open) {
      // Clear keyboard-nav state so the next open doesn't immediately
      // trigger a scroll based on stale arrow-key context.
      keyNavRef.current = false;
      setHighlight(0);
    }
  }, [open, filteredRows.length]);

  // Decide whether the popover renders below or above the input.
  // Recomputed every time it opens, and on window resize while open.
  useLayoutEffect(() => {
    if (!open) return;
    function recompute() {
      const trigger = inputRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const desired = 256; // matches the design max-height
      const margin = 12; // breathing room from viewport edges
      const spaceBelow = window.innerHeight - rect.bottom - margin;
      const spaceAbove = rect.top - margin;
      if (spaceBelow >= desired || spaceBelow >= spaceAbove) {
        setPlacement("below");
        setMaxListPx(Math.max(140, Math.min(desired, spaceBelow)));
      } else {
        setPlacement("above");
        setMaxListPx(Math.max(140, Math.min(desired, spaceAbove)));
      }
    }
    recompute();
    window.addEventListener("resize", recompute);
    window.addEventListener("scroll", recompute, true);
    return () => {
      window.removeEventListener("resize", recompute);
      window.removeEventListener("scroll", recompute, true);
    };
  }, [open]);

  // Click-outside to close. Also commits the current draft as a custom
  // value when allowCustom is on; otherwise reverts to the last
  // committed value.
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        commitOnBlur();
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, draft, allowCustom]);

  function commitOnBlur() {
    const d = draft.trim();
    if (!d) {
      onChange("");
      return;
    }
    if (allowCustom) {
      onChange(d);
    } else {
      const flat = groups ? groups.flatMap((g) => g.options) : (options ?? []);
      const match = flat.find((o) => o.toLowerCase() === d.toLowerCase());
      if (match) onChange(match);
      else setDraft(value); // revert
    }
  }

  function pick(v: string) {
    onChange(v);
    setDraft(v);
    setOpen(false);
    // Keep focus on the input (don't blur): the parent form's
    // "Enter jumps to the next field" flow needs a focused element to
    // advance FROM — blurring here left the keyboard flow dead right
    // after picking a State/City suggestion.
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    // When the suggestion list is CLOSED (a value is already committed),
    // Up/Down belong to the form's field-to-field navigation — don't swallow
    // them into re-opening the popover. Down on an EMPTY/uncommitted field
    // still opens the list, which is what staff expect when browsing options.
    if (!open && (e.key === "ArrowUp" || (e.key === "ArrowDown" && value))) {
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) setOpen(true);
      keyNavRef.current = true;
      setHighlight((h) => Math.min(h + 1, Math.max(0, selectable.length - 1)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      keyNavRef.current = true;
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      if (open && selectable[highlight]) {
        e.preventDefault();
        // Keep the Enter here — a parent "Enter jumps to next field" handler
        // must not also fire when the user is just picking a suggestion.
        e.stopPropagation();
        const row = selectable[highlight];
        pick(row.value);
      }
    } else if (e.key === "Escape") {
      setOpen(false);
      setDraft(value);
    }
  }

  // Scroll the highlighted row into view ONLY when the user is
  // arrow-keying through the list — never on mount, list re-filter,
  // or mouse hover. That avoids the autoscroll-side-effect that was
  // dragging the parent modal's scroll position around when the
  // popover first opened.
  useEffect(() => {
    if (!open || !listRef.current) return;
    if (!keyNavRef.current) return;
    const list = listRef.current;
    const el = list.querySelector<HTMLElement>(`[data-row="${highlight}"]`);
    if (el) {
      // Manually constrain the scroll adjustment to the listbox only —
      // scrollIntoView walks up the scroll tree and would scroll the
      // modal too, which is exactly the bug we just fixed.
      const elTop = el.offsetTop;
      const elBottom = elTop + el.offsetHeight;
      const visibleTop = list.scrollTop;
      const visibleBottom = visibleTop + list.clientHeight;
      if (elTop < visibleTop) list.scrollTop = elTop;
      else if (elBottom > visibleBottom) list.scrollTop = elBottom - list.clientHeight;
    }
    keyNavRef.current = false;
  }, [highlight, open]);

  // Walk filteredRows but track a running selectable-index so we can
  // mark the highlighted row visually.
  let selIdx = -1;

  return (
    <div ref={wrapRef} className={`relative ${className ?? ""}`}>
      <div className="relative">
        <input
          id={id}
          ref={inputRef}
          type="text"
          className="input pr-9"
          placeholder={placeholder}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            if (!open) setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          autoComplete="off"
          role="combobox"
          aria-expanded={open}
          aria-controls={`${id}-listbox`}
          aria-autocomplete="list"
        />
        {draft && (
          <button
            type="button"
            onClick={() => {
              setDraft("");
              onChange("");
              inputRef.current?.focus();
              setOpen(true);
            }}
            className="absolute right-7 top-1/2 -translate-y-1/2 text-textSecondary hover:text-textPrimary"
            title="Clear"
            tabIndex={-1}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
        <ChevronDown
          className={`absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-textSecondary pointer-events-none transition-transform ${
            open ? "rotate-180" : ""
          }`}
        />
      </div>

      {open && filteredRows.length > 0 && (
        <ul
          ref={listRef}
          id={`${id}-listbox`}
          role="listbox"
          style={{ maxHeight: `${maxListPx}px` }}
          className={`absolute z-50 left-0 right-0 overflow-y-auto rounded-sm border border-borderc bg-surface shadow-lg ${
            placement === "below" ? "top-full mt-1" : "bottom-full mb-1"
          }`}
        >
          {filteredRows.map((row, i) => {
            if (row.kind === "header") {
              return (
                <li
                  key={`h-${row.label}-${i}`}
                  className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wider font-semibold text-textSecondary bg-surface border-b border-borderc sticky top-0 z-10"
                  aria-hidden="true"
                >
                  {row.label}
                </li>
              );
            }
            selIdx++;
            const active = selIdx === highlight;
            const isCustom = row.kind === "custom";
            const selected = value === row.value;
            return (
              <li
                key={`${row.kind}-${row.value}-${i}`}
                role="option"
                aria-selected={selected}
                data-row={selIdx}
                onMouseEnter={() => setHighlight(selIdx)}
                onMouseDown={(e) => {
                  // mousedown (not click) so the input doesn't blur
                  // first and close the popover before we register.
                  e.preventDefault();
                  pick(row.value);
                }}
                className={`px-3 py-2 text-sm cursor-pointer flex items-center gap-2 ${
                  active
                    ? "bg-brand-soft text-brand-dark"
                    : "text-textPrimary hover:bg-bg"
                }`}
              >
                {isCustom ? (
                  <>
                    <span className="text-[10px] uppercase tracking-wider font-semibold text-[#157f5f] shrink-0">
                      Use
                    </span>
                    <span className="font-medium truncate">"{row.value}"</span>
                    <span className="text-[11px] text-textSecondary ml-auto shrink-0">
                      custom value
                    </span>
                  </>
                ) : (
                  <>
                    <span className="truncate flex-1">{row.value}</span>
                    {selected && (
                      <Check className="w-3.5 h-3.5 text-brand-dark shrink-0" />
                    )}
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {open && filteredRows.length === 0 && (
        <div
          className={`absolute z-50 left-0 right-0 rounded-sm border border-borderc bg-surface shadow-lg px-3 py-3 text-xs text-textSecondary ${
            placement === "below" ? "top-full mt-1" : "bottom-full mb-1"
          }`}
        >
          No matches.{" "}
          {!allowCustom && "Clear the search to see all options."}
        </div>
      )}
    </div>
  );
}
