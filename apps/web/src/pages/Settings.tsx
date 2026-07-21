import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  Copy,
  Eye,
  EyeOff,
  MapPin,
  ShieldCheck,
  Smartphone,
} from "@/lib/micons";
import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@/auth/AuthContext";
import { useDialog } from "@/components/Dialog";
import { TimePicker12h } from "@/components/TimePicker12h";
import { Loader } from "@/components/Loader";
import { useToast } from "@/components/Toast";
import { api } from "@/lib/api";
import { supabase } from "@/lib/supabase";

type Tab = "my-profile" | "hotel";

export default function Settings() {
  const tabs = useMemo<{ id: Tab; label: string }[]>(
    () => [
      { id: "my-profile", label: "My Profile" },
      { id: "hotel", label: "Hotel Profile" },
    ],
    [],
  );
  const [tab, setTab] = useState<Tab>("my-profile");
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-navy">Settings</h1>
      <div className="flex gap-1 flex-wrap border-b border-borderc">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition ${
              tab === t.id
                ? "border-gold text-navy"
                : "border-transparent text-textSecondary hover:text-navy"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === "my-profile" && <MyProfileTab />}
      {tab === "hotel" && <HotelTab />}
    </div>
  );
}

// ============================================================
// My Profile tab — the signed-in user edits their own account
// ============================================================

interface MeProfile {
  id: string;
  email: string;
  fullName: string;
  phone: string | null;
  rbacRoleKey: string | null;
  role: string;
}

function MyProfileTab() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { profile: authProfile } = useAuth();

  const { data: me, isLoading } = useQuery({
    queryKey: ["auth-me"],
    queryFn: () => api.get<{ profile: MeProfile }>("/auth/me").then((r) => r.profile),
  });

  const [form, setForm] = useState({ fullName: "", email: "", phone: "" });
  const [err, setErr] = useState<string | null>(null);
  // Required only for an email change — the email IS the login identity, so
  // the server demands the current password before repointing it.
  const [emailPw, setEmailPw] = useState("");

  useEffect(() => {
    if (!me) return;
    setForm({ fullName: me.fullName, email: me.email, phone: me.phone ?? "" });
  }, [me]);

  const emailChanged = !!me && form.email !== me.email;

  const save = useMutation({
    mutationFn: async () => {
      const patch: Record<string, unknown> = {};
      if (me && form.fullName !== me.fullName) patch.fullName = form.fullName;
      if (me && form.email !== me.email) {
        patch.email = form.email;
        patch.currentPassword = emailPw;
      }
      const newPhone = form.phone.trim() || null;
      if (me && newPhone !== (me.phone ?? null)) patch.phone = newPhone;
      if (Object.keys(patch).length === 0) {
        throw new Error("Nothing to save");
      }
      return api.put("/auth/me", patch);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["auth-me"] });
      setErr(null);
      setEmailPw("");
      toast("Profile updated", "success");
    },
    onError: (e: Error) => setErr(e.message),
  });

  if (isLoading || !me) return <Loader />;

  return (
    <div className="space-y-4">
      <div className="card space-y-5">
        <div>
          <h3 className="font-semibold text-brand-dark text-lg">My Profile</h3>
          <p className="text-xs text-textSecondary mt-1">
            Update your own account details. Only an administrator can change your role or
            permissions.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Full Name">
            <input
              className="input"
              value={form.fullName}
              onChange={(e) => setForm({ ...form, fullName: e.target.value })}
            />
          </Field>
          <Field label="Email">
            <input
              className="input"
              type="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />
          </Field>
          <Field label="Phone">
            <input
              className="input"
              type="tel"
              inputMode="numeric"
              maxLength={10}
              placeholder="9876543210"
              value={form.phone}
              onChange={(e) =>
                setForm({ ...form, phone: e.target.value.replace(/\D/g, "").slice(0, 10) })
              }
            />
          </Field>
          <Field label="Role">
            <input
              className="input bg-bg cursor-not-allowed"
              value={authProfile?.rbacRoleKey ?? me.role}
              readOnly
              disabled
            />
          </Field>
        </div>

        {emailChanged && (
          <div className="rounded-sm border border-warning/40 bg-warning/5 p-3 space-y-2">
            <div className="text-xs text-textPrimary">
              You are changing the email you sign in with. Enter your current
              password to confirm it is you.
            </div>
            <Field label="Current Password">
              <input
                className="input"
                type="password"
                autoComplete="current-password"
                placeholder="Your current password"
                value={emailPw}
                onChange={(e) => setEmailPw(e.target.value)}
              />
            </Field>
          </div>
        )}

        {err && (
          <div className="rounded-sm border border-danger/30 bg-danger/5 px-3 py-2 text-danger text-sm">
            {err}
          </div>
        )}

        <div className="flex justify-end">
          <button
            className="btn-primary"
            onClick={() => save.mutate()}
            disabled={save.isPending || (emailChanged && !emailPw)}
          >
            {save.isPending ? "Saving…" : "Save Changes"}
          </button>
        </div>
      </div>

      <ChangePasswordCard phone={me.phone} />

      <TwoFactorCard />

    </div>
  );
}

// ============================================================
// Password change with OTP-on-WhatsApp verification.
// Step 1: enter current password → server sends OTP to phone on file.
// Step 2: enter OTP + new password → server verifies all three, flips PW.
// ============================================================
function ChangePasswordCard({ phone }: { phone: string | null }) {
  const { toast } = useToast();
  const [step, setStep] = useState<1 | 2>(1);
  const [oldPw, setOldPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [newPwConfirm, setNewPwConfirm] = useState("");
  const [otp, setOtp] = useState("");
  const [showOldPw, setShowOldPw] = useState(false);
  const [showNewPw, setShowNewPw] = useState(false);
  const [maskedTarget, setMaskedTarget] = useState<string>("");
  const [devCode, setDevCode] = useState<string | undefined>(undefined);
  const [err, setErr] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);

  useEffect(() => {
    if (secondsLeft <= 0) return;
    const t = setInterval(() => setSecondsLeft((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(t);
  }, [secondsLeft]);

  function reset() {
    setStep(1);
    setOldPw("");
    setNewPw("");
    setNewPwConfirm("");
    setOtp("");
    setDevCode(undefined);
    setMaskedTarget("");
    setErr(null);
    setSecondsLeft(0);
  }

  const sendOtp = useMutation({
    mutationFn: async () => {
      if (!oldPw) throw new Error("Enter your current password");
      return api.post<{ target: string; expiresInSeconds: number; devCode?: string }>(
        "/auth/me/password/send-otp",
        { oldPassword: oldPw },
      );
    },
    onSuccess: (data) => {
      setMaskedTarget(data.target);
      setDevCode(data.devCode);
      setSecondsLeft(data.expiresInSeconds);
      setStep(2);
      setErr(null);
      toast("OTP sent on WhatsApp", "success");
    },
    onError: (e: Error) => setErr(e.message),
  });

  const change = useMutation({
    mutationFn: async () => {
      if (newPw.length < 8) throw new Error("New password must be at least 8 characters");
      if (newPw !== newPwConfirm) throw new Error("New passwords do not match");
      if (!otp) throw new Error("Enter the OTP from WhatsApp");
      return api.post("/auth/me/password/change", {
        oldPassword: oldPw,
        otp,
        newPassword: newPw,
      });
    },
    onSuccess: () => {
      toast("Password changed", "success");
      reset();
    },
    onError: (e: Error) => setErr(e.message),
  });

  const hasPhone = !!phone?.trim();

  return (
    <div className="card space-y-4">
      <div>
        <h3 className="font-semibold text-brand-dark text-lg">Change Password</h3>
        <p className="text-xs text-textSecondary mt-1">
          Verify your current password, then enter the OTP we send to your WhatsApp number.
        </p>
      </div>

      {!hasPhone && (
        <div className="rounded-sm border border-warning/40 bg-warning/10 px-3 py-2 text-warning text-sm">
          You don't have a phone number on file. Add one above and save before changing your
          password - the OTP is delivered via WhatsApp.
        </div>
      )}

      {step === 1 && (
        <>
          <Field label="Current Password">
            <div className="relative">
              <input
                className="input pr-10"
                type={showOldPw ? "text" : "password"}
                value={oldPw}
                onChange={(e) => setOldPw(e.target.value)}
                autoComplete="current-password"
              />
              <button
                type="button"
                onClick={() => setShowOldPw((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 text-textSecondary hover:text-navy"
                aria-label={showOldPw ? "Hide" : "Show"}
              >
                {showOldPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </Field>

          {err && (
            <div className="rounded-sm border border-danger/30 bg-danger/5 px-3 py-2 text-danger text-sm">
              {err}
            </div>
          )}

          <div className="flex justify-end">
            <button
              className="btn-primary"
              onClick={() => sendOtp.mutate()}
              disabled={sendOtp.isPending || !hasPhone || !oldPw}
            >
              {sendOtp.isPending ? "Verifying…" : "Send OTP on WhatsApp"}
            </button>
          </div>
        </>
      )}

      {step === 2 && (
        <>
          <div className="rounded-sm bg-brand-soft/40 border border-borderc px-3 py-2 text-sm">
            <>
              OTP sent to <span className="font-mono">{maskedTarget}</span> via WhatsApp.
            </>
            {secondsLeft > 0 && (
              <span className="text-textSecondary ml-2">
                Expires in {Math.floor(secondsLeft / 60)}m {String(secondsLeft % 60).padStart(2, "0")}s
              </span>
            )}
            {devCode && (
              <div className="mt-1 text-sm">
                Your code:{" "}
                <span className="font-mono font-bold text-brand-dark text-base">{devCode}</span>
              </div>
            )}
          </div>

          <Field label="OTP from WhatsApp">
            <input
              className="input font-mono tracking-widest text-lg"
              inputMode="numeric"
              maxLength={8}
              value={otp}
              onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))}
              placeholder="••••••"
              autoFocus
            />
          </Field>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="New Password">
              <div className="relative">
                <input
                  className="input pr-10"
                  type={showNewPw ? "text" : "password"}
                  value={newPw}
                  onChange={(e) => setNewPw(e.target.value)}
                  autoComplete="new-password"
                  minLength={8}
                />
                <button
                  type="button"
                  onClick={() => setShowNewPw((v) => !v)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 text-textSecondary hover:text-navy"
                  aria-label={showNewPw ? "Hide" : "Show"}
                >
                  {showNewPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </Field>
            <Field label="Confirm New Password">
              <input
                className="input"
                type={showNewPw ? "text" : "password"}
                value={newPwConfirm}
                onChange={(e) => setNewPwConfirm(e.target.value)}
                autoComplete="new-password"
                minLength={8}
              />
            </Field>
          </div>

          {err && (
            <div className="rounded-sm border border-danger/30 bg-danger/5 px-3 py-2 text-danger text-sm">
              {err}
            </div>
          )}

          <div className="flex justify-between items-center">
            <button
              type="button"
              className="text-sm text-textSecondary hover:text-navy"
              onClick={reset}
            >
              Cancel
            </button>
            <div className="flex gap-2">
              <button
                type="button"
                className="text-sm text-accentBlue hover:underline disabled:opacity-50"
                onClick={() => sendOtp.mutate()}
                disabled={sendOtp.isPending || secondsLeft > 0}
                title={secondsLeft > 0 ? "Wait for current code to expire or use it" : "Resend"}
              >
                {sendOtp.isPending ? "Sending…" : "Resend OTP"}
              </button>
              <button
                className="btn-primary"
                onClick={() => change.mutate()}
                disabled={change.isPending}
              >
                {change.isPending ? "Updating…" : "Change Password"}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ============================================================
// Two-factor authentication (TOTP via authenticator app).
// Uses Supabase Auth MFA directly from the browser — the factor,
// QR code, and verification all go through supabase-js. No backend
// route needed; Supabase stores the factor against the auth user.
//
// Flow:
//   idle      — show enrolled factors (if any) + "Add" button
//   enrolling — created an unverified factor; show QR + secret + code field
// A factor only becomes "verified" after the user enters one correct
// code. Unverified factors are cleaned up on cancel so they don't pile up.
// ============================================================
function TwoFactorCard() {
  const { toast } = useToast();
  const dialog = useDialog();
  const qc = useQueryClient();

  const { data: factors, isLoading } = useQuery({
    queryKey: ["mfa-factors"],
    queryFn: async () => {
      const { data, error } = await supabase.auth.mfa.listFactors();
      if (error) throw error;
      return data.totp ?? [];
    },
  });

  const verified = (factors ?? []).filter((f) => f.status === "verified");
  const hasVerified = verified.length > 0;

  // Active enrollment session (an unverified factor we just created).
  const [enroll, setEnroll] = useState<{
    factorId: string;
    qr: string;
    secret: string;
  } | null>(null);
  const [code, setCode] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // GoTrue returns "MFA enroll is disabled for TOTP" when the Supabase project
  // has TOTP MFA turned off — locally via config.toml [auth.mfa.totp], and on
  // a hosted project when it's not on the Pro plan (or MFA is off in
  // Dashboard > Authentication). Detect it so the card explains that instead
  // of surfacing a raw provider error, and stops offering a button that can
  // only fail.
  const mfaUnavailable =
    !!err && /mfa.*(disabled|not enabled|not available)/i.test(err);

  const startEnroll = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.auth.mfa.enroll({
        factorType: "totp",
        friendlyName: `Authenticator ${new Date().toLocaleDateString()}`,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: (data) => {
      setErr(null);
      setCode("");
      setEnroll({
        factorId: data.id,
        qr: data.totp.qr_code,
        secret: data.totp.secret,
      });
    },
    onError: (e: Error) => setErr(e.message),
  });

  const confirmEnroll = useMutation({
    mutationFn: async () => {
      if (!enroll) throw new Error("No enrollment in progress");
      const clean = code.replace(/\D/g, "");
      if (clean.length !== 6) throw new Error("Enter the 6-digit code from your app");
      const { data: chal, error: chalErr } = await supabase.auth.mfa.challenge({
        factorId: enroll.factorId,
      });
      if (chalErr) throw chalErr;
      const { error: verErr } = await supabase.auth.mfa.verify({
        factorId: enroll.factorId,
        challengeId: chal.id,
        code: clean,
      });
      if (verErr) throw verErr;
    },
    onSuccess: () => {
      setEnroll(null);
      setCode("");
      setErr(null);
      qc.invalidateQueries({ queryKey: ["mfa-factors"] });
      toast("Two-factor authentication enabled", "success");
    },
    onError: (e: Error) => setErr(e.message),
  });

  // Cancel an in-progress enrollment: remove the unverified factor so it
  // doesn't linger on the account.
  async function cancelEnroll() {
    if (enroll) {
      try {
        await supabase.auth.mfa.unenroll({ factorId: enroll.factorId });
      } catch {
        // best-effort cleanup
      }
    }
    setEnroll(null);
    setCode("");
    setErr(null);
  }

  const removeFactor = useMutation({
    mutationFn: async (factorId: string) => {
      const { error } = await supabase.auth.mfa.unenroll({ factorId });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["mfa-factors"] });
      toast("Two-factor authentication removed", "success");
    },
    onError: (e: Error) => toast(e.message, "error"),
  });

  async function onRemove(factorId: string) {
    const ok = await dialog.confirm({
      title: "Remove two-factor authentication?",
      message:
        "You'll sign in with just your password until you set it up again. We recommend keeping 2FA enabled.",
      okLabel: "Remove",
      tone: "danger",
    });
    if (ok) removeFactor.mutate(factorId);
  }

  function copySecret() {
    if (!enroll) return;
    navigator.clipboard?.writeText(enroll.secret).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <div className="card space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold text-brand-dark text-lg flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-brand" />
            Two-Factor Authentication
          </h3>
          <p className="text-xs text-textSecondary mt-1">
            Add a second layer of security. After your password, you'll enter a 6-digit code
            from an authenticator app (Google Authenticator, Authy, 1Password, etc).
          </p>
        </div>
        {hasVerified && !enroll && (
          <span className="shrink-0 inline-flex items-center gap-1 rounded-full bg-success/10 text-success text-xs font-medium px-2.5 py-1">
            <Check className="w-3 h-3" /> Enabled
          </span>
        )}
      </div>

      {isLoading && <Loader />}

      {/* No enrollment in progress — show status + actions */}
      {!isLoading && !enroll && (
        <>
          {hasVerified ? (
            <div className="space-y-2">
              {verified.map((f) => (
                <div
                  key={f.id}
                  className="flex items-center justify-between rounded-sm border border-borderc bg-bg px-3 py-2"
                >
                  <div className="flex items-center gap-2 text-sm">
                    <Smartphone className="w-4 h-4 text-textSecondary" />
                    <span className="font-medium text-brand-dark">
                      {f.friendly_name || "Authenticator app"}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="text-xs text-danger hover:underline disabled:opacity-50"
                    onClick={() => onRemove(f.id)}
                    disabled={removeFactor.isPending}
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-sm border border-warning/40 bg-warning/10 px-3 py-2 text-warning text-sm">
              Two-factor authentication is not enabled on your account.
            </div>
          )}

          {mfaUnavailable ? (
            <div className="rounded-sm border border-borderc bg-bg px-3 py-2 text-textSecondary text-sm">
              Two-factor authentication isn't available on this workspace yet.
              It needs to be enabled in the project's authentication settings
              (on hosted Supabase this requires the Pro plan).
            </div>
          ) : (
            err && (
              <div className="rounded-sm border border-danger/30 bg-danger/5 px-3 py-2 text-danger text-sm">
                {err}
              </div>
            )
          )}

          <div className="flex justify-end">
            <button
              className="btn-primary"
              onClick={() => startEnroll.mutate()}
              disabled={startEnroll.isPending || mfaUnavailable}
            >
              {startEnroll.isPending
                ? "Preparing…"
                : hasVerified
                  ? "Add another authenticator"
                  : "Enable 2FA"}
            </button>
          </div>
        </>
      )}

      {/* Enrollment in progress — show QR + secret + code entry */}
      {enroll && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-[auto_1fr] gap-4 items-start">
            <div className="bg-white border border-borderc rounded-md p-2 mx-auto sm:mx-0">
              {/* Supabase returns an SVG data URI for the QR code. */}
              <img
                src={enroll.qr}
                alt="Scan this QR code with your authenticator app"
                className="w-40 h-40"
              />
            </div>
            <div className="space-y-3 text-sm">
              <p className="text-textSecondary">
                1. Scan this QR code with your authenticator app. Can't scan? Enter this key
                manually:
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 break-all rounded-sm bg-bg border border-borderc px-2 py-1.5 text-xs font-mono">
                  {enroll.secret}
                </code>
                <button
                  type="button"
                  onClick={copySecret}
                  className="shrink-0 p-2 rounded-sm border border-borderc text-textSecondary hover:text-navy hover:bg-bg"
                  aria-label="Copy setup key"
                  title="Copy setup key"
                >
                  {copied ? (
                    <Check className="w-4 h-4 text-success" />
                  ) : (
                    <Copy className="w-4 h-4" />
                  )}
                </button>
              </div>
            </div>
          </div>

          <Field label="2. Enter the 6-digit code from your app">
            <input
              className="input text-center tracking-[0.4em] text-lg font-semibold max-w-[12rem]"
              inputMode="numeric"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              placeholder="000000"
              autoFocus
            />
          </Field>

          {err && (
            <div className="rounded-sm border border-danger/30 bg-danger/5 px-3 py-2 text-danger text-sm">
              {err}
            </div>
          )}

          <div className="flex justify-between items-center">
            <button
              type="button"
              className="text-sm text-textSecondary hover:text-navy"
              onClick={cancelEnroll}
            >
              Cancel
            </button>
            <button
              className="btn-primary"
              onClick={() => confirmEnroll.mutate()}
              disabled={confirmEnroll.isPending || code.replace(/\D/g, "").length !== 6}
            >
              {confirmEnroll.isPending ? "Verifying…" : "Verify & enable"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

interface HotelSettings {
  id: string;
  hotelName: string;
  hotelAddress: string;
  // Numeric on the DB but Drizzle returns string. We keep them as strings in
  // the form so the inputs stay controlled across empty/typing states.
  hotelLatitude: string | null;
  hotelLongitude: string | null;
  hotelPhone: string;
  hotelEmail: string | null;
  hotelGstin: string;
  invoicePrefix: string;
  checkInTime: string;
  checkOutTime: string;
  ownerPhone: string | null;
  ownerNotifyEnabled: boolean;
  otpRequiredForCheckin: boolean;
  // Whether complimentary bookings stay hidden from the normal views
  // (calendar, reservations, activity, invoices, dashboard alerts). On by
  // default; off = comp bookings show like any other booking.
  hideComplimentary: boolean;
  wifiSsid: string | null;
  wifiPassword: string | null;
  // Property-wide GST pricing mode. 'inclusive' = rate the staff types
  // already contains GST; 'exclusive' = GST is added on top. Only
  // affects NEW bookings; existing reservations keep their own snapshot.
  gstMode: "exclusive" | "inclusive";
  // Tagline under the hotel name on invoices/receipts. "" hides the line.
  docTagline?: string;
  // Per-hotel logo shown in the shell, receipts and PDF invoices. Null =
  // the Stayvia default mark.
  hotelLogoUrl?: string | null;
  // Soft access gate for the Complimentary report (0024). The API
  // never sends the actual code — `complimentaryUnlockCode` is "" when
  // a code IS set, null when it's not. The boolean tells the UI
  // whether to render "Set" or "Change / Clear" controls.
  complimentaryUnlockCode?: string | null;
  hasComplimentaryUnlockCode?: boolean;
}

function HotelTab() {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ["settings"],
    queryFn: () =>
      api.get<{
        settings: HotelSettings | null;
        roomTypes: unknown[];
      }>("/settings"),
  });
  const [form, setForm] = useState<HotelSettings | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  // Local confirm field for the complimentary-report access code. Never
  // sent to the API — purely a client-side typo guard.
  const [confirmCode, setConfirmCode] = useState("");
  const [codeErr, setCodeErr] = useState<string | null>(null);

  useEffect(() => {
    if (data?.settings && !form)
      setForm({
        ...data.settings,
        // Default to on for rows created before this column existed, so the
        // toggle never renders in an undefined/indeterminate state.
        otpRequiredForCheckin: data.settings.otpRequiredForCheckin ?? true,
        hideComplimentary: data.settings.hideComplimentary ?? false,
      });
  }, [data, form]);

  const save = useMutation({
    mutationFn: (f: HotelSettings) => {
      const payload: Record<string, unknown> = {
        hotelName: f.hotelName,
        hotelAddress: f.hotelAddress,
        hotelLatitude: f.hotelLatitude && f.hotelLatitude.trim() !== "" ? f.hotelLatitude : null,
        hotelLongitude: f.hotelLongitude && f.hotelLongitude.trim() !== "" ? f.hotelLongitude : null,
        hotelPhone: f.hotelPhone,
        hotelGstin: f.hotelGstin,
        invoicePrefix: f.invoicePrefix,
        checkInTime: f.checkInTime,
        checkOutTime: f.checkOutTime,
        hotelEmail: f.hotelEmail && f.hotelEmail.trim() !== "" ? f.hotelEmail : null,
        ownerPhone: f.ownerPhone && f.ownerPhone.trim() !== "" ? f.ownerPhone : null,
        ownerNotifyEnabled: f.ownerNotifyEnabled,
        otpRequiredForCheckin: f.otpRequiredForCheckin,
        hideComplimentary: f.hideComplimentary,
        docTagline: f.docTagline ?? "",
        wifiSsid: f.wifiSsid && f.wifiSsid.trim() !== "" ? f.wifiSsid : null,
        wifiPassword: f.wifiPassword && f.wifiPassword.trim() !== "" ? f.wifiPassword : null,
        gstMode: f.gstMode,
      };
      // Reports access code (0024). API returns "" when a code is set
      // (so the value never reaches the client), and null when not set.
      // We only include the field in the PUT when staff has typed a
      // new value or explicitly cleared it — otherwise the server's
      // "v !== undefined" check would overwrite the stored value with
      // an empty string.
      if (typeof f.complimentaryUnlockCode === "string") {
        payload.complimentaryUnlockCode =
          f.complimentaryUnlockCode.trim() === ""
            ? null
            : f.complimentaryUnlockCode.trim();
      }
      for (const k of Object.keys(payload)) {
        // docTagline may legitimately be "" (hide the tagline line).
        if ((payload[k] === "" && k !== "docTagline") || payload[k] === undefined) {
          delete payload[k];
        }
      }
      return api.put<HotelSettings | null>("/settings", payload);
    },
    onSuccess: (saved) => {
      // Re-seed the form from what the SERVER actually stored.
      //
      // The hydrate effect below only runs while `form` is null, so after the
      // first load the on-screen values never re-synced. Combined with the
      // sanitiser above — which deletes every "" key so a required field is
      // not rejected — clearing a field appeared to succeed: the PUT never
      // mentioned it, the server kept the old value, and the box stayed blank.
      // An admin could "clear" the GSTIN and go on printing the old one on
      // every invoice with nothing on screen to contradict them.
      if (saved) {
        setForm({
          ...saved,
          otpRequiredForCheckin: saved.otpRequiredForCheckin ?? true,
          hideComplimentary: saved.hideComplimentary ?? false,
        });
      }
      qc.invalidateQueries({ queryKey: ["settings"] });
      // NewReservation and ReservationDetail read the public settings under a
      // separate key with a 5-min staleTime, so without this they'd keep the
      // old OTP policy (and other public settings) until a hard refresh.
      qc.invalidateQueries({ queryKey: ["settings-public"] });
      setMsg("Saved");
      setTimeout(() => setMsg(null), 2000);
    },
    onError: (e: Error) => setMsg(e.message),
  });

  const uploadLogo = useMutation({
    mutationFn: (file: File) => {
      const fd = new FormData();
      fd.append("logo", file);
      return api.upload<{ hotelLogoUrl: string }>("/settings/logo", fd);
    },
    onSuccess: (r) => {
      setForm((prev) => (prev ? { ...prev, hotelLogoUrl: r.hotelLogoUrl } : prev));
      qc.invalidateQueries({ queryKey: ["settings"] });
      qc.invalidateQueries({ queryKey: ["settings-public"] });
      setMsg("Logo updated");
      setTimeout(() => setMsg(null), 2000);
    },
    onError: (e: Error) => setMsg(e.message),
  });
  const removeLogo = useMutation({
    mutationFn: () => api.del("/settings/logo"),
    onSuccess: () => {
      setForm((prev) => (prev ? { ...prev, hotelLogoUrl: null } : prev));
      qc.invalidateQueries({ queryKey: ["settings"] });
      qc.invalidateQueries({ queryKey: ["settings-public"] });
      setMsg("Logo removed");
      setTimeout(() => setMsg(null), 2000);
    },
    onError: (e: Error) => setMsg(e.message),
  });
  const logoBusy = uploadLogo.isPending || removeLogo.isPending;

  if (!form) return <Loader />;

  const set = <K extends keyof HotelSettings>(k: K, v: HotelSettings[K]) =>
    setForm({ ...form, [k]: v });

  const lat = form.hotelLatitude?.trim() ?? "";
  const lng = form.hotelLongitude?.trim() ?? "";
  const hasPin = lat !== "" && lng !== "";
  const mapsHref = hasPin
    ? `https://www.google.com/maps?q=${encodeURIComponent(`${lat},${lng}`)}`
    : form.hotelAddress
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(form.hotelAddress)}`
    : "";

  function useMyLocation() {
    if (!("geolocation" in navigator)) {
      setMsg("Geolocation not supported in this browser");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setForm((prev) =>
          prev
            ? {
                ...prev,
                hotelLatitude: pos.coords.latitude.toFixed(6),
                hotelLongitude: pos.coords.longitude.toFixed(6),
              }
            : prev,
        );
        setMsg("Location captured");
        setTimeout(() => setMsg(null), 2000);
      },
      (err) => setMsg(`Couldn't get location: ${err.message}`),
      { enableHighAccuracy: true, timeout: 10000 },
    );
  }

  return (
    <div className="card space-y-3">
      <div className="flex items-center gap-4">
        <img
          src={form.hotelLogoUrl || "/logo.png"}
          alt="Hotel logo"
          className="w-16 h-16 rounded-md object-contain border border-borderc bg-bg p-1 shrink-0"
        />
        <div className="min-w-0">
          <div className="label">Hotel logo</div>
          <div className="text-[11px] text-textSecondary mt-0.5">
            Shown on receipts, invoices and the app header.
            {!form.hotelLogoUrl && " Currently using the Stayvia default."}
          </div>
          <div className="flex items-center gap-3 mt-1.5">
            <label className="text-xs font-semibold text-brand hover:underline cursor-pointer">
              {logoBusy ? "Uploading…" : form.hotelLogoUrl ? "Replace" : "Upload logo"}
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="hidden"
                disabled={logoBusy}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (f) uploadLogo.mutate(f);
                }}
              />
            </label>
            {form.hotelLogoUrl && (
              <button
                type="button"
                className="text-xs font-semibold text-danger hover:underline"
                disabled={logoBusy}
                onClick={() => removeLogo.mutate()}
              >
                Remove
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Hotel Name">
          <input className="input" value={form.hotelName} onChange={(e) => set("hotelName", e.target.value)} />
        </Field>
        <Field label="Phone">
          <input
            className="input"
            type="tel"
            inputMode="numeric"
            maxLength={10}
            value={form.hotelPhone ?? ""}
            onChange={(e) => set("hotelPhone", e.target.value.replace(/\D/g, "").slice(0, 10))}
            placeholder="9876543210"
          />
        </Field>
        <Field label="Email">
          <input className="input" value={form.hotelEmail ?? ""} onChange={(e) => set("hotelEmail", e.target.value)} />
        </Field>
        <Field label="GSTIN">
          <input
            className="input font-mono"
            value={form.hotelGstin ?? ""}
            onChange={(e) => set("hotelGstin", e.target.value.toUpperCase())}
          />
        </Field>
        <Field label="Invoice Prefix">
          <input
            className="input"
            value={form.invoicePrefix ?? "INV"}
            onChange={(e) => set("invoicePrefix", e.target.value)}
          />
        </Field>
        <Field label="Tagline (under hotel name on invoices & receipts)">
          <input
            className="input"
            maxLength={60}
            value={form.docTagline ?? ""}
            onChange={(e) => set("docTagline", e.target.value)}
            placeholder="Hospitality & Stays - leave empty to hide"
          />
        </Field>
        <Field label="GST Pricing Mode">
          <select
            className="input"
            value={form.gstMode ?? "inclusive"}
            onChange={(e) => set("gstMode", e.target.value as "exclusive" | "inclusive")}
          >
            <option value="inclusive">Inclusive - rate already contains GST</option>
            <option value="exclusive">Exclusive - GST is added on top of rate</option>
          </select>
          <div className="text-[11px] text-textSecondary mt-1 leading-snug">
            {form.gstMode === "inclusive" ? (
              <>
                Staff types <span className="font-mono">₹1000</span>, the guest pays{" "}
                <span className="font-mono">₹1000</span>. GST = 5% of ₹1000 =
                <span className="font-mono"> ₹50</span> (CGST{" "}
                <span className="font-mono">₹25</span> + SGST{" "}
                <span className="font-mono">₹25</span>); net room =
                <span className="font-mono"> ₹950</span>.
              </>
            ) : (
              <>
                Staff types <span className="font-mono">₹1000</span>, the guest pays{" "}
                <span className="font-mono">₹1050</span> (₹1000 + 5% GST).
              </>
            )}
            <br />
            <span className="text-textSecondary/80">
              Changing this only affects new bookings; existing reservations
              keep their original math.
            </span>
          </div>
        </Field>
        <Field label="Default Check-in">
          <TimePicker12h
            value={form.checkInTime ?? "12:00"}
            onChange={(v) => set("checkInTime", v)}
          />
        </Field>
        <Field label="Default Check-out">
          <TimePicker12h
            value={form.checkOutTime ?? "11:00"}
            onChange={(v) => set("checkOutTime", v)}
          />
        </Field>
      </div>

      <Field label="Address">
        <input className="input" value={form.hotelAddress ?? ""} onChange={(e) => set("hotelAddress", e.target.value)} />
      </Field>

      <div className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_auto_auto] gap-3 items-end">
        <Field label="Latitude">
          <input
            className="input font-mono"
            inputMode="decimal"
            value={form.hotelLatitude ?? ""}
            onChange={(e) => set("hotelLatitude", e.target.value)}
            placeholder="17.687320"
          />
        </Field>
        <Field label="Longitude">
          <input
            className="input font-mono"
            inputMode="decimal"
            value={form.hotelLongitude ?? ""}
            onChange={(e) => set("hotelLongitude", e.target.value)}
            placeholder="83.123900"
          />
        </Field>
        <button
          type="button"
          onClick={useMyLocation}
          className="px-3 py-2 text-sm border border-borderc rounded-sm bg-surface hover:bg-bg inline-flex items-center gap-1.5 whitespace-nowrap"
          title="Capture from this device"
        >
          <MapPin className="w-4 h-4 text-brand-dark" />
          Use my location
        </button>
        <a
          href={mapsHref || "#"}
          target="_blank"
          rel="noopener noreferrer"
          aria-disabled={!mapsHref}
          className={`px-3 py-2 text-sm border rounded-sm inline-flex items-center gap-1.5 whitespace-nowrap ${
            mapsHref
              ? "border-brand-dark bg-brand-dark text-cream hover:opacity-90"
              : "border-borderc bg-bg text-textSecondary pointer-events-none opacity-60"
          }`}
          title={hasPin ? "Open pin in Google Maps" : "Open address in Google Maps"}
        >
          <MapPin className="w-4 h-4" />
          {hasPin ? "View pin" : "Find on Maps"}
        </a>
      </div>
      <p className="text-[11px] text-textSecondary -mt-1">
        Tip: open Google Maps, long-press the property, copy the coordinates that appear, then
        paste here. Or click <em>Use my location</em> while standing at the hotel.
      </p>

      <div className="border-t border-borderc pt-4 mt-2 space-y-3">
        <h3 className="font-semibold text-brand-dark">Owner Notifications</h3>
        <p className="text-xs text-textSecondary -mt-2">
          Owner gets an SMS on every new booking, check-in and check-out.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Owner Phone (with country code)">
            <input
              className="input"
              placeholder="+91 90000 00000"
              value={form.ownerPhone ?? ""}
              onChange={(e) => set("ownerPhone", e.target.value)}
            />
          </Field>
          <Field label="Send owner alerts">
            <div className="flex items-center justify-between px-3 py-2.5 border border-borderc rounded-sm bg-surface select-none">
              <span className="text-sm font-medium text-textPrimary">
                Owner alerts
                <span className="ml-2 text-xs font-normal text-textSecondary">
                  {form.ownerNotifyEnabled ? "On" : "Off"}
                </span>
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={form.ownerNotifyEnabled}
                aria-label="Send owner alerts"
                onClick={() => set("ownerNotifyEnabled", !form.ownerNotifyEnabled)}
                className={`relative shrink-0 h-6 w-11 rounded-full transition-colors ${
                  form.ownerNotifyEnabled ? "bg-brand" : "bg-borderc"
                }`}
              >
                <span
                  className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${
                    form.ownerNotifyEnabled ? "translate-x-5" : "translate-x-0"
                  }`}
                />
              </button>
            </div>
          </Field>
        </div>
      </div>

      <div className="border-t border-borderc pt-4 mt-2 space-y-3">
        <h3 className="font-semibold text-brand-dark">Guest Check-in</h3>
        <p className="text-xs text-textSecondary -mt-2">
          When OTP verification is on, every new booking sends a code to the
          guest that must be entered before check-in is completed. Turn it off
          if guests can't reliably receive a code - bookings will be created
          without OTP.
        </p>
        <div className="flex items-center justify-between px-3 py-2.5 border border-borderc rounded-sm bg-surface select-none">
          <span className="text-sm font-medium text-textPrimary">
            Require OTP verification
            <span className="ml-2 text-xs font-normal text-textSecondary">
              {form.otpRequiredForCheckin ? "On" : "Off"}
            </span>
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={form.otpRequiredForCheckin}
            aria-label="Require OTP verification"
            onClick={() => set("otpRequiredForCheckin", !form.otpRequiredForCheckin)}
            className={`relative shrink-0 h-6 w-11 rounded-full transition-colors ${
              form.otpRequiredForCheckin ? "bg-brand" : "bg-borderc"
            }`}
          >
            <span
              className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${
                form.otpRequiredForCheckin ? "translate-x-5" : "translate-x-0"
              }`}
            />
          </button>
        </div>
      </div>

      <div className="border-t border-borderc pt-4 mt-2 space-y-3">
        <h3 className="font-semibold text-brand-dark">Complimentary Bookings</h3>
        <p className="text-xs text-textSecondary -mt-2">
          On = the discreet complimentary flow is active: comp bookings stay
          out of the calendar, reservations list, activity, invoices and
          dashboard alerts - visible only in the code-gated Complimentary
          report. Off = the complimentary feature is put away entirely: the
          Make Complimentary button, booking source and report disappear, and
          any existing comp bookings show like normal ones. Their money is
          never counted as revenue either way.
        </p>
        <div className="flex items-center justify-between px-3 py-2.5 border border-borderc rounded-sm bg-surface select-none">
          <span className="text-sm font-medium text-textPrimary">
            Hide complimentary bookings
            <span className="ml-2 text-xs font-normal text-textSecondary">
              {form.hideComplimentary ? "On" : "Off"}
            </span>
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={form.hideComplimentary}
            aria-label="Hide complimentary bookings"
            onClick={() => set("hideComplimentary", !form.hideComplimentary)}
            className={`relative shrink-0 h-6 w-11 rounded-full transition-colors ${
              form.hideComplimentary ? "bg-brand" : "bg-borderc"
            }`}
          >
            <span
              className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${
                form.hideComplimentary ? "translate-x-5" : "translate-x-0"
              }`}
            />
          </button>
        </div>

        {/* Soft access gate for the Complimentary report (0024). Admins can
            set or clear it; the API never returns the actual value back, so
            a clearable masked field is the right pattern. */}
        <p className="text-xs text-textSecondary">
          Report access code: staff must type it before the Complimentary
          report opens. Required while hiding is on.
          {form.hasComplimentaryUnlockCode ? (
            <span className="ml-1 text-success font-semibold">
              · Code is set
            </span>
          ) : (
            <span className="ml-1 text-textSecondary">· No code set</span>
          )}
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-end">
          <Field
            label={
              form.hasComplimentaryUnlockCode
                ? "Change code (leave blank to keep current)"
                : "Set code"
            }
          >
            <input
              className="input font-mono"
              type="password"
              autoComplete="new-password"
              placeholder={
                form.hasComplimentaryUnlockCode ? "••••••••" : "min 4 characters"
              }
              value={form.complimentaryUnlockCode ?? ""}
              onChange={(e) => {
                set("complimentaryUnlockCode", e.target.value);
                setCodeErr(null);
              }}
            />
          </Field>
          <Field label="Confirm code">
            <input
              className="input font-mono"
              type="password"
              autoComplete="new-password"
              placeholder="Re-enter code"
              value={confirmCode}
              onChange={(e) => {
                setConfirmCode(e.target.value);
                setCodeErr(null);
              }}
            />
          </Field>
        </div>
        {codeErr && <p className="text-danger text-xs">{codeErr}</p>}
      </div>

      <div className="border-t border-borderc pt-4 mt-2 space-y-3">
        <h3 className="font-semibold text-brand-dark">Guest Wi-Fi</h3>
        <p className="text-xs text-textSecondary -mt-2">
          Shown in the check-in WhatsApp message so guests don't have to ask the front desk.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Network name (SSID)">
            <input
              className="input"
              placeholder="Hotel_Guest"
              value={form.wifiSsid ?? ""}
              onChange={(e) => set("wifiSsid", e.target.value)}
            />
          </Field>
          <Field label="Password">
            <input
              className="input"
              placeholder="access-code"
              value={form.wifiPassword ?? ""}
              onChange={(e) => set("wifiPassword", e.target.value)}
            />
          </Field>
        </div>
      </div>

      <div className="flex justify-end gap-2 items-center">
        {msg && <span className="text-xs text-success">{msg}</span>}
        <button
          className="btn-primary"
          onClick={() => {
            // Typo guard: a newly typed access code must be confirmed
            // before it's saved. Leaving the field untouched needs no
            // confirmation.
            const typed = form.complimentaryUnlockCode ?? "";
            if (typed.trim() !== "" && typed !== confirmCode) {
              setCodeErr("Access codes do not match. Re-enter the confirm code.");
              return;
            }
            // Hiding complimentary bookings requires an access code —
            // the server enforces the same rule.
            const willHaveCode =
              form.hasComplimentaryUnlockCode || typed.trim() !== "";
            if (form.hideComplimentary && !willHaveCode) {
              setCodeErr(
                "Hiding complimentary bookings requires a report access code. Set one below first.",
              );
              return;
            }
            setCodeErr(null);
            save.mutate(form);
          }}
          disabled={save.isPending}
        >
          {save.isPending ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="label block mb-1">{label}</label>
      {children}
    </div>
  );
}
