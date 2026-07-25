// Public in-room QR page (/r/:token). No auth, no AppShell — renders on a
// guest's phone. Vacant room = a warm hotel brochure. Occupied room = the
// guest proves they're the current guest (phone last-4) → WiFi + service
// requests. The unlock key lives in sessionStorage per token and the server
// re-checks occupancy on every call, so a screenshot dies at checkout.
//
// This is the guest's first digital impression of the hotel, so it's styled
// as a premium mini-app rather than a form: full-bleed gradient hero, soft
// cards, tap-to-copy WiFi, tactile request tiles.
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import {
  Bell,
  Check,
  Clock,
  Copy,
  DoorOpen,
  Loader2,
  Lock,
  Phone,
  SendFill,
  ShieldCheck,
  SprayCan,
  Wifi,
  Wrench,
} from "@/lib/micons";
import {
  Card,
  IconBubble,
  PrimaryButton,
  QrFooterBrand,
  QrTopNav,
  qrFormatDate,
  qrFormatTime,
} from "@/components/qrKit";
import {
  publicQr,
  tryGetGeo,
  PublicApiError,
  type QrRoomBrochure,
  type QrRoomHome,
} from "@/lib/publicQr";

type RequestKind = "cleaning" | "amenity" | "issue";

const REQUESTS: {
  kind: RequestKind;
  label: string;
  hint: string;
  Icon: typeof Bell;
  tint: string;
}[] = [
  {
    kind: "cleaning",
    label: "Clean my room",
    hint: "Housekeeping will come by",
    Icon: SprayCan,
    tint: "bg-brand-soft text-brand-deep",
  },
  {
    kind: "amenity",
    label: "Towels, water & amenities",
    hint: "Tell us what you need",
    Icon: Bell,
    tint: "bg-amber-50 text-amber-600",
  },
  {
    kind: "issue",
    label: "Report a problem",
    hint: "AC, plumbing, anything broken",
    Icon: Wrench,
    tint: "bg-red-50 text-red-600",
  },
];

export default function RoomQr() {
  const { token = "" } = useParams();
  const storageKey = `qr-unlock:${token}`;

  const [brochure, setBrochure] = useState<QrRoomBrochure | null>(null);
  const [home, setHome] = useState<QrRoomHome | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [loading, setLoading] = useState(true);

  const [last4, setLast4] = useState("");
  const [unlockError, setUnlockError] = useState("");
  const [unlocking, setUnlocking] = useState(false);

  const [activeRequest, setActiveRequest] = useState<RequestKind | null>(null);
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [toast, setToast] = useState("");
  const [copied, setCopied] = useState(false);

  async function loadHome(key: string): Promise<boolean> {
    try {
      const data = await publicQr.get<QrRoomHome>(
        `/public/qr/room/${token}/home?key=${encodeURIComponent(key)}`,
      );
      setHome(data);
      return true;
    } catch {
      sessionStorage.removeItem(storageKey);
      return false;
    }
  }

  useEffect(() => {
    (async () => {
      try {
        const data = await publicQr.get<QrRoomBrochure>(`/public/qr/room/${token}`);
        setBrochure(data);
        const saved = sessionStorage.getItem(storageKey);
        if (saved && data.occupied) await loadHome(saved);
      } catch {
        setNotFound(true);
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  async function unlock() {
    setUnlockError("");
    setUnlocking(true);
    try {
      const geo = await tryGetGeo();
      const { key } = await publicQr.post<{ key: string }>(`/public/qr/room/${token}/unlock`, {
        phoneLast4: last4,
        ...(geo ? { geo } : {}),
      });
      sessionStorage.setItem(storageKey, key);
      await loadHome(key);
    } catch (e) {
      setUnlockError(e instanceof PublicApiError ? e.message : "Could not unlock. Try again.");
    } finally {
      setUnlocking(false);
    }
  }

  async function sendRequest(kind: RequestKind) {
    const key = sessionStorage.getItem(storageKey);
    if (!key) return;
    setSending(true);
    try {
      await publicQr.post(`/public/qr/room/${token}/request`, {
        key,
        kind,
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      flashToast("Sent. The front desk has been notified.");
      setActiveRequest(null);
      setNote("");
    } catch (e) {
      flashToast(e instanceof PublicApiError ? e.message : "Could not send. Try again.");
    } finally {
      setSending(false);
    }
  }

  function flashToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(""), 4000);
  }

  async function copyPassword() {
    if (!home?.wifiPassword) return;
    try {
      await navigator.clipboard.writeText(home.wifiPassword);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked — the value is visible anyway */
    }
  }

  // ---- shells -------------------------------------------------------------

  if (loading) {
    return (
      <div className="min-h-screen bg-bg grid place-items-center">
        <Loader2 className="w-7 h-7 text-brand-deep animate-spin" />
      </div>
    );
  }

  if (notFound || !brochure) {
    return (
      <div className="min-h-screen bg-bg grid place-items-center p-6 text-center">
        <div className="max-w-xs">
          <div className="w-14 h-14 rounded-2xl bg-red-50 text-red-500 grid place-items-center mx-auto mb-4">
            <Lock className="w-6 h-6" />
          </div>
          <div className="text-xl font-semibold text-textPrimary">Unknown code</div>
          <p className="text-sm text-textSecondary mt-1.5">
            This QR isn't registered. Please contact the front desk.
          </p>
        </div>
      </div>
    );
  }

  const firstName = home?.guestName?.trim().split(" ")[0] ?? "";

  return (
    <div className="min-h-screen bg-bg text-textPrimary antialiased">
      {/* Floating toast */}
      {toast && (
        <div className="fixed top-4 inset-x-0 z-50 flex justify-center px-4 animate-in fade-in slide-in-from-top-2">
          <div className="flex items-center gap-2 bg-brand-dark text-white text-sm font-medium px-4 py-2.5 rounded-md shadow-lg max-w-sm">
            <Check className="w-4 h-4 text-brand-light shrink-0" />
            {toast}
          </div>
        </div>
      )}

      <QrTopNav
        hotelName={brochure.hotel.name}
        logoUrl="/fyn-arc-logo.png"
        right={
          <span className="inline-flex items-center gap-1.5 bg-white/10 border border-white/15 rounded-md px-2.5 h-9 shrink-0">
            <DoorOpen className="w-4 h-4 text-white/90" />
            <span className="text-sm font-semibold whitespace-nowrap">{brochure.roomNumber}</span>
          </span>
        }
      />

      <main className="max-w-md mx-auto px-4 pt-4 pb-10 space-y-3.5 relative">
        {/* Vacant */}
        {!brochure.occupied && (
          <Card>
            <div className="flex items-start gap-3">
              <IconBubble className="bg-bg text-textSecondary">
                <DoorOpen className="w-5 h-5" />
              </IconBubble>
              <div>
                <div className="font-semibold">This room is available</div>
                <p className="text-sm text-textSecondary mt-1 leading-relaxed">
                  Wi-Fi and room services appear here during a stay. For bookings, please
                  visit the front desk.
                </p>
              </div>
            </div>
          </Card>
        )}

        {/* Locked — verify */}
        {brochure.occupied && !home && (
          <Card>
            <IconBubble className="bg-brand-soft text-brand-deep mb-3">
              <ShieldCheck className="w-5 h-5" />
            </IconBubble>
            <div className="font-semibold text-lg">Verify your stay</div>
            <p className="text-sm text-textSecondary mt-1 leading-relaxed">
              Enter the <strong className="text-textPrimary">last 4 digits</strong> of the phone
              number this room was booked with.
            </p>
            <input
              className="w-full mt-4 h-14 rounded-md border border-borderc bg-white text-center text-2xl font-semibold tracking-[0.6em] outline-none focus:border-brand focus:ring-2 focus:ring-brand/25 transition"
              inputMode="numeric"
              maxLength={4}
              value={last4}
              onChange={(e) => setLast4(e.target.value.replace(/\D/g, "").slice(0, 4))}
              placeholder="••••"
              autoFocus
            />
            {unlockError && (
              <div className="text-sm text-red-600 mt-2 text-center">{unlockError}</div>
            )}
            <PrimaryButton
              className="mt-4"
              disabled={last4.length !== 4 || unlocking}
              onClick={unlock}
            >
              {unlocking ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" /> Checking…
                </>
              ) : (
                <>
                  <Lock className="w-4 h-4" /> Unlock room
                </>
              )}
            </PrimaryButton>
            <p className="text-[11px] text-textSecondary text-center mt-3">
              Your details stay private. This only works from inside your active stay.
            </p>
          </Card>
        )}

        {/* Unlocked */}
        {home && (
          <>
            <Card className="!p-5">
              <div className="text-sm text-textSecondary">Hello{firstName ? `, ${firstName}` : ""} 👋</div>
              <div className="flex items-center gap-2 mt-1.5 text-textPrimary font-semibold">
                <Clock className="w-4 h-4 text-brand-deep" />
                <span>
                  Check-out {qrFormatDate(home.checkOutDate)} · {qrFormatTime(home.checkOutTime)}
                </span>
              </div>
            </Card>

            {/* WiFi */}
            <Card>
              <div className="flex items-center gap-2.5 mb-3">
                <IconBubble className="bg-brand-soft text-brand-deep !w-9 !h-9">
                  <Wifi className="w-5 h-5" />
                </IconBubble>
                <div className="text-xs uppercase tracking-widest text-textSecondary font-semibold">
                  Wi-Fi
                </div>
              </div>
              {home.wifiSsid ? (
                <div className="space-y-2.5">
                  <Row label="Network" value={home.wifiSsid} />
                  <div className="h-px bg-borderc" />
                  <button
                    className="w-full flex items-center justify-between text-left group"
                    onClick={copyPassword}
                  >
                    <span className="text-sm text-textSecondary">Password</span>
                    <span className="flex items-center gap-2">
                      <span className="font-mono font-semibold">{home.wifiPassword || "—"}</span>
                      {home.wifiPassword &&
                        (copied ? (
                          <Check className="w-4 h-4 text-brand-deep" />
                        ) : (
                          <Copy className="w-4 h-4 text-textSecondary group-active:scale-90 transition" />
                        ))}
                    </span>
                  </button>
                  {home.wifiPassword && (
                    <div className="text-[11px] text-textSecondary text-right">
                      {copied ? "Copied!" : "Tap the password to copy"}
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-sm text-textSecondary">
                  Ask the front desk for Wi-Fi details.
                </p>
              )}
            </Card>

            {/* Requests */}
            <Card>
              <div className="text-xs uppercase tracking-widest text-textSecondary font-semibold mb-3">
                Need something?
              </div>
              <div className="space-y-2.5">
                {REQUESTS.map(({ kind, label, hint, Icon, tint }) => {
                  const open = activeRequest === kind;
                  return (
                    <div key={kind}>
                      <button
                        className={`w-full flex items-center gap-3 rounded-lg border p-3 text-left transition active:scale-[0.99] ${
                          open ? "border-brand bg-brand/5" : "border-borderc hover:border-brand/50"
                        }`}
                        onClick={() => {
                          setActiveRequest(open ? null : kind);
                          setNote("");
                        }}
                      >
                        <IconBubble className={tint}>
                          <Icon className="w-5 h-5" />
                        </IconBubble>
                        <div className="flex-1">
                          <div className="font-medium text-sm">{label}</div>
                          <div className="text-xs text-textSecondary">{hint}</div>
                        </div>
                      </button>
                      {open && (
                        <div className="mt-2 pl-1 animate-in fade-in slide-in-from-top-1">
                          <textarea
                            className="w-full rounded-md border border-borderc bg-white p-3 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/25 transition resize-none"
                            rows={2}
                            maxLength={300}
                            placeholder="Anything specific? (optional)"
                            value={note}
                            onChange={(e) => setNote(e.target.value)}
                          />
                          <PrimaryButton
                            className="mt-2"
                            disabled={sending}
                            onClick={() => sendRequest(kind)}
                          >
                            {sending ? (
                              <>
                                <Loader2 className="w-4 h-4 animate-spin" /> Sending…
                              </>
                            ) : (
                              <>
                                <SendFill className="w-4 h-4" /> Send to front desk
                              </>
                            )}
                          </PrimaryButton>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </Card>

            {brochure.hotel.phone && (
              <a
                href={`tel:${brochure.hotel.phone}`}
                className="flex items-center justify-center gap-2 w-full h-11 rounded-md border border-brand bg-white font-medium text-sm text-brand-deep active:scale-[0.99] transition"
              >
                <Phone className="w-4 h-4" />
                Call front desk · {brochure.hotel.phone}
              </a>
            )}
          </>
        )}

        <QrFooterBrand />
      </main>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm text-textSecondary">{label}</span>
      <span className="font-mono font-semibold">{value}</span>
    </div>
  );
}
