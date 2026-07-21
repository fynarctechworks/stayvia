import { useEffect, useRef, useState } from "react";
import { Loader2, Mail, Phone, ShieldCheck, X } from "@/lib/micons";
import { api, ApiError } from "@/lib/api";

interface Props {
  // EXACTLY ONE of reservationId / guestId / phone.
  //   - reservationId: OTP runs against an existing reservation. Used by
  //     ReservationDetail when staff re-verifies a guest before check-in.
  //     The modal consumes the OTP itself (/otp/verify marks it used).
  //   - guestId: pre-create OTP — no reservation row exists yet. Used by
  //     the booking flow for an EXISTING guest. The modal does NOT consume
  //     the OTP; it hands the raw code back to the caller so the
  //     reservation-create endpoint can verify + consume atomically.
  //   - phone: pre-create OTP for a BRAND-NEW guest — neither guest nor
  //     reservation rows exist yet. The guest is only written after this
  //     verifies, so an abandoned booking leaves no orphan record. Email
  //     delivery is possible too when the booking form captured one —
  //     pass it via `email`; the OTP stays keyed by the phone.
  reservationId?: string;
  guestId?: string;
  phone?: string;
  // Optional delivery address for the email channel in phone mode.
  email?: string;
  open: boolean;
  onClose: () => void;
  // In reservationId mode the modal calls /otp/verify itself; onVerified
  // is invoked with no args. In guestId/phone mode onVerified receives the
  // raw code so the caller can include it in POST /reservations.
  onVerified: (code?: string) => void | Promise<void>;
}

interface SendResp {
  id: string;
  channel: "sms" | "email";
  target: string;
  expiresInSeconds: number;
  devCode?: string;
}

export function OtpModal({ reservationId, guestId, phone, email, open, onClose, onVerified }: Props) {
  const [step, setStep] = useState<"choose" | "verify">("choose");
  const [channel, setChannel] = useState<"sms" | "email">("sms");
  const [send, setSend] = useState<SendResp | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      setStep("choose");
      setSend(null);
      setCode("");
      setError(null);
      setSecondsLeft(0);
    }
  }, [open]);

  useEffect(() => {
    if (secondsLeft <= 0) return;
    const t = setTimeout(() => setSecondsLeft((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [secondsLeft]);

  // Server-side: /otp/send and /otp/verify accept any of the three anchors,
  // so we just forward whichever was provided. Phone-anchored OTP is SMS
  // only (there's no email to fall back to before the guest exists).
  const anchor = reservationId
    ? { reservationId }
    : guestId
      ? { guestId }
      : phone
        ? { phone }
        : null;

  async function onSend() {
    if (!anchor) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<SendResp>("/otp/send", {
        ...anchor,
        channel,
        // Phone-anchored email delivery: the form-typed email rides along.
        ...(phone && channel === "email" && email ? { email } : {}),
      });
      setSend(r);
      setSecondsLeft(r.expiresInSeconds);
      setStep("verify");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to send OTP");
    } finally {
      setBusy(false);
    }
  }

  async function onVerify() {
    if (code.length < 4 || !anchor) return;
    setBusy(true);
    setError(null);
    try {
      await api.post("/otp/verify", { ...anchor, code });
      // In guestId/phone mode we don't consume the OTP here — the create-
      // reservation endpoint does that atomically. We hand the code back
      // so the caller can include it in POST /reservations.
      // Await the callback so the spinner stays visible while the
      // parent fires the actual reservation-create mutation.
      await onVerified(guestId || phone ? code : undefined);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Verification failed");
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;

  const mins = Math.floor(secondsLeft / 60);
  const secs = String(secondsLeft % 60).padStart(2, "0");

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:grid sm:place-items-center bg-brand-dark/40 sm:p-4">
      <div ref={dialogRef} className="w-full sm:max-w-md bg-surface rounded-t-2xl sm:rounded-md shadow-xl border border-borderc max-h-[92vh] overflow-y-auto pb-safe sm:pb-0">
        <div className="flex items-center justify-between px-5 py-3 border-b border-borderc">
          <div className="flex items-center gap-2 font-semibold text-textPrimary">
            <ShieldCheck className="w-5 h-5 text-brand" />
            Verify guest
          </div>
          <button onClick={onClose} className="text-textSecondary hover:text-textPrimary">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-4">
          {step === "choose" && (
            <>
              <p className="text-sm text-textSecondary">
                Send a one-time code to the guest to confirm their identity at check-in.
              </p>
              <div className="grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => setChannel("sms")}
                  className={`flex items-center gap-2 justify-center py-3 rounded-md border-2 transition-colors ${
                    channel === "sms" ? "border-brand bg-brand-soft text-brand-dark" : "border-borderc text-textSecondary hover:border-brand/40"
                  }`}
                >
                  <Phone className="w-4 h-4" /> SMS
                </button>
                {/* New-guest (phone-anchored) email OTP needs the email the
                    form captured; until one is typed the button is visible
                    but disabled so staff knows the option exists. */}
                <button
                  type="button"
                  disabled={!!phone && !email}
                  onClick={() => setChannel("email")}
                  className={`flex items-center gap-2 justify-center py-3 rounded-md border-2 transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                    channel === "email" ? "border-brand bg-brand-soft text-brand-dark" : "border-borderc text-textSecondary hover:border-brand/40"
                  }`}
                >
                  <Mail className="w-4 h-4" /> Email
                </button>
              </div>
              {!!phone && !email && (
                <p className="text-xs text-textSecondary">
                  To send the code by email, fill the guest's Email field on the
                  booking form first.
                </p>
              )}
              {error && <div className="text-danger text-sm">{error}</div>}
              <button
                type="button"
                onClick={onSend}
                disabled={busy}
                className="btn-primary w-full flex items-center justify-center gap-2"
              >
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                Send code
              </button>
            </>
          )}

          {step === "verify" && send && (
            <>
              <p className="text-sm text-textSecondary">
                Code sent to <strong className="text-textPrimary">{send.target}</strong>. Ask the guest to read it back.
              </p>
              {send.devCode && (
                <div className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning">
                  Dev mode: code is <strong className="font-mono">{send.devCode}</strong>
                </div>
              )}
              <input
                autoFocus
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 8))}
                className="input text-center text-2xl tracking-[0.5em] font-mono"
                placeholder="000000"
                inputMode="numeric"
              />
              <div className="flex items-center justify-between text-xs text-textSecondary">
                <span>{secondsLeft > 0 ? `Expires in ${mins}:${secs}` : "Code expired"}</span>
                <button
                  type="button"
                  onClick={() => {
                    setStep("choose");
                    setCode("");
                  }}
                  className="text-brand hover:underline"
                >
                  Resend / change channel
                </button>
              </div>
              {error && <div className="text-danger text-sm">{error}</div>}
              <button
                type="button"
                onClick={onVerify}
                disabled={busy || code.length < 4 || secondsLeft <= 0}
                className="btn-primary w-full flex items-center justify-center gap-2"
              >
                {busy && <Loader2 className="w-4 h-4 animate-spin" />}
                {busy ? "Creating reservation…" : "Verify & continue"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
