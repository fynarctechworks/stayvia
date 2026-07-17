import { useEffect, useId, useRef, useState } from "react";

// Common email domains sorted by Indian market prevalence. When the
// user types the local part (everything before @), these suffixes are
// offered as completions. Once they type @ themselves, only the
// matching domains are shown. The list is intentionally short so the
// popover stays scannable — staff can always finish typing any domain
// manually.
const DOMAINS = [
  "gmail.com",
  "yahoo.com",
  "yahoo.in",
  "outlook.com",
  "hotmail.com",
  "rediffmail.com",
  "icloud.com",
  "protonmail.com",
  "aol.com",
  "live.com",
  "ymail.com",
  "zoho.com",
  "mail.com",
] as const;

interface Props {
  value: string;
  onChange: (next: string) => void;
  // Optional blur hook so callers can probe for duplicates the moment
  // staff moves on from the field. Fires after the suggestion popover
  // has closed.
  onBlur?: () => void;
  placeholder?: string;
  className?: string;
  required?: boolean;
  id?: string;
}

export function EmailInput({
  value,
  onChange,
  onBlur,
  placeholder = "guest@example.com",
  className,
  required,
  id: propsId,
}: Props) {
  const generatedId = useId();
  const id = propsId ?? generatedId;
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // Build suggestions from the current value.
  // - No @ yet → suggest "local@domain" for each domain.
  // - Has @ → filter domains by whatever they've typed after @.
  // - Already a complete valid-looking email → no suggestions.
  const suggestions: string[] = (() => {
    const v = value.trim();
    if (!v) return [];
    const atIdx = v.indexOf("@");
    if (atIdx < 0) {
      // No @ yet — suggest all domains
      return DOMAINS.map((d) => `${v}@${d}`);
    }
    const local = v.slice(0, atIdx);
    const partial = v.slice(atIdx + 1).toLowerCase();
    if (!local) return [];
    // If the domain already looks complete and matches one of ours,
    // don't nag with a single-item dropdown that repeats what they typed.
    if (DOMAINS.some((d) => d === partial)) return [];
    return DOMAINS.filter((d) => d.startsWith(partial)).map(
      (d) => `${local}@${d}`,
    );
  })();

  // Show the popover whenever there are suggestions and the input is
  // focused. Close on blur / selection / Esc.
  useEffect(() => {
    if (suggestions.length === 0) setOpen(false);
  }, [suggestions.length]);

  useEffect(() => {
    setHighlight(0);
  }, [suggestions.length]);

  // Close on click-outside.
  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  function pick(email: string) {
    onChange(email);
    setOpen(false);
    inputRef.current?.blur();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open || suggestions.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, suggestions.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter" || e.key === "Tab") {
      if (suggestions[highlight]) {
        e.preventDefault();
        pick(suggestions[highlight]);
      }
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  // Scroll highlighted row into view (keyboard nav only — same
  // pattern as Combobox).
  useEffect(() => {
    if (!open || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(
      `[data-idx="${highlight}"]`,
    );
    if (el) {
      const top = el.offsetTop;
      const bottom = top + el.offsetHeight;
      const vTop = listRef.current.scrollTop;
      const vBottom = vTop + listRef.current.clientHeight;
      if (top < vTop) listRef.current.scrollTop = top;
      else if (bottom > vBottom)
        listRef.current.scrollTop = bottom - listRef.current.clientHeight;
    }
  }, [highlight, open]);

  return (
    <div ref={wrapRef} className="relative">
      <input
        ref={inputRef}
        id={id}
        type="email"
        autoComplete="off"
        className={className ?? "input"}
        placeholder={placeholder}
        value={value}
        required={required}
        onChange={(e) => {
          onChange(e.target.value);
          if (!open && e.target.value.trim()) setOpen(true);
        }}
        onFocus={() => {
          if (suggestions.length > 0) setOpen(true);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => {
          // The mouse-down on a suggestion fires before blur, so the
          // popover-pick still works. Only fire the caller's onBlur
          // once the suggestion list isn't being interacted with.
          setTimeout(() => onBlur?.(), 0);
        }}
      />
      {open && suggestions.length > 0 && (
        <ul
          ref={listRef}
          className="absolute z-50 left-0 right-0 top-full mt-1 max-h-52 overflow-y-auto rounded-sm border border-borderc bg-surface shadow-lg"
        >
          {suggestions.map((s, i) => {
            const atIdx = s.indexOf("@");
            const local = s.slice(0, atIdx);
            const domain = s.slice(atIdx);
            return (
              <li
                key={s}
                data-idx={i}
                onMouseEnter={() => setHighlight(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(s);
                }}
                className={`px-3 py-2 text-sm cursor-pointer ${
                  i === highlight
                    ? "bg-brand-soft text-brand-dark"
                    : "text-textPrimary hover:bg-bg"
                }`}
              >
                <span className="font-medium">{local}</span>
                <span className="text-textSecondary">{domain}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
