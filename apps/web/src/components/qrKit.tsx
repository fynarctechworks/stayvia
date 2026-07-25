// Shared building blocks for the public QR guest pages (/r/:token room,
// /h/:token booking). Booking.com's design SYSTEM — flat dark header, dense
// white cards with hairline borders, small radii, solid action buttons,
// reassurance ticks — but in Stayvia's own palette (emerald brand tokens
// from tailwind.config), so the guest pages match the product's identity.
import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Check, ChevronDown, Phone } from "@/lib/micons";

// Sticky top nav — app-bar style: logo + hotel name left, actions right,
// optional one-line subtitle bar underneath. Stays pinned while the guest
// scrolls so the hotel identity and the call action are always reachable.
export function QrTopNav({
  hotelName,
  subtitle,
  logoUrl,
  phone,
  right,
}: {
  hotelName: string;
  subtitle?: string;
  logoUrl?: string | null;
  phone?: string;
  right?: ReactNode;
}) {
  return (
    <header className="sticky top-0 z-40 bg-brand-dark text-white shadow-md">
      <div className="max-w-md mx-auto h-14 px-3.5 flex items-center gap-2.5">
        {logoUrl && (
          <div className="w-9 h-9 rounded-md overflow-hidden bg-white shrink-0">
            <img src={logoUrl} alt={hotelName} className="w-full h-full object-cover" />
          </div>
        )}
        <h1 className="flex-1 min-w-0 text-[17px] font-bold leading-tight capitalize truncate">
          {hotelName}
        </h1>
        {right}
        {phone && (
          <a
            href={`tel:${phone}`}
            aria-label="Call front desk"
            className="w-9 h-9 rounded-md bg-white/10 hover:bg-white/20 grid place-items-center shrink-0 transition-colors"
          >
            <Phone className="w-4 h-4" />
          </a>
        )}
      </div>
      {subtitle && (
        <div className="bg-black/25">
          <p className="max-w-md mx-auto px-4 py-1.5 text-[11px] text-white/75 leading-snug">
            {subtitle}
          </p>
        </div>
      )}
    </header>
  );
}

export function Card({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`bg-white rounded-lg border border-borderc shadow-sm p-4 ${className}`}>
      {children}
    </div>
  );
}

export function IconBubble({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`w-10 h-10 rounded-lg grid place-items-center shrink-0 ${className}`}>
      {children}
    </div>
  );
}

export function PrimaryButton({
  children,
  className = "",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={`w-full h-11 rounded-md bg-brand text-textPrimary font-semibold flex items-center justify-center gap-2 hover:bg-brand-light active:scale-[0.99] disabled:opacity-50 disabled:active:scale-100 transition ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

export function GhostButton({
  children,
  className = "",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={`w-full h-11 rounded-md border border-brand bg-white font-medium text-sm text-brand-deep flex items-center justify-center gap-2 hover:bg-brand/5 active:scale-[0.99] transition ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

export function QrField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="text-[12px] font-medium text-textPrimary">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}

// Booking-style input: hairline border, small radius, brand focus ring.
export const qrInputClass =
  "w-full h-11 rounded-md border border-borderc bg-white px-3 text-[15px] text-textPrimary outline-none focus:border-brand focus:ring-2 focus:ring-brand/25 transition";

// Custom dropdown — replaces native <select> so the closed control and the
// open list are both styled (native selects render an OS popover that ignores
// CSS and overflows the card). The list is bounded + scrolls internally.
export function QrSelect({
  value,
  onChange,
  options,
  placeholder = "Select…",
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const selected = options.find((o) => o.value === value);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`${qrInputClass} flex items-center justify-between text-left ${
          open ? "border-brand ring-2 ring-brand/25" : ""
        }`}
      >
        <span className={selected ? "text-textPrimary" : "text-textSecondary"}>
          {selected ? selected.label : placeholder}
        </span>
        <ChevronDown
          className={`w-4 h-4 text-textSecondary shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <div className="absolute z-30 left-0 right-0 mt-1 max-h-60 overflow-y-auto rounded-md border border-borderc bg-white shadow-lg py-1 animate-in fade-in slide-in-from-top-1">
          {options.map((o) => {
            const active = o.value === value;
            return (
              <button
                key={o.value}
                type="button"
                onClick={() => {
                  onChange(o.value);
                  setOpen(false);
                }}
                className={`w-full flex items-center justify-between px-3 py-2.5 text-left text-sm transition ${
                  active ? "bg-brand-soft text-brand-deep font-medium" : "hover:bg-bg"
                }`}
              >
                {o.label}
                {active && <Check className="w-4 h-4 shrink-0" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function QrFooterBrand() {
  return (
    <div className="flex flex-col items-center gap-2 pt-3 pb-1">
      <div className="text-[11px] text-textSecondary">Powered by Stayvia</div>
      <div className="flex items-center gap-2 opacity-80">
        <img src="/fyn-arc-logo.png" alt="FYN ARC Techworks" className="h-5 w-auto" />
        <span className="text-[11px] text-textSecondary tracking-wide">FYN ARC Techworks</span>
      </div>
    </div>
  );
}

export function qrFormatDate(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

export function qrFormatTime(hhmm: string): string {
  const [h = "0", m = "00"] = hhmm.split(":");
  const hour = Number(h);
  const period = hour >= 12 ? "PM" : "AM";
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${m.padStart(2, "0")} ${period}`;
}
