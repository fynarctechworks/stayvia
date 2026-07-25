// Public hotel master-QR page (/h/:token). The framed code at the front
// desk. A walk-in scans it, sees tonight's free rooms, and books with the
// same identity fields the staff walk-in form collects. The booking lands
// as a 30-minute HOLD — the front desk verifies the guest, takes payment,
// and confirms. Nothing here blocks inventory on its own.
//
// Styled to match the in-room QR page: gradient hero, soft cards, tactile
// selection, sticky booking bar. Guest-facing, so it earns the polish.
import {
  useEffect,
  useMemo,
  useState,
  type ButtonHTMLAttributes,
} from "react";
import { useParams } from "react-router-dom";
import {
  BadgeIndianRupee,
  BedDouble,
  Check,
  CheckCircle2,
  ChevronLeft,
  FileImage,
  IdCard,
  Loader2,
  Snowflake,
  Users,
  Wifi,
  X,
} from "@/lib/micons";
import {
  Card,
  IconBubble,
  PrimaryButton,
  QrField,
  QrFooterBrand,
  QrTopNav,
  QrSelect,
  qrFormatTime,
  qrInputClass,
} from "@/components/qrKit";
import { INDIAN_STATES, INDIAN_UNION_TERRITORIES } from "@/lib/indianStates";
import { ID_PROOF_SPECS, inr, sanitizeIdProofNumber } from "@/lib/utils";
import {
  publicQr,
  PublicApiError,
  type QrCatalog,
  type QrCatalogRoom,
} from "@/lib/publicQr";

const ID_TYPES = [
  ["aadhaar", "Aadhaar"],
  ["pan", "PAN"],
  ["passport", "Passport"],
  ["driving_license", "Driving License"],
  ["voter_id", "Voter ID"],
] as const;

type Step = "browse" | "details" | "otp" | "done";

export default function HotelQr() {
  const { token = "" } = useParams();

  const [catalog, setCatalog] = useState<QrCatalog | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [loading, setLoading] = useState(true);

  const [step, setStep] = useState<Step>("browse");
  const [selected, setSelected] = useState<string[]>([]);
  const [nights, setNights] = useState(1);
  const [numAdults, setNumAdults] = useState(1);
  const [detailRoom, setDetailRoom] = useState<QrCatalogRoom | null>(null);

  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [gender, setGender] = useState("");
  const [idProofType, setIdProofType] = useState<keyof typeof ID_PROOF_SPECS>("aadhaar");
  const [idProofNumber, setIdProofNumber] = useState("");
  const [nationality, setNationality] = useState("Indian");
  const [state, setState] = useState("");
  const [city, setCity] = useState("");
  const [address, setAddress] = useState("");
  const [gstin, setGstin] = useState("");
  const [specialRequests, setSpecialRequests] = useState("");

  const [otpCode, setOtpCode] = useState("");
  const [devCode, setDevCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const [result, setResult] = useState<{
    reservationNumber: string;
    grandTotal: number;
    holdExpiresAt: string;
  } | null>(null);

  useEffect(() => {
    (async () => {
      try {
        setCatalog(await publicQr.get<QrCatalog>(`/public/qr/hotel/${token}`));
      } catch {
        setNotFound(true);
      } finally {
        setLoading(false);
      }
    })();
  }, [token]);

  const chosenRooms: QrCatalogRoom[] = useMemo(
    () => (catalog?.rooms ?? []).filter((r) => selected.includes(r.id)),
    [catalog, selected],
  );
  const perNight = chosenRooms.reduce((a, r) => a + r.baseRate, 0);
  const total = perNight * nights;

  // Toggle one specific room. Global cap 3 rooms per booking.
  function toggleRoom(id: string) {
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : prev.length < 3 ? [...prev, id] : prev,
    );
  }

  const detailsValid =
    fullName.trim().length >= 2 &&
    /^[6-9]\d{9}$/.test(phone) &&
    gender !== "" &&
    idProofNumber.length >= 4 &&
    nationality.trim() !== "" &&
    state.trim() !== "" &&
    city.trim() !== "" &&
    address.trim() !== "";

  async function sendOtp() {
    setError("");
    setBusy(true);
    try {
      const r = await publicQr.post<{ sent: boolean; devCode?: string }>(
        `/public/qr/hotel/${token}/send-otp`,
        { phone },
      );
      if (r.devCode) setDevCode(r.devCode);
      setStep("otp");
    } catch (e) {
      setError(e instanceof PublicApiError ? e.message : "Could not send the code");
    } finally {
      setBusy(false);
    }
  }

  async function book() {
    setError("");
    setBusy(true);
    try {
      const r = await publicQr.post<{
        reservationNumber: string;
        grandTotal: number;
        holdExpiresAt: string;
      }>(`/public/qr/hotel/${token}/book`, {
        phone,
        otpCode,
        fullName: fullName.trim(),
        email: email.trim(),
        gender,
        idProofType,
        idProofNumber,
        nationality: nationality.trim(),
        state: state.trim(),
        city: city.trim(),
        address: address.trim(),
        gstin: gstin.trim(),
        nights,
        numAdults,
        roomIds: selected,
        ...(specialRequests.trim() ? { specialRequests: specialRequests.trim() } : {}),
      });
      setResult(r);
      setStep("done");
    } catch (e) {
      setError(e instanceof PublicApiError ? e.message : "Booking failed. Try again.");
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-bg grid place-items-center">
        <Loader2 className="w-7 h-7 text-brand-deep animate-spin" />
      </div>
    );
  }
  if (notFound || !catalog) {
    return (
      <div className="min-h-screen bg-bg grid place-items-center p-6 text-center">
        <div className="max-w-xs">
          <div className="text-xl font-semibold text-textPrimary">Unknown code</div>
          <p className="text-sm text-textSecondary mt-1.5">Please ask at the front desk.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-bg text-textPrimary antialiased">
      <QrTopNav
        hotelName={catalog.hotel.name}
        subtitle={catalog.hotel.address || undefined}
        logoUrl={catalog.hotel.logoUrl}
      />

      <main className="max-w-md mx-auto px-4 pt-5 pb-32 space-y-3.5 relative">
        {/* ---- browse ---- */}
        {step === "browse" && (
          <>
            {catalog.rooms.length === 0 && (
              <Card>
                <p className="text-sm text-textSecondary">
                  No rooms are free tonight. Please check with the front desk.
                </p>
              </Card>
            )}

            {catalog.rooms.length > 0 &&
              (() => {
                const cats = groupByType(catalog.rooms);
                return (
                  <>
                    <div className="flex items-center justify-between px-1">
                      <span className="text-sm font-semibold text-textPrimary">
                        Rooms free tonight
                        <span className="text-textSecondary font-normal">
                          {" "}
                          · {catalog.rooms.length}
                        </span>
                      </span>
                      <span className="text-xs text-textSecondary">
                        check-in {qrFormatTime(catalog.hotel.checkInTime)}
                      </span>
                    </div>

                    {/* Grouped by room type — a heading per category, rooms
                        (cheapest first) beneath it. No filter to tap. */}
                    {cats.map((cat) => (
                      <div key={cat.slug} className="space-y-2.5">
                        <div className="flex items-baseline gap-2 px-1 pt-1">
                          <h3 className="text-xs font-bold uppercase tracking-wider text-brand-dark">
                            {cat.label}
                          </h3>
                          <span className="text-[11px] text-textSecondary">
                            {cat.rooms.length} room{cat.rooms.length === 1 ? "" : "s"} · from{" "}
                            {inr(cat.fromRate)}
                          </span>
                        </div>
                        {cat.rooms.map((r) => (
                          <RoomCard
                            key={r.id}
                            room={r}
                            active={selected.includes(r.id)}
                            disabled={!selected.includes(r.id) && selected.length >= 3}
                            onToggle={() => toggleRoom(r.id)}
                            onDetails={() => setDetailRoom(r)}
                          />
                        ))}
                      </div>
                    ))}
                  </>
                );
              })()}

            {selected.length > 0 && (
              <Card className="space-y-4">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">Nights</span>
                  <div className="flex items-center gap-1.5">
                    {[1, 2, 3].map((n) => (
                      <button
                        key={n}
                        onClick={() => setNights(n)}
                        className={`h-10 w-10 rounded-md font-semibold transition ${
                          nights === n
                            ? "bg-brand text-textPrimary"
                            : "bg-white text-textPrimary border border-borderc"
                        }`}
                      >
                        {n}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="h-px bg-borderc/60" />
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">Guests</span>
                  <div className="flex items-center gap-3">
                    <RoundBtn disabled={numAdults <= 1} onClick={() => setNumAdults((v) => v - 1)}>
                      −
                    </RoundBtn>
                    <span className="min-w-6 text-center font-semibold">{numAdults}</span>
                    <RoundBtn disabled={numAdults >= 6} onClick={() => setNumAdults((v) => v + 1)}>
                      +
                    </RoundBtn>
                  </div>
                </div>
              </Card>
            )}
          </>
        )}

        {/* ---- details ---- */}
        {step === "details" && (
          <Card className="space-y-3.5">
            <BackRow onClick={() => setStep("browse")} title="Your details" />
            <QrField label="Full name">
              <input
                className={qrInputClass}
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
              />
            </QrField>
            <QrField label="Phone">
              <input
                className={`${qrInputClass} font-mono`}
                type="tel"
                inputMode="numeric"
                maxLength={10}
                placeholder="9876543210"
                value={phone}
                onChange={(e) => setPhone(e.target.value.replace(/\D/g, "").slice(0, 10))}
              />
              <p className="text-[11px] text-textSecondary mt-1">
                We'll text a verification code to this number.
              </p>
            </QrField>
            <QrField label="Email (optional)">
              <input
                className={qrInputClass}
                type="email"
                placeholder="guest@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </QrField>
            <div className="grid grid-cols-2 gap-3">
              <QrField label="Gender">
                <QrSelect
                  value={gender}
                  onChange={setGender}
                  options={[
                    { value: "male", label: "Male" },
                    { value: "female", label: "Female" },
                    { value: "other", label: "Other" },
                    { value: "prefer_not_to_say", label: "Prefer not to say" },
                  ]}
                />
              </QrField>
              <QrField label="ID type">
                <QrSelect
                  value={idProofType}
                  onChange={(v) => {
                    const t = v as keyof typeof ID_PROOF_SPECS;
                    setIdProofType(t);
                    setIdProofNumber(sanitizeIdProofNumber(t, idProofNumber));
                  }}
                  options={ID_TYPES.map(([value, label]) => ({ value, label }))}
                />
              </QrField>
            </div>
            <QrField label="ID number">
              <input
                className={`${qrInputClass} font-mono`}
                inputMode={ID_PROOF_SPECS[idProofType]?.digitsOnly ? "numeric" : "text"}
                maxLength={ID_PROOF_SPECS[idProofType]?.maxLength ?? 50}
                placeholder={ID_PROOF_SPECS[idProofType]?.placeholder}
                value={idProofNumber}
                onChange={(e) => setIdProofNumber(sanitizeIdProofNumber(idProofType, e.target.value))}
              />
              <p className="text-[11px] text-textSecondary mt-1 flex items-center gap-1">
                <IdCard className="w-3.5 h-3.5" /> Carry this ID. The front desk verifies it at
                check-in.
              </p>
            </QrField>
            <div className="grid grid-cols-2 gap-3">
              <QrField label="Nationality">
                <input
                  className={qrInputClass}
                  value={nationality}
                  onChange={(e) => setNationality(e.target.value)}
                />
              </QrField>
              <QrField label="State">
                <QrSelect
                  value={state}
                  onChange={setState}
                  options={[...INDIAN_STATES, ...INDIAN_UNION_TERRITORIES].map((s) => ({
                    value: s,
                    label: s,
                  }))}
                />
              </QrField>
            </div>
            <QrField label="City">
              <input className={qrInputClass} value={city} onChange={(e) => setCity(e.target.value)} />
            </QrField>
            <QrField label="Address">
              <textarea
                className={`${qrInputClass} !h-auto py-2.5`}
                rows={2}
                maxLength={500}
                value={address}
                onChange={(e) => setAddress(e.target.value)}
              />
            </QrField>
            <QrField label="GSTIN (optional)">
              <input
                className={`${qrInputClass} font-mono`}
                maxLength={15}
                placeholder="22AAAAA0000A1Z5"
                value={gstin}
                onChange={(e) => setGstin(e.target.value.toUpperCase().replace(/[^0-9A-Z]/g, "").slice(0, 15))}
              />
            </QrField>
            <QrField label="Special requests (optional)">
              <input
                className={qrInputClass}
                maxLength={300}
                value={specialRequests}
                onChange={(e) => setSpecialRequests(e.target.value)}
              />
            </QrField>
            {error && <div className="text-sm text-red-600">{error}</div>}
            <PrimaryButton disabled={!detailsValid || busy} onClick={sendOtp}>
              {busy ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" /> Sending…
                </>
              ) : (
                "Send verification code"
              )}
            </PrimaryButton>
          </Card>
        )}

        {/* ---- otp ---- */}
        {step === "otp" && (
          <Card className="space-y-3.5">
            <BackRow onClick={() => setStep("details")} title="Enter the code" />
            <p className="text-sm text-textSecondary">
              We sent a 6-digit code to <span className="font-mono text-textPrimary">{phone}</span>.
            </p>
            {devCode && (
              <div className="rounded-md bg-bg border border-borderc px-3 py-2 text-xs text-textSecondary">
                Test mode — your code is{" "}
                <span className="font-mono font-semibold text-textPrimary">{devCode}</span>
              </div>
            )}
            <input
              className="w-full h-14 rounded-md border border-borderc bg-white text-center text-2xl font-semibold tracking-[0.4em] outline-none focus:border-brand focus:ring-2 focus:ring-brand/25 transition"
              inputMode="numeric"
              maxLength={8}
              value={otpCode}
              onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, "").slice(0, 8))}
              autoFocus
            />
            {error && <div className="text-sm text-red-600">{error}</div>}
            <PrimaryButton disabled={otpCode.length < 4 || busy} onClick={book}>
              {busy ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" /> Booking…
                </>
              ) : (
                `Confirm booking · ${inr(total)}`
              )}
            </PrimaryButton>
          </Card>
        )}

        {/* ---- done ---- */}
        {step === "done" && result && (
          <Card className="text-center !p-6 space-y-4">
            <IconBubble className="bg-brand-soft text-brand-deep !w-14 !h-14 mx-auto">
              <CheckCircle2 className="w-7 h-7" />
            </IconBubble>
            <div>
              <div className="text-lg font-semibold">Request received</div>
              <div className="font-mono text-sm text-textSecondary mt-0.5">
                {result.reservationNumber}
              </div>
            </div>
            <div className="rounded-md bg-brand-softer border border-brand/30 py-3">
              <div className="font-mono text-2xl font-bold text-textPrimary">
                {inr(result.grandTotal)}
              </div>
              <div className="text-[11px] text-textSecondary">payable at the front desk</div>
            </div>
            <p className="text-sm text-textSecondary leading-relaxed">
              <strong className="text-textPrimary">Show this screen at the front desk.</strong> They'll
              verify your ID, take payment, and confirm the booking. This request expires in about
              30 minutes if not confirmed.
            </p>
          </Card>
        )}

        <QrFooterBrand />
      </main>

      {/* Sticky booking bar — browse step, once a room is picked */}
      {step === "browse" && selected.length > 0 && (
        <div className="fixed bottom-0 inset-x-0 z-40 bg-white/95 backdrop-blur border-t border-borderc">
          <div className="max-w-md mx-auto px-4 py-3 flex items-center gap-3">
            <div className="flex-1">
              <div className="flex items-center gap-1.5 font-bold text-lg">
                <BadgeIndianRupee className="w-4 h-4 text-brand-deep" />
                {inr(total)}
              </div>
              <div className="text-[11px] text-textSecondary -mt-0.5">
                {selected.length} room{selected.length === 1 ? "" : "s"} · {nights} night
                {nights === 1 ? "" : "s"} · + GST
              </div>
            </div>
            <PrimaryButton className="!w-auto px-6" onClick={() => setStep("details")}>
              Continue
            </PrimaryButton>
          </div>
        </div>
      )}

      {/* Room photos + details sheet */}
      {detailRoom && (
        <RoomDetailSheet
          room={detailRoom}
          selected={selected.includes(detailRoom.id)}
          onClose={() => setDetailRoom(null)}
          onSelect={() => {
            if (!selected.includes(detailRoom.id) && selected.length < 3) toggleRoom(detailRoom.id);
            setDetailRoom(null);
          }}
        />
      )}
    </div>
  );
}

// ---- room card -------------------------------------------------------------


// Group catalog rooms into room-type categories, cheapest first within and
// across categories. Category facts (sleeps/AC/WiFi) roll up from members.
function groupByType(rooms: QrCatalogRoom[]) {
  const map = new Map<string, QrCatalogRoom[]>();
  for (const r of rooms) {
    const list = map.get(r.roomType) ?? [];
    list.push(r);
    map.set(r.roomType, list);
  }
  return Array.from(map.entries())
    .map(([slug, list]) => {
      const sorted = [...list].sort((a, b) => a.baseRate - b.baseRate);
      return {
        slug,
        label: sorted[0]!.roomTypeLabel,
        description: sorted[0]!.roomTypeDescription,
        fromRate: sorted[0]!.baseRate,
        maxOccupancy: Math.max(...sorted.map((r) => r.maxOccupancy)),
        hasAc: sorted.some((r) => r.hasAc),
        hasWifi: sorted.some((r) => r.hasWifi),
        rooms: sorted,
      };
    })
    .sort((a, b) => a.fromRate - b.fromRate);
}


function RoomCard({
  room: r,
  active,
  disabled,
  onToggle,
  onDetails,
}: {
  room: QrCatalogRoom;
  active: boolean;
  disabled: boolean;
  onToggle: () => void;
  onDetails: () => void;
}) {
  const cover = r.images[0]?.url;
  return (
    <div
      className={`bg-white rounded-2xl border overflow-hidden shadow-sm transition ${
        active ? "border-brand ring-1 ring-brand" : "border-borderc"
      }`}
    >
      {/* Big cover photo — travel-app style */}
      <button onClick={onDetails} className="relative block w-full h-44">
        {cover ? (
          <img src={cover} alt={`Room ${r.roomNumber}`} className="absolute inset-0 w-full h-full object-cover" />
        ) : (
          <div className="absolute inset-0 bg-bg grid place-items-center text-textSecondary/50">
            <BedDouble className="w-10 h-10" />
          </div>
        )}
        <span className="absolute top-2.5 left-2.5 bg-white/90 backdrop-blur text-[11px] font-semibold rounded-full px-2.5 py-1">
          {r.roomTypeLabel}
        </span>
        {r.images.length > 0 && (
          <span className="absolute bottom-2.5 right-2.5 bg-black/55 text-white text-[10px] rounded-full px-2 py-0.5 inline-flex items-center gap-1">
            <FileImage className="w-3 h-3" /> {r.images.length}
          </span>
        )}
      </button>

      <div className="p-3">
        <div className="flex items-start justify-between gap-2">
          <button onClick={onDetails} className="text-left min-w-0">
            <div className="font-bold text-[15px] leading-tight">Room {r.roomNumber}</div>
            <div className="text-[11px] text-textSecondary mt-0.5">Floor {r.floor}</div>
          </button>
          <div className="text-right shrink-0">
            <div className="font-bold text-textPrimary">{inr(r.baseRate)}</div>
            <div className="text-[10px] text-textSecondary -mt-0.5">per night</div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 mt-2 text-[11px] text-textPrimary">
          <span className="inline-flex items-center gap-1">
            <Users className="w-3 h-3 text-textSecondary" /> Sleeps {r.maxOccupancy}
          </span>
          <span className="inline-flex items-center gap-1">
            <Snowflake className="w-3 h-3 text-textSecondary" /> {r.hasAc ? "AC" : "Non-AC"}
          </span>
          {r.hasWifi && (
            <span className="inline-flex items-center gap-1">
              <Wifi className="w-3 h-3 text-textSecondary" /> Free WiFi
            </span>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 mt-3">
          <span className="inline-flex items-center gap-1 text-[11px] font-medium text-brand-deep">
            <Check className="w-3.5 h-3.5" /> Pay at the hotel
          </span>
          <button
            onClick={onToggle}
            disabled={disabled}
            className={`h-9 px-5 rounded-lg text-[13px] font-semibold transition disabled:opacity-40 ${
              active ? "bg-brand-deep text-white" : "bg-brand text-textPrimary hover:bg-brand-light"
            }`}
          >
            {active ? "Selected" : "Select"}
          </button>
        </div>
      </div>
    </div>
  );
}

function RoomDetailSheet({
  room: r,
  selected,
  onClose,
  onSelect,
}: {
  room: QrCatalogRoom;
  selected: boolean;
  onClose: () => void;
  onSelect: () => void;
}) {
  const chips: string[] = [
    `Sleeps ${r.maxOccupancy}`,
    r.hasAc ? "Air conditioning" : "Non-AC",
    ...(r.hasTv ? ["Television"] : []),
    ...(r.hasWifi ? ["Free WiFi"] : []),
    ...r.amenities,
  ];
  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end bg-black/50 animate-in fade-in" onClick={onClose}>
      <div
        className="bg-white rounded-t-2xl max-h-[88vh] overflow-y-auto animate-in slide-in-from-bottom-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 bg-white/95 backdrop-blur z-10 flex items-center justify-between px-4 pt-3 pb-2">
          <div className="w-9" />
          <div className="w-10 h-1 rounded-full bg-borderc" />
          <button onClick={onClose} className="w-9 h-9 rounded-full grid place-items-center hover:bg-bg" aria-label="Close">
            <X className="w-5 h-5" />
          </button>
        </div>

        {r.images.length > 0 ? (
          <div className="flex gap-2 overflow-x-auto px-4 pb-2 snap-x snap-mandatory">
            {r.images.map((im, i) => (
              <img
                key={i}
                src={im.url}
                alt={im.caption ?? `Room ${r.roomNumber}`}
                className="h-56 w-[85%] shrink-0 object-cover rounded-lg snap-center"
              />
            ))}
          </div>
        ) : (
          <div className="mx-4 h-48 rounded-lg bg-bg grid place-items-center text-textSecondary/40">
            <BedDouble className="w-12 h-12" />
          </div>
        )}

        <div className="p-5 space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-xl font-semibold">Room {r.roomNumber}</div>
              <div className="text-sm text-textSecondary mt-0.5">
                {r.roomTypeLabel} · Floor {r.floor}
              </div>
              {r.roomTypeDescription && (
                <p className="text-sm text-textSecondary mt-2 leading-relaxed">{r.roomTypeDescription}</p>
              )}
            </div>
            <div className="text-right shrink-0">
              <div className="font-bold text-textPrimary text-lg">{inr(r.baseRate)}</div>
              <div className="text-[10px] text-textSecondary">per night</div>
            </div>
          </div>

          <div>
            <div className="text-xs uppercase tracking-widest text-textSecondary font-semibold mb-2">
              What's included
            </div>
            <div className="flex flex-wrap gap-2">
              {chips.map((c, i) => (
                <span
                  key={i}
                  className="inline-flex items-center gap-1.5 rounded-full bg-bg border border-borderc px-3 py-1.5 text-xs"
                >
                  <Check className="w-3.5 h-3.5 text-brand-deep" /> {c}
                </span>
              ))}
            </div>
          </div>

          <PrimaryButton onClick={onSelect}>
            {selected ? "Selected ✓" : "Select this room"}
          </PrimaryButton>
        </div>
      </div>
    </div>
  );
}

// ---- local primitives -----------------------------------------------------

function RoundBtn({ children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className="h-9 w-9 rounded-full border border-borderc text-lg text-textPrimary grid place-items-center disabled:opacity-40 active:scale-95 transition"
      {...rest}
    >
      {children}
    </button>
  );
}

function BackRow({ onClick, title }: { onClick: () => void; title: string }) {
  return (
    <div className="flex items-center gap-2 -mt-1">
      <button
        onClick={onClick}
        className="w-8 h-8 rounded-full grid place-items-center hover:bg-bg transition"
        aria-label="Back"
      >
        <ChevronLeft className="w-5 h-5" />
      </button>
      <div className="font-semibold text-lg">{title}</div>
    </div>
  );
}
