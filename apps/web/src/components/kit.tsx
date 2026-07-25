// Shared dashboard-density UI kit (ui-ux-pro-max "Data-Dense Dashboard"
// guidance in the Stayvia emerald system). Every staff page composes these
// so headers, KPI tiles, sections, empty states and loading shimmer look and
// behave identically: 44px touch targets, visible focus, 150-300ms hovers,
// tabular numbers for money.
import type { ReactNode } from "react";
import { Link } from "react-router-dom";

// Page title row — title left, actions right, always the same rhythm.
export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-bold text-navy leading-tight">{title}</h1>
        {subtitle && <div className="text-sm text-textSecondary mt-0.5">{subtitle}</div>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

// KPI tile — reference anatomy: icon chip + label on one row, big tabular
// number, context line under it. `featured` tints the whole tile with the
// brand soft wash (the reference highlights its first tile this way).
// Optionally links somewhere (whole tile is the target, 44px+).
export function KpiCard({
  icon,
  label,
  value,
  sub,
  to,
  tone = "brand",
  featured = false,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  sub?: ReactNode;
  to?: string;
  tone?: "brand" | "info" | "warning" | "danger" | "neutral";
  featured?: boolean;
}) {
  const tones: Record<string, string> = {
    brand: "bg-brand-soft text-brand-deep",
    info: "bg-info/10 text-info",
    warning: "bg-warning/10 text-warning",
    danger: "bg-danger/10 text-danger",
    neutral: "bg-bg text-textSecondary",
  };
  const body = (
    <>
      <div className="flex items-center gap-2">
        <div
          className={`w-8 h-8 rounded-md grid place-items-center shrink-0 ${
            featured ? "bg-white text-brand-deep" : tones[tone]
          }`}
        >
          {icon}
        </div>
        <div className="text-textSecondary text-[11px] font-semibold uppercase tracking-wider truncate">
          {label}
        </div>
      </div>
      <div className="text-2xl font-bold text-navy mt-2.5 tabular-nums leading-tight truncate">
        {value}
      </div>
      {sub && <div className="text-xs text-textSecondary mt-2 truncate">{sub}</div>}
    </>
  );
  const surface = featured ? "card !bg-brand-soft !border-brand/25" : "card";
  if (to) {
    return (
      <Link
        to={to}
        className={`${surface} block hover:shadow-md hover:-translate-y-0.5 hover:border-brand/40 transition cursor-pointer focus-visible:ring-2 focus-visible:ring-brand outline-none`}
      >
        {body}
      </Link>
    );
  }
  return <div className={surface}>{body}</div>;
}

// Reference-style "Room Availability" block: one stacked proportion bar +
// a stat per segment. Pass segments in display order; zero-count segments
// keep their stat (shows 0) but drop out of the bar.
export function StackedAvailability({
  segments,
}: {
  segments: { label: string; count: number; barClass: string }[];
}) {
  const total = segments.reduce((a, s) => a + s.count, 0);
  return (
    <div className="flex items-center gap-4 flex-wrap">
      <div className="flex h-2.5 rounded-full overflow-hidden bg-bg flex-1 min-w-[160px]">
        {total > 0 &&
          segments
            .filter((s) => s.count > 0)
            .map((s) => (
              <div
                key={s.label}
                className={`${s.barClass} transition-all`}
                style={{ width: `${(s.count / total) * 100}%` }}
                title={`${s.label}: ${s.count}`}
              />
            ))}
      </div>
      <div className="flex items-center gap-x-4 gap-y-1 flex-wrap text-xs">
        {segments.map((s) => (
          <span key={s.label} className="inline-flex items-center gap-1.5 text-textSecondary">
            <span className={`w-2 h-2 rounded-full ${s.barClass}`} />
            {s.label}
            <span className="font-bold text-navy tabular-nums">{s.count}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

// Titled section container — one heading style everywhere, optional action
// slot on the right (e.g. "View all").
export function SectionCard({
  title,
  action,
  children,
  className = "",
}: {
  title: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`card ${className}`}>
      <div className="flex items-center justify-between gap-2 mb-3">
        <h2 className="font-semibold text-brand-dark">{title}</h2>
        {action}
      </div>
      {children}
    </div>
  );
}

// Designed nothing-here state. Reserves vertical space so lists don't
// collapse/jump while loading -> empty transitions happen.
export function EmptyState({
  icon,
  title,
  hint,
  action,
}: {
  icon?: ReactNode;
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="py-10 px-4 text-center">
      {icon && (
        <div className="w-11 h-11 rounded-md bg-bg text-textSecondary/70 grid place-items-center mx-auto mb-3">
          {icon}
        </div>
      )}
      <div className="font-medium text-navy text-sm">{title}</div>
      {hint && <div className="text-xs text-textSecondary mt-1 max-w-sm mx-auto">{hint}</div>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

// Loading shimmer. Reserve the same height as the loaded content wherever
// possible (CLS rule) — pass rows/height accordingly.
export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-md bg-borderc/50 ${className}`} />;
}

export function KpiSkeletonRow({ tiles = 4 }: { tiles?: number }) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
      {Array.from({ length: tiles }).map((_, i) => (
        <div key={i} className="card">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-7 w-24 mt-3" />
          <Skeleton className="h-3 w-20 mt-2" />
        </div>
      ))}
    </div>
  );
}

export function ListSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="card flex items-center gap-3">
          <Skeleton className="w-9 h-9 rounded-full shrink-0" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3.5 w-1/3" />
            <Skeleton className="h-3 w-1/2" />
          </div>
          <Skeleton className="h-5 w-16" />
        </div>
      ))}
    </div>
  );
}

// Count-carrying filter chip: "Checked in (4)". Selected fills brand.
export function FilterChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count?: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 h-9 px-3 rounded-full border text-xs font-medium transition-colors cursor-pointer focus-visible:ring-2 focus-visible:ring-brand outline-none ${
        active
          ? "bg-brand-dark text-white border-brand-dark"
          : "bg-surface text-textPrimary border-borderc hover:border-brand"
      }`}
    >
      {label}
      {count !== undefined && (
        <span
          className={`min-w-5 h-5 px-1 grid place-items-center rounded-full text-[10px] font-bold ${
            active ? "bg-white/20" : "bg-bg text-textSecondary"
          }`}
        >
          {count}
        </span>
      )}
    </button>
  );
}
