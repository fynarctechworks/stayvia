// Shared dashboard-density UI kit (Warm Concierge system — see
// design_handoff_stayvia_redesign/README.md). Every staff page composes these
// so headers, KPI tiles, sections, empty states and loading shimmer look and
// behave identically: 44px touch targets, visible focus, 150-300ms hovers,
// tabular numbers for money.
import type { ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { AlertTriangle, ArrowLeft, Lock, RefreshCw } from "@/lib/micons";
import { ApiError } from "@/lib/api";

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
        <h1 className="text-[clamp(22px,3vw,28px)] font-semibold tracking-[-0.5px] text-ink leading-tight">{title}</h1>
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
    info: "bg-infoBg text-info",
    warning: "bg-warnBg text-warnFg",
    danger: "bg-dangerBg text-dangerFg",
    neutral: "bg-neutralBg text-inkMuted",
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
      <div className="text-2xl font-mono font-bold text-ink mt-2.5 tabular-nums leading-tight truncate">
        {value}
      </div>
      {sub && <div className="text-xs text-textSecondary mt-2 truncate">{sub}</div>}
    </>
  );
  const surface = featured
    ? "card !rounded-[14px] !bg-brand-soft !border-brand/25"
    : "card !rounded-[14px]";
  if (to) {
    return (
      <Link
        to={to}
        className={`${surface} block hover:shadow-lift hover:-translate-y-0.5 hover:border-inkFaint/60 transition cursor-pointer focus-visible:ring-2 focus-visible:ring-brand outline-none`}
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
      <div className="flex h-2.5 rounded-full overflow-hidden bg-surfaceSubtle flex-1 min-w-[160px]">
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
            <span className="font-bold text-ink tabular-nums font-mono">{s.count}</span>
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
        <h2 className="text-[16px] font-semibold text-ink">{title}</h2>
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
        <div className="w-11 h-11 rounded-md bg-surfaceSubtle text-inkMuted grid place-items-center mx-auto mb-3">
          {icon}
        </div>
      )}
      <div className="font-medium text-ink text-sm">{title}</div>
      {hint && <div className="text-xs text-textSecondary mt-1 max-w-sm mx-auto">{hint}</div>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

// ── Query failure surfaces ────────────────────────────────────────────────
// A failed request must never be dressed up as "nothing here". EmptyState is
// only for a query that SUCCEEDED and returned nothing; anything that threw
// gets QueryError (inline, inside a page/card body) or PageError (full page,
// for routes that early-return before their own header/back button renders).

type ErrorTone = "danger" | "warning";
interface ErrorCopy {
  title: string;
  message: string;
  tone: ErrorTone;
}

function statusOf(error: unknown): number | undefined {
  return error instanceof ApiError ? error.status : undefined;
}

// Maps a thrown value to staff-readable copy. A 403 is deliberately worded as
// an access change, not a system failure — the request worked, the answer was
// "not for you", and the fix is an administrator, not a retry.
function describeError(error: unknown): ErrorCopy {
  const status = statusOf(error);
  if (status === 403) {
    return {
      title: "You don't have access to this",
      message:
        "Your permissions may have changed. Ask an administrator to check your role, then try again.",
      tone: "warning",
    };
  }
  if (status === 404) {
    return {
      title: "Not found",
      message: "This record no longer exists, or it belongs to a different hotel.",
      tone: "warning",
    };
  }
  if (status === undefined) {
    return {
      title: "Can't reach Stayvia",
      message: "The request didn't get through. Check your connection and try again.",
      tone: "danger",
    };
  }
  return {
    title: "Couldn't load this",
    message:
      "The request failed, so this data is missing — not empty. Try again, and check with an administrator if it keeps failing.",
    tone: "danger",
  };
}

function detailOf(error: unknown, copy: ErrorCopy): string | undefined {
  const raw =
    error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const trimmed = raw.trim();
  if (!trimmed || trimmed === copy.message) return undefined;
  return trimmed;
}

// One-line message for toasts on failed MUTATIONS: `toast(queryErrorMessage(e), "error")`.
// Prefers the server's own message (it's the specific one — "Room is occupied",
// "Invoice already settled") except on 403, where the permission copy is clearer
// than the raw "Forbidden".
export function queryErrorMessage(
  error: unknown,
  fallback = "Something went wrong. Please try again.",
): string {
  const copy = describeError(error);
  if (statusOf(error) === 403) return copy.message;
  const detail = detailOf(error, copy);
  if (detail) return detail;
  return copy.message || fallback;
}

function RetryButton({
  onRetry,
  isRetrying,
  label,
  variant,
}: {
  onRetry: () => void;
  isRetrying: boolean;
  label: string;
  variant: "primary" | "secondary";
}) {
  return (
    <button
      type="button"
      onClick={onRetry}
      disabled={isRetrying}
      aria-busy={isRetrying || undefined}
      className={`${
        variant === "primary" ? "btn-primary" : "btn-secondary"
      } !h-11 min-w-[44px] inline-flex items-center justify-center gap-1.5 disabled:opacity-60 cursor-pointer focus-visible:ring-2 focus-visible:ring-brand outline-none`}
    >
      <RefreshCw className={`w-4 h-4 shrink-0 ${isRetrying ? "animate-spin" : ""}`} />
      {isRetrying ? "Retrying…" : label}
    </button>
  );
}

// Inline failure block. Drops into a page body, a `card`, or a SectionCard in
// place of the list/table that failed. Most call sites pass only { error, onRetry }.
export function QueryError({
  error,
  onRetry,
  isRetrying = false,
  title,
  message,
  detail,
  retryLabel = "Try again",
  action,
  className = "",
}: {
  error?: unknown;
  onRetry?: () => void;
  isRetrying?: boolean;
  title?: string;
  message?: ReactNode;
  detail?: ReactNode;
  retryLabel?: string;
  action?: ReactNode;
  className?: string;
}) {
  const copy = describeError(error);
  const warning = copy.tone === "warning";
  const Icon = warning ? Lock : AlertTriangle;
  const derivedDetail = detailOf(error, copy);
  const shownDetail = detail !== undefined ? detail : derivedDetail;
  return (
    <div
      role="alert"
      className={`rounded-md border p-4 ${
        warning ? "border-warnBorder bg-warnBg" : "border-dangerBorder bg-dangerBg"
      } ${className}`}
    >
      <div className="flex items-start gap-3">
        <div
          className={`w-8 h-8 rounded-md grid place-items-center shrink-0 ${
            warning ? "bg-surface text-warnFg" : "bg-surface text-dangerFg"
          }`}
        >
          <Icon className="w-4 h-4" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-ink text-sm">{title ?? copy.title}</div>
          <div className="text-xs text-inkBody mt-1 leading-relaxed">
            {message ?? copy.message}
          </div>
          {shownDetail && (
            <div className="text-[11px] text-textSecondary mt-1.5 break-words">
              {shownDetail}
            </div>
          )}
          {(onRetry || action) && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {onRetry && (
                <RetryButton
                  onRetry={onRetry}
                  isRetrying={isRetrying}
                  label={retryLabel}
                  variant="secondary"
                />
              )}
              {action}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Full-page failure, for routes that early-return before rendering their own
// header (RoomDetail, MaintenanceDetail, …). Always carries a way out: those
// pages' own back button hasn't rendered yet, so without one the user is stuck.
export function PageError({
  error,
  onRetry,
  isRetrying = false,
  title,
  message,
  detail,
  retryLabel = "Try again",
  backTo,
  backLabel = "Go back",
  action,
}: {
  error?: unknown;
  onRetry?: () => void;
  isRetrying?: boolean;
  title?: string;
  message?: ReactNode;
  detail?: ReactNode;
  retryLabel?: string;
  backTo?: string;
  backLabel?: string;
  action?: ReactNode;
}) {
  const navigate = useNavigate();
  const copy = describeError(error);
  const warning = copy.tone === "warning";
  const Icon = warning ? Lock : AlertTriangle;
  const derivedDetail = detailOf(error, copy);
  const shownDetail = detail !== undefined ? detail : derivedDetail;
  const goBack = () => {
    if (backTo) {
      navigate(backTo);
      return;
    }
    // A directly-opened URL (fresh tab, pasted link, QR scan) has no in-app
    // history to pop — navigate(-1) would be a no-op and strand the user on
    // this error — so fall back to the dashboard.
    if (typeof window !== "undefined" && window.history.length > 1) navigate(-1);
    else navigate("/");
  };
  return (
    <div role="alert" className="flex items-center justify-center min-h-[50vh] py-12 px-4">
      <div className="card max-w-md w-full text-center !p-8">
        <div
          className={`w-14 h-14 rounded-full grid place-items-center mx-auto ${
            warning ? "bg-warnBg text-warnFg" : "bg-dangerBg text-dangerFg"
          }`}
        >
          <Icon className="w-7 h-7" />
        </div>
        <h1 className="text-xl font-bold text-ink mt-4">{title ?? copy.title}</h1>
        <p className="text-sm text-textSecondary mt-2 leading-relaxed">
          {message ?? copy.message}
        </p>
        {shownDetail && (
          <p className="text-xs text-inkMuted mt-1.5 break-words">{shownDetail}</p>
        )}
        <div className="flex flex-wrap justify-center gap-2 mt-5">
          <button
            type="button"
            onClick={goBack}
            className="btn-secondary !h-11 min-w-[44px] inline-flex items-center justify-center gap-1.5 cursor-pointer focus-visible:ring-2 focus-visible:ring-brand outline-none"
          >
            <ArrowLeft className="w-4 h-4 shrink-0" />
            {backLabel}
          </button>
          {onRetry && (
            <RetryButton
              onRetry={onRetry}
              isRetrying={isRetrying}
              label={retryLabel}
              variant="primary"
            />
          )}
          {action}
        </div>
      </div>
    </div>
  );
}

// Loading shimmer. Reserve the same height as the loaded content wherever
// possible (CLS rule) — pass rows/height accordingly.
export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-md bg-divider ${className}`} />;
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
          ? "bg-brand text-white border-brand shadow-primary"
          : "bg-surface text-ink border-borderControl hover:bg-surfaceAlt"
      }`}
    >
      {label}
      {count !== undefined && (
        <span
          className={`min-w-[18px] h-[18px] px-1 grid place-items-center rounded-full text-[10px] font-bold tabular-nums leading-none ${
            active ? "bg-white/20 text-white" : "bg-surfaceSubtle text-textSecondary"
          }`}
        >
          {count}
        </span>
      )}
    </button>
  );
}
