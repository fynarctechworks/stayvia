import { useEffect, useId, useMemo, useState } from "react";
import { Link, Navigate, useLocation } from "react-router-dom";
import {
  AlertCircle,
  Eye,
  EyeOff,
  Loader2,
  Lock,
  Mail,
  ShieldCheck,
} from "@/lib/micons";
import { AuthLiquidBackdrop } from "@/components/AuthLiquidBackdrop";
import { useAuth } from "@/auth/AuthContext";
import { useDialog } from "@/components/Dialog";
import { api } from "@/lib/api";
import { supabase } from "@/lib/supabase";

// Warm Concierge auth brand pane: forest base + radial glow + faint
// diagonal stripes. Inline styles are the sanctioned exception for this
// pane only (see design handoff — special surfaces).
const forestBase = { background: "#10352A" };
const forestGlow = {
  background:
    "radial-gradient(120% 90% at 15% 10%, #1A4A3A 0%, #10352A 55%, #0B281F 100%)",
};
const forestStripes = {
  background:
    "repeating-linear-gradient(115deg, rgba(255,255,255,.03) 0 2px, transparent 2px 26px)",
};
const brassHairline = { background: "rgba(180,136,74,.24)" };

export default function Login() {
  const { signIn, verifyMfa, session, mfaPending } = useAuth();
  const dialog = useDialog();
  const location = useLocation();
  const emailId = useId();
  const pwId = useId();
  const errId = useId();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState<{ email?: boolean; pw?: boolean }>({});
  const [capsOn, setCapsOn] = useState(false);
  // Second-factor step. Shown after a correct password when the account
  // has a verified authenticator. mfaCode holds the 6-digit TOTP entry.
  const [mfaStep, setMfaStep] = useState(false);
  const [mfaCode, setMfaCode] = useState("");

  useEffect(() => {
    const saved = localStorage.getItem("hd:lastEmail");
    if (saved) setEmail(saved);
  }, []);

  // If the auth context says a challenge is owed (e.g. a restored AAL1
  // session on page load), surface the MFA step even without going
  // through the password form again.
  useEffect(() => {
    if (mfaPending) setMfaStep(true);
  }, [mfaPending]);

  // Shown when api.ts redirects here after a 401. Avoids confusing the user
  // ("why am I back at login?") and tells them what happened.
  const expired = useMemo(
    () => new URLSearchParams(location.search).get("expired") === "1",
    [location.search],
  );

  // Only redirect into the app when fully authenticated — a session that
  // still owes a second factor (mfaPending) must stay here for the
  // challenge step.
  if (session && !mfaPending) {
    // After a successful login, land on /dashboard by default. If the
    // user was bounced to /login from a protected route (e.g. their
    // session expired mid-navigation), send them back to that route.
    const from =
      (location.state as { from?: { pathname: string } } | null)?.from?.pathname ?? "/dashboard";
    return <Navigate to={from} replace />;
  }

  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  const pwValid = password.length >= 6;
  const formValid = emailValid && pwValid;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setTouched({ email: true, pw: true });
    if (!formValid || busy) return;
    setError(null);
    setBusy(true);
    try {
      if (remember) localStorage.setItem("hd:lastEmail", email);
      else localStorage.removeItem("hd:lastEmail");
      const { mfaRequired } = await signIn(email, password);
      // If a second factor is owed, show the code step. Otherwise the
      // `session && !mfaPending` redirect above takes over on re-render.
      if (mfaRequired) {
        setMfaStep(true);
        setMfaCode("");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setBusy(false);
    }
  }

  // Second-factor verification. Sends the 6-digit TOTP code to Supabase;
  // on success the session upgrades to AAL2 and the redirect above fires.
  async function onVerifyMfa(e: React.FormEvent) {
    e.preventDefault();
    const code = mfaCode.replace(/\s/g, "");
    if (code.length < 6 || busy) return;
    setError(null);
    setBusy(true);
    try {
      await verifyMfa(code);
      // verifyMfa clears mfaPending; the `session && !mfaPending` guard
      // re-renders and navigates into the app.
    } catch (err) {
      setError(
        err instanceof Error && err.message
          ? err.message
          : "That code didn't work. Check your authenticator and try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  // Forgot-password: prompt for the email, then ask Supabase Auth to send
  // a recovery email. The link in that email lands the user on
  // /reset-password (see redirectTo) where they set a new password.
  //
  // We ALWAYS show the same "if an account exists, you'll get an email"
  // confirmation regardless of whether the email is registered — this is
  // standard practice so the reset form can't be used to enumerate which
  // emails have accounts.
  async function onForgotPassword() {
    const entered = await dialog.prompt({
      title: "Reset your password",
      message:
        "Enter the email for your account. We'll send a link to set a new password.",
      placeholder: "you@yourhotel.com",
      defaultValue: emailValid ? email : "",
      okLabel: "Send reset link",
      cancelLabel: "Cancel",
      required: true,
    });
    if (!entered) return;
    const target = entered.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(target)) {
      await dialog.alert({
        title: "Invalid email",
        message: "That doesn't look like a valid email address. Please try again.",
        okLabel: "OK",
      });
      return;
    }

    // Pre-flight against the API — a rate-limit gate and reachability
    // check only. The server intentionally never reveals whether the
    // email is registered (enumeration protection on a multi-tenant
    // SaaS), so any 2xx just means "proceed".
    try {
      await api.post<{ ok: boolean }>("/auth/forgot-password/check", {
        email: target,
      });
    } catch (err) {
      // If the check itself fails (rate-limited or server down), surface
      // a soft error rather than pretending it worked.
      await dialog.alert({
        title: "Couldn't send reset link",
        message:
          err instanceof Error && err.message
            ? err.message
            : "Something went wrong. Please try again in a moment.",
        okLabel: "OK",
      });
      return;
    }

    // Ask Supabase to send the recovery email. Supabase is silent for
    // unknown addresses, so the confirmation below is deliberately
    // "if registered" — we never confirm whether the account exists.
    try {
      await supabase.auth.resetPasswordForEmail(target, {
        // The recovery link redirects here; the reset page reads the
        // recovery token from the URL hash that Supabase appends.
        redirectTo: `${window.location.origin}/reset-password`,
      });
    } catch {
      // Swallow the underlying send error — the generic "if registered"
      // message below stays correct either way.
    }
    await dialog.alert({
      title: "Check your email",
      message: `If ${target} is registered as a staff account, a password-reset link has been sent. The link expires in 1 hour. Didn't get it? Check the spelling or contact your hotel administrator.`,
      okLabel: "Got it",
    });
  }

  return (
    <div className="min-h-screen grid lg:grid-cols-2 bg-bg">
      <aside
        className="hidden lg:block relative overflow-hidden text-cream min-h-screen"
        style={forestBase}
      >
        {/* Forest radial glow + faint diagonal stripes (spec: special surfaces). */}
        <div aria-hidden className="absolute inset-0" style={forestGlow} />
        <div aria-hidden className="absolute inset-0 opacity-50" style={forestStripes} />
        {/* GPU fluid sim, layered over the static gradient. Lazy-loaded and
            skipped entirely for reduced-motion / narrow viewports. */}
        <AuthLiquidBackdrop />
        <div aria-hidden className="absolute inset-y-0 right-0 w-px" style={brassHairline} />

        {/* Logo + name, top-left. */}
        <div className="absolute top-10 left-10 xl:left-14 flex items-center gap-3 pointer-events-none">
          <img src="/logo.png" alt="Stayvia" className="w-14 h-14 object-contain" />
          <div className="leading-tight">
            <div className="text-cream font-semibold text-lg">Stayvia</div>
            <div className="text-[11px] font-normal text-brass tracking-[0.18em] uppercase">Hotel OS</div>
          </div>
        </div>

        {/* Overlay content — vertically centered, left-aligned. */}
        <div className="absolute inset-0 flex flex-col items-start justify-center text-left p-10 xl:p-14 pointer-events-none">
          <span className="inline-flex items-center rounded-full border border-brass/40 bg-brass/10 backdrop-blur px-4 py-1.5 text-xs font-semibold tracking-[0.18em] uppercase text-brass mb-6">
            Front Office Suite
          </span>

          <h2 className="text-cream text-4xl xl:text-5xl font-bold leading-tight drop-shadow-sm max-w-md tracking-[-0.5px]">
            Welcome to your{" "}
            <span className="font-[Georgia] italic font-semibold text-brass">front desk.</span>
          </h2>

          <p className="text-cream/85 text-base leading-relaxed mt-5 max-w-md">
            Reservations, housekeeping, guest profiles and reports, all in one
            calm workspace, made for modern hotels.
          </p>

          <ul className="mt-8 space-y-4">
            {[
              "Role-based staff access",
              "Encrypted guest data & KYC",
              "Real-time housekeeping sync",
            ].map((label) => (
              <li key={label} className="flex items-center gap-3">
                <span className="flex items-center justify-center w-9 h-9 rounded-full border border-brass/30 bg-brass/10 backdrop-blur text-brass">
                  <ShieldCheck className="w-4 h-4" />
                </span>
                <span className="text-cream/90 text-[15px] font-medium">{label}</span>
              </li>
            ))}
          </ul>
        </div>

        {/* FYN ARC footer, bottom-left. */}
        <div className="absolute bottom-8 left-10 xl:left-14 flex items-center gap-2.5 pointer-events-none">
          <img
            src="/fyn-arc-logo.png"
            alt="FYN ARC Techworks"
            className="h-6 w-auto opacity-80"
          />
          <span className="text-xs text-cream/60 tracking-wide leading-tight">
            <span className="block">© {new Date().getFullYear()} Stayvia</span>
            <span className="block">Powered by FYN ARC Techworks</span>
          </span>
        </div>
      </aside>

      {/* On phone/tablet (no brand aside) the form pane gets the forest
          backdrop itself — same gradient + stripes — so the card floats on
          something rich instead of empty paper. On lg+ it reverts to the
          warm-paper canvas next to the brand aside. */}
      <main className="relative flex items-center justify-center p-6 sm:p-10 lg:bg-bg overflow-hidden">
        <div aria-hidden className="lg:hidden absolute inset-0" style={forestGlow} />
        <div aria-hidden className="lg:hidden absolute inset-0 opacity-50" style={forestStripes} />
        <img
          src="/logo.png"
          alt=""
          aria-hidden
          className="lg:hidden absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[80vw] max-w-sm object-contain opacity-[0.05] mix-blend-screen select-none pointer-events-none"
        />
        <div className="relative w-full max-w-md flex flex-col items-center">
          {/* Brand mark ABOVE the card — phone/tablet only (lg+ has the
              brand aside). Logo on the green backdrop, then the card. */}
          <div className="lg:hidden flex flex-col items-center text-center mb-5">
            <img
              src="/logo.png"
              alt="Stayvia"
              className="w-16 h-16 object-contain"
            />
            <div className="mt-3 text-cream font-semibold text-lg leading-tight">Stayvia</div>
            <div className="text-[11px] tracking-[0.18em] uppercase text-brass">Hotel OS</div>
          </div>
        <form
          onSubmit={onSubmit}
          noValidate
          className="relative w-full p-7 sm:p-9 space-y-5 bg-surface rounded-[20px] border border-borderc shadow-modal"
          aria-describedby={error ? errId : undefined}
        >

          {!mfaStep && (
            <div>
              <h1 className="text-2xl font-semibold text-ink">Welcome back</h1>
              <p className="text-textSecondary text-sm mt-1">
                Sign in to continue to your workspace.
              </p>
            </div>
          )}

          {expired && !error && (
            <div
              role="status"
              className="flex items-start gap-2 rounded-sm border border-warnBorder bg-warnBg px-3 py-2 text-warnFg text-sm"
            >
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>Your session expired. Please sign in again.</span>
            </div>
          )}

          {error && (
            <div
              id={errId}
              role="alert"
              className="flex items-start gap-2 rounded-sm border border-dangerBorder bg-dangerBg px-3 py-2 text-dangerFg text-sm"
            >
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {!mfaStep && (
          <>
          <div>
            <label htmlFor={emailId} className="label block mb-1">
              Email
            </label>
            <div className="relative">
              <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-textSecondary pointer-events-none" />
              <input
                id={emailId}
                className={`input pl-9 ${
                  touched.email && !emailValid ? "border-danger focus:border-danger focus:ring-danger/30" : ""
                }`}
                type="email"
                inputMode="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onBlur={() => setTouched((t) => ({ ...t, email: true }))}
                placeholder="you@yourhotel.com"
                required
                autoComplete="username"
                autoFocus
                aria-invalid={touched.email && !emailValid}
              />
            </div>
            {touched.email && !emailValid && (
              <p className="text-danger text-xs mt-1">Enter a valid email address.</p>
            )}
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label htmlFor={pwId} className="label">
                Password
              </label>
              <button
                type="button"
                className="text-xs font-semibold text-brand-deep hover:underline"
                onClick={onForgotPassword}
              >
                Forgot password?
              </button>
            </div>
            <div className="relative">
              <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-textSecondary pointer-events-none" />
              <input
                id={pwId}
                className={`input pl-9 pr-10 ${
                  touched.pw && !pwValid ? "border-danger focus:border-danger focus:ring-danger/30" : ""
                }`}
                type={showPw ? "text" : "password"}
                placeholder="Enter your password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onBlur={() => setTouched((t) => ({ ...t, pw: true }))}
                onKeyUp={(e) => setCapsOn(e.getModifierState && e.getModifierState("CapsLock"))}
                onKeyDown={(e) => setCapsOn(e.getModifierState && e.getModifierState("CapsLock"))}
                required
                minLength={6}
                autoComplete="current-password"
                aria-invalid={touched.pw && !pwValid}
              />
              <button
                type="button"
                onClick={() => setShowPw((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded text-textSecondary hover:text-ink hover:bg-bg"
                aria-label={showPw ? "Hide password" : "Show password"}
                tabIndex={-1}
              >
                {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
            <div className="min-h-[1rem] mt-1 flex items-center gap-3 text-xs">
              {touched.pw && !pwValid && (
                <span className="text-danger">Minimum 6 characters.</span>
              )}
              {capsOn && (
                <span className="text-warning flex items-center gap-1">
                  <AlertCircle className="w-3 h-3" /> Caps Lock is on
                </span>
              )}
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm text-textSecondary select-none cursor-pointer">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
              className="w-4 h-4 rounded-sm border-borderControl text-brand focus:ring-brand/40"
            />
            Remember me
          </label>

          <button
            type="submit"
            className="btn-primary w-full flex items-center justify-center gap-2"
            disabled={busy || !formValid}
          >
            {busy ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Signing in…
              </>
            ) : (
              "Sign in"
            )}
          </button>

          <p className="text-center text-xs text-textSecondary">
            New hotel?{" "}
            <Link to="/signup" className="text-brand-deep font-bold hover:underline">
              Start your free 14-day trial
            </Link>
          </p>
          </>
          )}

          {mfaStep && (
            <div className="space-y-5">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-md bg-brand-soft grid place-items-center shrink-0">
                  <ShieldCheck className="w-5 h-5 text-brand-deep" />
                </div>
                <div className="leading-tight">
                  <div className="font-semibold text-ink">Two-factor verification</div>
                  <p className="text-textSecondary text-xs">
                    Enter the 6-digit code from your authenticator app.
                  </p>
                </div>
              </div>

              <div>
                <label htmlFor={`${pwId}-mfa`} className="label block mb-1">
                  Authentication code
                </label>
                <input
                  id={`${pwId}-mfa`}
                  className="input text-center tracking-[0.5em] text-lg font-semibold font-mono"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={mfaCode}
                  onChange={(e) => setMfaCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  placeholder="000000"
                  autoFocus
                />
              </div>

              <button
                type="button"
                onClick={onVerifyMfa}
                className="btn-primary w-full flex items-center justify-center gap-2"
                disabled={busy || mfaCode.replace(/\s/g, "").length < 6}
              >
                {busy ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Verifying…
                  </>
                ) : (
                  "Verify & sign in"
                )}
              </button>

              <button
                type="button"
                onClick={() => {
                  setMfaStep(false);
                  setMfaCode("");
                  setError(null);
                }}
                className="w-full text-center text-xs font-semibold text-brand-deep hover:underline"
              >
                Back to sign in
              </button>
            </div>
          )}
        </form>

          {/* FYN ARC footer — phone/tablet only (lg+ shows it in the aside). */}
          <div className="lg:hidden mt-6 flex items-center gap-2.5">
            <img
              src="/fyn-arc-logo.png"
              alt="FYN ARC Techworks"
              className="h-5 w-auto opacity-80"
            />
            <span className="text-[11px] text-cream/60 tracking-wide leading-tight">
              <span className="block">© {new Date().getFullYear()} Stayvia</span>
              <span className="block">Powered by FYN ARC Techworks</span>
            </span>
          </div>
        </div>
      </main>
    </div>
  );
}
