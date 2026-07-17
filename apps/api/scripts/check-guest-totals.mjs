import "dotenv/config";
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL, { max: 1 });
try {
  const guests = await sql`SELECT id, full_name FROM guests`;
  for (const g of guests) {
    const result = await sql`
      WITH guest_reservations AS (
        SELECT r.id, r.status, r.balance_due
        FROM reservations r
        WHERE r.guest_id = ${g.id}
      ),
      paid AS (
        SELECT COALESCE(SUM(p.amount::numeric), 0) AS total
        FROM payments p
        INNER JOIN guest_reservations gr ON gr.id = p.reservation_id
        WHERE p.voided = false AND p.status = 'received'
      ),
      balances AS (
        SELECT COALESCE(SUM(
          CASE
            WHEN gr.status = 'cancelled' THEN 0
            ELSE COALESCE(
              (SELECT i.balance_due::numeric
               FROM invoices i
               WHERE i.reservation_id = gr.id AND i.status != 'voided'
               ORDER BY i.created_at DESC
               LIMIT 1),
              gr.balance_due::numeric
            )
          END
        ), 0) AS total
        FROM guest_reservations gr
      )
      SELECT (SELECT total FROM paid) AS total_paid,
             (SELECT total FROM balances) AS balance_due
    `;
    console.log(`${g.full_name}: paid=${result[0].total_paid} balance=${result[0].balance_due}`);
  }
} finally {
  await sql.end();
}
