import "dotenv/config";
import postgres from "postgres";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const sql = postgres(process.env.DATABASE_URL, { max: 1 });

try {
  // Show what's about to be deleted
  const [{ count: rCount }] = await sql`SELECT COUNT(*)::int AS count FROM reservations`;
  const [{ count: gCount }] = await sql`SELECT COUNT(*)::int AS count FROM guests`;
  const [{ count: iCount }] = await sql`SELECT COUNT(*)::int AS count FROM invoices`;
  const [{ count: pCount }] = await sql`SELECT COUNT(*)::int AS count FROM payments`;
  console.log(
    `Wiping: ${rCount} reservation(s), ${iCount} invoice(s), ${pCount} payment(s), ${gCount} guest(s)`,
  );

  await sql.begin(async (tx) => {
    // 1. Activity log rows that reference reservations/guests/invoices/payments
    //    (no FK — just clear by entity_type)
    await tx`DELETE FROM activity_log WHERE entity_type IN ('reservation','guest','invoice','payment','room_type')`;

    // 2. Notifications + OTPs related to reservations
    await tx`DELETE FROM otps`;
    await tx`DELETE FROM notifications`;

    // 3. Payments first (FK to invoices, reservations)
    await tx`DELETE FROM payments`;

    // 4. Invoice line items, invoices
    await tx`DELETE FROM invoice_line_items`;
    await tx`DELETE FROM invoices`;

    // 5. Additional charges, reservation_rooms, reservations
    await tx`DELETE FROM additional_charges`;
    await tx`DELETE FROM reservation_rooms`;
    await tx`DELETE FROM reservations`;

    // 6. Guest ledger, follow-ups, notes, guests
    await tx`DELETE FROM guest_ledger`;
    await tx`DELETE FROM guest_follow_ups`;
    await tx`DELETE FROM guest_notes`;
    await tx`DELETE FROM guests`;

    // 7. Reset all rooms to "available" and clear any operational notes
    await tx`
      UPDATE rooms
      SET status = 'available',
          notes = NULL,
          updated_at = now()
      WHERE status IN ('occupied','reserved','dirty','clean','inspected','maintenance')
    `;
  });

  console.log("ok: reservations, invoices, payments, guests wiped; rooms reset to available");
  console.log("note: KYC photos in the kyc-docs bucket are now orphaned");
} catch (err) {
  console.error("wipe failed:", err.message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
