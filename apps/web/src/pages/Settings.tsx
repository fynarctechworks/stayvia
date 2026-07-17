import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  Copy,
  Eye,
  EyeOff,
  MapPin,
  Pencil,
  Plus,
  ShieldCheck,
  Smartphone,
  Trash2,
  UserPlus,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@/auth/AuthContext";
import { useDialog } from "@/components/Dialog";
import { TimePicker12h } from "@/components/TimePicker12h";
import { Loader } from "@/components/Loader";
import { useToast } from "@/components/Toast";
import { api } from "@/lib/api";
import { invalidateRoomData } from "@/lib/invalidate";
import { isOfflineMode } from "@/lib/offlineMode";
import { supabase } from "@/lib/supabase";
import { inr } from "@/lib/utils";

type Tab = "my-profile" | "hotel" | "room-types" | "staff" | "roles";

export default function Settings() {
  const tabs = useMemo<{ id: Tab; label: string }[]>(
    () => [
      { id: "my-profile", label: "My Profile" },
      { id: "hotel", label: "Hotel Profile" },
      { id: "room-types", label: "Room Types" },
      { id: "staff", label: "Staff" },
      { id: "roles", label: "Roles & Permissions" },
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
      {tab === "room-types" && <RoomTypesTab />}
      {tab === "staff" && <StaffTab />}
      {tab === "roles" && <RolesTab />}
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

  useEffect(() => {
    if (!me) return;
    setForm({ fullName: me.fullName, email: me.email, phone: me.phone ?? "" });
  }, [me]);

  const save = useMutation({
    mutationFn: async () => {
      const patch: Record<string, unknown> = {};
      if (me && form.fullName !== me.fullName) patch.fullName = form.fullName;
      if (me && form.email !== me.email) patch.email = form.email;
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
      toast("Profile updated", "success");
    },
    onError: (e: Error) => setErr(e.message),
  });

  if (isLoading || !me) return <Loader />;

  return (
    <div className="space-y-4 max-w-2xl">
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

        {err && (
          <div className="rounded-sm border border-danger/30 bg-danger/5 px-3 py-2 text-danger text-sm">
            {err}
          </div>
        )}

        <div className="flex justify-end">
          <button
            className="btn-primary"
            onClick={() => save.mutate()}
            disabled={save.isPending}
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

  // Offline desk: the verification code is shown ON SCREEN (the server
  // returns it as devCode — WhatsApp can't deliver synchronously without
  // internet), so no phone number is required.
  const hasPhone = isOfflineMode() || !!phone?.trim();

  return (
    <div className="card space-y-4">
      <div>
        <h3 className="font-semibold text-brand-dark text-lg">Change Password</h3>
        <p className="text-xs text-textSecondary mt-1">
          {isOfflineMode()
            ? "Verify your current password, then enter the code shown on screen."
            : "Verify your current password, then enter the OTP we send to your WhatsApp number."}
        </p>
      </div>

      {!hasPhone && (
        <div className="rounded-sm border border-warning/40 bg-warning/10 px-3 py-2 text-warning text-sm">
          You don't have a phone number on file. Add one above and save before changing your
          password — the OTP is delivered via WhatsApp.
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
              {sendOtp.isPending
                ? "Verifying…"
                : isOfflineMode()
                  ? "Verify & show code"
                  : "Send OTP on WhatsApp"}
            </button>
          </div>
        </>
      )}

      {step === 2 && (
        <>
          <div className="rounded-sm bg-brand-soft/40 border border-borderc px-3 py-2 text-sm">
            {isOfflineMode() ? (
              <>Enter the code below to confirm the change.</>
            ) : (
              <>
                OTP sent to <span className="font-mono">{maskedTarget}</span> via WhatsApp.
              </>
            )}
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
// Desktop app: TOTP is a cloud-account feature (Supabase). The desk uses
// local PIN auth on a physically-secured machine, so instead of rendering a
// card whose every action fails, explain and bail. Split into a wrapper so
// the online component's hooks never run conditionally.
function TwoFactorCard() {
  if (!isOfflineMode()) return <TwoFactorCardOnline />;
  return (
    <div className="card p-5">
      <div className="font-semibold mb-1">Two-Factor Authentication</div>
      <p className="text-sm text-textSecondary">
        Two-factor sign-in applies to the online (cloud) version. The desk app
        uses PIN sign-in on this machine — protect it with a Windows password
        and keep the desk physically secure.
      </p>
    </div>
  );
}

function TwoFactorCardOnline() {
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

          {err && (
            <div className="rounded-sm border border-danger/30 bg-danger/5 px-3 py-2 text-danger text-sm">
              {err}
            </div>
          )}

          <div className="flex justify-end">
            <button
              className="btn-primary"
              onClick={() => startEnroll.mutate()}
              disabled={startEnroll.isPending}
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
  wifiSsid: string | null;
  wifiPassword: string | null;
  // Property-wide GST pricing mode. 'inclusive' = rate the staff types
  // already contains GST; 'exclusive' = GST is added on top. Only
  // affects NEW bookings; existing reservations keep their own snapshot.
  gstMode: "exclusive" | "inclusive";
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

  useEffect(() => {
    if (data?.settings && !form)
      setForm({
        ...data.settings,
        // Default to on for rows created before this column existed, so the
        // toggle never renders in an undefined/indeterminate state.
        otpRequiredForCheckin: data.settings.otpRequiredForCheckin ?? true,
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
        if (payload[k] === "" || payload[k] === undefined) delete payload[k];
      }
      return api.put("/settings", payload);
    },
    onSuccess: () => {
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
        <Field label="GST Pricing Mode">
          <select
            className="input"
            value={form.gstMode ?? "inclusive"}
            onChange={(e) => set("gstMode", e.target.value as "exclusive" | "inclusive")}
          >
            <option value="inclusive">Inclusive — rate already contains GST</option>
            <option value="exclusive">Exclusive — GST is added on top of rate</option>
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
            <label className="flex items-center gap-2 px-3 py-2 border border-borderc rounded-sm bg-surface cursor-pointer hover:bg-bg select-none">
              <input
                type="checkbox"
                checked={form.ownerNotifyEnabled}
                onChange={(e) => set("ownerNotifyEnabled", e.target.checked)}
                className="w-4 h-4 accent-brand"
              />
              <span className="text-sm">Enabled</span>
            </label>
          </Field>
        </div>
      </div>

      <div className="border-t border-borderc pt-4 mt-2 space-y-3">
        <h3 className="font-semibold text-brand-dark">Guest Check-in</h3>
        <p className="text-xs text-textSecondary -mt-2">
          When OTP verification is on, every new booking sends a code to the
          guest that must be entered before check-in is completed. Turn it off
          if guests can't reliably receive a code — bookings will be created
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
              placeholder="sldt2026"
              value={form.wifiPassword ?? ""}
              onChange={(e) => set("wifiPassword", e.target.value)}
            />
          </Field>
        </div>
      </div>

      {/* Soft access gate for a sensitive report (0024). Generic label
          on purpose — "Reports access code" doesn't reveal which
          specific report it gates. Admins can set or clear it; the
          API never returns the actual value back so a clearable
          masked field is the right pattern. */}
      <div className="border-t border-borderc pt-4 mt-2 space-y-3">
        <h3 className="font-semibold text-brand-dark">Reports access code</h3>
        <p className="text-xs text-textSecondary -mt-2">
          Front-desk staff must type this code before they can open
          certain sensitive reports. Leave blank to disable the gate.
          {form.hasComplimentaryUnlockCode ? (
            <span className="ml-1 text-success font-semibold">
              · Code is set
            </span>
          ) : (
            <span className="ml-1 text-textSecondary">· No code set</span>
          )}
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-3 items-end">
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
              onChange={(e) => set("complimentaryUnlockCode", e.target.value)}
            />
          </Field>
          {form.hasComplimentaryUnlockCode && (
            <button
              type="button"
              className="btn-secondary"
              onClick={() => {
                // Send an explicit null to clear the gate on save.
                set("complimentaryUnlockCode", "");
              }}
            >
              Clear on save
            </button>
          )}
        </div>
      </div>

      <div className="flex justify-end gap-2 items-center">
        {msg && <span className="text-xs text-success">{msg}</span>}
        <button className="btn-primary" onClick={() => save.mutate(form)} disabled={save.isPending}>
          {save.isPending ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}

interface ShortStayBand {
  label: string;
  hours: number;
  rate: number;
}

interface RoomTypeRow {
  id: string;
  slug: string;
  label: string;
  defaultRate: string;
  maxOccupancy: string;
  // Per-night charge for each extra person (extra bed) over a room's base
  // occupancy. "0" means extra beds aren't offered for this type.
  extraPersonRate: string;
  description: string | null;
  isActive: boolean;
  // Day-use price bands shown on the reservation form when stay_type is
  // 'short_stay'. Empty array when the property hasn't configured any
  // (the booking form then pro-rates the overnight default rate).
  shortStayBands?: ShortStayBand[];
}

function RoomTypesTab() {
  const qc = useQueryClient();
  const dialog = useDialog();
  const { data: types = [] } = useQuery({
    queryKey: ["room-types", true],
    queryFn: () => api.get<RoomTypeRow[]>("/settings/room-types", { all: "true" }),
  });

  const [editing, setEditing] = useState<RoomTypeRow | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  // Delete a room type. The API hard-deletes if no rooms reference
  // the slug, and returns 409 IN_USE with a room count otherwise.
  // On IN_USE we prompt the user to force-delete (which nulls the
  // type on every dependent room) — only proceeding if they confirm.
  const del = useMutation({
    mutationFn: async (args: { id: string; force?: boolean }) => {
      const path = `/settings/room-types/${args.id}${args.force ? "?force=true" : ""}`;
      return api.del(path);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["room-types"] }),
  });

  // Restore (un-archive) a previously archived type. Same PUT endpoint
  // the edit form uses, just flipping is_active back to true.
  const restore = useMutation({
    mutationFn: (t: RoomTypeRow) =>
      api.put(`/settings/room-types/${t.id}`, {
        label: t.label,
        slug: t.slug,
        defaultRate: Number(t.defaultRate),
        maxOccupancy: t.maxOccupancy,
        extraPersonRate: Number(t.extraPersonRate),
        description: t.description ?? null,
        isActive: true,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["room-types"] });
      qc.invalidateQueries({ queryKey: ["room-types-active"] });
      invalidateRoomData(qc);
    },
  });

  async function handleDelete(t: RoomTypeRow) {
    const confirmed = await dialog.confirm({
      title: `Delete "${t.label}"?`,
      message:
        "This permanently removes the room type. Use Archive instead if you want existing rooms to keep the label.",
      okLabel: "Delete",
      tone: "danger",
    });
    if (!confirmed) return;
    try {
      await del.mutateAsync({ id: t.id });
    } catch (e) {
      // API returns 409 IN_USE when rooms still reference this slug.
      // ApiError carries .code + .details; the helper api client throws
      // an Error with .message containing the API's message string.
      const msg = e instanceof Error ? e.message : String(e);
      const looksInUse = /still use|in use|IN_USE/i.test(msg);
      if (!looksInUse) {
        await dialog.alert({ title: "Couldn't delete", message: msg });
        return;
      }
      const force = await dialog.confirm({
        title: `Force-delete "${t.label}"?`,
        message: `${msg}\n\nForce delete will detach those rooms (their type becomes empty until you edit them).`,
        okLabel: "Force delete",
        tone: "danger",
      });
      if (force) {
        try {
          await del.mutateAsync({ id: t.id, force: true });
        } catch (e2) {
          await dialog.alert({
            title: "Force delete failed",
            message: e2 instanceof Error ? e2.message : String(e2),
          });
        }
      }
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <div className="text-sm text-textSecondary">
          Room types drive every Type dropdown across the app. Archived types remain on existing rooms but are hidden from new-room forms.
        </div>
        <button className="btn-primary inline-flex items-center gap-2" onClick={() => setShowAdd(true)}>
          <Plus className="w-4 h-4" /> Add Room Type
        </button>
      </div>

      <div className="card p-0 overflow-x-auto">
        <table className="table-base table-fixed">
          <colgroup>
            <col className="w-[24%]" />
            <col className="w-[18%]" />
            <col className="w-[13%]" />
            <col className="w-[9%]" />
            <col className="w-[13%]" />
            <col className="w-[11%]" />
            <col className="w-[12%]" />
          </colgroup>
          <thead>
            <tr>
              <th>Label</th>
              <th>Slug</th>
              <th className="!text-right">Default Rate</th>
              <th className="!text-right">Max Occ.</th>
              <th className="!text-right">Extra Bed/Night</th>
              <th>Status</th>
              <th className="!text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {types.length === 0 && (
              <tr>
                <td colSpan={7} className="p-4 text-textSecondary text-center">
                  No room types yet. Add one to start creating rooms.
                </td>
              </tr>
            )}
            {types.map((t) => (
              <tr key={t.id} className={t.isActive ? "" : "opacity-60"}>
                <td className="font-medium text-navy">{t.label}</td>
                <td className="font-mono text-xs text-textSecondary">{t.slug}</td>
                <td className="text-right font-mono tabular-nums">{inr(t.defaultRate)}</td>
                <td className="text-right tabular-nums">{t.maxOccupancy}</td>
                <td className="text-right font-mono tabular-nums">
                  {Number(t.extraPersonRate) > 0 ? inr(t.extraPersonRate) : "—"}
                </td>
                <td>
                  <span
                    className={`inline-block px-2 py-0.5 rounded-sm text-xs font-medium ${
                      t.isActive
                        ? "bg-success/15 text-success"
                        : "bg-gray-200 text-textSecondary"
                    }`}
                  >
                    {t.isActive ? "Active" : "Archived"}
                  </span>
                </td>
                <td>
                  <div className="flex items-center justify-end gap-3">
                    <button
                      className="text-accentBlue text-xs hover:underline"
                      onClick={() => setEditing(t)}
                    >
                      Edit
                    </button>
                    {!t.isActive && (
                      <button
                        className="text-success text-xs hover:underline"
                        onClick={() => restore.mutate(t)}
                        disabled={restore.isPending}
                        title="Make this room type active again"
                      >
                        Restore
                      </button>
                    )}
                    <button
                      className="text-danger text-xs hover:underline inline-flex items-center gap-1"
                      onClick={() => handleDelete(t)}
                      disabled={del.isPending}
                    >
                      <Trash2 className="w-3 h-3" /> Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {(showAdd || editing) && (
        <RoomTypeModal
          row={editing}
          onClose={() => {
            setShowAdd(false);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function slugify(s: string) {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function RoomTypeModal({ row, onClose }: { row: RoomTypeRow | null; onClose: () => void }) {
  const qc = useQueryClient();
  const isEdit = !!row;
  const [form, setForm] = useState({
    slug: row?.slug ?? "",
    label: row?.label ?? "",
    defaultRate: row ? Number(row.defaultRate) : 1200,
    maxOccupancy: row ? Number(row.maxOccupancy) : 2,
    extraPersonRate: row ? Number(row.extraPersonRate) : 0,
    description: row?.description ?? "",
    isActive: row?.isActive ?? true,
    shortStayBands: (row?.shortStayBands ?? []) as ShortStayBand[],
  });
  const [slugDirty, setSlugDirty] = useState(isEdit);
  const [err, setErr] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () => {
      const body = {
        slug: form.slug,
        label: form.label,
        defaultRate: form.defaultRate,
        maxOccupancy: form.maxOccupancy,
        extraPersonRate: form.extraPersonRate,
        description: form.description || null,
        isActive: form.isActive,
        // Filter out blank/zero rows so an empty trailing input doesn't
        // get persisted as a useless band. The server clamps hours and
        // rates again with Zod.
        shortStayBands: form.shortStayBands.filter(
          (b) => b.label.trim() && b.hours > 0 && b.rate >= 0,
        ),
      };
      return isEdit
        ? api.put(`/settings/room-types/${row!.id}`, body)
        : api.post("/settings/room-types", body);
    },
    onSuccess: () => {
      // A default-rate change cascades to rooms of this type on the server,
      // so refresh every reader of a room rate — not just the type list.
      qc.invalidateQueries({ queryKey: ["room-types"] });
      qc.invalidateQueries({ queryKey: ["room-types-active"] });
      invalidateRoomData(qc);
      onClose();
    },
    onError: (e: Error) => setErr(e.message),
  });

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        className="bg-surface rounded-md w-full max-w-md p-6 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold text-navy">
          {isEdit ? `Edit ${row!.label}` : "Add Room Type"}
        </h2>
        <Field label="Label (shown to staff)">
          <input
            className="input"
            value={form.label}
            onChange={(e) => {
              const label = e.target.value;
              setForm({
                ...form,
                label,
                slug: slugDirty ? form.slug : slugify(label),
              });
            }}
            placeholder="e.g. Penthouse Suite"
          />
        </Field>
        <Field label="Slug (internal ID, lowercase, _ allowed)">
          <input
            className="input font-mono"
            value={form.slug}
            onChange={(e) => {
              setSlugDirty(true);
              setForm({ ...form, slug: slugify(e.target.value) });
            }}
            placeholder="penthouse_suite"
          />
          {isEdit && form.slug !== row!.slug && (
            <div className="text-xs text-warning mt-1">
              Renaming the slug will update every room and reservation referencing "{row!.slug}".
            </div>
          )}
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Default Rate (₹)">
            <input
              className="input"
              type="number"
              value={form.defaultRate === 0 ? "" : form.defaultRate}
              onChange={(e) => {
                const v = e.target.value;
                setForm({ ...form, defaultRate: v === "" ? 0 : Number(v) });
              }}
            />
          </Field>
          <Field label="Max Occupancy">
            <input
              className="input"
              type="number"
              value={form.maxOccupancy === 0 ? "" : form.maxOccupancy}
              onChange={(e) => {
                const v = e.target.value;
                setForm({ ...form, maxOccupancy: v === "" ? 0 : Number(v) });
              }}
            />
          </Field>
        </div>
        <Field label="Extra Person Rate (₹ / person / night)">
          <input
            className="input"
            type="number"
            min={0}
            value={form.extraPersonRate === 0 ? "" : form.extraPersonRate}
            placeholder="0"
            onChange={(e) => {
              const v = e.target.value;
              setForm({ ...form, extraPersonRate: v === "" ? 0 : Math.max(0, Number(v)) });
            }}
          />
          <div className="text-xs text-textSecondary mt-1">
            Per-night charge for each extra bed beyond Max Occupancy. Leave 0 to
            disable extra beds for this room type.
          </div>
        </Field>
        <Field label="Description (optional)">
          <input
            className="input"
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
          />
        </Field>
        <label className="inline-flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.isActive}
            onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
          />
          Active (available in new-room forms)
        </label>

        <div className="pt-3 border-t border-borderc/40">
          <div className="flex items-center justify-between mb-2">
            <div>
              <div className="text-sm font-semibold text-navy">Day-use price bands</div>
              <div className="text-[11px] text-textSecondary">
                Hourly tiers shown when staff picks "Day use" on a booking. Leave
                empty to pro-rate from the nightly default rate.
              </div>
            </div>
            <button
              type="button"
              className="text-xs text-accentBlue hover:underline"
              onClick={() =>
                setForm({
                  ...form,
                  shortStayBands: [
                    ...form.shortStayBands,
                    { label: "", hours: 0, rate: 0 },
                  ],
                })
              }
            >
              + Add band
            </button>
          </div>
          {form.shortStayBands.length > 0 && (
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-textSecondary">
                  <th className="py-1 font-medium">Label</th>
                  <th className="py-1 font-medium w-20">Hours</th>
                  <th className="py-1 font-medium w-24">Rate (₹)</th>
                  <th className="w-8"></th>
                </tr>
              </thead>
              <tbody>
                {form.shortStayBands.map((b, i) => (
                  <tr key={i}>
                    <td className="py-1 pr-1">
                      <input
                        className="input !h-8 text-xs"
                        value={b.label}
                        placeholder="e.g. 6 hrs"
                        onChange={(e) => {
                          const next = [...form.shortStayBands];
                          next[i] = { ...next[i]!, label: e.target.value };
                          setForm({ ...form, shortStayBands: next });
                        }}
                      />
                    </td>
                    <td className="py-1 pr-1">
                      <input
                        className="input !h-8 text-xs"
                        type="number"
                        min={1}
                        max={23.5}
                        step={0.5}
                        value={b.hours || ""}
                        onChange={(e) => {
                          const next = [...form.shortStayBands];
                          next[i] = { ...next[i]!, hours: Number(e.target.value) };
                          setForm({ ...form, shortStayBands: next });
                        }}
                      />
                    </td>
                    <td className="py-1 pr-1">
                      <input
                        className="input !h-8 text-xs"
                        type="number"
                        min={0}
                        value={b.rate || ""}
                        onChange={(e) => {
                          const next = [...form.shortStayBands];
                          next[i] = { ...next[i]!, rate: Number(e.target.value) };
                          setForm({ ...form, shortStayBands: next });
                        }}
                      />
                    </td>
                    <td className="py-1 text-right">
                      <button
                        type="button"
                        className="text-danger text-xs hover:underline"
                        onClick={() =>
                          setForm({
                            ...form,
                            shortStayBands: form.shortStayBands.filter((_, j) => j !== i),
                          })
                        }
                      >
                        ×
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {err && <div className="text-danger text-sm">{err}</div>}
        <div className="flex justify-end gap-2 pt-2">
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button
            className="btn-primary"
            onClick={() => save.mutate()}
            disabled={save.isPending || !form.label || !form.slug || form.defaultRate <= 0}
          >
            {save.isPending ? "Saving…" : isEdit ? "Save" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}

interface Staff {
  id: string;
  fullName: string;
  email: string;
  role: "admin" | "frontdesk" | "housekeeping";
  phone: string | null;
  isActive: boolean;
}

function StaffTab() {
  const qc = useQueryClient();
  const dialog = useDialog();
  const { toast } = useToast();
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState<Staff | null>(null);
  const { data = [] } = useQuery({
    queryKey: ["staff"],
    queryFn: () => api.get<Staff[]>("/staff"),
  });

  const deactivate = useMutation({
    mutationFn: (id: string) => api.del(`/staff/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["staff"] }),
  });
  const reactivate = useMutation({
    mutationFn: (id: string) => api.put(`/staff/${id}`, { isActive: true }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["staff"] }),
  });
  const hardDelete = useMutation({
    mutationFn: (id: string) => api.del(`/staff/${id}/hard`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["staff"] }),
    onError: (e: Error) => toast(e.message, "error"),
  });

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <button className="btn-primary inline-flex items-center gap-2" onClick={() => setShowAdd(true)}>
          <UserPlus className="w-4 h-4" /> Add Staff
        </button>
      </div>
      <div className="card p-0">
        <table className="table-base">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Role</th>
              <th>Phone</th>
              <th>Status</th>
              <th className="text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {data.map((s) => (
              <tr key={s.id} className={s.isActive ? "" : "opacity-60"}>
                <td>{s.fullName}</td>
                <td>{s.email}</td>
                <td className="capitalize">{s.role}</td>
                <td>{s.phone ?? "-"}</td>
                <td>{s.isActive ? "Active" : "Deactivated"}</td>
                <td className="text-right">
                  <div className="inline-flex items-center gap-3">
                    <button
                      className="text-brand hover:underline text-xs inline-flex items-center gap-1"
                      onClick={() => setEditing(s)}
                    >
                      <Pencil className="w-3 h-3" /> Edit
                    </button>
                    {s.isActive && (
                      <button
                        className="text-warning hover:underline text-xs inline-flex items-center gap-1"
                        onClick={async () => {
                          const ok = await dialog.confirm({
                            title: `Deactivate ${s.fullName}?`,
                            message: "They will lose access but their history is kept.",
                            okLabel: "Deactivate",
                            tone: "warning",
                          });
                          if (ok) deactivate.mutate(s.id);
                        }}
                      >
                        Deactivate
                      </button>
                    )}
                    {!s.isActive && (
                      <button
                        className="text-success hover:underline text-xs"
                        onClick={() => reactivate.mutate(s.id)}
                      >
                        Reactivate
                      </button>
                    )}
                    <button
                      className="text-danger hover:underline text-xs inline-flex items-center gap-1"
                      onClick={async () => {
                        const ans = await dialog.prompt({
                          title: `Permanently delete ${s.fullName}?`,
                          message:
                            "This removes them from auth and the database. Only works if they have no reservations, invoices, payments, or activity. Type DELETE to confirm.",
                          placeholder: "Type DELETE",
                          okLabel: "Delete forever",
                          tone: "danger",
                          required: true,
                        });
                        if (ans === "DELETE") hardDelete.mutate(s.id);
                      }}
                    >
                      <Trash2 className="w-3 h-3" /> Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {showAdd && <AddStaffModal onClose={() => setShowAdd(false)} />}
      {editing && <EditStaffModal staff={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function EditStaffModal({ staff, onClose }: { staff: Staff; onClose: () => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    fullName: staff.fullName,
    email: staff.email,
    phone: staff.phone ?? "",
  });
  const [newPassword, setNewPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  // Reveal-once: after a reset, show the new password one time so it can be
  // handed to the staff member. Never retrievable afterwards (hashed).
  const [resetShown, setResetShown] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const { data: rbacRoles } = useQuery({
    queryKey: ["rbac-roles"],
    queryFn: () => api.get<RbacRole[]>("/rbac/roles"),
  });
  const { data: catalog } = useQuery({
    queryKey: ["rbac-catalog"],
    queryFn: () => api.get<PermissionDef[]>("/rbac/permissions"),
  });
  const { data: effective } = useQuery({
    queryKey: ["rbac-effective", staff.id],
    queryFn: () =>
      api.get<{ roleKey: string | null; isGodMode: boolean; permissions: string[] }>(
        `/rbac/users/${staff.id}/effective`,
      ),
  });
  const { data: existingOverrides } = useQuery({
    queryKey: ["rbac-overrides", staff.id],
    queryFn: () =>
      api.get<{ permissionKey: string; effect: "grant" | "deny" }[]>(
        `/rbac/users/${staff.id}/overrides`,
      ),
  });

  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null);
  const [overrides, setOverrides] = useState<Record<string, "grant" | "deny">>({});
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Initialise selectedRoleId once rbacRoles + effective have loaded
  useEffect(() => {
    if (selectedRoleId || !rbacRoles || !effective) return;
    const cur = rbacRoles.find((r) => r.key === effective.roleKey);
    setSelectedRoleId(cur?.id ?? null);
  }, [rbacRoles, effective, selectedRoleId]);

  // Initialise overrides from server once
  useEffect(() => {
    if (!existingOverrides) return;
    const map: Record<string, "grant" | "deny"> = {};
    for (const o of existingOverrides) map[o.permissionKey] = o.effect;
    setOverrides(map);
  }, [existingOverrides]);

  const save = useMutation({
    mutationFn: async () => {
      // 1. Profile patch (name/email/phone/password)
      const patch: Record<string, unknown> = {};
      if (form.fullName !== staff.fullName) patch.fullName = form.fullName;
      if (form.email !== staff.email) patch.email = form.email;
      const newPhone = form.phone || null;
      if (newPhone !== (staff.phone ?? null)) patch.phone = newPhone;
      if (newPassword) patch.password = newPassword;
      if (Object.keys(patch).length > 0) {
        await api.put(`/staff/${staff.id}`, patch);
      }

      // 2. RBAC role
      if (selectedRoleId && selectedRoleId !== rbacRoles?.find((r) => r.key === effective?.roleKey)?.id) {
        await api.put(`/rbac/users/${staff.id}/role`, { roleId: selectedRoleId });
      }

      // 3. Overrides
      const arr = Object.entries(overrides).map(([permissionKey, effect]) => ({
        permissionKey,
        effect,
      }));
      await api.put(`/rbac/users/${staff.id}/overrides`, { overrides: arr });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["staff"] });
      qc.invalidateQueries({ queryKey: ["rbac-effective", staff.id] });
      qc.invalidateQueries({ queryKey: ["rbac-overrides", staff.id] });
      // If the password was reset, surface it once instead of auto-closing.
      if (newPassword) {
        setResetShown(newPassword);
      } else {
        setMsg("Saved");
        setTimeout(onClose, 700);
      }
    },
    onError: (e: Error) => setErr(e.message),
  });

  function genStrong() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
    let out = "";
    const arr = new Uint32Array(14);
    crypto.getRandomValues(arr);
    for (const n of arr) out += chars[n % chars.length];
    setNewPassword(out + "!");
    setShowPw(true);
  }

  const selectedRole = rbacRoles?.find((r) => r.id === selectedRoleId) ?? null;
  const baseRolePerms = new Set(
    selectedRole?.permissions.includes("*")
      ? (catalog ?? []).map((c) => c.key)
      : selectedRole?.permissions ?? [],
  );
  const effectivePerms = (() => {
    const set = new Set(baseRolePerms);
    for (const [k, eff] of Object.entries(overrides)) {
      if (eff === "grant") set.add(k);
      else if (eff === "deny") set.delete(k);
    }
    return set;
  })();

  // Reveal-once screen after a password reset.
  if (resetShown) {
    return (
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={onClose}>
        <div
          className="bg-surface rounded-md w-full max-w-md p-6 space-y-4"
          onClick={(e) => e.stopPropagation()}
        >
          <h2 className="text-lg font-semibold text-brand-dark">Password reset</h2>
          <p className="text-sm text-textSecondary">
            New password for <strong className="text-brand-dark">{staff.fullName}</strong>. Copy it
            and share securely — it <strong>won&apos;t be shown again</strong> (stored encrypted, can
            only be reset).
          </p>
          <div className="relative">
            <input readOnly className="input pr-20 font-mono select-all" value={resetShown} />
            <button
              type="button"
              onClick={() => {
                navigator.clipboard?.writeText(resetShown).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                });
              }}
              className="absolute right-2 top-1/2 -translate-y-1/2 inline-flex items-center gap-1 text-xs text-brand hover:underline"
            >
              {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <div className="flex justify-end pt-2">
            <button className="btn-primary" onClick={onClose}>Done</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div
        className="bg-surface rounded-md w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-3 border-b border-borderc">
          <h2 className="text-lg font-semibold text-brand-dark">Edit Staff · {staff.fullName}</h2>
        </div>
        <div className="p-5 space-y-4 overflow-y-auto">
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
          <Field label="Phone (optional)">
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
            <select
              className="input"
              value={selectedRoleId ?? ""}
              onChange={(e) => setSelectedRoleId(e.target.value || null)}
            >
              <option value="">— Pick a role —</option>
              {(rbacRoles ?? []).map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                  {r.isSystem ? " · system" : " · custom"}
                </option>
              ))}
            </select>
          </Field>
        </div>

        {selectedRole && (
          <div className="bg-bg/50 border border-borderc rounded-sm px-3 py-2 text-xs text-textSecondary">
            <span className="font-semibold text-brand-dark">{selectedRole.label}</span> grants{" "}
            {selectedRole.permissions.includes("*") ? (
              <span className="font-semibold text-success">all permissions (god mode)</span>
            ) : (
              <span>{selectedRole.permissions.length} permissions</span>
            )}
            . Effective for this user: <span className="font-mono">{effectivePerms.size}</span>
            {Object.keys(overrides).length > 0 && (
              <span> · {Object.keys(overrides).length} override(s)</span>
            )}
          </div>
        )}

        {selectedRole && !selectedRole.permissions.includes("*") && catalog && (
          <div>
            <button
              type="button"
              onClick={() => setShowAdvanced((s) => !s)}
              className="text-xs font-semibold text-brand hover:underline"
            >
              {showAdvanced ? "Hide" : "Show"} advanced permission overrides
            </button>
            {showAdvanced && (
              <div className="mt-3 border border-borderc rounded-sm p-3 space-y-3">
                <p className="text-xs text-textSecondary">
                  Three-state for each permission: <strong>Inherit</strong> (use role default),{" "}
                  <strong className="text-success">Grant</strong> (force allow), or{" "}
                  <strong className="text-danger">Deny</strong> (force block). Deny wins.
                </p>
                {Object.entries(groupByArea(catalog)).map(([area, defs]) => (
                  <div key={area}>
                    <div className="text-xs font-bold text-brand-dark mb-1.5">{area}</div>
                    <div className="space-y-1">
                      {defs.map((d) => {
                        const ovr = overrides[d.key];
                        const inRole = baseRolePerms.has(d.key);
                        return (
                          <div
                            key={d.key}
                            className="flex items-center justify-between gap-2 text-sm py-1"
                          >
                            <div className="flex-1 min-w-0">
                              <div className="text-textPrimary truncate">{d.label}</div>
                              <div className="text-[11px] text-textSecondary font-mono">
                                {d.key} · role:{" "}
                                {inRole ? (
                                  <span className="text-success">allowed</span>
                                ) : (
                                  <span className="text-textSecondary">not in role</span>
                                )}
                              </div>
                            </div>
                            <div className="flex gap-1 shrink-0">
                              {(["inherit", "grant", "deny"] as const).map((opt) => {
                                const active = (ovr ?? "inherit") === opt;
                                const cls =
                                  opt === "grant"
                                    ? active
                                      ? "bg-success text-white border-success"
                                      : "border-borderc text-success hover:border-success"
                                    : opt === "deny"
                                      ? active
                                        ? "bg-danger text-white border-danger"
                                        : "border-borderc text-danger hover:border-danger"
                                      : active
                                        ? "bg-brand-dark text-cream border-brand-dark"
                                        : "border-borderc text-textSecondary hover:border-brand-dark";
                                return (
                                  <button
                                    key={opt}
                                    type="button"
                                    onClick={() =>
                                      setOverrides((o) => {
                                        const next = { ...o };
                                        if (opt === "inherit") delete next[d.key];
                                        else next[d.key] = opt;
                                        return next;
                                      })
                                    }
                                    className={`px-2 h-6 text-[10px] font-semibold rounded-sm border transition-colors capitalize ${cls}`}
                                  >
                                    {opt}
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="border-t border-borderc pt-3 mt-2">
          <div className="text-xs uppercase tracking-wide text-textSecondary mb-2">Reset password</div>
          <div className="relative">
            <input
              className="input pr-20 font-mono"
              type={showPw ? "text" : "password"}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="Leave blank to keep current"
              minLength={8}
              autoComplete="new-password"
            />
            <button
              type="button"
              onClick={() => setShowPw(!showPw)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-textSecondary hover:text-brand"
            >
              {showPw ? "Hide" : "Show"}
            </button>
          </div>
          <div className="flex justify-between items-center mt-1">
            <button type="button" onClick={genStrong} className="text-xs text-brand hover:underline">
              Generate strong password
            </button>
            {newPassword && newPassword.length < 8 && (
              <span className="text-xs text-danger">Min 8 characters</span>
            )}
          </div>
        </div>

        {err && <div className="text-danger text-sm">{err}</div>}
        {msg && <div className="text-success text-sm">{msg}</div>}
        </div>
        <div className="flex justify-end gap-2 px-5 py-3 border-t border-borderc bg-bg/50">
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button
            className="btn-primary"
            onClick={() => save.mutate()}
            disabled={save.isPending || (newPassword.length > 0 && newPassword.length < 8)}
          >
            {save.isPending ? "Saving…" : "Save changes"}
          </button>
        </div>
      </div>
    </div>
  );
}

function AddStaffModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [form, setForm] = useState({
    email: "",
    password: "",
    fullName: "",
    role: "frontdesk" as "admin" | "frontdesk" | "housekeeping",
    phone: "",
  });
  const [err, setErr] = useState<string | null>(null);
  const [showPw, setShowPw] = useState(false);
  // Reveal-once: after a successful create we show the plaintext password
  // one time so staff can hand it over. It's never retrievable afterwards
  // (stored only as an irreversible hash), so this is the single chance
  // to copy it.
  const [created, setCreated] = useState<{ name: string; password: string } | null>(null);
  const [copied, setCopied] = useState(false);

  function genStrong() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
    let out = "";
    const arr = new Uint32Array(14);
    crypto.getRandomValues(arr);
    for (const n of arr) out += chars[n % chars.length];
    setForm((f) => ({ ...f, password: out + "!" }));
    setShowPw(true);
  }

  const save = useMutation({
    mutationFn: () => api.post("/staff", { ...form, phone: form.phone || undefined }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["staff"] });
      // Don't close yet — surface the password once.
      setCreated({ name: form.fullName, password: form.password });
    },
    onError: (e: Error) => setErr(e.message),
  });

  // Post-create reveal-once screen.
  if (created) {
    return (
      <div
        className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
        onClick={onClose}
      >
        <div
          className="bg-surface rounded-md w-full max-w-md p-6 space-y-4"
          onClick={(e) => e.stopPropagation()}
        >
          <h2 className="text-lg font-semibold text-navy">Staff created</h2>
          <p className="text-sm text-textSecondary">
            <strong className="text-navy">{created.name}</strong> can now sign in. Copy the
            password below and share it securely — it{" "}
            <strong>won&apos;t be shown again</strong> (it&apos;s stored encrypted and can only be
            reset, never viewed).
          </p>
          <div>
            <label className="label block mb-1">Password</label>
            <div className="relative">
              <input
                readOnly
                className="input pr-20 font-mono select-all"
                value={created.password}
              />
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard?.writeText(created.password).then(() => {
                    setCopied(true);
                    toast("Password copied", "success");
                    setTimeout(() => setCopied(false), 2000);
                  });
                }}
                className="absolute right-2 top-1/2 -translate-y-1/2 inline-flex items-center gap-1 text-xs text-brand hover:underline"
              >
                {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          </div>
          <div className="flex justify-end pt-2">
            <button className="btn-primary" onClick={onClose}>Done</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        className="bg-surface rounded-md w-full max-w-md p-6 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold text-navy">Add Staff</h2>
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
        <Field label="Password">
          <div className="relative">
            <input
              className="input pr-20 font-mono"
              type={showPw ? "text" : "password"}
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              minLength={8}
              autoComplete="new-password"
            />
            <button
              type="button"
              onClick={() => setShowPw((v) => !v)}
              className="absolute right-2 top-1/2 -translate-y-1/2 inline-flex items-center gap-1 text-xs text-textSecondary hover:text-brand"
              aria-label={showPw ? "Hide password" : "Show password"}
            >
              {showPw ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
              {showPw ? "Hide" : "Show"}
            </button>
          </div>
          <div className="flex justify-between items-center mt-1">
            <button type="button" onClick={genStrong} className="text-xs text-brand hover:underline">
              Generate strong password
            </button>
            {form.password && form.password.length < 8 && (
              <span className="text-xs text-danger">Min 8 characters</span>
            )}
          </div>
        </Field>
        <Field label="Role">
          <select
            className="input"
            value={form.role}
            onChange={(e) => setForm({ ...form, role: e.target.value as typeof form.role })}
          >
            <option value="frontdesk">Front Desk</option>
            <option value="housekeeping">Housekeeping</option>
            <option value="admin">Admin</option>
          </select>
        </Field>
        <Field label="Phone (optional)">
          <input
            className="input"
            type="tel"
            inputMode="numeric"
            maxLength={10}
            placeholder="9876543210"
            value={form.phone}
            onChange={(e) => setForm({ ...form, phone: e.target.value.replace(/\D/g, "").slice(0, 10) })}
          />
        </Field>
        {err && <div className="text-danger text-sm">{err}</div>}
        <div className="flex justify-end gap-2 pt-2">
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button
            className="btn-primary"
            onClick={() => save.mutate()}
            disabled={
              save.isPending ||
              !form.email ||
              form.password.length < 8 ||
              !form.fullName
            }
          >
            {save.isPending ? "Creating…" : "Create"}
          </button>
        </div>
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

// ============================================================
// Roles & Permissions tab
// ============================================================

interface PermissionDef {
  key: string;
  area: string;
  label: string;
  description?: string;
}

interface RbacRole {
  id: string;
  key: string;
  label: string;
  description: string | null;
  isSystem: boolean;
  permissions: string[];
}

function RolesTab() {
  const qc = useQueryClient();
  const dialog = useDialog();
  const { toast } = useToast();
  const [editing, setEditing] = useState<RbacRole | null>(null);
  const [creating, setCreating] = useState(false);

  const { data: rolesData } = useQuery({
    queryKey: ["rbac-roles"],
    queryFn: () => api.get<RbacRole[]>("/rbac/roles"),
  });
  const { data: catalog } = useQuery({
    queryKey: ["rbac-catalog"],
    queryFn: () => api.get<PermissionDef[]>("/rbac/permissions"),
  });

  const del = useMutation({
    mutationFn: (id: string) => api.del(`/rbac/roles/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["rbac-roles"] });
      toast("Role deleted", "success");
    },
    onError: (e: Error) => toast(e.message, "error"),
  });

  if (!rolesData || !catalog) return <Loader />;

  const grouped = groupByArea(catalog);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-textSecondary">
            Roles bundle permissions. System roles can be edited (except <em>admin</em>).
            Custom roles can be deleted when no users hold them.
          </p>
        </div>
        <button
          className="btn-primary inline-flex items-center gap-2"
          onClick={() => setCreating(true)}
        >
          <Plus className="w-4 h-4" /> New Role
        </button>
      </div>

      <div className="card p-0">
        <table className="table-base">
          <thead>
            <tr>
              <th>Role</th>
              <th>Type</th>
              <th>Permissions</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rolesData.map((r) => {
              const isAdmin = r.key === "admin";
              const permCount = r.permissions.includes("*") ? "All (god mode)" : `${r.permissions.length}`;
              return (
                <tr key={r.id}>
                  <td>
                    <div className="font-semibold text-brand-dark">{r.label}</div>
                    <div className="text-xs text-textSecondary font-mono">{r.key}</div>
                    {r.description && (
                      <div className="text-xs text-textSecondary mt-0.5">{r.description}</div>
                    )}
                  </td>
                  <td className="text-xs">
                    {r.isSystem ? (
                      <span className="px-1.5 py-0.5 rounded-sm bg-brand-soft text-brand-dark font-semibold">
                        System
                      </span>
                    ) : (
                      <span className="px-1.5 py-0.5 rounded-sm bg-bg text-textSecondary border border-borderc">
                        Custom
                      </span>
                    )}
                  </td>
                  <td className="text-sm font-mono">{permCount}</td>
                  <td className="text-right">
                    <div className="inline-flex gap-2">
                      {!isAdmin && (
                        <button
                          className="text-brand text-xs hover:underline inline-flex items-center gap-1"
                          onClick={() => setEditing(r)}
                        >
                          <Pencil className="w-3 h-3" /> Edit
                        </button>
                      )}
                      {!r.isSystem && (
                        <button
                          className="text-danger text-xs hover:underline inline-flex items-center gap-1"
                          onClick={async () => {
                            const ok = await dialog.confirm({
                              title: `Delete role "${r.label}"?`,
                              message:
                                "This cannot be undone. Users currently in this role must be reassigned first.",
                              okLabel: "Delete role",
                              tone: "danger",
                            });
                            if (ok) del.mutate(r.id);
                          }}
                        >
                          <Trash2 className="w-3 h-3" /> Delete
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {creating && <RoleEditor catalog={grouped} onClose={() => setCreating(false)} />}
      {editing && (
        <RoleEditor catalog={grouped} role={editing} onClose={() => setEditing(null)} />
      )}
    </div>
  );
}

function groupByArea(catalog: PermissionDef[]): Record<string, PermissionDef[]> {
  const out: Record<string, PermissionDef[]> = {};
  for (const p of catalog) {
    if (!out[p.area]) out[p.area] = [];
    out[p.area]!.push(p);
  }
  return out;
}

function RoleEditor({
  role,
  catalog,
  onClose,
}: {
  role?: RbacRole;
  catalog: Record<string, PermissionDef[]>;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [key, setKey] = useState(role?.key ?? "");
  const [label, setLabel] = useState(role?.label ?? "");
  const [description, setDescription] = useState(role?.description ?? "");
  const [perms, setPerms] = useState<Set<string>>(new Set(role?.permissions ?? []));
  const [err, setErr] = useState<string | null>(null);

  function toggle(k: string) {
    setPerms((s) => {
      const next = new Set(s);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }

  function toggleArea(area: string, on: boolean) {
    const keys = (catalog[area] ?? []).map((p) => p.key);
    setPerms((s) => {
      const next = new Set(s);
      for (const k of keys) {
        if (on) next.add(k);
        else next.delete(k);
      }
      return next;
    });
  }

  const save = useMutation({
    mutationFn: () => {
      const body = {
        key,
        label,
        description: description || null,
        permissions: Array.from(perms),
      };
      if (role) {
        const { key: _k, ...rest } = body;
        return api.patch(`/rbac/roles/${role.id}`, rest);
      }
      return api.post(`/rbac/roles`, body);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["rbac-roles"] });
      toast(role ? "Role updated" : "Role created", "success");
      onClose();
    },
    onError: (e: Error) => setErr(e.message),
  });

  return (
    <div
      className="fixed inset-0 z-[150] grid place-items-center bg-brand-dark/40 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-3xl bg-surface rounded-md shadow-xl border border-borderc max-h-[90vh] overflow-hidden flex flex-col">
        <div className="flex items-center justify-between px-5 py-3 border-b border-borderc">
          <div className="font-semibold text-textPrimary">
            {role ? `Edit role · ${role.label}` : "Create role"}
          </div>
          <button onClick={onClose} className="text-textSecondary hover:text-textPrimary text-lg">
            ×
          </button>
        </div>

        <div className="p-5 space-y-4 overflow-y-auto">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Role key (lowercase, _)">
              <input
                className="input font-mono disabled:bg-bg/50 disabled:text-textSecondary"
                value={key}
                disabled={!!role}
                placeholder="e.g. front_desk_lead"
                onChange={(e) => setKey(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""))}
              />
            </Field>
            <Field label="Display label">
              <input
                className="input"
                value={label}
                placeholder="e.g. Front Desk Lead"
                onChange={(e) => setLabel(e.target.value)}
              />
            </Field>
          </div>
          <Field label="Description">
            <input
              className="input"
              value={description}
              placeholder="What this role is for"
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>

          <div>
            <div className="label mb-2">Permissions ({perms.size})</div>
            <div className="space-y-3">
              {Object.entries(catalog).map(([area, defs]) => {
                const all = defs.every((d) => perms.has(d.key));
                const some = defs.some((d) => perms.has(d.key));
                return (
                  <div key={area} className="border border-borderc rounded-sm p-3">
                    <div className="flex items-center justify-between mb-2">
                      <div className="text-sm font-bold text-brand-dark">{area}</div>
                      <button
                        type="button"
                        className="text-xs font-semibold text-brand hover:underline"
                        onClick={() => toggleArea(area, !all)}
                      >
                        {all ? "Clear all" : some ? "Select all" : "Select all"}
                      </button>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                      {defs.map((d) => {
                        const on = perms.has(d.key);
                        return (
                          <label
                            key={d.key}
                            className={`flex items-start gap-2 px-2 py-1.5 rounded-sm cursor-pointer text-sm transition-colors ${
                              on ? "bg-brand-soft" : "hover:bg-bg"
                            }`}
                          >
                            <input
                              type="checkbox"
                              className="mt-0.5"
                              checked={on}
                              onChange={() => toggle(d.key)}
                            />
                            <div className="flex-1 min-w-0">
                              <div className="font-medium text-textPrimary">{d.label}</div>
                              <div className="text-[11px] text-textSecondary font-mono truncate">
                                {d.key}
                              </div>
                            </div>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {err && <div className="text-danger text-sm">{err}</div>}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-borderc bg-bg/50">
          <button
            onClick={onClose}
            className="px-4 h-9 text-sm font-semibold rounded-sm border-2 border-borderc text-textSecondary hover:border-textSecondary hover:text-textPrimary transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => save.mutate()}
            disabled={save.isPending || !key.trim() || !label.trim()}
            className="px-4 h-9 text-sm font-semibold rounded-sm bg-brand-dark text-cream border-2 border-brand-dark hover:opacity-90 transition-opacity disabled:opacity-40"
          >
            {save.isPending ? "Saving…" : role ? "Save changes" : "Create role"}
          </button>
        </div>
      </div>
    </div>
  );
}

