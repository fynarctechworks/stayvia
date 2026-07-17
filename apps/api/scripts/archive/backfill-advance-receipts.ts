import "dotenv/config";
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL!, { prepare: false });

function pad4(n: number) {
  return String(n).padStart(4, "0");
}
function fmtDate(d: Date) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

async function main() {
  console.log("Scanning for reservations with advance but no payment row...");

  const rows = await sql<
    {
      id: string;
      reservation_number: string;
      advance_paid: string;
      created_at: Date;
      guest_id: string;
      invoice_id: string | null;
    }[]
  >`
    SELECT r.id, r.reservation_number, r.advance_paid, r.created_at, r.guest_id,
           (SELECT i.id FROM invoices i WHERE i.reservation_id = r.id LIMIT 1) AS invoice_id
    FROM reservations r
    WHERE CAST(r.advance_paid AS numeric) > 0
      AND NOT EXISTS (
        SELECT 1 FROM payments p
        WHERE p.reservation_id = r.id
      )
    ORDER BY r.created_at ASC
  `;

  console.log(`Found ${rows.length} reservation(s) needing backfill.`);
  if (!rows.length) {
    await sql.end();
    return;
  }

  const seqByDay = new Map<string, number>();
  async function nextSeq(day: string): Promise<number> {
    if (!seqByDay.has(day)) {
      const res = await sql<{ max: number | null }[]>`
        SELECT COALESCE(MAX(CAST(SPLIT_PART(receipt_number, '-', 3) AS INT)), 0) AS max
        FROM payments WHERE receipt_number LIKE ${"RCP-" + day + "-%"}
      `;
      seqByDay.set(day, res[0]?.max ?? 0);
    }
    const current = seqByDay.get(day)! + 1;
    seqByDay.set(day, current);
    return current;
  }

  let inserted = 0;
  for (const r of rows) {
    const day = fmtDate(new Date(r.created_at));
    const seq = await nextSeq(day);
    const receiptNo = `RCP-${day}-${pad4(seq)}`;

    const reservation = await sql<{ created_by: string | null }[]>`
      SELECT created_by FROM reservations WHERE id = ${r.id}
    `;
    const receivedBy = reservation[0]?.created_by;
    if (!receivedBy) {
      console.warn(`  Skipped ${r.reservation_number}: no created_by on reservation`);
      continue;
    }

    await sql`
      INSERT INTO payments (
        receipt_number, invoice_id, reservation_id,
        amount, payment_method, received_by, notes,
        payment_date, created_at
      ) VALUES (
        ${receiptNo}, ${r.invoice_id}, ${r.id},
        ${r.advance_paid}, 'cash', ${receivedBy}, 'Backfilled advance receipt',
        ${r.created_at.toISOString()}, ${r.created_at.toISOString()}
      )
    `;
    inserted += 1;
    console.log(`  ${r.reservation_number}: ₹${r.advance_paid} -> ${receiptNo}`);
  }

  console.log(`\nBackfilled ${inserted} payment row(s).`);
  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
