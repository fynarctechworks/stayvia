// One-shot backfill: rewrites the room_charge invoice line-item descriptions
// for all existing invoices so they match the new format
// "Room <N> - <physical-label>[ booked as <sold-as-label>] (<nights> nights)".
//
// Earlier versions saved the raw slug ("non_ac_bed_rooms"), and a brief
// intermediate version saved the sold-as slug only. This script makes
// every existing invoice consistent with the post-fix server code.
//
// Safe to re-run — it always rebuilds from the source-of-truth rows.
//
//   node scripts/rebuild-invoice-line-items.mjs

import "dotenv/config";
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL, { max: 1 });

function prettify(slug) {
  return String(slug)
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

try {
  const types = await sql`SELECT slug, label FROM room_types`;
  const labelMap = new Map(types.map((t) => [t.slug, t.label]));
  const lookup = (slug) => labelMap.get(slug) ?? prettify(slug);

  // Every room-charge line item joined with its source reservation_rooms row.
  // We match line items to their reservation_rooms row by the room number
  // embedded in the description ("Room 202 - ..."). That's a heuristic, but
  // historical descriptions all use this pattern.
  const rows = await sql`
    SELECT
      li.id            AS line_item_id,
      li.description   AS old_description,
      i.reservation_id AS reservation_id,
      rr.room_id       AS room_id,
      rr.sold_as_type  AS sold_as_type,
      r.room_number    AS room_number,
      r.room_type      AS physical_type,
      res.num_nights   AS nights
    FROM invoice_line_items li
    JOIN invoices i        ON i.id  = li.invoice_id
    JOIN reservation_rooms rr ON rr.reservation_id = i.reservation_id
    JOIN rooms r           ON r.id  = rr.room_id
    JOIN reservations res  ON res.id = i.reservation_id
    WHERE li.item_type = 'room_charge'
      AND li.description LIKE '%Room ' || r.room_number || ' -%'
  `;

  let updated = 0;
  for (const row of rows) {
    const physicalLabel = lookup(row.physical_type);
    const displayType =
      row.sold_as_type && row.sold_as_type !== row.physical_type
        ? `${physicalLabel} booked as ${lookup(row.sold_as_type)}`
        : physicalLabel;
    const nights = Number(row.nights);
    const newDescription = `Room ${row.room_number} - ${displayType} (${nights} nights)`;
    if (newDescription === row.old_description) continue;
    await sql`UPDATE invoice_line_items SET description = ${newDescription} WHERE id = ${row.line_item_id}`;
    console.log(`updated ${row.line_item_id}: "${row.old_description}" -> "${newDescription}"`);
    updated++;
  }
  console.log(`\nDone. ${updated} line item(s) updated, ${rows.length - updated} already correct.`);
} finally {
  await sql.end();
}
