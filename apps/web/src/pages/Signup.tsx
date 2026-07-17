import { Suspense, lazy, useId, useState } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import {
  AlertCircle,
  Building2,
  Eye,
  EyeOff,
  Loader2,
  Lock,
  Mail,
  Phone,
  ShieldCheck,
  User,
} from "lucide-react";
import { signupSchema } from "@stayvia/shared";
import { useAuth } from "@/auth/AuthContext";
import { ApiError, api } from "@/lib/api";

// Same heavy WebGL backdrop the login page uses — lazy so it only loads
// on the public pages and never weighs down the app bundle.
const Silk = lazy(() => import("@/components/Silk"));

type FieldKey = "hotelName" | "ownerName" | "email" | "password" | "phone";

export default function Signup() {
  const { signIn, session, mfaPending } = useAuth();
  const navigate = useNavigate();
  const uid = useId();

  const [form, setForm] = useState({
    hotelName: "",
    ownerName: "",
    email: "",
    password: "",
    phone: "",
  });
  const [showPw, setShowPw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<FieldKey, string>>>({});

  // Already signed in → straight into the app (mirrors Login's guard).
  if (session && !mfaPending) return <Navigate to="/" replace />;

  function set(key: FieldKey, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
    // Clear the field's error as the user fixes it.
    setFieldErrors((fe) => (fe[key] ? { ...fe, [key]: undefined } : fe));
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);

    const payload = {
      hotelName: form.hotelName.trim(),
      ownerName: form.ownerName.trim(),
      email: form.email.trim(),
      password: form.password,
      phone: form.phone.replace(/[\s-]/g, "") || undefined,
    };

    const parsed = signupSchema.safeParse(payload);
    if (!parsed.success) {
      const flat = parsed.error.flatten().fieldErrors;
      // Friendlier wording than zod's defaults for the common cases.
      setFieldErrors({
        hotelName: flat.hotelName ? "Hotel name must be 2–80 characters." : undefined,
        ownerName: flat.ownerName ? "Your name must be 2–80 characters." : undefined,
        email: flat.email ? "Enter a valid email address." : undefined,
        password: flat.password ? "Password must be 8–128 characters." : undefined,
        phone: flat.phone ? "Enter a 10-digit Indian mobile (starts 6–9)." : undefined,
      });
      return;
    }

    setBusy(true);
    try {
      await api.post<{ propertyId: string }>("/public/signup", parsed.data);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setFieldErrors((fe) => ({ ...fe, email: "This email is already in use." }));
        setError("An account with this email already exists. Try signing in instead.");
      } else if (err instanceof ApiError && err.status === 429) {
        setError("Too many signup attempts. Please wait a while and try again.");
      } else {
        setError(err instanceof Error ? err.message : "Signup failed. Please try again.");
      }
      setBusy(false);
      return;
    }

    // Hotel provisioned — sign the owner straight in. If the automatic
    // sign-in hiccups, the account still exists: hand off to /login.
    try {
      await signIn(parsed.data.email, parsed.data.password);
      navigate("/", { replace: true });
    } catch {
      navigate("/login", { replace: true });
    } finally {
      setBusy(false);
    }
  }

  const inputCls = (key: FieldKey) =>
    `input pl-9 ${fieldErrors[key] ? "border-danger focus:border-danger focus:ring-danger/30" : ""}`;

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
          <img src="/logo.jpg" alt="Stayvia" className="w-14 h-14 rounded-2xl object-contain bg-cream shadow-md ring-1 ring-brass/30" />
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
            Reservations, housekeeping, GST invoices and reports — set up in
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
              src="/logo.jpg"
              alt="Stayvia"
              className="w-16 h-16 rounded-2xl object-contain bg-cream shadow-lg ring-1 ring-brass/30"
            />
            <div className="mt-3 text-cream font-semibold text-lg leading-tight">Stayvia</div>
            <div className="text-[11px] tracking-[0.18em] uppercase text-brass">Hotel OS</div>
          </div>

          <form
            onSubmit={onSubmit}
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
              <label htmlFor={`${uid}-phone`} className="label block mb-1">
                Phone <span className="normal-case tracking-normal font-normal">(optional)</span>
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
                "Start free trial"
              )}
            </button>

            <p className="text-center text-xs text-textSecondary">
              Already have an account?{" "}
              <Link to="/login" className="text-brand-dark font-semibold hover:underline">
                Sign in
              </Link>
            </p>
          </form>

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
