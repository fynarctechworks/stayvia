import { useState } from "react";
import {
  ArrowRight,
  BedDouble,
  CalendarCheck,
  Check,
  FileText,
  Lock,
  Menu,
  MessageCircle,
  QrCode,
  Receipt,
  ShieldCheck,
  Sparkles,
  Users,
  Wifi,
  X,
} from "./micons";

// Where the product lives. Point at the deployed app in production via
// VITE_APP_URL; falls back to the local dev app.
const APP_URL = import.meta.env.VITE_APP_URL ?? "http://localhost:5180";
const SIGNUP = `${APP_URL}/signup`;
const LOGIN = `${APP_URL}/login`;

// Page shell. Warm paper canvas, matching the product app — a visitor who
// clicks "Start free trial" should feel they stayed inside the same product.
export default function App() {
  return (
    <div className="min-h-screen bg-bg text-ink antialiased">
      <Nav />
      <Hero />
      <ProofStrip />
      <Features />
      <QrSpotlight />
      <HowItWorks />
      <Boundaries />
      <Pricing />
      <Faq />
      <FinalCta />
      <Footer />
    </div>
  );
}

/* Shared -------------------------------------------------------------- */

// Full-bleed: content fills the viewport with responsive gutters, the
// same call the product app made.
const SHELL = "w-full px-5 sm:px-8 md:px-12 xl:px-20";

function SectionHead({
  eyebrow,
  title,
  sub,
  center = false,
}: {
  eyebrow: string;
  title: React.ReactNode;
  sub?: string;
  center?: boolean;
}) {
  return (
    <div className={center ? "max-w-3xl mx-auto text-center" : "max-w-3xl"}>
      <div
        className={`inline-flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.16em] text-brand-deep ${
          center ? "justify-center" : ""
        }`}
      >
        <span className="w-5 h-px bg-gold" />
        {eyebrow}
      </div>
      <h2 className="mt-3 text-[clamp(26px,4vw,38px)] font-semibold leading-[1.12] tracking-[-0.5px] text-ink">
        {title}
      </h2>
      {sub && <p className="mt-3.5 text-[17px] leading-relaxed text-textSecondary">{sub}</p>}
    </div>
  );
}

function PrimaryCta({ children = "Start your free 14-day trial", className = "" }) {
  return (
    <a
      href={SIGNUP}
      className={`inline-flex items-center justify-center gap-2 h-12 px-6 rounded-md bg-brand text-white font-semibold shadow-primary hover:bg-brand-deep transition-colors ${className}`}
    >
      {children} <ArrowRight className="w-4 h-4" />
    </a>
  );
}

/* Nav ----------------------------------------------------------------- */

const NAV_LINKS: [string, string][] = [
  ["#features", "Features"],
  ["#how", "How it works"],
  ["#pricing", "Pricing"],
  ["#faq", "FAQ"],
];

function Nav() {
  const [open, setOpen] = useState(false);
  return (
    <header className="sticky top-0 z-40 bg-paper/85 backdrop-blur-[10px] border-b border-borderc">
      <div className={`${SHELL} h-16 flex items-center gap-4 sm:gap-6`}>
        <a href="#" className="flex items-center gap-2.5 shrink-0 min-h-[44px]">
          <img src="/logo.png" alt="" className="w-9 h-9 rounded-[11px] object-contain" />
          <span className="leading-none">
            <span className="block font-bold text-[17px] tracking-tight text-ink">Stayvia</span>
            <span className="block text-[9.5px] font-bold tracking-[0.18em] text-inkMuted mt-1">
              HOTEL OS
            </span>
          </span>
        </a>

        <nav className="hidden md:flex items-center gap-7 text-sm font-medium text-textSecondary ml-4">
          {NAV_LINKS.map(([href, label]) => (
            <a key={href} href={href} className="hover:text-ink transition-colors">
              {label}
            </a>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-2 sm:gap-3">
          <a
            href={LOGIN}
            className="hidden sm:inline-flex items-center h-11 px-4 rounded-md border border-borderControl bg-surface text-sm font-semibold text-ink hover:bg-surfaceAlt transition-colors"
          >
            Sign in
          </a>
          <a
            href={SIGNUP}
            className="inline-flex items-center h-11 px-4 rounded-md bg-brand text-white text-sm font-semibold shadow-primary hover:bg-brand-deep transition-colors"
          >
            Start free
          </a>
          {/* Below md the section links have nowhere to live, so they get a
              real menu instead of vanishing. */}
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-label={open ? "Close menu" : "Open menu"}
            className="md:hidden w-11 h-11 grid place-items-center rounded-md border border-borderControl bg-surface text-ink"
          >
            {open ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
        </div>
      </div>

      {open && (
        <div className="md:hidden border-t border-borderc bg-paper/95 backdrop-blur-[10px]">
          <nav className={`${SHELL} py-2 flex flex-col`}>
            {NAV_LINKS.map(([href, label]) => (
              <a
                key={href}
                href={href}
                onClick={() => setOpen(false)}
                className="flex items-center min-h-[48px] text-[15px] font-medium text-ink border-b border-divider last:border-0"
              >
                {label}
              </a>
            ))}
            <a
              href={LOGIN}
              className="flex items-center min-h-[48px] text-[15px] font-semibold text-brand-deep"
            >
              Sign in
            </a>
          </nav>
        </div>
      )}
    </header>
  );
}

/* Hero ---------------------------------------------------------------- */

function Hero() {
  return (
    <section className="relative">
      {/* Forest brand pane — the one dark surface Stayvia already owns (it
          backs the product's auth screens), so the site and the app share a
          signature instead of just a hue.

          The pane WRAPS the copy rather than being a fixed-height layer
          behind it: at 320px the headline is tall enough that a fixed
          560px pane left the cream text sitting on paper with ~10px to
          spare — one longer word from being unreadable. */}
      <div
        className="relative overflow-hidden bg-forest pb-24 sm:pb-32 md:pb-40"
        style={{
          backgroundImage:
            "radial-gradient(120% 90% at 20% 0%, #1A4A3A 0%, #10352A 45%, #0B281F 100%)",
        }}
      >
        <div
          aria-hidden
          className="absolute inset-0 opacity-[0.05]"
          style={{
            backgroundImage:
              "repeating-linear-gradient(135deg, #fff 0 1px, transparent 1px 12px)",
          }}
        />
        <div aria-hidden className="absolute inset-x-0 bottom-0 h-px bg-brass/25" />

        <div className={`${SHELL} relative pt-12 sm:pt-16 md:pt-20`}>
          <div className="max-w-[860px]">
          <span className="inline-flex items-center gap-2 rounded-full border border-brass/35 bg-white/[0.06] px-3.5 py-1.5 text-[11px] font-bold uppercase tracking-[0.18em] text-brass">
            Front office suite
          </span>
          <h1 className="mt-5 sm:mt-6 text-[clamp(30px,7vw,58px)] font-semibold leading-[1.06] tracking-[-1px] text-cream">
            Run your hotel from{" "}
            <span className="font-[Georgia,serif] italic text-brass">one desk.</span>
          </h1>
          <p className="mt-4 sm:mt-5 text-[15.5px] sm:text-[17px] md:text-[19px] leading-relaxed text-cream/70 max-w-[680px]">
            Reservations, GST invoices, guest KYC, housekeeping, WhatsApp updates and
            contactless QR check-in — one calm workspace built for independent Indian
            hotels.
          </p>
          <div className="mt-7 sm:mt-8 flex flex-col sm:flex-row sm:flex-wrap items-stretch sm:items-center gap-3">
              <PrimaryCta />
              <a
                href="#pricing"
                className="inline-flex items-center justify-center h-12 px-6 rounded-md border border-cream/25 text-cream font-semibold hover:border-brass hover:text-brass transition-colors"
              >
                See pricing
              </a>
            </div>
            <p className="mt-5 text-[13px] sm:text-sm text-cream/45">
              ₹999/month · No card required · Cancel anytime
            </p>
          </div>
        </div>
      </div>

      {/* Mock straddles the pane edge: pulled up over the forest, ending on
          paper. The pull must stay smaller than the pane's bottom padding —
          the difference is the band of bare forest under the copy. Keep the
          mock itself margin-free, or its top margin collapses with this one
          and eats most of the overlap. */}
      <div className={`${SHELL} relative -mt-14 sm:-mt-20 md:-mt-24`}>
        <DashboardMock />
      </div>
    </section>
  );
}

// Pure-CSS product surface. No screenshots to go stale, and it renders
// crisply at any width.
function DashboardMock() {
  return (
    <div className="rounded-2xl border border-borderc bg-surface shadow-lift overflow-hidden">
      <div className="flex items-center gap-2 px-4 h-11 bg-surfaceAlt border-b border-divider">
        <span className="w-2.5 h-2.5 rounded-full bg-borderControl" />
        <span className="w-2.5 h-2.5 rounded-full bg-borderControl" />
        <span className="w-2.5 h-2.5 rounded-full bg-borderControl" />
        <span className="ml-3 text-[11px] font-medium text-inkMuted">
          Dashboard · Seaview Residency
        </span>
      </div>

      <div className="p-4 sm:p-6 grid gap-4 lg:grid-cols-[1.15fr_1fr]">
        <div className="space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { k: "Occupancy", v: "18 / 24", s: "75% tonight", tone: "brand" },
              { k: "Arrivals", v: "6", s: "2 pending" },
              { k: "Departures", v: "4", s: "1 overdue" },
              { k: "Revenue", v: "₹42,300", s: "collected" },
            ].map((t) => (
              <div
                key={t.k}
                className={`rounded-[14px] border p-3.5 ${
                  t.tone === "brand"
                    ? "border-brand/25 bg-brand-soft"
                    : "border-borderc bg-surface"
                }`}
              >
                <div className="text-[10px] font-bold uppercase tracking-[0.08em] text-inkMuted">
                  {t.k}
                </div>
                <div className="mt-1.5 font-mono text-[19px] font-bold text-ink leading-none">
                  {t.v}
                </div>
                <div className="mt-1.5 text-[10.5px] text-textSecondary">{t.s}</div>
              </div>
            ))}
          </div>

          <div className="rounded-[14px] border border-borderc p-4">
            <div className="text-[11px] font-bold uppercase tracking-[0.1em] text-inkMuted">
              Rooms right now
            </div>
            <div className="mt-3 flex h-2 rounded-full overflow-hidden">
              <span className="w-[54%] bg-inkDark" />
              <span className="w-[12%] bg-info" />
              <span className="w-[26%] bg-brand" />
              <span className="w-[8%] bg-gold" />
            </div>
            <div className="mt-3.5 grid grid-cols-4 sm:grid-cols-8 gap-1.5">
              {["101", "102", "103", "104", "201", "202", "203", "204"].map((n, i) => (
                <div
                  key={n}
                  className={`rounded-[9px] px-1.5 py-2 text-center font-mono text-[11px] font-bold ${
                    i < 4
                      ? "bg-inkDark text-cream"
                      : i === 4
                        ? "bg-warnBg text-warnFg border border-warnBorder"
                        : "bg-surfaceAlt text-ink border border-borderc"
                  }`}
                >
                  {n}
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="space-y-3">
          <div className="rounded-[14px] border border-borderc p-4">
            <div className="text-[11px] font-bold uppercase tracking-[0.1em] text-inkMuted">
              Today's arrivals
            </div>
            <div className="mt-2.5 divide-y divide-divider">
              {[
                ["Ravi Kumar", "204", "Checked in", true],
                ["Anita Sharma", "108", "2:00 PM", false],
                ["M. Srinivas", "305", "6:00 PM", false],
              ].map(([name, room, status, done]) => (
                <div key={name as string} className="flex items-center gap-2.5 py-2.5">
                  <span className="w-7 h-7 rounded-full bg-brand-soft text-brand-deep grid place-items-center text-[10px] font-bold shrink-0">
                    {(name as string)
                      .split(" ")
                      .map((w) => w[0])
                      .join("")
                      .slice(0, 2)}
                  </span>
                  <span className="text-[13px] font-medium text-ink flex-1 min-w-0 truncate">
                    {name}
                  </span>
                  <span className="font-mono text-[11px] text-inkMuted">{room}</span>
                  <span
                    className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${
                      done
                        ? "bg-successBg text-success border-successBorder"
                        : "bg-warnBg text-warnFg border-warnBorder"
                    }`}
                  >
                    {status}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-[14px] border border-successBorder bg-successBg p-3.5 flex items-center gap-2.5">
            <Receipt className="w-4 h-4 text-success shrink-0" />
            <span className="text-[12.5px] font-semibold text-success flex-1">
              GST invoice INV-0042 issued
            </span>
            <span className="text-[10.5px] text-success/80">sent on WhatsApp</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/* Proof strip --------------------------------------------------------- */

function ProofStrip() {
  const items: [string, string][] = [
    ["Built for", "10–50 room hotels run by the owner"],
    ["Instead of", "a register, a diary and three WhatsApp groups"],
    ["Set up in", "an afternoon, from a phone if you like"],
    ["Costs", "₹999 a month — flat, every room included"],
  ];
  return (
    <section className="border-y border-borderc bg-surfaceAlt">
      <div className={`${SHELL} py-8 grid sm:grid-cols-2 lg:grid-cols-4 gap-px bg-borderc`}>
        {items.map(([k, v]) => (
          <div key={k} className="bg-surfaceAlt sm:px-6 first:pl-0 py-2">
            <div className="text-[10.5px] font-bold uppercase tracking-[0.1em] text-inkMuted">
              {k}
            </div>
            <div className="mt-1.5 text-[15px] font-medium leading-snug text-ink">{v}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

/* Features ------------------------------------------------------------ */

const FEATURES = [
  {
    icon: CalendarCheck,
    title: "Reservations & walk-ins",
    body: "Pre-bookings, walk-in check-ins, room swaps, extensions and day-use stays - with a live calendar your whole desk can read at a glance.",
  },
  {
    icon: Receipt,
    title: "GST invoicing that's audit-ready",
    body: "CGST/SGST slabs applied automatically, sequential invoice numbers per hotel, credit notes, room-wise splits and clean PDF documents.",
  },
  {
    icon: MessageCircle,
    title: "WhatsApp built in",
    body: "Booking confirmations, OTP-verified check-ins, receipts and owner alerts land on WhatsApp - the one app every guest already has.",
  },
  {
    icon: Lock,
    title: "Guest KYC, encrypted",
    body: "Aadhaar and ID photos captured at check-in, stored encrypted, masked from junior staff. Ready when the authorities ask.",
  },
  {
    icon: Sparkles,
    title: "Housekeeping board",
    body: "Dirty → clean → inspected in one tap. Maintenance issues tracked per room so nothing gets rented out broken.",
  },
  {
    icon: FileText,
    title: "Reports & daily cash-up",
    body: "Occupancy, revenue, collections by payment method, outstanding balances and a day book your accountant will actually like.",
  },
  {
    icon: Users,
    title: "Staff roles & permissions",
    body: "Front desk, housekeeping, accountant - each sees exactly what their job needs. Every action lands in the activity log.",
  },
  {
    icon: BedDouble,
    title: "Unlimited rooms & staff",
    body: "One flat price. Add every room, every floor and your whole team without watching a meter.",
  },
];

function Features() {
  return (
    <section id="features" className={`${SHELL} py-20 md:py-24`}>
      <SectionHead
        eyebrow="Everything included"
        title="Everything the front desk does, in one place"
        sub="Built for 10–50 room independent hotels and lodges — not a stripped-down version of enterprise software."
      />
      <div className="mt-12 grid sm:grid-cols-2 lg:grid-cols-4 2xl:grid-cols-4 gap-4">
        {FEATURES.map((f) => (
          <div
            key={f.title}
            className="rounded-2xl border border-borderc bg-surface p-5 shadow-card hover:-translate-y-0.5 hover:shadow-lift transition-all duration-150"
          >
            <div className="w-11 h-11 rounded-[13px] bg-brand-soft grid place-items-center">
              <f.icon className="w-5 h-5 text-brand-deep" />
            </div>
            <h3 className="mt-4 font-semibold text-ink leading-snug">{f.title}</h3>
            <p className="mt-2 text-[13.5px] text-textSecondary leading-relaxed">{f.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

/* QR spotlight -------------------------------------------------------- */

// The newest and most differentiating capability earns its own band rather
// than sharing a grid cell with eight peers.
function QrSpotlight() {
  return (
    <section className="border-y border-borderc bg-surfaceAlt">
      <div className={`${SHELL} py-20 md:py-24 grid lg:grid-cols-2 gap-12 items-center`}>
        <div>
          <SectionHead
            eyebrow="Contactless"
            title={
              <>
                Let guests do the tapping,{" "}
                <span className="text-brand-deep">you stay in control.</span>
              </>
            }
            sub="Two QR codes do the work of a second receptionist — without ever taking a payment out of your hands."
          />
          <div className="mt-8 space-y-5">
            {[
              {
                icon: QrCode,
                t: "Scan-to-book at the desk",
                b: "Guests see tonight's free rooms and fill in their own KYC on their phone. It arrives as a request your desk confirms after checking the ID and taking payment.",
              },
              {
                icon: Wifi,
                t: "WiFi & service from the room",
                b: "A QR in every room hands over the WiFi and takes cleaning, amenity or maintenance requests. It switches itself off at checkout.",
              },
            ].map((r) => (
              <div key={r.t} className="flex gap-3.5">
                <span className="w-10 h-10 rounded-[13px] bg-brand-soft grid place-items-center shrink-0">
                  <r.icon className="w-5 h-5 text-brand-deep" />
                </span>
                <div>
                  <h3 className="font-semibold text-ink">{r.t}</h3>
                  <p className="mt-1 text-[13.5px] text-textSecondary leading-relaxed">{r.b}</p>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-7 inline-flex items-center gap-2 rounded-full bg-successBg border border-successBorder px-3.5 py-1.5 text-[12px] font-semibold text-success">
            <ShieldCheck className="w-3.5 h-3.5" /> Nothing is charged online — you take the money
          </div>
        </div>

        <PhoneMock />
      </div>
    </section>
  );
}

function PhoneMock() {
  return (
    <div className="mx-auto w-full max-w-[300px]">
      <div className="rounded-[26px] border-[6px] border-inkDark bg-surface overflow-hidden shadow-lift">
        <div className="bg-inkDark px-4 pt-3 pb-4">
          <div className="text-[9px] font-bold uppercase tracking-[0.18em] text-brand">
            Direct booking
          </div>
          <div className="mt-1 text-[15px] font-bold text-cream">Seaview Residency</div>
          <div className="mt-1.5 text-[9.5px] text-cream/60">
            Check-in 12:00 PM · Pay at the desk
          </div>
        </div>
        <div className="p-3 space-y-2.5 bg-bg">
          <div className="text-[9.5px] font-bold uppercase tracking-[0.1em] text-brand-deep">
            ● Free tonight · 4
          </div>
          {[
            ["102", "AC Deluxe", "₹2,000"],
            ["204", "AC Suite", "₹3,200"],
          ].map(([no, type, rate]) => (
            <div key={no} className="rounded-xl border border-borderc bg-surface p-3">
              <div className="flex items-center justify-between">
                <span className="font-mono text-[15px] font-bold text-ink">{no}</span>
                <span className="font-mono text-[14px] font-bold text-ink">{rate}</span>
              </div>
              <div className="mt-0.5 flex items-center justify-between">
                <span className="text-[10.5px] text-textSecondary">{type}</span>
                <span className="text-[9px] text-textSecondary">per night · GST incl.</span>
              </div>
              <div className="mt-2.5 flex items-center justify-between">
                <span className="inline-flex items-center gap-1 text-[9.5px] font-semibold text-brand-deep">
                  <Check className="w-3 h-3" /> Pay at the hotel
                </span>
                <span className="rounded-full bg-brand px-3 py-1 text-[10px] font-bold text-white">
                  Select
                </span>
              </div>
            </div>
          ))}
          <div className="rounded-xl bg-surface border border-borderc p-3 flex items-center justify-between">
            <div>
              <div className="font-mono text-[15px] font-bold text-ink">₹2,000</div>
              <div className="text-[9px] text-textSecondary">1 room · 1 night</div>
            </div>
            <span className="rounded-md bg-brand px-3.5 py-2 text-[11px] font-bold text-white">
              Continue
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

/* How it works -------------------------------------------------------- */

const STEPS = [
  {
    n: "01",
    title: "Sign up & add your rooms",
    body: "Create your hotel, add room types and rooms, drop in your GST details. Fifteen minutes, from a phone if you like.",
  },
  {
    n: "02",
    title: "Take bookings & check guests in",
    body: "Walk-ins and pre-bookings with KYC capture and optional OTP verification - or let guests self-book by scanning your QR. The calendar and housekeeping board stay in sync on their own.",
  },
  {
    n: "03",
    title: "Invoice, collect & sleep easy",
    body: "GST invoices at checkout, receipts on WhatsApp, daily cash-up by payment method. The owner sees everything without calling the desk.",
  },
];

function HowItWorks() {
  return (
    <section id="how" className={`${SHELL} py-20 md:py-24`}>
      <SectionHead eyebrow="Live in an afternoon" title="Three steps to a calmer desk" />
      <div className="mt-12 grid md:grid-cols-3 gap-5">
        {STEPS.map((s) => (
          <div
            key={s.n}
            className="relative rounded-2xl border border-borderc bg-surface p-6 shadow-card"
          >
            <span className="font-mono text-[13px] font-bold text-brand-deep">{s.n}</span>
            <span className="absolute top-6 right-6 w-8 h-px bg-gold/50" />
            <h3 className="mt-3 font-semibold text-[17px] text-ink">{s.title}</h3>
            <p className="mt-2 text-[13.5px] text-textSecondary leading-relaxed">{s.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

/* Boundaries ---------------------------------------------------------- */

// Said plainly, one scroll above the price. A product with no testimonials
// and no customer logos earns trust by being straight about its edges.
function Boundaries() {
  const items = [
    [
      "It doesn't take the guest's money",
      "No online payments, no payment gateway for your guests. They pay you at the desk, in cash or UPI or card, exactly as they do today. Stayvia records it.",
    ],
    [
      "It doesn't confirm bookings for you",
      "A QR self-booking arrives as a request with the guest's details and ID. Your desk checks the guest, takes the payment and confirms. Nothing is held against your inventory until you say so.",
    ],
    [
      "It isn't a channel manager",
      "Stayvia doesn't push your rooms to OTAs or sync rates with them. It runs your own front desk, your own direct bookings and your own books.",
    ],
  ];
  return (
    <section className={`${SHELL} pb-20 md:pb-24`}>
      <div className="rounded-2xl border border-brand-tint bg-brand-soft p-7 sm:p-9">
        <div className="flex items-start gap-3.5">
          <span className="w-11 h-11 rounded-[13px] bg-surface grid place-items-center shrink-0">
            <ShieldCheck className="w-5 h-5 text-brand-deep" />
          </span>
          <div>
            <h2 className="text-[clamp(22px,3vw,30px)] font-semibold tracking-[-0.4px] text-ink">
              What Stayvia does not do
            </h2>
            <p className="mt-2 text-[15px] text-inkBody">
              Worth knowing before you spend anything.
            </p>
          </div>
        </div>
        <div className="mt-8 grid md:grid-cols-3 gap-px bg-brand-tint rounded-xl overflow-hidden">
          {items.map(([t, b]) => (
            <div key={t} className="bg-brand-soft p-5">
              <h3 className="font-semibold text-ink leading-snug">{t}</h3>
              <p className="mt-2 text-[13.5px] leading-relaxed text-inkBody">{b}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* Pricing ------------------------------------------------------------- */

const PLAN_POINTS = [
  "Unlimited rooms, bookings & staff accounts",
  "Reservations, calendar & housekeeping",
  "Contactless QR booking + in-room guest service QR",
  "GST invoices, credit notes & PDF documents",
  "WhatsApp confirmations, OTP check-in & receipts",
  "Encrypted guest KYC vault",
  "Reports, day book & daily cash-up",
  "Roles & permissions with activity log",
  "WhatsApp support from the Stayvia team",
];

function Pricing() {
  return (
    <section id="pricing" className="border-y border-borderc bg-surfaceAlt">
      <div className={`${SHELL} py-20 md:py-24`}>
        <SectionHead
          center
          eyebrow="Pricing"
          title={
            <>
              ₹999 a month.{" "}
              <span className="font-[Georgia,serif] italic text-brand-deep">
                About ₹33 a day.
              </span>
            </>
          }
          sub="One plan, everything included. No per-room meters, no locked features, no surprise add-ons."
        />

        <div className="mt-12 mx-auto max-w-[560px] rounded-2xl border-2 border-brand bg-surface p-7 sm:p-8 shadow-lift">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[11px] font-bold uppercase tracking-[0.16em] text-brand-deep">
              Stayvia Standard
            </span>
            <span className="rounded-full bg-warnBg border border-warnBorder px-3 py-1 text-[10.5px] font-bold text-warnFg">
              Launch offer
            </span>
          </div>

          <div className="mt-5 flex items-end flex-wrap gap-x-3 gap-y-1">
            <span className="font-mono text-[46px] font-bold leading-none text-ink">₹999</span>
            <span className="pb-1 text-textSecondary">/month per hotel</span>
            <span className="pb-1 ml-auto font-mono text-textSecondary line-through">₹1,499</span>
          </div>
          {/* The annual-plan line was removed: the product ships exactly ONE
              plan (a single RAZORPAY_PLAN_ID) and the Billing page has no plan
              selector, so a hotel that signed up expecting ₹9,999/year would
              reach checkout, find only "Standard plan", and be charged monthly —
              a refund dispute on the very first paid transaction. Restore it
              once a second plan id and a selector actually exist. */}

          <ul className="mt-7 space-y-3 border-t border-divider pt-6">
            {PLAN_POINTS.map((p) => (
              <li key={p} className="flex items-start gap-2.5 text-[14px] text-inkBody">
                <Check className="w-4 h-4 text-brand-deep mt-0.5 shrink-0" />
                {p}
              </li>
            ))}
          </ul>

          <PrimaryCta className="mt-8 w-full">Start free 14-day trial</PrimaryCta>
          <p className="mt-3 text-center text-[12px] text-textSecondary">
            Full access during the trial. No card required.
          </p>
        </div>
      </div>
    </section>
  );
}

/* FAQ ----------------------------------------------------------------- */

const FAQS = [
  {
    q: "Is my hotel's data safe?",
    a: "Every hotel's data is fully isolated - your rooms, guests and invoices are never visible to any other property. Guest ID documents are stored encrypted, and staff only see what their role allows.",
  },
  {
    q: "Do I need special hardware?",
    a: "No. Stayvia runs in the browser on any laptop, tablet or phone. Reception uses whatever computer it already has.",
  },
  {
    q: "Can guests book and check in themselves?",
    a: "Yes. Put a Stayvia QR at your front desk and guests browse tonight's free rooms and submit their own details from their phone - it arrives as a hold your desk confirms after taking payment, so you stay in control. A separate QR in each room shares the WiFi and takes service requests, and it turns off automatically when the guest checks out.",
  },
  {
    q: "Are the invoices GST-compliant?",
    a: "Yes - CGST/SGST are applied by slab, invoice numbers are sequential per hotel, and credit notes handle cancellations the way your CA expects.",
  },
  {
    q: "What happens after the 14-day trial?",
    a: "Subscribe inside the app and pay by UPI, card or netbanking via Razorpay. If you don't subscribe, your data stays safe - the workspace just locks until you do.",
  },
  {
    q: "Can I cancel anytime?",
    a: "Yes. There's no lock-in and no cancellation fee. Your subscription simply runs out its paid period.",
  },
  {
    q: "Do you help with setup?",
    a: "The setup guide walks you through rooms, GST details and staff in about fifteen minutes, and the Stayvia team is a WhatsApp message away if you get stuck.",
  },
];

function Faq() {
  return (
    <section id="faq" className={`${SHELL} py-20 md:py-24`}>
      <SectionHead center eyebrow="FAQ" title="Questions hotels actually ask" />
      <div className="mt-11 mx-auto max-w-[760px] rounded-2xl border border-borderc bg-surface shadow-card overflow-hidden">
        {FAQS.map((f) => (
          <details key={f.q} className="group border-b border-divider last:border-0">
            <summary className="flex items-center justify-between gap-4 cursor-pointer list-none px-5 sm:px-6 py-4 font-semibold text-ink hover:bg-surfaceAlt transition-colors">
              {f.q}
              <span className="shrink-0 w-6 h-6 rounded-full border border-borderControl grid place-items-center text-inkMuted text-lg leading-none group-open:rotate-45 group-open:border-brand group-open:text-brand-deep transition-transform">
                +
              </span>
            </summary>
            <p className="px-5 sm:px-6 pb-5 -mt-1 text-[14px] text-textSecondary leading-relaxed">
              {f.a}
            </p>
          </details>
        ))}
      </div>
    </section>
  );
}

/* Final CTA + footer -------------------------------------------------- */

function FinalCta() {
  return (
    <section className="relative overflow-hidden bg-forest">
      <div
        className="absolute inset-0"
        style={{
          backgroundImage:
            "radial-gradient(110% 100% at 80% 0%, #1A4A3A 0%, #10352A 50%, #0B281F 100%)",
        }}
      />
      <div
        className="absolute inset-0 opacity-[0.05]"
        style={{
          backgroundImage: "repeating-linear-gradient(135deg, #fff 0 1px, transparent 1px 12px)",
        }}
      />
      <div
        className={`${SHELL} relative py-16 md:py-20 flex flex-col md:flex-row items-start md:items-center justify-between gap-8`}
      >
        <div>
          <h2 className="text-[clamp(26px,4vw,36px)] font-semibold leading-tight tracking-[-0.5px] text-cream">
            Your front desk,{" "}
            <span className="font-[Georgia,serif] italic text-brass">calmer by tonight.</span>
          </h2>
          <p className="mt-3 text-cream/65">
            14 days free. No card. Set up before the evening check-ins arrive.
          </p>
        </div>
        <PrimaryCta className="shrink-0">Start free trial</PrimaryCta>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="bg-forest-deep border-t border-brass/20">
      <div
        className={`${SHELL} py-10 flex flex-col sm:flex-row items-center justify-between gap-6 text-sm text-cream/55`}
      >
        <div className="flex items-center gap-2.5">
          <img src="/logo.png" alt="" className="w-8 h-8 rounded-[10px] object-contain" />
          <div className="leading-tight">
            <div className="font-bold tracking-tight text-cream">Stayvia</div>
            <div className="text-[9.5px] font-bold tracking-[0.18em] text-brass mt-0.5">
              HOTEL OS
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-x-5">
          {[...NAV_LINKS.filter(([h]) => h !== "#how"), [LOGIN, "Sign in"] as [string, string]].map(
            ([href, label]) => (
              <a
                key={label}
                href={href}
                className="inline-flex items-center min-h-[44px] px-1 hover:text-cream transition-colors"
              >
                {label}
              </a>
            ),
          )}
        </div>
        <div className="flex items-center gap-2 text-xs text-cream/45">
          <ShieldCheck className="w-4 h-4 text-brass" />
          <span>© {new Date().getFullYear()} Stayvia · Powered by FYN ARC Techworks</span>
        </div>
      </div>
    </footer>
  );
}
