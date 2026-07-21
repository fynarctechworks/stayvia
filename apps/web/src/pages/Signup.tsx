import { Suspense, lazy, useId, useState } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Building2,
  CheckCircle2,
  CreditCard,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Lock,
  Mail,
  MessageCircle,
  Phone,
  ShieldCheck,
  User,
} from "@/lib/micons";
import { signupFormSchema, type SignupOtpChannel } from "@stayvia/shared";
import { useAuth } from "@/auth/AuthContext";
import { ApiError, api } from "@/lib/api";

// Same heavy WebGL backdrop the login page uses — lazy so it only loads
// on the public pages and never weighs down the app bundle.
const Silk = lazy(() => import("@/components/Silk"));

type FieldKey = "hotelName" | "ownerName" | "email" | "password" | "confirmPassword" | "phone" | "otp";

export default function Signup() {
  const { signIn, session, mfaPending } = useAuth();
  const navigate = useNavigate();
  const uid = useId();

  const [form, setForm] = useState({
    hotelName: "",
    ownerName: "",
    email: "",
    password: "",
    confirmPassword: "",
    phone: "",
  });
  const [showPw, setShowPw] = useState(false);
  const [showPw2, setShowPw2] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<FieldKey, string>>>({});

  // Verification step state. The contact is verified on the chosen channel
  // BEFORE the hotel is created. "done" = hotel provisioned, offering the
  // optional payment-setup hop before entering the app.
  const [step, setStep] = useState<"form" | "verify" | "done">("form");
  const [channel, setChannel] = useState<SignupOtpChannel>("email");
  const [otp, setOtp] = useState("");
  const [maskedTarget, setMaskedTarget] = useState("");
  const [devCode, setDevCode] = useState<string | null>(null);
  const [resendBusy, setResendBusy] = useState(false);

  // Already signed in → straight into the app (mirrors Login's guard).
  // Skipped on the post-signup "done" step: finish() signs in and then
  // navigates to the chosen destination itself.
  if (session && !mfaPending && step !== "done") return <Navigate to="/" replace />;

  function set(key: Exclude<FieldKey, "otp">, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
    // Clear the field's error as the user fixes it.
    setFieldErrors((fe) => (fe[key] ? { ...fe, [key]: undefined } : fe));
  }

  function buildPayload() {
    return {
      hotelName: form.hotelName.trim(),
      ownerName: form.ownerName.trim(),
      email: form.email.trim(),
      password: form.password,
      phone: form.phone.replace(/[\s-]/g, "") || undefined,
    };
  }

  function validateForm() {
    const payload = buildPayload();

    // Confirm-password + channel checks are client-side gates only — the
    // API payload doesn't carry them.
    const confirmError =
      form.confirmPassword !== form.password ? "Passwords do not match." : undefined;
    const channelPhoneError =
      channel === "sms" && !payload.phone
        ? "Phone number is required for WhatsApp verification."
        : undefined;

    const parsed = signupFormSchema.safeParse(payload);
    if (!parsed.success || confirmError || channelPhoneError) {
      const flat = parsed.success ? {} : parsed.error.flatten().fieldErrors;
      // Friendlier wording than zod's defaults for the common cases.
      setFieldErrors({
        hotelName: flat.hotelName ? "Hotel name must be 2–80 characters." : undefined,
        ownerName: flat.ownerName ? "Your name must be 2–80 characters." : undefined,
        email: flat.email ? "Enter a valid email address." : undefined,
        password: flat.password ? "Password must be 8–128 characters." : undefined,
        confirmPassword: confirmError,
        phone:
          (flat.phone ? "Enter a 10-digit Indian mobile (starts 6–9)." : undefined) ??
          channelPhoneError,
      });
      return null;
    }
    return parsed.data;
  }

  async function sendCode(kind: "initial" | "resend") {
    const payload = validateForm();
    if (!payload) return;

    const setBusyFlag = kind === "initial" ? setBusy : setResendBusy;
    setBusyFlag(true);
    setError(null);
    try {
      const res = await api.post<{
        target: string;
        channel: SignupOtpChannel;
        expiresInSeconds: number;
        devCode?: string;
      }>("/public/signup/send-otp", {
        email: payload.email,
        phone: payload.phone,
        channel,
      });
      setMaskedTarget(res.target);
      setDevCode(res.devCode ?? null);
      setOtp("");
      setFieldErrors((fe) => ({ ...fe, otp: undefined }));
      setStep("verify");
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // Caught before any code is sent — no verification dance for an
        // email that already has an account.
        setFieldErrors((fe) => ({ ...fe, email: "This email is already in use." }));
        setError("An account with this email already exists. Try signing in instead.");
        setStep("form");
      } else if (err instanceof ApiError && err.status === 429) {
        setError("Too many attempts. Please wait a minute and try again.");
      } else if (err instanceof ApiError && err.status === 503) {
        setError("Email verification is unavailable right now. Try WhatsApp instead.");
      } else {
        setError(err instanceof Error ? err.message : "Could not send the code. Try again.");
      }
    } finally {
      setBusyFlag(false);
    }
  }

  async function onSubmitForm(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    await sendCode("initial");
  }

  async function onSubmitVerify(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (otp.trim().length < 4) {
      setFieldErrors((fe) => ({ ...fe, otp: "Enter the code you received." }));
      return;
    }
    const payload = validateForm();
    if (!payload) {
      // A field went invalid since step 1 — send the user back to fix it.
      setStep("form");
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await api.post<{ propertyId: string }>("/public/signup", {
        ...payload,
        otp: otp.trim(),
        otpChannel: channel,
      });
    } catch (err) {
      if (err instanceof ApiError && err.status === 400 && err.code === "INVALID_CODE") {
        setFieldErrors((fe) => ({ ...fe, otp: "Incorrect code. Check and try again." }));
      } else if (
        err instanceof ApiError &&
        (err.code === "OTP_EXPIRED" || err.code === "NO_OTP" || err.code === "TOO_MANY_ATTEMPTS")
      ) {
        setError("That code is no longer valid. Resend a new one.");
      } else if (err instanceof ApiError && err.status === 409) {
        setFieldErrors((fe) => ({ ...fe, email: "This email is already in use." }));
        setError("An account with this email already exists. Try signing in instead.");
        setStep("form");
      } else if (err instanceof ApiError && err.status === 429) {
        setError("Too many signup attempts. Please wait a while and try again.");
      } else {
        setError(err instanceof Error ? err.message : "Signup failed. Please try again.");
      }
      setBusy(false);
      return;
    }

    // Hotel provisioned — offer the optional payment-setup hop before
    // entering the app. The sign-in happens when they pick a destination.
    setBusy(false);
    setError(null);
    setStep("done");
  }

  // Post-signup: sign the owner in and land them on the chosen page.
  // If the automatic sign-in hiccups, the account still exists: hand
  // off to /login.
  async function finish(target: "/billing" | "/") {
    if (busy) return;
    setBusy(true);
    try {
      await signIn(form.email.trim(), form.password);
      navigate(target, { replace: true });
    } catch {
      navigate("/login", { replace: true });
    } finally {
      setBusy(false);
    }
  }

  const inputCls = (key: FieldKey) =>
    `input pl-9 ${fieldErrors[key] ? "border-danger focus:border-danger focus:ring-danger/30" : ""}`;

  const channelPill = (value: SignupOtpChannel, label: string, Icon: typeof Mail) => (
    <button
      type="button"
      onClick={() => {
        setChannel(value);
        setFieldErrors((fe) => (fe.phone ? { ...fe, phone: undefined } : fe));
      }}
      className={`flex-1 flex items-center justify-center gap-2 rounded-sm border px-3 py-2 text-sm font-medium transition-colors ${
        channel === value
          ? "border-brand-dark bg-brand-soft text-navy"
          : "border-borderc text-textSecondary hover:border-brand-dark/40"
      }`}
      aria-pressed={channel === value}
    >
      <Icon className="w-4 h-4" />
      {label}
    </button>
  );

  return (
    <div className="min-h-screen grid lg:grid-cols-2 bg-ivory">
      <aside className="hidden lg:block relative overflow-hidden bg-brand-dark text-cream min-h-screen">
        {/* Animated silk backdrop in the allowed deep-emerald accent. */}
        <div aria-hidden className="absolute inset-0 bg-brand-dark">
          <Suspense fallback={null}>
            <Silk speed={4} scale={1.1} color="#157f5f" noiseIntensity={1.2} rotation={0.2} />
          </Suspense>
        </div>
        <div aria-hidden className="absolute inset-0 bg-gradient-to-tr from-brand-dark/55 via-brand-dark/25 to-transparent" />
        <div className="absolute inset-y-0 right-0 w-px bg-brass/20" />

        <div className="absolute top-10 left-10 xl:left-14 flex items-center gap-3 pointer-events-none">
          <img src="/logo.png" alt="Stayvia" className="w-14 h-14 object-contain" />
          <div className="leading-tight">
            <div className="text-cream font-semibold text-lg">Stayvia</div>
            <div className="text-[11px] font-normal text-brass tracking-[0.18em] uppercase">Hotel OS</div>
          </div>
        </div>

        <div className="absolute inset-0 flex flex-col items-start justify-center text-left p-10 xl:p-14 pointer-events-none">
          <span className="inline-flex items-center rounded-full border border-brass/40 bg-brass/10 backdrop-blur px-4 py-1.5 text-xs font-semibold tracking-[0.18em] uppercase text-brass mb-6">
            14-day free trial
          </span>

          <h2 className="text-cream text-4xl xl:text-5xl font-bold leading-tight drop-shadow-sm max-w-md">
            Run your hotel from{" "}
            <span className="italic font-serif text-brass">one desk.</span>
          </h2>

          <p className="text-cream/85 text-base leading-relaxed mt-5 max-w-md">
            Reservations, housekeeping, GST invoices and reports - set up in
            minutes, no card required to start.
          </p>

          <ul className="mt-8 space-y-4">
            {[
              "Full access for 14 days, free",
              "GST-ready invoices & reports",
              "Add your whole front-desk team",
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

        <div className="absolute bottom-8 left-10 xl:left-14 flex items-center gap-2.5 pointer-events-none">
          <img src="/fyn-arc-logo.png" alt="FYN ARC Techworks" className="h-6 w-auto opacity-80" />
          <span className="text-xs text-cream/60 tracking-wide leading-tight">
            <span className="block">© {new Date().getFullYear()} Stayvia</span>
            <span className="block">Powered by FYN ARC Techworks</span>
          </span>
        </div>
      </aside>

      {/* Phone/tablet: form pane carries the brand backdrop itself, same
          treatment as Login. */}
      <main className="relative flex items-center justify-center p-6 sm:p-10 bg-brand-dark lg:bg-ivory overflow-hidden">
        <div aria-hidden className="lg:hidden absolute inset-0">
          <Suspense fallback={null}>
            <Silk speed={4} scale={1.1} color="#157f5f" noiseIntensity={1.2} rotation={0.2} />
          </Suspense>
        </div>
        <div aria-hidden className="lg:hidden absolute inset-0 bg-brand-dark/55" />
        <div className="relative w-full max-w-md flex flex-col items-center py-4">
          <div className="lg:hidden flex flex-col items-center text-center mb-5">
            <img
              src="/logo.png"
              alt="Stayvia"
              className="w-16 h-16 object-contain"
            />
            <div className="mt-3 text-cream font-semibold text-lg leading-tight">Stayvia</div>
            <div className="text-[11px] tracking-[0.18em] uppercase text-brass">Hotel OS</div>
          </div>

          {step === "form" && (
          <form
            onSubmit={onSubmitForm}
            noValidate
            className="relative w-full p-7 sm:p-9 space-y-4 bg-surface rounded-2xl lg:rounded-md border border-borderc shadow-[0_20px_50px_-20px_rgba(15,61,46,0.45)]"
          >
            <div>
              <h1 className="text-2xl font-semibold text-navy">Create your hotel</h1>
              <p className="text-textSecondary text-sm mt-1">
                Start your free 14-day trial. No card required.
              </p>
            </div>

            {error && (
              <div
                role="alert"
                className="flex items-start gap-2 rounded-sm border border-danger/30 bg-danger/5 px-3 py-2 text-danger text-sm"
              >
                <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <div>
              <label htmlFor={`${uid}-hotel`} className="label block mb-1">
                Hotel name
              </label>
              <div className="relative">
                <Building2 className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-textSecondary pointer-events-none" />
                <input
                  id={`${uid}-hotel`}
                  className={inputCls("hotelName")}
                  value={form.hotelName}
                  onChange={(e) => set("hotelName", e.target.value)}
                  placeholder="e.g. Sunrise Residency"
                  autoComplete="organization"
                  autoFocus
                  aria-invalid={!!fieldErrors.hotelName}
                />
              </div>
              {fieldErrors.hotelName && (
                <p className="text-danger text-xs mt-1">{fieldErrors.hotelName}</p>
              )}
            </div>

            <div>
              <label htmlFor={`${uid}-owner`} className="label block mb-1">
                Your name
              </label>
              <div className="relative">
                <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-textSecondary pointer-events-none" />
                <input
                  id={`${uid}-owner`}
                  className={inputCls("ownerName")}
                  value={form.ownerName}
                  onChange={(e) => set("ownerName", e.target.value)}
                  placeholder="Full name"
                  autoComplete="name"
                  aria-invalid={!!fieldErrors.ownerName}
                />
              </div>
              {fieldErrors.ownerName && (
                <p className="text-danger text-xs mt-1">{fieldErrors.ownerName}</p>
              )}
            </div>

            <div>
              <label htmlFor={`${uid}-email`} className="label block mb-1">
                Email
              </label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-textSecondary pointer-events-none" />
                <input
                  id={`${uid}-email`}
                  className={inputCls("email")}
                  type="email"
                  inputMode="email"
                  value={form.email}
                  onChange={(e) => set("email", e.target.value)}
                  placeholder="you@yourhotel.com"
                  autoComplete="email"
                  aria-invalid={!!fieldErrors.email}
                />
              </div>
              {fieldErrors.email && (
                <p className="text-danger text-xs mt-1">{fieldErrors.email}</p>
              )}
            </div>

            <div>
              <label htmlFor={`${uid}-pw`} className="label block mb-1">
                Password
              </label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-textSecondary pointer-events-none" />
                <input
                  id={`${uid}-pw`}
                  className={`${inputCls("password")} pr-10`}
                  type={showPw ? "text" : "password"}
                  value={form.password}
                  onChange={(e) => set("password", e.target.value)}
                  placeholder="At least 8 characters"
                  autoComplete="new-password"
                  aria-invalid={!!fieldErrors.password}
                />
                <button
                  type="button"
                  onClick={() => setShowPw((v) => !v)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded text-textSecondary hover:text-navy hover:bg-bg"
                  aria-label={showPw ? "Hide password" : "Show password"}
                  tabIndex={-1}
                >
                  {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              {fieldErrors.password && (
                <p className="text-danger text-xs mt-1">{fieldErrors.password}</p>
              )}
            </div>

            <div>
              <label htmlFor={`${uid}-pw2`} className="label block mb-1">
                Confirm password
              </label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-textSecondary pointer-events-none" />
                <input
                  id={`${uid}-pw2`}
                  className={`${inputCls("confirmPassword")} pr-10`}
                  type={showPw2 ? "text" : "password"}
                  value={form.confirmPassword}
                  onChange={(e) => set("confirmPassword", e.target.value)}
                  placeholder="Re-enter password"
                  autoComplete="new-password"
                  aria-invalid={!!fieldErrors.confirmPassword}
                />
                <button
                  type="button"
                  onClick={() => setShowPw2((v) => !v)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded text-textSecondary hover:text-navy hover:bg-bg"
                  aria-label={showPw2 ? "Hide password" : "Show password"}
                  tabIndex={-1}
                >
                  {showPw2 ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              {fieldErrors.confirmPassword && (
                <p className="text-danger text-xs mt-1">{fieldErrors.confirmPassword}</p>
              )}
            </div>

            <div>
              <label htmlFor={`${uid}-phone`} className="label block mb-1">
                Phone{" "}
                <span className="normal-case tracking-normal font-normal">
                  {channel === "sms" ? "(required for WhatsApp)" : "(optional)"}
                </span>
              </label>
              <div className="relative">
                <Phone className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-textSecondary pointer-events-none" />
                <input
                  id={`${uid}-phone`}
                  className={inputCls("phone")}
                  type="tel"
                  inputMode="tel"
                  value={form.phone}
                  onChange={(e) => set("phone", e.target.value)}
                  placeholder="10-digit mobile"
                  autoComplete="tel-national"
                  aria-invalid={!!fieldErrors.phone}
                />
              </div>
              {fieldErrors.phone && (
                <p className="text-danger text-xs mt-1">{fieldErrors.phone}</p>
              )}
            </div>

            <div>
              <span className="label block mb-1">Verify via</span>
              <div className="flex gap-2">
                {channelPill("email", "Email", Mail)}
                {channelPill("sms", "WhatsApp", MessageCircle)}
              </div>
            </div>

            <button
              type="submit"
              className="btn-primary w-full flex items-center justify-center gap-2"
              disabled={busy}
            >
              {busy ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Sending code…
                </>
              ) : (
                "Send verification code"
              )}
            </button>

            <p className="text-center text-xs text-textSecondary">
              Already have an account?{" "}
              <Link to="/login" className="text-brand-dark font-semibold hover:underline">
                Sign in
              </Link>
            </p>
          </form>
          )}

          {step === "verify" && (
          <form
            onSubmit={onSubmitVerify}
            noValidate
            className="relative w-full p-7 sm:p-9 space-y-4 bg-surface rounded-2xl lg:rounded-md border border-borderc shadow-[0_20px_50px_-20px_rgba(15,61,46,0.45)]"
          >
            <div>
              <h1 className="text-2xl font-semibold text-navy">Verify your {channel === "email" ? "email" : "WhatsApp"}</h1>
              <p className="text-textSecondary text-sm mt-1">
                We sent a code to <span className="font-semibold text-navy">{maskedTarget}</span>.
                Enter it below to create your hotel.
              </p>
            </div>

            {error && (
              <div
                role="alert"
                className="flex items-start gap-2 rounded-sm border border-danger/30 bg-danger/5 px-3 py-2 text-danger text-sm"
              >
                <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            {devCode && (
              <div className="rounded-sm border border-brass/40 bg-brass/10 px-3 py-2 text-xs text-navy">
                Dev mode - your code is <span className="font-mono font-semibold">{devCode}</span>
              </div>
            )}

            <div>
              <label htmlFor={`${uid}-otp`} className="label block mb-1">
                Verification code
              </label>
              <div className="relative">
                <KeyRound className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-textSecondary pointer-events-none" />
                <input
                  id={`${uid}-otp`}
                  className={`${inputCls("otp")} tracking-[0.3em] font-mono`}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={8}
                  value={otp}
                  onChange={(e) => {
                    setOtp(e.target.value.replace(/\D/g, ""));
                    setFieldErrors((fe) => (fe.otp ? { ...fe, otp: undefined } : fe));
                  }}
                  placeholder="••••••"
                  autoFocus
                  aria-invalid={!!fieldErrors.otp}
                />
              </div>
              {fieldErrors.otp && <p className="text-danger text-xs mt-1">{fieldErrors.otp}</p>}
            </div>

            <button
              type="submit"
              className="btn-primary w-full flex items-center justify-center gap-2"
              disabled={busy}
            >
              {busy ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Creating your hotel…
                </>
              ) : (
                "Verify & create hotel"
              )}
            </button>

            <div className="flex items-center justify-between text-xs text-textSecondary">
              <button
                type="button"
                onClick={() => {
                  setStep("form");
                  setError(null);
                }}
                className="inline-flex items-center gap-1 text-brand-dark font-semibold hover:underline"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                Edit details
              </button>
              <button
                type="button"
                onClick={() => sendCode("resend")}
                disabled={resendBusy}
                className="text-brand-dark font-semibold hover:underline disabled:opacity-50"
              >
                {resendBusy ? "Sending…" : "Resend code"}
              </button>
            </div>
          </form>
          )}

          {step === "done" && (
          <div className="relative w-full p-7 sm:p-9 space-y-4 bg-surface rounded-2xl lg:rounded-md border border-borderc shadow-[0_20px_50px_-20px_rgba(15,61,46,0.45)]">
            <div className="w-12 h-12 rounded-full bg-brand-soft grid place-items-center">
              <CheckCircle2 className="w-6 h-6 text-brand-deep" />
            </div>
            <div>
              <h1 className="text-2xl font-semibold text-navy">Your hotel is ready!</h1>
              <p className="text-textSecondary text-sm mt-1">
                The 14-day free trial is live - full access, nothing locked.
              </p>
            </div>
            <div className="rounded-sm border border-borderc bg-bg/60 px-4 py-3 text-sm text-textSecondary">
              Want uninterrupted service after the trial? Set up your
              subscription payment with <strong className="text-navy">Razorpay</strong> now
              - UPI, card or netbanking. Completely optional; you can also do
              it any time from the Billing page.
            </div>
            {error && (
              <div
                role="alert"
                className="flex items-start gap-2 rounded-sm border border-danger/30 bg-danger/5 px-3 py-2 text-danger text-sm"
              >
                <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                <span>{error}</span>
              </div>
            )}
            <button
              type="button"
              onClick={() => finish("/billing")}
              disabled={busy}
              className="btn-primary w-full flex items-center justify-center gap-2"
            >
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CreditCard className="w-4 h-4" />}
              Set up payment now
            </button>
            <button
              type="button"
              onClick={() => finish("/")}
              disabled={busy}
              className="w-full flex items-center justify-center gap-2 h-11 rounded-sm border border-borderc text-sm font-semibold text-textSecondary hover:text-navy hover:border-navy/40 transition-colors disabled:opacity-50"
            >
              Skip for now - go to my dashboard <ArrowRight className="w-4 h-4" />
            </button>
          </div>
          )}

          <div className="lg:hidden mt-6 flex items-center gap-2.5">
            <img src="/fyn-arc-logo.png" alt="FYN ARC Techworks" className="h-5 w-auto opacity-80" />
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
