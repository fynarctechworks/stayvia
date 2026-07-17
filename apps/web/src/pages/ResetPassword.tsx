// Password-reset confirmation page.
//
// The user arrives here from the recovery link in the email Supabase
// sends (see Login.tsx onForgotPassword). Supabase appends a recovery
// token to the URL — the supabase-js client auto-detects it and
// establishes a short-lived recovery session, firing a
// PASSWORD_RECOVERY auth event. Once that session exists, calling
// supabase.auth.updateUser({ password }) sets the new password.
//
// States:
//   verifying — checking the URL/session for a valid recovery token
//   ready     — recovery session established; show the new-password form
//   invalid   — no/expired token; tell the user to request a fresh link
//   done      — password updated; offer to sign in

import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { CheckCircle2, Eye, EyeOff, Loader2, Lock, ShieldAlert } from "lucide-react";
import { isOfflineMode } from "@/lib/offlineMode";
import { supabase } from "@/lib/supabase";

type Phase = "verifying" | "ready" | "invalid" | "done";

export default function ResetPassword() {
  const navigate = useNavigate();
  const [phase, setPhase] = useState<Phase>(
    // Desktop app: this page is Supabase-recovery-driven and only reachable
    // via a cloud email link — there's no recovery session to wait for, so
    // skip straight to the guidance state instead of a 4s fake "verifying".
    isOfflineMode() ? "invalid" : "verifying",
  );
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Detect the recovery session. supabase-js parses the URL hash on
  // load (detectSessionInUrl defaults true) and fires onAuthStateChange
  // with "PASSWORD_RECOVERY". We also check getSession() directly in
  // case the event already fired before this component mounted.
  useEffect(() => {
    let resolved = false;

    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY" || (session && event === "SIGNED_IN")) {
        resolved = true;
        setPhase("ready");
      }
    });

    // Fallback: if a session is already present (recovery token already
    // consumed into a session by the time we mount), allow the reset.
    supabase.auth.getSession().then(({ data }) => {
      if (resolved) return;
      // The recovery link puts the token in the hash; if Supabase has a
      // session OR the URL still carries a recovery hash, we're good.
      const hash = window.location.hash;
      const hasRecoveryHash = hash.includes("type=recovery") || hash.includes("access_token");
      if (data.session || hasRecoveryHash) {
        setPhase("ready");
      } else {
        setPhase("invalid");
      }
    });

    // Safety timeout: if nothing resolves in 4s, treat as invalid so the
    // user isn't stuck on a spinner.
    const t = setTimeout(() => {
      if (!resolved) {
        setPhase((p) => (p === "verifying" ? "invalid" : p));
      }
    }, 4000);

    return () => {
      sub.subscription.unsubscribe();
      clearTimeout(t);
    };
  }, []);

  const pwValid = password.length >= 6;
  const match = password === confirm;
  const canSubmit = pwValid && match && !busy;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setError(null);
    setBusy(true);
    try {
      const { error: updErr } = await supabase.auth.updateUser({ password });
      if (updErr) throw updErr;
      // Sign out the recovery session so the user logs in fresh with the
      // new password (cleaner than auto-entering the app on a recovery
      // session).
      await supabase.auth.signOut();
      setPhase("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't update the password");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen grid place-items-center bg-ivory p-4">
      <div className="w-full max-w-md bg-surface border border-borderc rounded-md shadow-sm p-6 sm:p-8">
        <div className="flex items-center gap-3 mb-6">
          <img
            src="/logo.jpg"
            alt="SLDT Stay Inn"
            className="w-12 h-12 rounded-lg object-contain bg-cream ring-1 ring-brass/30"
          />
          <div className="leading-tight">
            <div className="font-semibold text-brand-dark">SLDT Stay Inn</div>
            <div className="text-[11px] text-[#157f5f] tracking-wide">SABBAVARAM</div>
          </div>
        </div>

        {phase === "verifying" && (
          <div className="text-center py-8">
            <Loader2 className="w-8 h-8 mx-auto animate-spin text-brand" />
            <p className="text-sm text-textSecondary mt-3">Verifying your reset link…</p>
          </div>
        )}

        {phase === "invalid" && (
          <div className="text-center py-6">
            <div className="mx-auto w-14 h-14 rounded-full bg-danger/10 grid place-items-center mb-3">
              <ShieldAlert className="w-7 h-7 text-danger" />
            </div>
            <h1 className="text-lg font-bold text-brand-dark">
              {isOfflineMode() ? "Not available on the desk app" : "Link expired or invalid"}
            </h1>
            <p className="text-sm text-textSecondary mt-2">
              {isOfflineMode()
                ? "Email password-reset links apply to the online version. On this desk, any administrator can set a new PIN or password for you from Settings → Staff."
                : "This password-reset link is no longer valid. Reset links expire after 1 hour and can only be used once. Please request a new one from the login page."}
            </p>
            <Link to="/login" className="btn-primary inline-flex mt-5">
              Back to login
            </Link>
          </div>
        )}

        {phase === "done" && (
          <div className="text-center py-6">
            <div className="mx-auto w-14 h-14 rounded-full bg-success/10 grid place-items-center mb-3">
              <CheckCircle2 className="w-7 h-7 text-success" />
            </div>
            <h1 className="text-lg font-bold text-brand-dark">Password updated</h1>
            <p className="text-sm text-textSecondary mt-2">
              Your password has been changed. Sign in with your new password to continue.
            </p>
            <button onClick={() => navigate("/login")} className="btn-primary mt-5">
              Go to login
            </button>
          </div>
        )}

        {phase === "ready" && (
          <form onSubmit={onSubmit} className="space-y-4">
            <div>
              <h1 className="text-xl font-bold text-brand-dark">Set a new password</h1>
              <p className="text-sm text-textSecondary mt-1">
                Choose a new password for your account. Minimum 6 characters.
              </p>
            </div>

            <div>
              <label className="label block mb-1">New password</label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-textSecondary pointer-events-none" />
                <input
                  className="input pl-9 pr-10"
                  type={showPw ? "text" : "password"}
                  placeholder="Enter a new password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="new-password"
                  minLength={6}
                  autoFocus
                />
                <button
                  type="button"
                  onClick={() => setShowPw((s) => !s)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-textSecondary hover:text-brand-dark"
                  aria-label={showPw ? "Hide password" : "Show password"}
                >
                  {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <div>
              <label className="label block mb-1">Confirm password</label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-textSecondary pointer-events-none" />
                <input
                  className={`input pl-9 ${confirm && !match ? "border-danger focus:border-danger focus:ring-danger/30" : ""}`}
                  type={showPw ? "text" : "password"}
                  placeholder="Re-enter the password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  autoComplete="new-password"
                  minLength={6}
                />
              </div>
              {confirm && !match && (
                <p className="text-xs text-danger mt-1">Passwords don't match.</p>
              )}
            </div>

            {error && <div className="text-sm text-danger">{error}</div>}

            <button type="submit" disabled={!canSubmit} className="btn-primary w-full">
              {busy ? "Updating…" : "Update password"}
            </button>
            <div className="text-center">
              <Link to="/login" className="text-xs text-accentBlue hover:underline">
                Back to login
              </Link>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
