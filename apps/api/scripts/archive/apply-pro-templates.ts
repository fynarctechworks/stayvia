import "dotenv/config";
import postgres from "postgres";

const TEMPLATES: Record<string, { subject: string | null; body: string }> = {
  booking_created_guest_sms: {
    subject: null,
    body: `🌿 Namaste {guest_name},

Your booking at SLDT Stay Inn is confirmed.

Reference: {reservation_number}
Check-in: {check_in_date}
Check-out: {check_out_date}
Total: ₹{total}

We look forward to welcoming you in Sabbavaram.

— SLDT Stay Inn`,
  },
  booking_created_owner_sms: {
    subject: null,
    body: `📥 New Booking
{reservation_number}
{guest_name} · {guest_phone}
{check_in_date} → {check_out_date}
Total: ₹{total}`,
  },
  checkin_guest_sms: {
    subject: null,
    body: `🌿 Welcome, {guest_name}!

Your check-in is confirmed.
Reference: {reservation_number}
Check-out: {check_out_date} by 11:00 AM

For room service or any assistance, please reach the front desk anytime.

Have a pleasant stay,
— SLDT Stay Inn`,
  },
  checkin_owner_sms: {
    subject: null,
    body: `🟢 Checked In
{guest_name} · {guest_phone}
{reservation_number}`,
  },
  checkout_guest_sms: {
    subject: null,
    body: `🙏 Thank you for staying, {guest_name}.

Invoice {invoice_number} has been generated.
View invoice: {invoice_link}

We hope you had a comfortable stay at SLDT Stay Inn.
We'd love to host you again on your next visit to Sabbavaram.

— SLDT Stay Inn
Sabbavaram`,
  },
  checkout_owner_sms: {
    subject: null,
    body: `🔴 Checked Out
{guest_name}
{reservation_number} · Invoice {invoice_number}`,
  },
  otp_guest_sms: {
    subject: null,
    body: `🔐 SLDT Stay Inn

Your verification code is: {otp_code}

Valid for {otp_minutes} minutes.
Do not share this code with anyone.`,
  },
};

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL missing");
  const sql = postgres(url, { prepare: false });
  console.log("Applying professional WhatsApp templates...");
  for (const [key, t] of Object.entries(TEMPLATES)) {
    await sql`
      insert into message_templates (key, subject, body, enabled)
      values (${key}, ${t.subject}, ${t.body}, true)
      on conflict (key) do update
      set subject = excluded.subject, body = excluded.body, updated_at = now()
    `;
    console.log(`  ✓ ${key}`);
  }
  await sql.end();
  console.log("Done.");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
