// Dev-only smoke check for printed-document branding.
//
// Renders a real receipt PDF for a hotel that has NO logo of its own and
// asserts the three things that can silently regress:
//   1. it renders at all (the fallback-logo path doesn't throw),
//   2. the page box is A4,
//   3. both marks (Stayvia fallback + FYN ARC credit) are embedded.
//
// Run: npx tsx apps/api/scripts/verify-brand-pdf.mts
import { eq } from "drizzle-orm";
import { db } from "../src/db/client.js";
import { invoiceLineItems, invoices } from "../src/db/schema/invoices.js";
import { properties } from "../src/db/schema/properties.js";
import { settings } from "../src/db/schema/settings.js";
import { renderInvoicePdf } from "../src/lib/pdf.js";

// Start from an invoice so we always land on a property that actually has
// documents (two demo hotels share a name).
const [inv] = await db.select().from(invoices).limit(1);
if (!inv) throw new Error("no invoice to render");
const [prop] = await db
  .select()
  .from(properties)
  .where(eq(properties.id, inv.propertyId))
  .limit(1);
const [s] = await db.select().from(settings).where(eq(settings.propertyId, inv.propertyId)).limit(1);
if (!s) throw new Error("no settings");
console.log("hotel:", prop?.name);
console.log("hotel logo:", s.hotelLogoUrl ?? "(none - fallback path under test)");
console.log("invoice page size:", s.docInvoicePageSize, "| receipt page size:", s.docReceiptPageSize);

const items = await db
  .select()
  .from(invoiceLineItems)
  .where(eq(invoiceLineItems.invoiceId, inv.id));

async function render(label: string, settingsRow: typeof s) {
  const pdf = await renderInvoicePdf({
    invoice: inv,
    lineItems: items,
    payments: [],
    settings: settingsRow,
  });
  const raw = pdf.toString("latin1");
  // A4 portrait = 595.28 x 841.89 pt; Chromium rounds, so allow +/-1.
  const box = raw.match(/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)/);
  const w = box ? Math.round(Number(box[1])) : 0;
  const h = box ? Math.round(Number(box[2])) : 0;
  const a4 = Math.abs(w - 595) <= 1 && Math.abs(h - 842) <= 1;
  const images = (raw.match(/\/Subtype\s*\/Image/g) ?? []).length;
  console.log(
    `${label}: ${pdf.length} bytes | ${w}x${h}pt ${a4 ? "A4 OK" : "!! NOT A4"} | images ${images}`,
  );
  return a4 && images >= 2;
}

const withLogo = await render("with hotel logo   ", s);
// The real fallback path: a property that never uploaded a mark.
const noLogo = await render("no logo (fallback)", { ...s, hotelLogoUrl: null });
process.exit(withLogo && noLogo ? 0 : 1);
