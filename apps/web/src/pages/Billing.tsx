import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import {
  AlertCircle,
  CalendarClock,
  CreditCard,
  Info,
  Loader2,
  ShieldCheck,
} from "lucide-react";
import { useState } from "react";
import { useAuth } from "@/auth/AuthContext";
import { useDialog } from "@/components/Dialog";
import { Loader } from "@/components/Loader";
import { useToast } from "@/components/Toast";
import { ApiError, api } from "@/lib/api";
import { cn } from "@/lib/utils";

type BillingStatus = "trialing" | "active" | "past_due" | "cancelled" | "expired";

interface BillingData {
  plan: string;
  status: BillingStatus;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  razorpaySubscriptionId: string | null;
  locked: boolean;
  daysLeft: number;
}

const STATUS_CHIP: Record<BillingStatus, { label: string; cls: string }> = {
  trialing: { label: "Trial", cls: "bg-info/15 text-info" },
  active: { label: "Active", cls: "bg-success/15 text-success" },
  past_due: { label: "Past due", cls: "bg-warning/15 text-warning" },
  cancelled: { label: "Cancelled", cls: "bg-danger/15 text-danger" },
  expired: { label: "Expired", cls: "bg-danger/15 text-danger" },
};

// Minimal typing for the Razorpay Checkout script we inject below.
declare global {
  interface Window {
    Razorpay?: new (options: {
      key: string;
      subscription_id: string;
      name: string;
      handler: () => void;
    }) => { open: () => void };
  }
}

// Inject checkout.js once and cache the promise so repeat clicks (or a
// failed-then-retried subscribe) never add a second script tag.
let razorpayScript: Promise<void> | null = null;
function loadRazorpayCheckout(): Promise<void> {
  if (window.Razorpay) return Promise.resolve();
  if (!razorpayScript) {
    razorpayScript = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://checkout.razorpay.com/v1/checkout.js";
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => {
        // Allow a retry to inject a fresh tag after a network failure.
        razorpayScript = null;
        s.remove();
        reject(new Error("Could not load the payment window. Check your connection and try again."));
      };
      document.head.appendChild(s);
    });
  }
  return razorpayScript;
}

function fmtDate(iso: string | null): string {
  return iso ? format(new Date(iso), "d MMM yyyy") : "—";
}

export default function Billing() {
  const { property } = useAuth();
  const dialog = useDialog();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [notConfigured, setNotConfigured] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ["billing"],
    queryFn: () => api.get<BillingData>("/billing"),
  });

  const subscribe = useMutation({
    mutationFn: async () => {
      const { subscriptionId, keyId } = await api.post<{ subscriptionId: string; keyId: string }>(
        "/billing/subscribe",
      );
      await loadRazorpayCheckout();
      if (!window.Razorpay) throw new Error("Payment window unavailable. Try again.");
      new window.Razorpay({
        key: keyId,
        subscription_id: subscriptionId,
        name: property?.name ?? "Stayvia",
        // Fires after the user completes payment in the checkout modal.
        // Actual activation lands via the server webhook — refetching
        // /billing picks the new status up once it's applied.
        handler: () => {
          void qc.invalidateQueries({ queryKey: ["billing"] });
          toast("Payment received. Your subscription will activate shortly.", "success");
        },
      }).open();
    },
    onError: (e: Error) => {
      if (e instanceof ApiError && e.code === "BILLING_NOT_CONFIGURED") {
        setNotConfigured(true);
        return;
      }
      toast(e.message, "error");
    },
  });

  const cancel = useMutation({
    mutationFn: () => api.post("/billing/cancel"),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["billing"] });
      toast("Subscription cancelled. Access continues until the end of the paid period.", "info");
    },
    onError: (e: Error) => toast(e.message, "error"),
  });

  async function onCancel() {
    const ok = await dialog.confirm({
      title: "Cancel subscription?",
      message:
        "Your hotel keeps full access until the end of the current paid period. After that, staff can't use Stayvia until you subscribe again.",
      okLabel: "Cancel subscription",
      cancelLabel: "Keep subscription",
      tone: "danger",
    });
    if (ok) cancel.mutate();
  }

  if (isLoading) return <Loader label="Loading billing…" size="lg" />;

  if (error || !data) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold text-navy">Billing</h1>
        <div className="card flex items-start gap-2 text-danger">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <span className="text-sm">
            {error instanceof Error ? error.message : "Could not load billing details."}
          </span>
        </div>
      </div>
    );
  }

  const chip = STATUS_CHIP[data.status];
  const showSubscribe = data.status !== "active";

  return (
    <div className="space-y-4 max-w-2xl">
      <h1 className="text-2xl font-bold text-navy">Billing</h1>

      {notConfigured && (
        <div
          role="status"
          className="flex items-start gap-2 rounded-sm border border-info/30 bg-info/5 px-3 py-2 text-info text-sm"
        >
          <Info className="w-4 h-4 mt-0.5 shrink-0" />
          <span>
            Online billing is not configured yet. Contact Stayvia support to activate your
            subscription.
          </span>
        </div>
      )}

      {/* Plan summary */}
      <div className="card space-y-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="font-semibold text-brand-dark text-lg">Standard plan</h2>
              <span
                className={cn(
                  "inline-flex items-center px-2 py-0.5 text-xs font-medium uppercase tracking-wide rounded-sm",
                  chip.cls,
                )}
              >
                {chip.label}
              </span>
            </div>
            <p className="text-xs text-textSecondary mt-1">
              Everything in Stayvia — reservations, housekeeping, invoices, reports and staff
              accounts.
            </p>
          </div>
          <CreditCard className="w-5 h-5 text-textSecondary shrink-0" />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
          {data.status === "trialing" && (
            <div className="flex items-center gap-2">
              <CalendarClock className="w-4 h-4 text-textSecondary shrink-0" />
              <span>
                <span className="font-semibold text-brand-dark">{data.daysLeft}</span>{" "}
                {data.daysLeft === 1 ? "day" : "days"} left in trial
                <span className="text-textSecondary"> (ends {fmtDate(data.trialEndsAt)})</span>
              </span>
            </div>
          )}
          {data.status === "active" && (
            <div className="flex items-center gap-2">
              <CalendarClock className="w-4 h-4 text-textSecondary shrink-0" />
              <span>
                Current period ends{" "}
                <span className="font-semibold text-brand-dark">{fmtDate(data.currentPeriodEnd)}</span>
                <span className="text-textSecondary">
                  {" "}
                  ({data.daysLeft} {data.daysLeft === 1 ? "day" : "days"} left)
                </span>
              </span>
            </div>
          )}
          {data.status === "cancelled" && data.currentPeriodEnd && (
            <div className="flex items-center gap-2">
              <CalendarClock className="w-4 h-4 text-textSecondary shrink-0" />
              <span>
                Access until{" "}
                <span className="font-semibold text-brand-dark">{fmtDate(data.currentPeriodEnd)}</span>
              </span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {showSubscribe && (
            <button
              onClick={() => subscribe.mutate()}
              disabled={subscribe.isPending}
              className="btn-primary inline-flex items-center gap-2"
            >
              {subscribe.isPending ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <CreditCard className="w-4 h-4" />
              )}
              {data.status === "trialing" ? "Subscribe now" : "Renew subscription"}
            </button>
          )}
          {data.status === "active" && data.razorpaySubscriptionId && (
            <button
              onClick={onCancel}
              disabled={cancel.isPending}
              className="btn-secondary inline-flex items-center gap-2"
            >
              {cancel.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
              Cancel subscription
            </button>
          )}
        </div>
      </div>

      {/* State explanation */}
      {data.locked ? (
        <div className="card border-danger/30 space-y-2">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-danger shrink-0" />
            <h3 className="font-semibold text-brand-dark">Your workspace is locked</h3>
          </div>
          <p className="text-sm text-textSecondary">
            {data.status === "trialing" || data.status === "expired"
              ? "Your free trial has ended."
              : "Your subscription has lapsed."}{" "}
            Staff can sign in, but reservations, invoices and other day-to-day features stay
            read-blocked until the subscription is active. Subscribe above to unlock everything
            instantly — your data is safe and nothing has been deleted.
          </p>
        </div>
      ) : data.status === "trialing" ? (
        <div className="card space-y-2">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-success shrink-0" />
            <h3 className="font-semibold text-brand-dark">You're on the free trial</h3>
          </div>
          <p className="text-sm text-textSecondary">
            Full access until {fmtDate(data.trialEndsAt)}. Subscribe any time before then and
            billing simply starts when you pay — no interruption for your front desk.
          </p>
        </div>
      ) : null}
    </div>
  );
}
