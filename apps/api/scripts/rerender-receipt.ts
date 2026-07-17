// Re-renders the receipt PDF for a single payment and overwrites the stored
// public PDF (so the link previously sent via WhatsApp / shown on screen now
// reflects the latest renderer). Useful after a renderer bug fix.
//
// Usage:
//   npx tsx scripts/rerender-receipt.ts <reservationNumber>
// Example:
//   npx tsx scripts/rerender-receipt.ts SLDT-RES-0004

import { eq } from "drizzle-orm";
import { db } from "../src/db/client.js";
import { guests } from "../src/db/schema/guests.js";
import { invoices, payments } from "../src/db/schema/invoices.js";
import { reservations } from "../src/db/schema/reservations.js";
import { renderReceiptPdf, closeBrowser } from "../src/lib/pdf.js";
import { getSettings } from "../src/lib/settings.js";
import { uploadPublicPdf } from "../src/lib/storage.js";

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error("Usage: tsx scripts/rerender-receipt.ts <reservationNumber>");
    process.exit(1);
  }

  const [r] = await db
    .select()
    .from(reservations)
    .where(eq(reservations.reservationNumber, arg))
    .limit(1);
  if (!r) {
    console.error(`No reservation with number "${arg}"`);
    process.exit(1);
  }
  const [g] = await db.select().from(guests).where(eq(guests.id, r.guestId)).limit(1);
  if (!g) {
    console.error(`Guest ${r.guestId} missing`);
    process.exit(1);
  }
  const pays = await db.select().from(payments).where(eq(payments.reservationId, r.id));
  if (!pays.length) {
    console.error("No payments on this reservation — nothing to re-render.");
    process.exit(1);
  }
  const [inv] = await db.select().from(invoices).where(eq(invoices.reservationId, r.id)).limit(1);
  const settings = await getSettings();

  for (const p of pays) {
    console.log(`Rendering receipt for payment ${p.receiptNumber ?? p.id} (₹${p.amount})…`);
    const pdf = await renderReceiptPdf({
      payment: p,
      reservation: r,
      guest: g,
      invoice: inv ?? null,
      settings,
    });
    const path = `receipts/${p.receiptNumber ?? p.id}.pdf`;
    const url = await uploadPublicPdf(path, pdf);
    console.log(`  uploaded → ${url ?? "(no public URL)"}`);
  }

  await closeBrowser();
  await db.$client.end({ timeout: 5 });
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
