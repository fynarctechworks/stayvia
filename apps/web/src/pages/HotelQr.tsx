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
  Clock,
  FileImage,
  IdCard,
  LayoutDashboard,
  Loader2,
  MapPin,
  Plus,
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
  QrSuggestInput,
  QrTopNav,
  QrSelect,
  qrFormatTime,
  qrInputClass,
} from "@/components/qrKit";
import { ID_PROOF_NUMBER_RULES } from "@stayvia/shared";
import { citiesForState } from "@/lib/indianCities";
import { INDIAN_STATES, INDIAN_UNION_TERRITORIES } from "@/lib/indianStates";
import { EmailInput } from "@/components/EmailInput";
import { ID_PROOF_SPECS, inr, inr0, sanitizeIdProofNumber } from "@/lib/utils";
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
  const [numChildren, setNumChildren] = useState(0);
  const [detailRoom, setDetailRoom] = useState<QrCatalogRoom | null>(null);
  const [showStayOptions, setShowStayOptions] = useState(false);
  const [activeType, setActiveType] = useState<string>("all");

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
  // KYC photos captured on the guest's phone. Photo + ID front are required
  // (same rule as the staff walk-in form); back is optional.
  const [kycPhoto, setKycPhoto] = useState<File | null>(null);
  const [kycFront, setKycFront] = useState<File | null>(null);
  const [kycBack, setKycBack] = useState<File | null>(null);
  const [kycNote, setKycNote] = useState("");

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

  // GST preview — mirrors the server's /book math exactly (slab from the
  // AVERAGE nightly rate, then the property's mode; see apps/api/src/lib/
  // gst.ts + routes/qr.ts). Inclusive mode: GST is a straight % OF the
  // gross and the quoted price already contains it. Exclusive: added on top.
  const gst = useMemo(() => {
    if (!catalog || chosenRooms.length === 0) return null;
    const { gstSlabs: sl, gstMode } = catalog.hotel;
    const avgRate = perNight / chosenRooms.length;
    const rate =
      avgRate < sl.exemptBelow ? 0 : avgRate <= sl.lowMax ? sl.lowRate : sl.highRate;
    const gross = +(perNight * nights).toFixed(2);
    let subtotal: number, gstAmount: number, grandTotal: number;
    if (gstMode === "inclusive") {
      grandTotal = gross;
      gstAmount = +(grandTotal * (rate / 100)).toFixed(2);
      subtotal = +(grandTotal - gstAmount).toFixed(2);
    } else {
      subtotal = gross;
      gstAmount = +(subtotal * (rate / 100)).toFixed(2);
      grandTotal = +(subtotal + gstAmount).toFixed(2);
    }
    const cgst = +(gstAmount / 2).toFixed(2);
    return { rate, mode: gstMode, subtotal, gstAmount, cgst, sgst: +(gstAmount - cgst).toFixed(2), grandTotal };
  }, [catalog, chosenRooms.length, perNight, nights]);

  // "+ GST" is only true when the property adds tax on top; inclusive
  // properties quote a price that already contains it.
  const gstSuffix =
    catalog?.hotel.gstMode === "inclusive" ? "GST included" : "+ GST";

  // Toggle one specific room. Global cap 3 rooms per booking. Picking a
  // room pops the stay-options sheet right away (nights/guests/total);
  // deselecting never does.
  function toggleRoom(id: string) {
    const adding = !selected.includes(id);
    if (adding && selected.length >= 3) return;
    setSelected((prev) =>
      adding ? [...prev, id] : prev.filter((x) => x !== id),
    );
    if (adding) setShowStayOptions(true);
  }

  const detailsValid =
    fullName.trim().length >= 2 &&
    /^[6-9]\d{9}$/.test(phone) &&
    gender !== "" &&
    (ID_PROOF_NUMBER_RULES[idProofType]?.regex.test(idProofNumber) ??
      idProofNumber.length >= 4) &&
    nationality.trim() !== "" &&
    state.trim() !== "" &&
    city.trim() !== "" &&
    address.trim() !== "" &&
    kycPhoto !== null &&
    kycFront !== null;

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
        kycUploadKey?: string;
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
        numChildren,
        roomIds: selected,
        ...(specialRequests.trim() ? { specialRequests: specialRequests.trim() } : {}),
      });
      // Attach the ID photos to the booking. Failure is non-fatal — the
      // hold exists either way; the desk captures documents at check-in.
      if (r.kycUploadKey && (kycPhoto || kycFront || kycBack)) {
        try {
          const form = new FormData();
          form.append("key", r.kycUploadKey);
          if (kycPhoto) form.append("photo", kycPhoto);
          if (kycFront) form.append("front", kycFront);
          if (kycBack) form.append("back", kycBack);
          await publicQr.upload(`/public/qr/hotel/${token}/kyc`, form);
          setKycNote("ID documents received.");
        } catch {
          setKycNote("Documents could not be uploaded - the desk will take them at check-in.");
        }
      }
      setResult(r);
      setStep("done");
    } catch (e) {
      setError(e instanceof PublicApiError ? e.message : "Booking failed. Try again.");
      // Somebody else took a room while this guest was filling the form —
      // the catalog on screen is stale, so refetch it and drop the picks
      // that no longer exist before sending them back to browse.
      if (e instanceof PublicApiError && e.code === "ROOM_TAKEN") {
        try {
          const fresh = await publicQr.get<QrCatalog>(`/public/qr/hotel/${token}`);
          setCatalog(fresh);
          const stillFree = new Set(fresh.rooms.map((r) => r.id));
          setSelected((prev) => prev.filter((id) => stillFree.has(id)));
        } catch {
          /* leave the stale catalog; the error message still explains it */
        }
        setStep("browse");
      }
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
        logoUrl={catalog.hotel.logoUrl}
        phone={catalog.hotel.phone || undefined}
        eyebrow={<>Direct booking</>}
        meta={
          <>
            {catalog.hotel.address && (
              <span className="inline-flex items-center gap-1 min-w-0">
                <MapPin className="w-3 h-3 text-brand shrink-0" />
                <span className="truncate">{catalog.hotel.address}</span>
              </span>
            )}
            <span className="inline-flex items-center gap-1 shrink-0">
              <Clock className="w-3 h-3 text-brand" /> Check-in {qrFormatTime(catalog.hotel.checkInTime)}
            </span>
            <span className="inline-flex items-center gap-1 shrink-0">
              <Check className="w-3 h-3 text-brand" /> Pay at the desk
            </span>
          </>
        }
      />

      <main className="max-w-md mx-auto px-4 pt-4 pb-32 space-y-4 relative">
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
                const shownCats =
                  activeType === "all" ? cats : cats.filter((c) => c.slug === activeType);
                // Stats in the band describe what is actually listed below,
                // not the whole hotel — otherwise the count contradicts the
                // list whenever a category filter is on.
                const shownRooms = shownCats.flatMap((c) => c.rooms);
                const fromRate = Math.min(...shownRooms.map((r) => r.baseRate));
                return (
                  <>
                    {/* Arrival band — a warm greeting that sets the tone
                        without needing a hero photo. */}
                    <div className="rounded-2xl bg-brand-softer border border-brand/15 px-4 py-3">
                      <div className="text-[15px] font-bold text-brand-dark capitalize">
                        Tonight at {catalog.hotel.name}
                      </div>
                      <p className="text-[12px] text-textSecondary mt-0.5">
                        Rooms ready now — reserve in a tap, settle at the front desk.
                      </p>
                    </div>

                    {/* Round photo category thumbnails — tap to filter the
                        list below. "All" first, then one per room type. */}
                    <div className="-mx-4 px-4 overflow-x-auto">
                      <div className="flex gap-3 w-max py-1.5">
                        <CategoryCircle
                          label="All"
                          active={activeType === "all"}
                          onClick={() => setActiveType("all")}
                        />
                        {cats.map((cat) => (
                          <CategoryCircle
                            key={cat.slug}
                            label={cat.label}
                            cover={cat.cover}
                            hasAc={cat.hasAc}
                            active={activeType === cat.slug}
                            onClick={() => setActiveType(cat.slug)}
                          />
                        ))}
                      </div>
                    </div>

                    <div className="flex items-center gap-2.5 px-1">
                      {/* Live-availability pulse. */}
                      <span className="relative flex h-2 w-2 shrink-0">
                        <span className="absolute inline-flex h-full w-full rounded-full bg-brand opacity-60 animate-ping" />
                        <span className="relative inline-flex h-2 w-2 rounded-full bg-brand-deep" />
                      </span>
                      <span className="text-[13px] font-semibold uppercase tracking-[0.12em] text-brand-dark">
                        Free tonight
                      </span>
                      <span className="font-mono text-[13px] text-textSecondary">
                        {activeType === "all"
                          ? shownRooms.length
                          : `${shownRooms.length} of ${catalog.rooms.length}`}
                      </span>
                      <span className="flex-1 h-px bg-borderc" />
                      <span className="text-[11px] text-textSecondary whitespace-nowrap">
                        from <span className="font-mono">{inr0(fromRate)}</span>
                      </span>
                    </div>

                    {shownCats.map((cat) => (
                      <div key={cat.slug} className="space-y-2.5">
                        <div className="flex items-center gap-2 px-1 pt-1">
                          <span className="w-1 h-4 rounded-full bg-brand-deep shrink-0" />
                          <h3 className="text-[12px] font-bold uppercase tracking-[0.14em] text-brand-dark">
                            {cat.label}
                          </h3>
                          <span className="flex-1 h-px bg-borderc/70" />
                          <span className="text-[11px] text-textSecondary whitespace-nowrap">
                            {cat.rooms.length} room{cat.rooms.length === 1 ? "" : "s"} · from{" "}
                            <span className="font-mono">{inr0(cat.fromRate)}</span>
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
                            gstNote={gstSuffix}
                          />
                        ))}
                      </div>
                    ))}
                  </>
                );
              })()}

          </>
        )}

        {/* ---- details ---- */}
        {step === "details" && (
          <>
          {/* Booking breakdown — the full picture above the identity form:
              stay facts, one line per room with its rate math, and the
              pre-GST total with honest GST/payment wording. The exact GST
              is computed by the desk at confirmation, so it is never
              guessed here. */}
          <Card className="!p-4 space-y-3">
            <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-brand-deep">
              Your booking
            </div>

            <div className="grid grid-cols-2 gap-2 text-sm">
              <div className="rounded-md bg-bg border border-borderc/60 px-3 py-2">
                <div className="text-[10px] uppercase tracking-wider text-textSecondary">Check-in</div>
                <div className="font-semibold mt-0.5">
                  Tonight · {qrFormatTime(catalog.hotel.checkInTime)}
                </div>
              </div>
              <div className="rounded-md bg-bg border border-borderc/60 px-3 py-2">
                <div className="text-[10px] uppercase tracking-wider text-textSecondary">Stay</div>
                <div className="font-semibold mt-0.5">
                  {nights} night{nights === 1 ? "" : "s"} · {numAdults} adult
                  {numAdults === 1 ? "" : "s"}
                  {numChildren > 0
                    ? ` · ${numChildren} child${numChildren === 1 ? "" : "ren"}`
                    : ""}
                </div>
              </div>
            </div>

            <div className="divide-y divide-borderc/60">
              {chosenRooms.map((r) => (
                <div key={r.id} className="flex items-center justify-between gap-2 py-2">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold flex items-center gap-1.5">
                      <BedDouble className="w-3.5 h-3.5 text-brand-deep shrink-0" />
                      Room {r.roomNumber}
                    </div>
                    <div className="text-[11px] text-textSecondary mt-0.5">
                      {r.roomTypeLabel} · {inr0(r.baseRate)}/night × {nights} night
                      {nights === 1 ? "" : "s"}
                    </div>
                  </div>
                  <div className="font-mono font-semibold text-sm shrink-0">
                    {inr0(r.baseRate * nights)}
                  </div>
                </div>
              ))}
            </div>

            {gst && (
              <div className="border-t border-borderc pt-2.5 space-y-1.5 text-sm">
                <div className="flex items-center justify-between text-textSecondary">
                  <span>Room charges{gst.mode === "inclusive" ? " (before tax)" : ""}</span>
                  <span className="font-mono">{inr(gst.subtotal)}</span>
                </div>
                <div className="flex items-center justify-between text-textSecondary">
                  <span>CGST @ {gst.rate / 2}%</span>
                  <span className="font-mono">{inr(gst.cgst)}</span>
                </div>
                <div className="flex items-center justify-between text-textSecondary">
                  <span>SGST @ {gst.rate / 2}%</span>
                  <span className="font-mono">{inr(gst.sgst)}</span>
                </div>
                <div className="flex items-center justify-between border-t border-borderc pt-2 mt-1">
                  <span className="font-semibold">Total to pay</span>
                  <span className="font-mono font-bold text-lg text-textPrimary">
                    {inr(gst.grandTotal)}
                  </span>
                </div>
              </div>
            )}
            <p className="text-[11px] text-textSecondary leading-snug">
              {gst?.mode === "inclusive"
                ? "Room prices include GST."
                : "GST added as shown."}{" "}
              Nothing is charged online — you pay at the hotel when the desk
              confirms your booking.
            </p>
          </Card>

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
              <EmailInput
                className={qrInputClass}
                placeholder="guest@example.com"
                value={email}
                onChange={setEmail}
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
                  onChange={(v) => {
                    setState(v);
                    // The city list is state-scoped; keeping the old city
                    // would submit a mismatched address pair.
                    setCity("");
                  }}
                  options={[...INDIAN_STATES, ...INDIAN_UNION_TERRITORIES].map((s) => ({
                    value: s,
                    label: s,
                  }))}
                />
              </QrField>
            </div>
            <QrField label="City">
              <QrSuggestInput
                value={city}
                onChange={setCity}
                options={citiesForState(state)}
                placeholder={state ? `Cities in ${state}…` : "Pick a state first"}
              />
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
            <div>
              <div className="text-[12px] font-medium text-textPrimary">ID photos</div>
              <p className="text-[11px] text-textSecondary mt-0.5 mb-2">
                A photo of you and the front of your ID. The desk matches them
                at check-in.
              </p>
              <div className="grid grid-cols-3 gap-2">
                <QrUploadTile label="Your photo" required file={kycPhoto} onPick={setKycPhoto} />
                <QrUploadTile label="ID front" required file={kycFront} onPick={setKycFront} />
                <QrUploadTile label="ID back" file={kycBack} onPick={setKycBack} />
              </div>
            </div>

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
          </>
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
                `Confirm booking · ${inr0(gst ? gst.grandTotal : total)}`
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
            {kycNote && (
              <p className="text-[11px] text-textSecondary -mt-2">{kycNote}</p>
            )}
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
        <div
          className="fixed bottom-0 inset-x-0 z-40 bg-white/95 backdrop-blur border-t border-borderc shadow-[0_-4px_16px_rgba(0,0,0,0.06)] animate-in fade-in slide-in-from-bottom-2"
          style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
        >
          <div className="max-w-md mx-auto px-4 py-3 flex items-center gap-3">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1 font-mono font-bold text-xl text-brand-dark leading-none">
                <BadgeIndianRupee className="w-4 h-4 text-brand-deep" />
                {inr0(gst ? gst.grandTotal : total)}
              </div>
              <div className="text-[11px] text-textSecondary mt-1">
                {selected.length} room{selected.length === 1 ? "" : "s"} · {nights} night
                {nights === 1 ? "" : "s"} · {gstSuffix}
              </div>
            </div>
            <PrimaryButton className="!w-auto px-6" onClick={() => setStep("details")}>
              Continue
            </PrimaryButton>
          </div>
        </div>
      )}

      {/* Stay options — bottom-sheet overlay for nights + guests. Opens
          from Continue; confirming proceeds to the details step. */}
      {showStayOptions && (
        <div
          className="fixed inset-0 z-50 flex flex-col justify-end bg-black/50 animate-in fade-in"
          onClick={() => setShowStayOptions(false)}
        >
          <div
            className="bg-white rounded-t-2xl animate-in slide-in-from-bottom-4"
            style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 pt-3 pb-1">
              <div className="w-9" />
              <div className="w-10 h-1 rounded-full bg-borderc" />
              <button
                onClick={() => setShowStayOptions(false)}
                className="w-9 h-9 rounded-full grid place-items-center hover:bg-bg"
                aria-label="Close"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="max-w-md mx-auto w-full px-5 pb-5 space-y-4">
              <div className="text-lg font-semibold">Your stay</div>
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Nights</span>
                <div className="flex items-center gap-1.5">
                  {[1, 2, 3].map((n) => (
                    <button
                      key={n}
                      onClick={() => setNights(n)}
                      className={`h-10 w-10 rounded-md font-semibold transition ${
                        nights === n
                          ? "bg-brand text-white"
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
                <span className="text-sm font-medium">Adults</span>
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
              <div className="h-px bg-borderc/60" />
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Children</span>
                <div className="flex items-center gap-3">
                  <RoundBtn disabled={numChildren <= 0} onClick={() => setNumChildren((v) => v - 1)}>
                    −
                  </RoundBtn>
                  <span className="min-w-6 text-center font-semibold">{numChildren}</span>
                  <RoundBtn disabled={numChildren >= 6} onClick={() => setNumChildren((v) => v + 1)}>
                    +
                  </RoundBtn>
                </div>
              </div>
              <div className="h-px bg-borderc/60" />
              <div className="flex items-center justify-between text-sm">
                <span className="text-textSecondary">
                  {selected.length} room{selected.length === 1 ? "" : "s"} · {nights} night
                  {nights === 1 ? "" : "s"} · {gstSuffix}
                </span>
                <span className="font-mono font-bold text-textPrimary">
                  {inr0(gst ? gst.grandTotal : total)}
                </span>
              </div>
              <PrimaryButton onClick={() => setShowStayOptions(false)}>
                Done
              </PrimaryButton>
              <p className="text-[11px] text-textSecondary text-center -mt-1">
                You can keep adding rooms — tap Continue below when ready.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Room photos + details sheet */}
      {detailRoom && (
        <RoomDetailSheet
          room={detailRoom}
          selected={selected.includes(detailRoom.id)}
          atCap={!selected.includes(detailRoom.id) && selected.length >= 3}
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
// Round photo category thumbnail (destination-circle style). Cover photo,
// or a soft icon circle when the type has no photo. Active = brand ring.
function CategoryCircle({
  label,
  cover,
  hasAc,
  active,
  onClick,
}: {
  label: string;
  cover?: string;
  hasAc?: boolean;
  active: boolean;
  onClick: () => void;
}) {
  const isAll = label === "All";
  const Icon = isAll ? LayoutDashboard : hasAc ? Snowflake : BedDouble;
  return (
    <button onClick={onClick} className="flex flex-col items-center gap-1.5 w-16 shrink-0">
      <span
        className={`relative w-16 h-16 rounded-2xl overflow-hidden grid place-items-center transition ${
          active ? "ring-2 ring-brand shadow-sm" : "border border-borderc"
        }`}
      >
        {cover && !isAll ? (
          <>
            <img src={cover} alt={label} className="w-full h-full object-cover" />
            <span className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-black/30 to-transparent" />
          </>
        ) : (
          <span className="w-full h-full bg-brand-soft text-brand-deep grid place-items-center">
            <Icon className="w-6 h-6" />
          </span>
        )}
      </span>
      <span
        className={`text-[11px] leading-tight text-center capitalize truncate max-w-full ${
          active ? "font-semibold text-brand-dark" : "text-textSecondary"
        }`}
      >
        {label.toLowerCase()}
      </span>
    </button>
  );
}

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
        // First available photo of the type — used for the round category
        // thumbnail. Undefined falls back to an icon.
        cover: sorted.flatMap((r) => r.images)[0]?.url,
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
  gstNote,
}: {
  room: QrCatalogRoom;
  active: boolean;
  disabled: boolean;
  onToggle: () => void;
  onDetails: () => void;
  gstNote: string;
}) {
  const cover = r.images[0]?.url;
  return (
    <div
      className={`bg-white rounded-2xl border overflow-hidden transition shadow-[0_1px_2px_rgba(0,0,0,0.04)] ${
        active
          ? "border-brand ring-2 ring-brand shadow-[0_4px_16px_rgba(62,207,142,0.18)]"
          : "border-borderc"
      }`}
    >
      {/* Cover photo — or a designed branded plate when the room has none */}
      <button onClick={onDetails} className="group relative block w-full h-44 overflow-hidden">
        {cover ? (
          <img
            src={cover}
            alt={`Room ${r.roomNumber}`}
            className="absolute inset-0 w-full h-full object-cover transition duration-500 group-active:scale-[1.02]"
          />
        ) : (
          <EmptyRoomArt roomNumber={r.roomNumber} label={r.roomTypeLabel} />
        )}
        <span className="absolute inset-x-0 bottom-0 h-20 bg-gradient-to-t from-black/45 via-black/10 to-transparent" />
        <span className="absolute top-3 left-3 bg-brand-dark/70 backdrop-blur text-cream text-[11px] font-semibold rounded-full px-2.5 py-1 ring-1 ring-white/10">
          {r.roomTypeLabel}
        </span>
        {r.images.length > 0 && (
          <span className="absolute bottom-3 right-3 bg-black/45 backdrop-blur ring-1 ring-white/10 text-white text-[10px] rounded-full px-2 py-0.5 inline-flex items-center gap-1">
            <FileImage className="w-3 h-3" /> {r.images.length}
          </span>
        )}
        {active && (
          <span className="absolute top-3 right-3 w-6 h-6 rounded-full bg-brand text-white grid place-items-center shadow">
            <Check className="w-4 h-4" />
          </span>
        )}
      </button>

      <div className="p-3.5">
        <div className="flex items-start justify-between gap-2">
          <button onClick={onDetails} className="text-left min-w-0">
            <div className="font-bold text-[15px] leading-tight">Room {r.roomNumber}</div>
            <div className="text-[11px] text-textSecondary mt-0.5">Floor {r.floor}</div>
          </button>
          <div className="text-right shrink-0">
            <div className="font-mono font-bold text-[18px] text-brand-dark leading-none">
              {inr0(r.baseRate)}
            </div>
            <div className="text-[10px] text-textSecondary mt-1">per night · {gstNote}</div>
          </div>
        </div>

        {/* Feature chips */}
        <div className="flex flex-wrap gap-1.5 mt-2.5">
          <span className="inline-flex items-center gap-1 rounded-full bg-brand-soft text-brand-deep px-2.5 py-1 text-[11px] font-medium">
            <Users className="w-3 h-3" /> Sleeps {r.maxOccupancy}
          </span>
          <span className="inline-flex items-center gap-1 rounded-full bg-brand-soft text-brand-deep px-2.5 py-1 text-[11px] font-medium">
            <Snowflake className="w-3 h-3" /> {r.hasAc ? "AC" : "Non-AC"}
          </span>
          {r.hasWifi && (
            <span className="inline-flex items-center gap-1 rounded-full bg-brand-soft text-brand-deep px-2.5 py-1 text-[11px] font-medium">
              <Wifi className="w-3 h-3" /> Free WiFi
            </span>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 mt-3.5">
          <span className="inline-flex items-center gap-1 text-[11px] font-medium text-brand-deep">
            <Check className="w-3.5 h-3.5" /> Pay at the hotel
          </span>
          <button
            onClick={onToggle}
            disabled={disabled}
            className={`h-9 px-5 rounded-full text-[13px] font-semibold transition disabled:opacity-40 inline-flex items-center gap-1 shadow-sm active:scale-95 ${
              active ? "bg-brand-dark text-cream" : "bg-brand text-white hover:bg-brand-light"
            }`}
          >
            {active ? (
              <>
                <Check className="w-3.5 h-3.5" /> Selected
              </>
            ) : (
              <>
                Select <Plus className="w-3.5 h-3.5" />
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

// Designed placeholder for rooms with no uploaded photo — a dark emerald
// plate (ties to the header) with a dot texture and the room number as an
// oversized mono watermark. Reads as intentional, never "missing image".
function EmptyRoomArt({ roomNumber, label }: { roomNumber: string; label: string }) {
  return (
    <div className="absolute inset-0 bg-gradient-to-br from-brand-dark via-brand-deep to-brand overflow-hidden grid place-items-center">
      <div className="absolute inset-0 opacity-[0.10] [background-image:radial-gradient(circle_at_1px_1px,#fff_1px,transparent_0)] [background-size:14px_14px]" />
      <span className="absolute -bottom-3 -right-1 font-mono font-bold text-[7rem] leading-none text-cream/10 select-none">
        {roomNumber}
      </span>
      <div className="relative flex flex-col items-center gap-1.5 text-cream/80">
        <BedDouble className="w-9 h-9" />
        <span className="text-[11px] font-medium tracking-wide capitalize">{label}</span>
      </div>
    </div>
  );
}

function RoomDetailSheet({
  room: r,
  selected,
  atCap,
  onClose,
  onSelect,
}: {
  room: QrCatalogRoom;
  selected: boolean;
  atCap: boolean;
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
          <div className="relative mx-4 h-48 rounded-lg overflow-hidden">
            <EmptyRoomArt roomNumber={r.roomNumber} label={r.roomTypeLabel} />
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

          <PrimaryButton onClick={onSelect} disabled={atCap}>
            {selected ? "Selected ✓" : atCap ? "Limit reached — 3 rooms max" : "Select this room"}
          </PrimaryButton>
          {atCap && (
            <p className="text-[11px] text-textSecondary text-center">
              You can book up to 3 rooms. Deselect one to swap.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

// Camera/gallery picker tile for the guest's KYC photos. Shows a preview
// thumbnail once picked; tapping again re-picks. capture-friendly input so
// phones offer the camera directly.
function QrUploadTile({
  label,
  file,
  onPick,
  required = false,
}: {
  label: string;
  file: File | null;
  onPick: (f: File | null) => void;
  required?: boolean;
}) {
  const [preview, setPreview] = useState<string | null>(null);
  useEffect(() => {
    if (!file) {
      setPreview(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  return (
    <label
      className={`relative block rounded-xl border-2 border-dashed overflow-hidden cursor-pointer aspect-[4/5] ${
        file ? "border-brand" : "border-borderc hover:border-brand/60"
      }`}
    >
      <input
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="sr-only"
        onChange={(e) => onPick(e.target.files?.[0] ?? null)}
      />
      {preview ? (
        <>
          <img src={preview} alt={label} className="absolute inset-0 w-full h-full object-cover" />
          <span className="absolute bottom-0 inset-x-0 bg-brand-dark/70 text-cream text-[9px] font-semibold text-center py-1">
            {label} ✓
          </span>
        </>
      ) : (
        <span className="absolute inset-0 grid place-items-center p-1.5 text-center">
          <span>
            <Plus className="w-4 h-4 mx-auto text-brand-deep" />
            <span className="block text-[10px] font-medium text-textPrimary mt-1 leading-tight">
              {label}
              {required && <span className="text-dangerFg"> *</span>}
            </span>
          </span>
        </span>
      )}
    </label>
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
