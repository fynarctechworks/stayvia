import {
  ArrowRight,
  BedDouble,
  CalendarCheck,
  Check,
  FileText,
  Lock,
  MessageCircle,
  Receipt,
  ShieldCheck,
  Sparkles,
  Users,
} from "./micons";

// Where the product lives. Point at the deployed app in production via
// VITE_APP_URL; falls back to the local dev app.
const APP_URL = import.meta.env.VITE_APP_URL ?? "http://localhost:5180";
const SIGNUP = `${APP_URL}/signup`;
const LOGIN = `${APP_URL}/login`;

export default function App() {
  return (
    <div className="min-h-screen bg-surface">
      <Nav />
      <Hero />
      <Features />
      <HowItWorks />
      <Pricing />
      <Faq />
      <FinalCta />
      <Footer />
    </div>
  );
}

function Nav() {
  return (
    <header className="sticky top-0 z-40 bg-surface/90 backdrop-blur border-b border-borderc">
      <div className="w-full px-6 md:px-12 xl:px-20 h-16 flex items-center gap-6">
        <a href="#" className="flex items-center gap-2.5 shrink-0">
          <img src="/logo.png" alt="Stayvia" className="w-8 h-8 rounded-md object-contain" />
          <span className="font-bold text-lg tracking-tight text-ink">STAYVIA</span>
        </a>
        <nav className="hidden md:flex items-center gap-6 text-xs font-semibold uppercase tracking-[0.12em] text-textSecondary ml-4">
          <a href="#features" className="hover:text-ink transition-colors">Features</a>
          <a href="#how" className="hover:text-ink transition-colors">How it works</a>
          <a href="#pricing" className="hover:text-ink transition-colors">Pricing</a>
          <a href="#faq" className="hover:text-ink transition-colors">FAQ</a>
        </nav>
        <div className="ml-auto flex items-center gap-3">
          <a
            href={LOGIN}
            className="hidden sm:inline-block text-sm font-medium text-textSecondary hover:text-ink transition-colors"
          >
            Sign in
          </a>
          <a
            href={SIGNUP}
            className="inline-flex items-center gap-1.5 h-9 px-4 rounded-sm bg-brand text-ink text-sm font-semibold hover:bg-brand-deep transition-colors"
          >
            Start free trial
          </a>
        </div>
      </div>
    </header>
  );
}

function Hero() {
  return (
    <section className="bg-brand-dark text-white relative overflow-hidden">
      {/* Faint watermark, same treatment as the app shell */}
      <img
        src="/logo.png"
        alt=""
        aria-hidden
        className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[420px] opacity-[0.05] pointer-events-none select-none"
      />
      <div className="w-full px-6 md:px-12 xl:px-20 py-20 md:py-28 grid md:grid-cols-2 gap-12 items-center relative">
        <div>
          <span className="inline-flex items-center rounded-full border border-brand/40 bg-brand/10 px-4 py-1.5 text-xs font-semibold tracking-[0.18em] uppercase text-brand">
            Hotel OS
          </span>
          <h1 className="mt-6 text-4xl md:text-5xl font-extrabold leading-tight tracking-tight">
            Run your hotel from{" "}
            <span className="text-brand">one desk.</span>
          </h1>
          <p className="mt-5 text-white/75 text-lg leading-relaxed max-w-xl">
            Reservations, GST invoices, guest KYC, housekeeping and WhatsApp
            updates - one calm workspace built for independent Indian hotels.
            Set up in minutes, no hardware, no training manuals.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-4">
            <a
              href={SIGNUP}
              className="inline-flex items-center gap-2 h-12 px-6 rounded-sm bg-brand text-ink font-semibold hover:bg-brand-deep transition-colors"
            >
              Start your free 14-day trial <ArrowRight className="w-4 h-4" />
            </a>
            <a
              href="#pricing"
              className="inline-flex items-center gap-2 h-12 px-6 rounded-sm border border-white/25 text-white font-semibold hover:border-brand hover:text-brand transition-colors"
            >
              See pricing
            </a>
          </div>
          <p className="mt-4 text-sm text-white/50">
            No card required · Unlimited rooms &amp; staff · Cancel anytime
          </p>
        </div>

        {/* Stylised product mock - pure CSS, no screenshots to go stale. */}
        <div className="hidden md:block">
          <div className="rounded-md border border-white/10 bg-[#232323] shadow-2xl p-4 space-y-3">
            <div className="flex gap-3">
              {[
                { label: "Occupancy", value: "18 / 24" },
                { label: "Check-ins", value: "6" },
                { label: "Revenue today", value: "₹42,300" },
              ].map((s) => (
                <div key={s.label} className="flex-1 rounded-sm bg-[#2b2b2b] border border-white/5 p-3">
                  <div className="text-[10px] uppercase tracking-widest text-white/40">{s.label}</div>
                  <div className="mt-1 text-xl font-bold text-white">{s.value}</div>
                </div>
              ))}
            </div>
            <div className="rounded-sm bg-[#2b2b2b] border border-white/5 p-3">
              <div className="text-[10px] uppercase tracking-widest text-white/40 mb-2">
                Today's check-ins
              </div>
              {[
                ["Ravi Kumar", "Room 204", "Checked in"],
                ["Anita Sharma", "Room 108", "Arriving 2 PM"],
                ["M. Srinivas", "Room 305", "Arriving 6 PM"],
              ].map(([name, room, status]) => (
                <div
                  key={name}
                  className="flex items-center justify-between py-2 border-b border-white/5 last:border-0 text-sm"
                >
                  <span className="text-white/85">{name}</span>
                  <span className="text-white/40 text-xs">{room}</span>
                  <span
                    className={`text-xs font-semibold ${
                      status === "Checked in" ? "text-brand" : "text-white/50"
                    }`}
                  >
                    {status}
                  </span>
                </div>
              ))}
            </div>
            <div className="rounded-sm bg-brand/15 border border-brand/30 p-3 flex items-center justify-between">
              <span className="text-sm text-brand font-semibold">GST invoice INV-0042 issued</span>
              <span className="text-xs text-white/50">sent on WhatsApp</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

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
    <section id="features" className="w-full px-6 md:px-12 xl:px-20 py-20">
      <div className="max-w-2xl">
        <h2 className="text-3xl font-bold tracking-tight text-ink">
          Everything the front desk does, in one place
        </h2>
        <p className="mt-3 text-textSecondary text-lg">
          Built for 10-50 room independent hotels and lodges - not a stripped-down
          version of enterprise software.
        </p>
      </div>
      <div className="mt-12 grid sm:grid-cols-2 lg:grid-cols-4 gap-5">
        {FEATURES.map((f) => (
          <div
            key={f.title}
            className="rounded-md border border-borderc bg-surface p-5 hover:border-brand/50 transition-colors"
          >
            <div className="w-10 h-10 rounded-sm bg-brand-soft grid place-items-center">
              <f.icon className="w-5 h-5 text-brand-deep" />
            </div>
            <h3 className="mt-4 font-semibold text-ink">{f.title}</h3>
            <p className="mt-2 text-sm text-textSecondary leading-relaxed">{f.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

const STEPS = [
  {
    n: "1",
    title: "Sign up & add your rooms",
    body: "Create your hotel, add room types and rooms, drop in your GST details. Fifteen minutes, from a phone if you like.",
  },
  {
    n: "2",
    title: "Take bookings & check guests in",
    body: "Walk-ins and pre-bookings with KYC capture and optional OTP verification. The calendar and housekeeping board stay in sync on their own.",
  },
  {
    n: "3",
    title: "Invoice, collect & sleep easy",
    body: "GST invoices at checkout, receipts on WhatsApp, daily cash-up by payment method. The owner sees everything without calling the desk.",
  },
];

function HowItWorks() {
  return (
    <section id="how" className="bg-bg border-y border-borderc">
      <div className="w-full px-6 md:px-12 xl:px-20 py-20">
        <h2 className="text-3xl font-bold tracking-tight text-ink">Live in an afternoon</h2>
        <div className="mt-10 grid md:grid-cols-3 gap-6">
          {STEPS.map((s) => (
            <div key={s.n} className="rounded-md border border-borderc bg-surface p-6">
              <div className="w-9 h-9 rounded-full bg-brand text-ink font-bold grid place-items-center">
                {s.n}
              </div>
              <h3 className="mt-4 font-semibold text-ink">{s.title}</h3>
              <p className="mt-2 text-sm text-textSecondary leading-relaxed">{s.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

const PLAN_POINTS = [
  "Unlimited rooms, bookings & staff accounts",
  "Reservations, calendar & housekeeping",
  "GST invoices, credit notes & PDF documents",
  "WhatsApp confirmations, OTP check-in & receipts",
  "Encrypted guest KYC vault",
  "Reports, day book & daily cash-up",
  "Roles & permissions with activity log",
  "WhatsApp support from the Stayvia team",
];

function Pricing() {
  return (
    <section id="pricing" className="w-full px-6 md:px-12 xl:px-20 py-20">
      <div className="max-w-2xl mx-auto text-center">
        <h2 className="text-3xl font-bold tracking-tight text-ink">
          One plan. Everything included.
        </h2>
        <p className="mt-3 text-textSecondary text-lg">
          No per-room meters, no locked features, no surprise add-ons.
        </p>
      </div>
      <div className="mt-12 max-w-lg mx-auto rounded-md border-2 border-brand bg-surface shadow-[0_20px_60px_-30px_rgba(36,180,126,0.4)] p-8">
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold uppercase tracking-[0.18em] text-brand-deep">
            Stayvia Standard
          </span>
          <span className="text-xs font-semibold rounded-full bg-brand-soft text-brand-deep px-3 py-1">
            Launch offer
          </span>
        </div>
        <div className="mt-5 flex items-end gap-3">
          <span className="text-5xl font-extrabold text-ink">₹999</span>
          <span className="pb-1.5 text-textSecondary">/month per hotel</span>
          <span className="pb-1.5 ml-auto text-textSecondary line-through">₹1,499</span>
        </div>
        {/* The annual-plan line was removed: the product ships exactly ONE
            plan (a single RAZORPAY_PLAN_ID) and the Billing page has no plan
            selector, so a hotel that signed up expecting ₹9,999/year would
            reach checkout, find only "Standard plan", and be charged monthly —
            a refund dispute on the very first paid transaction. Restore it
            once a second plan id and a selector actually exist. */}
        <ul className="mt-6 space-y-2.5">
          {PLAN_POINTS.map((p) => (
            <li key={p} className="flex items-start gap-2.5 text-sm text-textPrimary">
              <Check className="w-4 h-4 text-brand-deep mt-0.5 shrink-0" />
              {p}
            </li>
          ))}
        </ul>
        <a
          href={SIGNUP}
          className="mt-8 w-full inline-flex items-center justify-center gap-2 h-12 rounded-sm bg-brand text-ink font-semibold hover:bg-brand-deep transition-colors"
        >
          Start free 14-day trial <ArrowRight className="w-4 h-4" />
        </a>
        <p className="mt-3 text-center text-xs text-textSecondary">
          Full access during the trial. No card required.
        </p>
      </div>
    </section>
  );
}

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
    <section id="faq" className="bg-bg border-y border-borderc">
      <div className="w-full px-6 md:px-12 xl:px-20 py-20">
        <h2 className="text-3xl font-bold tracking-tight text-ink text-center">
          Questions hotels actually ask
        </h2>
        <div className="mt-10 space-y-3">
          {FAQS.map((f) => (
            <details
              key={f.q}
              className="group rounded-md border border-borderc bg-surface p-5 open:border-brand/50"
            >
              <summary className="flex items-center justify-between cursor-pointer list-none font-semibold text-ink">
                {f.q}
                <span className="text-textSecondary group-open:rotate-45 transition-transform text-xl leading-none">
                  +
                </span>
              </summary>
              <p className="mt-3 text-sm text-textSecondary leading-relaxed">{f.a}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

function FinalCta() {
  return (
    <section className="bg-brand-dark text-white">
      <div className="w-full px-6 md:px-12 xl:px-20 py-16 flex flex-col md:flex-row items-center justify-between gap-8">
        <div>
          <h2 className="text-3xl font-bold tracking-tight">
            Your front desk, calmer by tonight.
          </h2>
          <p className="mt-2 text-white/70">
            14 days free. No card. Set up before the evening check-ins arrive.
          </p>
        </div>
        <a
          href={SIGNUP}
          className="inline-flex items-center gap-2 h-12 px-8 rounded-sm bg-brand text-ink font-semibold hover:bg-brand-deep transition-colors shrink-0"
        >
          Start free trial <ArrowRight className="w-4 h-4" />
        </a>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="bg-brand-dark text-white/60 border-t border-white/10">
      <div className="w-full px-6 md:px-12 xl:px-20 py-10 flex flex-col sm:flex-row items-center justify-between gap-6 text-sm">
        <div className="flex items-center gap-2.5">
          <img src="/logo.png" alt="Stayvia" className="w-7 h-7 rounded-md object-contain" />
          <div className="leading-tight">
            <div className="text-white font-semibold tracking-tight">STAYVIA</div>
            <div className="text-[10px] tracking-[0.18em] uppercase text-brand">Hotel OS</div>
          </div>
        </div>
        <div className="flex items-center gap-5">
          <a href="#features" className="hover:text-white transition-colors">Features</a>
          <a href="#pricing" className="hover:text-white transition-colors">Pricing</a>
          <a href={LOGIN} className="hover:text-white transition-colors">Sign in</a>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <ShieldCheck className="w-4 h-4 text-brand" />
          <span>
            © {new Date().getFullYear()} Stayvia · Powered by FYN ARC Techworks
          </span>
        </div>
      </div>
    </footer>
  );
}

