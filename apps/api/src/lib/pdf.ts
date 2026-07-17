import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { format } from "date-fns";
import { asc, eq } from "drizzle-orm";
import { type Browser, type PaperFormat } from "puppeteer";
import { db } from "../db/client.js";
import type { InvoiceLineItem, Invoice, Payment } from "../db/schema/invoices.js";
import { payments } from "../db/schema/invoices.js";
import { guests, type Guest } from "../db/schema/guests.js";
import { reservationCoGuests, reservationRooms, type Reservation } from "../db/schema/reservations.js";
import { rooms } from "../db/schema/rooms.js";
import { roomTypes } from "../db/schema/settings.js";
import type { Settings } from "../db/schema/settings.js";
import { logger } from "./logger.js";
import { combinedRoomTypeLabel } from "./roomTypeLabel.js";

function formatTime(hhmm: string | null | undefined): string {
  if (!hhmm) return "";
  const [hStr, mStr] = hhmm.split(":");
  const h = Number(hStr);
  const m = mStr ?? "00";
  const period = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${m.padStart(2, "0")} ${period}`;
}

// The hotel runs on IST regardless of where the server is hosted (prod
// is a UTC VPS). date-fns `format()` renders in the SERVER's local zone,
// so a checked-in stamp of 05:01Z printed as "5:01 AM" on the invoice
// while the IST web UI correctly showed "10:31 AM" — a 5:30 skew. These
// helpers format an instant in Asia/Kolkata so every surface agrees.
const IST_TZ = "Asia/Kolkata";
function formatIstDate(d: Date): string {
  // "20 Jun 2026" — assembled from parts so the order is fixed regardless of
  // locale. The packaged sidecar's small-icu Node ignores en-GB and would
  // otherwise print the US "Jun 20, 2026". (Numeric/short-month field VALUES
  // are correct under small-icu; only the locale's ORDERING is not.)
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: IST_TZ,
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).formatToParts(d);
  const f: Record<string, string> = {};
  for (const p of parts) f[p.type] = p.value;
  return `${f.day} ${f.month} ${f.year}`;
}
function formatIstTime(d: Date): string {
  // "10:31 AM"
  return d
    .toLocaleTimeString("en-US", {
      timeZone: IST_TZ,
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    })
    .toUpperCase();
}
function formatIstDateTime(d: Date): string {
  // "20 Jun 2026 · 10:31 AM"
  return `${formatIstDate(d)} · ${formatIstTime(d)}`;
}
// 24-hour "20 Jun 2026 · 14:31" style stamp for the generated-at footers.
function formatIstDateTime24(d: Date): string {
  const time = d.toLocaleTimeString("en-GB", {
    timeZone: IST_TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return `${formatIstDate(d)} · ${time}`;
}

let browserPromise: Promise<Browser> | null = null;

async function getBrowser() {
  if (!browserPromise) {
    // Lazy-load so the pkg-bundled offline sidecar boots without puppeteer's
    // full module graph being resolvable at import time; Chromium itself is a
    // separate binary launched via PUPPETEER_EXECUTABLE_PATH (set by the Rust
    // sidecar to the bundled build).
    //
    // createRequire, NOT dynamic import(): the pkg snapshot cannot execute
    // runtime ESM import() (ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING), but its
    // patched CJS require works. Bases: this module (dev), then the exe dir
    // (packaged app with node_modules shipped alongside).
    const bases = [import.meta.url, join(dirname(process.execPath), "package.json")];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let mod: any;
    let lastErr: unknown;
    for (const base of bases) {
      try {
        mod = createRequire(base)("puppeteer");
        break;
      } catch (err) {
        lastErr = err;
      }
    }
    if (!mod) {
      logger.error(
        { err: lastErr instanceof Error ? lastErr.message : lastErr },
        "puppeteer not resolvable — PDF rendering unavailable",
      );
      throw new Error("PDF rendering unavailable: puppeteer is not bundled with this build");
    }
    const puppeteer = mod.default ?? mod;
    browserPromise = puppeteer.launch({
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    }) as Promise<Browser>;
  }
  return browserPromise;
}

export async function closeBrowser() {
  if (browserPromise) {
    const b = await browserPromise;
    await b.close();
    browserPromise = null;
  }
}

// Hardens a freshly-created page for rendering invoice/receipt HTML.
//
// 1. JavaScript execution is disabled. Our templates are pure HTML+CSS, so
//    JS in the rendered document can only come from injection. Turning it
//    off is the cheapest way to neutralise that risk class entirely.
// 2. Request interception blocks every non-image network call, and even
//    images are restricted to https/data URIs. This kills SSRF (the page
//    can't be coerced into fetching internal IPs) and any "load remote
//    stylesheet/font/script" injection.
// 3. We never navigate to a URL — only setContent — so no opportunity for
//    the doc to bounce out via window.location.
async function hardenPage(page: import("puppeteer").Page) {
  await page.setJavaScriptEnabled(false);
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    const url = request.url();
    const resourceType = request.resourceType();
    // Allow images only, and only from data: or https: schemes (the hotel
    // logo on Supabase storage is the only legitimate remote resource).
    if (
      resourceType === "image" &&
      (url.startsWith("data:") || url.startsWith("https://"))
    ) {
      request.continue();
      return;
    }
    // The synthetic about:blank document Puppeteer creates before setContent.
    if (url === "about:blank") {
      request.continue();
      return;
    }
    request.abort();
  });
}

function esc(s: string | null | undefined) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

// "prefer_not_to_say" → "Prefer not to say", "male" → "Male", etc.
function formatGender(g: string | null | undefined): string {
  if (!g) return "";
  if (g === "prefer_not_to_say") return "Prefer not to say";
  return g.charAt(0).toUpperCase() + g.slice(1);
}

// Indian digit grouping (3-2-2: 1,23,456.50), assembled by hand. The packaged
// sidecar's small-icu Node ignores the "en-IN" locale and would fall back to
// Western 3-3-3 grouping (1,23,456 → 123,456), which is wrong on Indian
// invoices. So we group the rupee integer part ourselves.
function inr(n: string | number, symbol = "₹") {
  const v = typeof n === "string" ? Number(n) : n;
  const neg = v < 0;
  const [intPart = "0", fracPart = "00"] = Math.abs(v).toFixed(2).split(".");
  // Last 3 digits stay together; the rest are grouped in pairs.
  const head = intPart.slice(0, -3);
  const tail = intPart.slice(-3);
  const grouped = head
    ? `${head.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${tail}`
    : tail;
  return `${neg ? "-" : ""}${symbol}${grouped}.${fracPart}`;
}

function asPaper(s: string): PaperFormat {
  const x = s.toUpperCase();
  if (x === "A4" || x === "A5" || x === "A6" || x === "LETTER") return x.toLowerCase() as PaperFormat;
  return "a4";
}

interface DocLayout {
  primary: string;
  accent: string;
  invoiceTitle: string;
  receiptTitle: string;
  footerText: string;
  termsText: string | null;
  signatoryLabel: string;
  showLogo: boolean;
  showGstin: boolean;
  showTerms: boolean;
  showSignature: boolean;
  logoUrl: string | null;
  currency: string;
}

function layoutFromSettings(s: Settings): DocLayout {
  return {
    primary: s.docPrimaryColor,
    accent: s.docAccentColor,
    invoiceTitle: s.docInvoiceTitle,
    receiptTitle: s.docReceiptTitle,
    footerText: s.docFooterText,
    termsText: s.docTermsText,
    signatoryLabel: s.docSignatoryLabel,
    showLogo: s.docShowLogo,
    showGstin: s.docShowGstin,
    showTerms: s.docShowTerms,
    showSignature: s.docShowSignature,
    logoUrl: s.hotelLogoUrl ?? null,
    currency: s.currencySymbol,
  };
}

// Puppeteer wait strategy: `networkidle0` lets the remote logo finish loading.
const PAGE_WAIT_UNTIL: "networkidle0" | "load" = "networkidle0";

// Pass-through: the hardened Chromium page (hardenPage: https/data-only,
// aborted otherwise, bounded by setContent's 15s) fetches the logo itself, so
// we never introduce an unbounded server-side fetch / SSRF on the render path.
async function inlineLogo(logoUrl: string | null): Promise<string | null> {
  return logoUrl;
}

function commonStyles(L: DocLayout) {
  return `
    * { box-sizing: border-box; }
    @page { margin: 0; }
    html, body { background: #FAF7F0; }
    body {
      font-family: 'Helvetica Neue', -apple-system, 'Segoe UI', Roboto, sans-serif;
      color: #1C2620;
      margin: 0;
      padding: 28px 32px;
      font-size: 11.5px;
      line-height: 1.45;
      position: relative;
    }

    /* Watermark logo behind content */
    .watermark {
      position: fixed;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      pointer-events: none;
      z-index: 0;
      opacity: 0.045;
    }
    .watermark img { width: 320px; height: 320px; object-fit: contain; }
    .page { position: relative; z-index: 1; }

    /* Top brass band */
    .top-rule { height: 4px; background: ${L.accent}; margin: -28px -32px 24px; }

    /* Header */
    .header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 24px;
      margin-bottom: 22px;
      padding-bottom: 18px;
      border-bottom: 1px solid ${L.accent};
    }
    .brand { display: flex; gap: 14px; align-items: flex-start; max-width: 62%; }
    .brand .logo-tile {
      width: 64px; height: 64px;
      background: #FFFFFF;
      border-radius: 10px;
      padding: 4px;
      box-shadow: 0 0 0 1px ${L.accent}55, 0 2px 4px rgba(15,61,46,0.08);
      display: grid; place-items: center;
    }
    .brand .logo-tile img { width: 100%; height: 100%; object-fit: contain; }
    .brand h1 {
      margin: 0;
      font-size: 22px;
      color: ${L.primary};
      letter-spacing: 0.3px;
      font-weight: 700;
    }
    .brand .tagline {
      font-size: 10px;
      color: ${L.accent};
      letter-spacing: 0.25em;
      text-transform: uppercase;
      margin-top: 2px;
      font-weight: 600;
    }
    .addr { margin-top: 6px; color: #4A554F; font-size: 11px; }
    .gstin { font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 10.5px; color: #4A554F; margin-top: 2px; }

    .meta { text-align: right; min-width: 32%; }
    .meta .doc-label {
      display: inline-block;
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.3em;
      color: ${L.accent};
      font-weight: 700;
      padding: 4px 10px;
      border: 1px solid ${L.accent};
      border-radius: 999px;
    }
    .meta .doc-no {
      font-size: 18px;
      font-weight: 700;
      color: ${L.primary};
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      margin-top: 8px;
      letter-spacing: 0.5px;
    }
    .meta .doc-date { font-size: 11px; color: #4A554F; margin-top: 2px; }
    .meta .status-pill {
      display: inline-block;
      margin-top: 6px;
      padding: 2px 8px;
      font-size: 9.5px;
      letter-spacing: 0.15em;
      text-transform: uppercase;
      font-weight: 600;
      background: ${L.primary};
      color: #FFF;
      border-radius: 3px;
    }

    /* Two-column info */
    .info-grid { display: flex; gap: 14px; margin: 18px 0 22px; }
    .info-card {
      flex: 1;
      background: #FFFFFF;
      border: 1px solid #E2DCCD;
      border-top: 3px solid ${L.accent};
      border-radius: 5px;
      padding: 12px 14px;
    }
    .info-card .label {
      font-size: 9px;
      color: ${L.accent};
      text-transform: uppercase;
      letter-spacing: 0.22em;
      font-weight: 700;
      margin-bottom: 6px;
    }
    .info-card .name { font-weight: 700; color: ${L.primary}; font-size: 13px; }
    .info-card .sub { color: #4A554F; margin-top: 2px; }
    .info-card .mono { font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 11px; }

    /* Section heading */
    .section-title {
      font-size: 10px;
      color: ${L.accent};
      text-transform: uppercase;
      letter-spacing: 0.3em;
      font-weight: 700;
      margin: 22px 0 8px;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .section-title::after {
      content: '';
      flex: 1;
      height: 1px;
      background: ${L.accent}55;
    }

    /* Line items */
    .items {
      width: 100%;
      border-collapse: separate;
      border-spacing: 0;
    }
    .items thead th {
      text-align: left;
      padding: 10px 10px;
      font-weight: 700;
      font-size: 9.5px;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      color: #FFFFFF;
      background: ${L.primary};
    }
    .items thead th:first-child { border-top-left-radius: 4px; }
    .items thead th:last-child { border-top-right-radius: 4px; }
    .items tbody td {
      padding: 9px 10px;
      border-bottom: 1px solid #E8E2D3;
      font-size: 11px;
      vertical-align: top;
    }
    .items tbody tr:nth-child(even) td { background: #FBF8F0; }
    .items .num { text-align: right; }
    .items .mono { font-family: 'JetBrains Mono', ui-monospace, monospace; }
    .items .desc-main { font-weight: 600; color: ${L.primary}; }

    /* Totals */
    .totals-wrap { display: flex; justify-content: flex-end; margin-top: 14px; }
    .totals {
      width: 56%;
      border-collapse: collapse;
    }
    .totals td { padding: 5px 10px; border: none; font-size: 11px; }
    .totals tr.sub td { color: #4A554F; }
    .totals tr.tax td { color: #4A554F; }
    .totals tr.divider td { border-top: 1px dashed ${L.accent}; padding-top: 8px; }
    .totals tr.grand td {
      border-top: 2px solid ${L.primary};
      border-bottom: 2px solid ${L.primary};
      font-weight: 700;
      font-size: 14px;
      padding: 10px 10px;
      color: ${L.primary};
      background: #FFFFFF;
    }
    .totals tr.paid td { color: #2E7D32; padding-top: 8px; }
    .totals tr.balance td {
      font-weight: 700;
      font-size: 12.5px;
      color: #B23A2E;
    }
    .totals tr.balance td.paid { color: #2E7D32; }

    /* Hero amount (receipts) */
    .amount-box {
      margin: 18px 0;
      padding: 22px 20px;
      background: ${L.primary};
      color: #FFF;
      border-radius: 8px;
      text-align: center;
      position: relative;
      overflow: hidden;
    }
    .amount-box::before, .amount-box::after {
      content: '';
      position: absolute;
      width: 60px; height: 60px;
      border: 1px solid ${L.accent}66;
      border-radius: 50%;
    }
    .amount-box::before { top: -25px; left: -20px; }
    .amount-box::after { bottom: -25px; right: -20px; }
    .amount-box .lbl {
      font-size: 9.5px;
      text-transform: uppercase;
      letter-spacing: 0.32em;
      color: ${L.accent};
      font-weight: 700;
    }
    .amount-box .amt {
      font-size: 36px;
      font-weight: 700;
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      margin-top: 6px;
      letter-spacing: 0.5px;
    }
    .amount-box .method {
      font-size: 11px;
      margin-top: 8px;
      letter-spacing: 0.1em;
      text-transform: capitalize;
      opacity: 0.95;
    }

    /* Terms */
    .terms {
      margin-top: 22px;
      padding: 12px 14px;
      background: #FFFFFF;
      border: 1px solid #E2DCCD;
      border-left: 3px solid ${L.accent};
      font-size: 10.5px;
      color: #4A554F;
      white-space: pre-wrap;
      border-radius: 0 4px 4px 0;
    }
    .terms .terms-title {
      font-size: 9.5px;
      letter-spacing: 0.25em;
      text-transform: uppercase;
      color: ${L.accent};
      font-weight: 700;
      margin-bottom: 4px;
    }

    /* Footer */
    .footer {
      margin-top: 36px;
      padding-top: 14px;
      border-top: 1px solid ${L.accent};
      display: flex;
      justify-content: space-between;
      align-items: flex-end;
      gap: 16px;
    }
    .footer .thanks {
      font-size: 10.5px;
      color: #4A554F;
      max-width: 60%;
    }
    .footer .thanks .signoff {
      font-style: italic;
      color: ${L.primary};
      font-size: 12px;
      margin-bottom: 2px;
    }
    .sign { text-align: center; min-width: 200px; }
    .sign .line {
      margin-top: 36px;
      border-top: 1px solid ${L.accent};
      padding-top: 4px;
      color: #4A554F;
      font-size: 10px;
      letter-spacing: 0.2em;
      text-transform: uppercase;
    }
    .doc-id-strip {
      position: absolute;
      left: 32px; right: 32px; bottom: 12px;
      text-align: center;
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      color: #B0AB99;
      font-size: 8.5px;
      letter-spacing: 0.2em;
    }
  `;
}

function brandHeader(
  L: DocLayout,
  hotelName: string,
  hotelAddress: string,
  hotelGstin: string,
  hotelPhone?: string | null,
  ownerPhone?: string | null,
) {
  const phones = [hotelPhone, ownerPhone].filter((p): p is string => !!p && p.trim() !== "");
  return `
    <div class="brand">
      ${L.showLogo && L.logoUrl ? `<div class="logo-tile"><img src="${esc(L.logoUrl)}" alt="logo" /></div>` : ""}
      <div>
        <h1>${esc(hotelName)}</h1>
        <div class="tagline">Hospitality &amp; Stays</div>
        <div class="addr">${esc(hotelAddress)}</div>
        ${phones.length ? `<div class="addr">${phones.map((p) => esc(p)).join(" &nbsp;·&nbsp; ")}</div>` : ""}
        ${hotelGstin ? `<div class="gstin">GSTIN&nbsp;·&nbsp;${esc(hotelGstin)}</div>` : ""}
      </div>
    </div>
  `;
}

// Concise per-payment label for the totals block: prefer the payment's
// own note (stripped of the per-room/split qualifiers, matching the
// Payment History tag), otherwise a chronological Advance/Later tag.
function paymentTotalsLabel(
  p: { notes?: string | null; paymentDate: string | Date; amount?: string | number },
  checkedInAtMs: number | null,
): string {
  // Negative amounts are refunds (money out) — label them as such so the
  // totals block reads "Refund … −₹700" rather than a plain "Paid".
  if (p.amount !== undefined && Number(p.amount) < 0) {
    const note = (p.notes ?? "").trim();
    return note.length > 0 ? note : "Refund";
  }
  const cleaned = (p.notes ?? "")
    .trim()
    .replace(/\s*·\s*part \d+\/\d+(?:\s*\(split from [^)]+\))?/g, "")
    .replace(/\s*\(Room [^)]+\)/g, "")
    .replace(/^Per-room share of check-out collection/, "Collected at check-out");
  if (cleaned.length > 0) return cleaned;
  const isLater =
    checkedInAtMs !== null && new Date(p.paymentDate).getTime() > checkedInAtMs;
  return isLater ? "Later payment" : "Advance at check-in";
}

// One "Paid" totals row per received payment, each labelled. Falls back
// to a single "Total Paid" line when there are no itemisable rows (e.g.
// payment list not supplied). `paidFallback` is the cached total used
// for that single-line case.
function paidLinesHtml(
  payments: Array<{
    notes?: string | null;
    paymentDate: string | Date;
    amount: string | number;
    voided?: boolean;
    status?: string | null;
  }>,
  opts: {
    currency: string;
    rowClass: string;
    numClass: string;
    checkedInAtMs: number | null;
    paidFallback: string | number;
    totalLabel: string;
  },
): string {
  const received = payments.filter(
    (p) => !p.voided && (!p.status || p.status === "received"),
  );
  if (received.length === 0) {
    return `<tr class="${opts.rowClass}"><td>${opts.totalLabel}</td><td class="${opts.numClass}">${inr(opts.paidFallback, opts.currency)}</td></tr>`;
  }
  const rows = received
    .map(
      (p) =>
        `<tr class="${opts.rowClass}"><td>Paid · ${esc(paymentTotalsLabel(p, opts.checkedInAtMs))}</td><td class="${opts.numClass}">${inr(p.amount, opts.currency)}</td></tr>`,
    )
    .join("");
  // Keep a bold total line when there's more than one payment so the
  // sum is obvious; a single payment is self-evidently the total.
  const totalRow =
    received.length > 1
      ? `<tr class="${opts.rowClass}"><td><strong>${opts.totalLabel}</strong></td><td class="${opts.numClass}"><strong>${inr(opts.paidFallback, opts.currency)}</strong></td></tr>`
      : "";
  return rows + totalRow;
}

function renderInvoiceHtml(data: {
  invoice: Invoice;
  lineItems: InvoiceLineItem[];
  payments: Payment[];
  settings: Settings;
  // Stay window comes from the reservation, not the invoice. Optional so
  // callers that don't have it (legacy paths) still render correctly.
  stay?: {
    checkInDate: string;
    checkOutDate: string;
    numNights: number;
    // Day-use vs overnight. When 'short_stay', the stay block in the
    // header reads "Day use · N hours" instead of "N night(s)".
    stayType?: "overnight" | "short_stay";
    durationHours?: number | null;
    // ISO timestamp of when the guest actually checked in. Used to split
    // payments into "Advance (at booking/check-in)" vs "Later" so the
    // totals show the breakdown rather than a single Total Paid number.
    // Null/missing when the reservation isn't checked in yet (advance-
    // receipt rendering path).
    checkedInAt?: string | null;
    // 0023 — staff-chosen planned clock times. Used to print
    // "Check-in: 02 Jun 2026 · 4:00 PM" when staff promised a specific
    // window; falls back to dateless format otherwise.
    plannedCheckInAt?: string | null;
    plannedCheckOutAt?: string | null;
  };
  // Guest extras for the Billed To block (migration 0020). gender prints
  // alongside the existing name; coGuests prints as a small "Also
  // occupying" sub-block so the bill mirrors who actually used the room.
  guestExtra?: {
    gender?: string | null;
    coGuests?: {
      fullName: string;
      phone: string;
      gender: string | null;
      idProofType: string;
      idProofLast4: string;
    }[];
  };
  // Other bookings for the same guest that were paid at the same desk
  // visit (the "collect previous balance" flow on check-out). Surfaced as
  // an informational footer block. Does NOT affect the invoice's totals
  // or GST — those other bookings are separate documents. invoiceNumber
  // may be null when the companion is still a pre-invoice reservation
  // (active stay, not yet checked out).
  companionCollections?: {
    invoiceNumber: string | null;
    reservationNumber: string;
    amount: string;
  }[];
  // Per-room bill mode (money/paperwork split). When set, this PDF is a
  // PRESENTATION-ONLY split of the parent tax invoice for ONE room — it
  // carries the parent invoice number with a "· Room N" suffix, a
  // banner clarifying it's not a separate tax document, and only that
  // room's line items. No new invoice number, no new GST, no money.
  roomBill?: {
    roomLabel: string; // e.g. "Room 302"
    parentInvoiceNumber: string; // e.g. "SLDT-INV-0044"
  };
}) {
  const { invoice, lineItems, payments, settings, stay, companionCollections } = data;
  const L = layoutFromSettings(settings);

  const roomBill = data.roomBill;
  // Credit notes reuse this template but read as a reversal: the title
  // says "CREDIT NOTE", a reference line names the invoice being
  // reversed, and amounts are already negative in the data.
  const isCreditNote =
    (invoice as { documentType?: string }).documentType === "credit_note";
  const docTitle = roomBill
    ? "ROOM BILL"
    : isCreditNote
      ? "CREDIT NOTE"
      : L.invoiceTitle;
  const reversalRef = isCreditNote
    ? ((invoice.notes ?? "").match(/reversing\s+(SLDT-INV-\d+)/i)?.[1] ?? null)
    : null;

  const itemRows = lineItems
    .map(
      (li) => `
    <tr>
      <td><div class="desc-main">${esc(li.description)}</div></td>
      <td class="mono">${esc(li.sacCode)}</td>
      <td class="num">${li.quantity}</td>
      <td class="num mono">${inr(li.rate, L.currency)}</td>
      <td class="num mono">${inr(li.amount, L.currency)}</td>
    </tr>`,
    )
    .join("");

  // Determine the advance/later boundary so each payment row can be
  // tagged. When checkedInAt isn't known yet (still pre-check-in), all
  // payments are advance. Voided rows are skipped entirely.
  const checkedInAtMs = data.stay?.checkedInAt
    ? new Date(data.stay.checkedInAt).getTime()
    : null;
  const payRows = payments.length
    ? payments
        .filter((p) => !p.voided)
        .map((p) => {
          // Tag precedence: a payment's actual notes win when they
          // describe a specific scenario the generic Advance/Later
          // labels can't (e.g. "Collected at check-out of SLDT-RES-0072"
          // tells staff exactly which prior desk visit collected this
          // money). Falls back to the chronological Advance/Later tag.
          const notes = (p.notes ?? "").trim();
          // Strip the per-room "(Room X)" qualifier and any "part Y/Z
          // (split from ...)" trailer so guest-facing receipts read
          // as a single labelled collection, not as N split slices.
          const cleanedNotes = notes
            .replace(/\s*·\s*part \d+\/\d+(?:\s*\(split from [^)]+\))?/g, "")
            .replace(/\s*\(Room [^)]+\)/g, "")
            // After the (Room X) is gone, "Per-room share of check-out
            // collection" is redundant — collapse to plain wording.
            .replace(/^Per-room share of check-out collection/, "Collected at check-out");
          const isLater =
            checkedInAtMs !== null &&
            new Date(p.paymentDate).getTime() > checkedInAtMs;
          // Any actual note wins over the generic chronological tag —
          // staff-entered reasons ("part payment", refs) belong on the
          // invoice just like the system's rich notes do.
          const tag = cleanedNotes.length > 0
            ? cleanedNotes
            : isLater
              ? "Later payment"
              : "Advance at check-in";
          return `
    <tr>
      <td>${formatIstDate(new Date(p.paymentDate))}</td>
      <td class="capitalize">
        ${p.paymentMethod.replace("_", " ")}
        <span style="color:#6B6358;font-size:9.5px;text-transform:none;letter-spacing:0;margin-left:4px;">
          · ${esc(tag)}
        </span>
      </td>
      <td class="num mono">${inr(p.amount, L.currency)}</td>
    </tr>`;
        })
        .join("")
    : `<tr><td colspan="3" style="color:#999;text-align:center;padding:14px;">No payments yet</td></tr>`;

  const balanceClass = Number(invoice.balanceDue) <= 0.009 ? "paid" : "";

  return `<!doctype html>
<html><head><meta charset="utf-8"><style>${commonStyles(L)}</style></head>
<body>

${L.showLogo && L.logoUrl ? `<div class="watermark"><img src="${esc(L.logoUrl)}" alt="" /></div>` : ""}

<div class="page">
  <div class="top-rule"></div>

  <div class="header">
    ${brandHeader(L, invoice.hotelName, invoice.hotelAddress, invoice.hotelGstin, data.settings.hotelPhone, data.settings.ownerPhone)}
    <div class="meta">
      <div class="doc-label">${esc(docTitle)}</div>
      <div class="doc-no">${esc(roomBill ? `${roomBill.parentInvoiceNumber} · ${roomBill.roomLabel}` : invoice.invoiceNumber)}</div>
      <div class="doc-date">Date: ${formatIstDate(new Date(invoice.createdAt))}</div>
      ${reversalRef ? `<div class="doc-date">Against: ${esc(reversalRef)}</div>` : ""}
      <div class="status-pill">${esc(roomBill ? "room split" : isCreditNote ? "credit note" : invoice.status)}</div>
    </div>
  </div>

  ${
    roomBill
      ? `<div style="margin:8px 0 4px;padding:7px 11px;border:1px solid #d8c9a8;background:#fbf6ea;border-radius:5px;font-size:10px;color:#6b6358;line-height:1.4;">
           Room-wise split of tax invoice <strong>${esc(roomBill.parentInvoiceNumber)}</strong> — provided for the customer's reference.
           The full tax invoice for the stay is ${esc(roomBill.parentInvoiceNumber)}; this split is not a separate tax invoice.
         </div>`
      : ""
  }

  <div class="info-grid">
    <div class="info-card">
      <div class="label">Billed To</div>
      <div class="name">${esc(invoice.guestName)}</div>
      ${
        data.guestExtra?.gender
          ? `<div class="sub">${esc(formatGender(data.guestExtra.gender))}</div>`
          : ""
      }
      ${invoice.guestAddress ? `<div class="sub">${esc(invoice.guestAddress)}</div>` : ""}
      ${invoice.guestGstin ? `<div class="sub mono">GSTIN: ${esc(invoice.guestGstin)}</div>` : ""}
      ${
        data.guestExtra?.coGuests && data.guestExtra.coGuests.length > 0
          ? `<div style="margin-top:8px;padding-top:6px;border-top:1px dashed #D6D2C4;">
              <div class="label" style="font-size:9px;">Also occupying</div>
              ${data.guestExtra.coGuests
                .map(
                  (cg) =>
                    `<div class="sub" style="margin-top:3px;">${esc(cg.fullName)} · ${esc(cg.phone)}${
                      cg.idProofType && cg.idProofLast4
                        ? ` · ${esc(cg.idProofType.replace("_", " "))} ····${esc(cg.idProofLast4)}`
                        : ""
                    }${cg.gender ? ` · ${esc(formatGender(cg.gender))}` : ""}</div>`,
                )
                .join("")}
            </div>`
          : ""
      }
    </div>
    <div class="info-card">
      <div class="label">Stay</div>
      ${(() => {
        if (!stay) return "";
        const isShort = stay.stayType === "short_stay";
        // For day-use bookings, derive the actual exit time from
        // checkedInAt + durationHours so the invoice reflects when the
        // guest is supposed to leave (not the overnight check-out date).
        const shortOut = isShort && stay.checkedInAt
          ? new Date(
              new Date(stay.checkedInAt).getTime()
                + Math.round(Number(stay.durationHours ?? 0) * 3600 * 1000),
            )
          : null;
        // Check-in time priority (0023): actual checked-in stamp >
        // staff-chosen planned time > date-only fallback. The "h:mm a"
        // format kicks in whenever we have an actual time value.
        // Time-bearing values are true instants (UTC in the DB) and must
        // be formatted in IST — see formatIstDateTime. Date-only fallbacks
        // ("dd MMM yyyy") carry no instant, so plain date-fns is fine.
        const checkInRendered = stay.checkedInAt
          ? formatIstDateTime(new Date(stay.checkedInAt))
          : stay.plannedCheckInAt
            ? formatIstDateTime(new Date(stay.plannedCheckInAt))
            : format(new Date(stay.checkInDate + "T00:00:00"), "dd MMM yyyy");
        const checkInLine = `<div class="sub">Check-in: <strong>${checkInRendered}</strong></div>`;
        const checkOutRendered = shortOut
          ? formatIstDateTime(shortOut)
          : stay.plannedCheckOutAt
            ? formatIstDateTime(new Date(stay.plannedCheckOutAt))
            : format(new Date(stay.checkOutDate + "T00:00:00"), "dd MMM yyyy");
        const checkOutLine = `<div class="sub">Check-out: <strong>${checkOutRendered}</strong></div>`;
        const durationLine = `<div class="sub" style="color:#6B6358;">${
          isShort
            ? `Day use · ${Number(stay.durationHours ?? 0)} hour${Number(stay.durationHours ?? 0) === 1 ? "" : "s"}`
            : `${stay.numNights} night${stay.numNights === 1 ? "" : "s"}`
        }</div>`;
        return checkInLine + checkOutLine + durationLine;
      })()}
      <div class="sub" style="margin-top:4px;">Issued ${formatIstDate(new Date(invoice.issueDate ?? invoice.createdAt))}</div>
    </div>
  </div>

  <div class="section-title">Line Items</div>
  <table class="items">
    <thead>
      <tr>
        <th style="width:48%">Description</th>
        <th style="width:12%">SAC</th>
        <th class="num" style="width:8%">Qty</th>
        <th class="num" style="width:16%">Rate</th>
        <th class="num" style="width:16%">Amount</th>
      </tr>
    </thead>
    <tbody>${itemRows}</tbody>
  </table>

  <div class="totals-wrap">
    <table class="totals">
      <tr class="sub"><td>Subtotal</td><td class="num mono">${inr(invoice.subtotal, L.currency)}</td></tr>
      <tr class="tax"><td>CGST @ ${invoice.cgstRate}%</td><td class="num mono">${inr(invoice.cgstAmount, L.currency)}</td></tr>
      <tr class="tax"><td>SGST @ ${invoice.sgstRate}%</td><td class="num mono">${inr(invoice.sgstAmount, L.currency)}</td></tr>
      <tr class="grand"><td>Grand Total</td><td class="num mono">${inr(invoice.grandTotal, L.currency)}</td></tr>
      ${
        Number(invoice.walletCreditApplied ?? 0) > 0.009
          ? `<tr class="paid"><td>Wallet credit applied</td><td class="num mono">−${inr(invoice.walletCreditApplied, L.currency)}</td></tr>`
          : ""
      }
      ${paidLinesHtml(payments, {
        currency: L.currency,
        rowClass: "paid",
        numClass: "num mono",
        checkedInAtMs: data.stay?.checkedInAt
          ? new Date(data.stay.checkedInAt).getTime()
          : null,
        paidFallback: invoice.totalPaid,
        totalLabel: "Total Paid",
      })}
      <tr class="balance"><td>Balance Due</td><td class="num mono ${balanceClass}">${inr(invoice.balanceDue, L.currency)}</td></tr>
    </table>
  </div>

  <div class="section-title">Payment History</div>
  <table class="items">
    <thead>
      <tr>
        <th style="width:30%">Date</th>
        <th style="width:40%">Method</th>
        <th class="num" style="width:30%">Amount</th>
      </tr>
    </thead>
    <tbody>${payRows}</tbody>
  </table>

  ${
    companionCollections && companionCollections.length > 0
      ? (() => {
          const total = companionCollections
            .reduce((s, c) => s + Number(c.amount), 0)
            .toFixed(2);
          const rows = companionCollections
            .map((c) => {
              // Pre-invoice rows have no invoice number yet. Show the
              // reservation number and a small "(advance)" tag so staff
              // and the guest understand it's a payment toward an
              // ongoing booking that hasn't been invoiced yet.
              const left = c.invoiceNumber
                ? `${esc(c.invoiceNumber)} <span style="color:#6B6358;">(${esc(c.reservationNumber)})</span>`
                : `${esc(c.reservationNumber)} <span style="color:#6B6358;font-style:italic;">(advance, not invoiced yet)</span>`;
              return `
              <tr>
                <td style="padding:3px 6px;border-bottom:1px solid #EEE8DA;">${left}</td>
                <td style="padding:3px 6px;border-bottom:1px solid #EEE8DA;text-align:right;font-family:'JetBrains Mono',monospace;">${inr(c.amount, L.currency)}</td>
              </tr>`;
            })
            .join("");
          // Subtitle adapts based on whether any companions are pre-invoice.
          const hasPreInvoice = companionCollections.some((c) => !c.invoiceNumber);
          const subtitleNoun = hasPreInvoice
            ? `booking${companionCollections.length === 1 ? "" : "s"}`
            : `invoice${companionCollections.length === 1 ? "" : "s"}`;
          return `
  <div style="margin-top:10px;padding:8px 10px;border-left:2px solid #B08A4A;background:#FAF7F0;font-size:10.5px;page-break-inside:avoid;">
    <div style="font-weight:600;color:#0F3D2E;text-transform:uppercase;letter-spacing:0.06em;font-size:10px;margin-bottom:2px;">
      Also collected today
    </div>
    <div style="color:#6B6358;font-size:10px;margin-bottom:4px;">
      Settled at the same visit, against other ${subtitleNoun} for this guest.
    </div>
    <table style="width:100%;border-collapse:collapse;font-size:10.5px;">
      <tbody>
        ${rows}
        <tr style="font-weight:600;">
          <td style="padding:3px 6px;">Total settled separately</td>
          <td style="padding:3px 6px;text-align:right;font-family:'JetBrains Mono',monospace;">${inr(total, L.currency)}</td>
        </tr>
      </tbody>
    </table>
  </div>`;
        })()
      : ""
  }

  ${
    L.showTerms && L.termsText
      ? `<div class="terms"><div class="terms-title">Terms &amp; Conditions</div>${esc(L.termsText)}</div>`
      : ""
  }

  <div class="footer">
    <div class="thanks">
      <div class="signoff">${esc(L.footerText)}</div>
      <div>This is a system-generated tax invoice. No physical signature is required for validity.</div>
    </div>
    ${L.showSignature ? `<div class="sign"><div class="line">${esc(L.signatoryLabel)}</div></div>` : ""}
  </div>

  <div class="doc-id-strip">${esc(invoice.invoiceNumber)} &middot; ${formatIstDateTime24(new Date())}</div>
</div>

</body></html>`;
}

export async function renderInvoicePdf(data: {
  invoice: Invoice;
  lineItems: InvoiceLineItem[];
  payments: Payment[];
  settings: Settings;
  stay?: {
    checkInDate: string;
    checkOutDate: string;
    numNights: number;
    stayType?: "overnight" | "short_stay";
    durationHours?: number | null;
    // ISO timestamp of when the guest actually checked in. Used to split
    // payments into "Advance (at booking/check-in)" vs "Later" so the
    // totals show the breakdown rather than a single Total Paid number.
    // Null/missing when the reservation isn't checked in yet (advance-
    // receipt rendering path).
    checkedInAt?: string | null;
    // 0023 — staff-chosen planned clock times. Same role as above:
    // surfaced when present so the invoice shows the promised window.
    plannedCheckInAt?: string | null;
    plannedCheckOutAt?: string | null;
  };
  // See renderInvoiceHtml signature — pass-through.
  guestExtra?: {
    gender?: string | null;
    coGuests?: {
      fullName: string;
      phone: string;
      gender: string | null;
      idProofType: string;
      idProofLast4: string;
    }[];
  };
  companionCollections?: {
    invoiceNumber: string | null;
    reservationNumber: string;
    amount: string;
  }[];
  // Per-room presentation split — see renderInvoiceHtml.roomBill.
  roomBill?: {
    roomLabel: string;
    parentInvoiceNumber: string;
  };
}): Promise<Buffer> {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await hardenPage(page);
    // Inline the logo as a data: URI so the doc renders with no network wait
    // (essential offline; harmless online).
    const inlinedLogo = await inlineLogo(data.settings.hotelLogoUrl ?? null);
    const dataWithLogo = {
      ...data,
      settings: { ...data.settings, hotelLogoUrl: inlinedLogo },
    };
    const html = renderInvoiceHtml(dataWithLogo);
    await page.setContent(html, { waitUntil: PAGE_WAIT_UNTIL, timeout: 15_000 });
    const pdf = await page.pdf({
      format: asPaper(data.settings.docInvoicePageSize),
      printBackground: true,
      margin: { top: "20mm", bottom: "20mm", left: "15mm", right: "15mm" },
      timeout: 15_000,
    });
    return Buffer.from(pdf);
  } catch (err) {
    logger.error({ err }, "PDF rendering failed");
    throw err;
  } finally {
    await page.close();
  }
}

function renderReceiptHtml(data: {
  payment: Payment;
  reservation: Reservation;
  guest: Guest;
  invoice: Invoice | null;
  settings: Settings;
  rooms: {
    roomNumber: string;
    // Pre-rendered: "Ac Single Bed Rooms" when there's no sold-as
    // override, "Ac Single Bed Rooms booked as Non Ac Bed Rooms" when
    // there is. Built by the caller via combinedRoomTypeLabel().
    displayType: string;
    ratePerNight: string;
  }[];
  // All non-voided payments for this reservation, used to split totals
  // into Advance (at/before check-in) vs Later. Optional — if omitted,
  // the totals render with a single "Paid" line as before.
  allPayments?: Payment[];
  // Additional adults whose KYC was captured at booking (migration 0020).
  // Empty for single-occupancy stays.
  coGuests?: {
    position: number;
    fullName: string;
    phone: string;
    gender: string | null;
    idProofType: string;
    idProofLast4: string;
  }[];
}) {
  const { payment, reservation, guest, invoice, settings, rooms, allPayments, coGuests } = data;
  const L = layoutFromSettings(settings);

  // Refund rows have a negative amount (cancel-reservation flow records
  // the refund as a single signed payment so the per-reservation sum
  // reconciles). They need their own label set — otherwise the PDF
  // shows "Booking Advance Receipt — Advance Received ₹-499" which
  // reads as if the property collected a negative advance instead of
  // returning the guest's money.
  const isRefund = Number(payment.amount) < 0;
  const isAdvance = !invoice && !isRefund;
  const pillLabel = isRefund ? "Refund" : isAdvance ? "Advance" : "Check-in";
  const titleLabel = isRefund
    ? "Refund Receipt"
    : isAdvance
      ? "Booking Advance Receipt"
      : L.receiptTitle;
  const amountLabel = isRefund
    ? "Refunded to Guest"
    : isAdvance
      ? "Advance Received"
      : "Amount Received";

  const subtotal = Number(reservation.subtotal);
  const gstRate = Number(reservation.gstRate);
  const gstAmount = Number(reservation.gstAmount);
  const halfGstRate = +(gstRate / 2).toFixed(2);
  const halfGstAmount = +(gstAmount / 2).toFixed(2);
  const otherHalfGstAmount = +(gstAmount - halfGstAmount).toFixed(2);

  const grandTotal = invoice ? Number(invoice.grandTotal) : Number(reservation.grandTotal);
  const paidSoFar = invoice ? Number(invoice.totalPaid) : Number(reservation.advancePaid);
  const walletCreditApplied = invoice
    ? Number(invoice.walletCreditApplied ?? 0)
    : Number(reservation.walletCreditApplied ?? 0);
  const balanceDue = Math.max(
    0,
    +(grandTotal - paidSoFar - walletCreditApplied).toFixed(2),
  );

  const isShortStay = reservation.stayType === "short_stay";
  const durationHours = Number(reservation.durationHours ?? 0);
  const nights = Number(reservation.numNights);
  // Label shown both in the Stay card ("3 nights" / "Day use · 6 hours")
  // and the Subtotal row ("Subtotal (3n)" / "Subtotal (6 hrs)").
  const stayUnitLabel = isShortStay
    ? `Day use · ${durationHours} hour${durationHours === 1 ? "" : "s"}`
    : `${nights} night${nights === 1 ? "" : "s"}`;
  const subtotalUnitLabel = isShortStay ? `${durationHours} hrs` : `${nights}n`;
  // For short_stay, check-out is checkedInAt + durationHours (or, if not
  // yet checked in, checkInDate + hotel checkInTime + durationHours). We
  // compute it once and show it instead of the overnight "by 11:00 AM"
  // default, which is wrong for day-use exits.
  const shortStayCheckoutDate = (() => {
    if (!isShortStay) return null;
    const startMs = reservation.checkedInAt
      ? new Date(reservation.checkedInAt).getTime()
      : (() => {
          const [ch, cm] = (settings.checkInTime ?? "12:00").split(":");
          return new Date(
            `${reservation.checkInDate}T${(ch ?? "12").padStart(2, "0")}:${(cm ?? "00").padStart(2, "0")}:00+05:30`,
          ).getTime();
        })();
    return new Date(startMs + Math.round(durationHours * 3600 * 1000));
  })();

  return `<!doctype html>
<html><head><meta charset="utf-8"><style>${commonStyles(L)}
  /* Slip layout (matches on-screen CheckInReceiptModal) */
  .slip { color: #1C2620; }
  .slip-header {
    display: flex; justify-content: space-between; align-items: flex-start;
    gap: 12px; padding-bottom: 12px;
    border-bottom: 2px solid ${L.primary};
  }
  .slip-header .hotel { display: flex; gap: 10px; align-items: flex-start; }
  .slip-header .hotel-logo {
    width: 48px; height: 48px; border-radius: 6px; padding: 2px;
    background: #FAF7F0; box-shadow: inset 0 0 0 1px ${L.primary}33;
    object-fit: contain;
  }
  .slip-header .hotel-name { font-size: 15px; font-weight: 700; color: ${L.primary}; line-height: 1.1; }
  .slip-header .hotel-sub { font-size: 10px; color: #6B7C72; margin-top: 2px; line-height: 1.35; }
  .slip-header .hotel-gstin { font-size: 10px; color: #6B7C72; font-family: 'SF Mono', Menlo, monospace; margin-top: 2px; }
  .slip-header .meta { text-align: right; }
  .pill {
    display: inline-block; font-size: 10px; letter-spacing: 0.2em; text-transform: uppercase;
    font-weight: 700; color: ${L.accent};
    border: 1px solid ${L.accent}; border-radius: 999px; padding: 2px 10px;
  }
  .res-no { font-size: 13px; font-weight: 700; color: ${L.primary}; font-family: 'SF Mono', Menlo, monospace; margin-top: 6px; }
  .doc-date-small { font-size: 10px; color: #6B7C72; }

  .cards { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 12px; }
  .card {
    border: 1px solid #E5DFCB; border-radius: 4px;
    background: rgba(250, 247, 240, 0.5); padding: 10px;
  }
  .card-label { font-size: 9px; letter-spacing: 0.1em; text-transform: uppercase; font-weight: 600; color: #6B7C72; }
  .card-name { font-weight: 600; color: ${L.primary}; margin-top: 2px; }
  .card-sub { font-family: 'SF Mono', Menlo, monospace; font-size: 11px; margin-top: 2px; }
  .card-id { font-size: 10px; color: #6B7C72; margin-top: 4px; text-transform: capitalize; }
  .stay-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-top: 4px; }
  .stay-tag { font-size: 9px; letter-spacing: 0.1em; text-transform: uppercase; font-weight: 700; color: ${L.accent}; }
  .stay-date { font-size: 12px; font-weight: 600; color: ${L.primary}; line-height: 1.1; }
  .stay-time { font-size: 10px; color: #6B7C72; line-height: 1.1; margin-top: 2px; }
  .stay-occ { font-size: 10px; color: #6B7C72; margin-top: 6px; }

  .section-cap { font-size: 10px; letter-spacing: 0.2em; text-transform: uppercase; font-weight: 700; color: ${L.accent}; margin: 16px 0 6px; }

  table.rooms-allotted { width: 100%; border-collapse: collapse; font-size: 11px; }
  table.rooms-allotted th {
    text-align: left; padding: 5px 0; font-weight: 600; color: ${L.primary};
    border-bottom: 1px solid ${L.primary}55;
  }
  table.rooms-allotted td { padding: 5px 0; border-bottom: 1px solid #E5DFCB; }
  table.rooms-allotted .num { text-align: right; font-family: 'SF Mono', Menlo, monospace; }
  table.rooms-allotted .roomno { font-family: 'SF Mono', Menlo, monospace; font-weight: 700; }
  table.rooms-allotted .cap { text-transform: capitalize; }

  .amount-banner {
    margin-top: 14px; padding: 14px; border-radius: 6px; text-align: center;
    background: ${L.primary}; color: #FAF7F0;
  }
  .amount-banner .cap {
    font-size: 9px; letter-spacing: 0.25em; text-transform: uppercase; font-weight: 700; color: ${L.accent};
  }
  .amount-banner .amt {
    font-size: 24px; font-weight: 700; font-family: 'SF Mono', Menlo, monospace; margin-top: 2px;
  }
  .amount-banner .method { font-size: 10px; margin-top: 2px; opacity: 0.9; text-transform: capitalize; }

  .totals-wrap { margin-top: 14px; display: flex; justify-content: flex-end; }
  table.totals-slip { width: 280px; font-size: 11px; border-collapse: collapse; }
  table.totals-slip td { padding: 4px 0; }
  table.totals-slip td.lbl { color: #6B7C72; }
  table.totals-slip td.num { text-align: right; font-family: 'SF Mono', Menlo, monospace; }
  table.totals-slip tr.gt td {
    border-top: 1px solid ${L.primary}55;
    padding-top: 7px; font-weight: 700; color: ${L.primary};
  }
  table.totals-slip tr.paid td { color: #2F7D4F; }
  table.totals-slip tr.bal td { color: #B23A2E; font-weight: 700; }

  .welcome-note {
    margin-top: 16px; padding-top: 10px; border-top: 1px solid #E5DFCB;
    font-size: 10px; color: #6B7C72; line-height: 1.6;
  }

  .sigs { display: flex; justify-content: space-between; gap: 12px; margin-top: 24px; }
  .sig-line {
    font-size: 10px; color: #6B7C72;
    padding-top: 28px;
    border-top: 1px solid #B4BCB8;
    min-width: 140px; display: inline-block;
  }
</style></head>
<body>

${L.showLogo && L.logoUrl ? `<div class="watermark"><img src="${esc(L.logoUrl)}" alt="" /></div>` : ""}

<div class="page slip">
  <div class="top-rule"></div>

  <div class="slip-header">
    <div class="hotel">
      ${L.showLogo && L.logoUrl ? `<img class="hotel-logo" src="${esc(L.logoUrl)}" alt="" />` : ""}
      <div>
        <div class="hotel-name">${esc(settings.hotelName)}</div>
        <div class="hotel-sub">${esc(settings.hotelAddress)}${
          settings.hotelPhone || settings.ownerPhone
            ? ` · ${[settings.hotelPhone, settings.ownerPhone].filter(Boolean).map((p) => esc(p as string)).join(" · ")}`
            : ""
        }</div>
        ${settings.hotelGstin ? `<div class="hotel-gstin">GSTIN: ${esc(settings.hotelGstin)}</div>` : ""}
      </div>
    </div>
    <div class="meta">
      <div class="pill">${esc(pillLabel)}</div>
      <div class="res-no">${esc(reservation.reservationNumber)}</div>
      <div class="doc-date-small">${formatIstDateTime24(new Date(payment.paymentDate))}</div>
      ${payment.receiptNumber ? `<div class="doc-date-small" style="font-family:'SF Mono',Menlo,monospace;margin-top:2px;">${esc(payment.receiptNumber)}</div>` : ""}
      <div style="font-size:8px;color:#9AA59E;margin-top:4px;">${esc(titleLabel)}</div>
    </div>
  </div>

  <div class="cards">
    <div class="card">
      <div class="card-label">Guest</div>
      <div class="card-name">${esc(guest.fullName)}</div>
      <div class="card-sub">${esc(guest.phone)}</div>
      ${
        guest.idProofType && guest.idProofLast4
          ? `<div class="card-id">${esc(guest.idProofType.replace("_", " "))} ····${esc(guest.idProofLast4)}${
              guest.gender ? ` · ${esc(formatGender(guest.gender))}` : ""
            }</div>`
          : guest.gender
            ? `<div class="card-id">${esc(formatGender(guest.gender))}</div>`
            : ""
      }
      ${guest.gstin ? `<div class="card-sub" style="margin-top:2px;">GSTIN: ${esc(guest.gstin)}</div>` : ""}
      ${
        coGuests && coGuests.length > 0
          ? `<div style="margin-top:6px;padding-top:6px;border-top:1px dashed #D6D2C4;">
              <div class="card-label" style="font-size:8px;">Also occupying</div>
              ${coGuests
                .map(
                  (cg) =>
                    `<div class="card-sub" style="margin-top:2px;">${esc(cg.fullName)} · ${esc(cg.phone)}${
                      cg.idProofType && cg.idProofLast4
                        ? ` · ${esc(cg.idProofType.replace("_", " "))} ····${esc(cg.idProofLast4)}`
                        : ""
                    }${cg.gender ? ` · ${esc(formatGender(cg.gender))}` : ""}</div>`,
                )
                .join("")}
            </div>`
          : ""
      }
    </div>
    <div class="card">
      <div class="card-label">Stay</div>
      <div class="stay-grid">
        <div>
          <div class="stay-tag">Check-in</div>
          <div class="stay-date">${formatIstDate(
            new Date(
              reservation.checkedInAt ??
                reservation.plannedCheckInAt ??
                reservation.checkInDate,
            ),
          )}</div>
          <div class="stay-time">${(() => {
            // Priority (0023): actual checked-in stamp > staff-chosen
            // planned time > hotel policy default.
            if (reservation.checkedInAt) {
              return `at ${formatIstTime(new Date(reservation.checkedInAt))}`;
            }
            if (reservation.plannedCheckInAt) {
              return `at ${formatIstTime(new Date(reservation.plannedCheckInAt))}`;
            }
            return settings.checkInTime
              ? `from ${formatTime(settings.checkInTime)}`
              : "";
          })()}</div>
        </div>
        <div>
          <div class="stay-tag">Check-out</div>
          <div class="stay-date">${formatIstDate(
            shortStayCheckoutDate ??
              (reservation.plannedCheckOutAt
                ? new Date(reservation.plannedCheckOutAt)
                : new Date(reservation.checkOutDate)),
          )}</div>
          ${(() => {
            if (shortStayCheckoutDate) {
              return `<div class="stay-time">by ${formatIstTime(shortStayCheckoutDate)}</div>`;
            }
            if (reservation.plannedCheckOutAt) {
              return `<div class="stay-time">by ${formatIstTime(new Date(reservation.plannedCheckOutAt))}</div>`;
            }
            return settings.checkOutTime
              ? `<div class="stay-time">by ${formatTime(settings.checkOutTime)}</div>`
              : "";
          })()}
        </div>
      </div>
      <div class="stay-occ">${stayUnitLabel} · ${reservation.numAdults} adult${reservation.numAdults === 1 ? "" : "s"}${
        reservation.numChildren > 0
          ? `, ${reservation.numChildren} child${reservation.numChildren === 1 ? "" : "ren"}`
          : ""
      }</div>
    </div>
  </div>

  ${
    rooms.length
      ? `
  <div class="section-cap">Rooms Allotted</div>
  <table class="rooms-allotted">
    <thead>
      <tr>
        <th>Room</th>
        <th>Type</th>
        <th class="num">${isShortStay ? `Rate / ${durationHours} hrs` : "Rate/Night"}</th>
      </tr>
    </thead>
    <tbody>
      ${rooms
        .map(
          (rm) => `
        <tr>
          <td class="roomno">${esc(rm.roomNumber)}</td>
          <td class="cap">${esc(rm.displayType)}</td>
          <td class="num">${inr(rm.ratePerNight, L.currency)}</td>
        </tr>`,
        )
        .join("")}
    </tbody>
  </table>`
      : ""
  }

  <div class="amount-banner">
    <div class="cap">${esc(amountLabel)}</div>
    <div class="amt">${inr(Math.abs(Number(payment.amount)), L.currency)}</div>
    <div class="method">via ${esc(payment.paymentMethod.replace(/_/g, " "))}${payment.notes ? ` · ${esc(payment.notes)}` : ""}</div>
  </div>

  <div class="totals-wrap">
    <table class="totals-slip">
      <tr>
        <td class="lbl">Subtotal (${subtotalUnitLabel})</td>
        <td class="num">${inr(subtotal, L.currency)}</td>
      </tr>
      ${
        gstRate && gstAmount
          ? `
        <tr>
          <td class="lbl">CGST @ ${halfGstRate}%</td>
          <td class="num">${inr(halfGstAmount, L.currency)}</td>
        </tr>
        <tr>
          <td class="lbl">SGST @ ${halfGstRate}%</td>
          <td class="num">${inr(otherHalfGstAmount, L.currency)}</td>
        </tr>`
          : ""
      }
      <tr class="gt">
        <td>Grand Total</td>
        <td class="num">${inr(grandTotal, L.currency)}</td>
      </tr>
      ${
        walletCreditApplied > 0.009
          ? `
        <tr class="paid">
          <td>Wallet credit applied</td>
          <td class="num">−${inr(walletCreditApplied, L.currency)}</td>
        </tr>`
          : ""
      }
      ${paidLinesHtml(allPayments ?? [], {
        currency: L.currency,
        rowClass: "paid",
        numClass: "num",
        checkedInAtMs: reservation.checkedInAt
          ? new Date(reservation.checkedInAt).getTime()
          : null,
        paidFallback: paidSoFar,
        totalLabel: "Paid",
      })}
      <tr class="bal">
        <td>Balance Due</td>
        <td class="num">${inr(balanceDue, L.currency)}</td>
      </tr>
    </table>
  </div>

  <div class="welcome-note">
    ${
      isAdvance
        ? `Welcome to ${esc(settings.hotelName)}. Please retain this slip for reference. Final invoice will be issued at check-out${
            shortStayCheckoutDate
              ? ` (by ${formatIstTime(shortStayCheckoutDate)})`
              : settings.checkOutTime
                ? ` (by ${formatTime(settings.checkOutTime)})`
                : ""
          }. For any assistance, contact the front desk.`
        : esc(L.footerText)
    }
  </div>

  ${
    // Only show the "balance due at check-in" note for pre-bookings —
    // the guest isn't on premises yet and needs to know to clear the
    // balance on arrival. For walk-ins the guest is already at the
    // desk and either pays in full now or signs off at checkout, so
    // the note is meaningless. Complimentary bookings never bill.
    isAdvance &&
    balanceDue > 0.009 &&
    reservation.bookingSource === "phone_whatsapp"
      ? `<div style="margin-top:10px;padding:8px 10px;border:1px solid #B45309;border-radius:3px;background:#FBEFD9;color:#7C2D12;font-size:10pt;font-weight:600;text-align:center;">
            Note: The remaining balance of ${inr(balanceDue, L.currency)} must be paid on or before check-in.
          </div>`
      : ""
  }

  ${
    L.showSignature
      ? `<div class="sigs">
          <div class="sig-line">Guest Signature</div>
          <div class="sig-line" style="text-align:right;">${esc(L.signatoryLabel)}</div>
        </div>`
      : ""
  }
</div>

</body></html>`;
}

export async function renderReceiptPdf(data: {
  payment: Payment;
  reservation: Reservation;
  guest: Guest;
  invoice: Invoice | null;
  settings: Settings;
}): Promise<Buffer> {
  // Fetch the rooms allotted to this reservation so the receipt PDF can show
  // the same "Rooms Allotted" table as the on-screen slip.
  const roomRows = await db
    .select({
      roomNumber: rooms.roomNumber,
      roomType: rooms.roomType,
      soldAsType: reservationRooms.soldAsType,
      ratePerNight: reservationRooms.ratePerNight,
    })
    .from(reservationRooms)
    .innerJoin(rooms, eq(rooms.id, reservationRooms.roomId))
    .where(eq(reservationRooms.reservationId, data.reservation.id));
  const typeRows = await db
    .select({ slug: roomTypes.slug, label: roomTypes.label })
    .from(roomTypes);
  const labelMap = new Map(typeRows.map((r) => [r.slug, r.label]));
  const roomsForRender = roomRows.map((rm) => ({
    roomNumber: rm.roomNumber,
    ratePerNight: rm.ratePerNight,
    displayType: combinedRoomTypeLabel(rm.roomType, rm.soldAsType, labelMap),
  }));

  // Fetch every non-voided payment for this reservation so renderReceiptHtml
  // can split the "Paid" total into Advance (at/before check-in) and Later.
  const allPayments = await db
    .select()
    .from(payments)
    .where(eq(payments.reservationId, data.reservation.id));

  // Co-guests (migration 0020) — additional adults whose KYC was
  // captured at booking. Surfaced on the receipt as a "Also occupying"
  // block so the printed slip mirrors what's on screen.
  const coGuestRows = await db
    .select({
      position: reservationCoGuests.position,
      fullName: guests.fullName,
      phone: guests.phone,
      gender: guests.gender,
      idProofType: guests.idProofType,
      idProofLast4: guests.idProofLast4,
    })
    .from(reservationCoGuests)
    .innerJoin(guests, eq(guests.id, reservationCoGuests.guestId))
    .where(eq(reservationCoGuests.reservationId, data.reservation.id))
    .orderBy(asc(reservationCoGuests.position));

  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await hardenPage(page);
    const inlinedLogo = await inlineLogo(data.settings.hotelLogoUrl ?? null);
    const html = renderReceiptHtml({
      ...data,
      settings: { ...data.settings, hotelLogoUrl: inlinedLogo },
      rooms: roomsForRender,
      allPayments,
      coGuests: coGuestRows,
    });
    await page.setContent(html, { waitUntil: PAGE_WAIT_UNTIL, timeout: 15_000 });
    const pdf = await page.pdf({
      format: asPaper(data.settings.docReceiptPageSize),
      printBackground: true,
      margin: { top: "12mm", bottom: "12mm", left: "12mm", right: "12mm" },
      timeout: 15_000,
    });
    return Buffer.from(pdf);
  } catch (err) {
    logger.error({ err }, "Receipt PDF rendering failed");
    throw err;
  } finally {
    await page.close();
  }
}

export const docRenderHelpers = { layoutFromSettings, renderInvoiceHtml, renderReceiptHtml };
