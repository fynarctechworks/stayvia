import "dotenv/config";
import postgres from "postgres";

const T: Record<string, { body: string; enabled: boolean }> = {
  // Booking-created templates kept disabled — staff will mark these false anyway.
  booking_created_guest_sms: { body: "", enabled: false },
  booking_created_owner_sms: { body: "", enabled: false },

  checkin_guest_sms: {
    enabled: true,
    body: `🌿 Welcome, {guest_name}!

Your check-in is confirmed.
Reference: {reservation_number}
Room: {room_numbers}
Check-out: {check_out_date} by 11:00 AM

Total: ₹{total}
Advance paid: ₹{advance_paid}
Balance due: ₹{balance}

View receipt: {receipt_link}

📞 Front desk: {hotel_phone}
📶 Wi-Fi: {wifi_ssid} / {wifi_password}

Enjoy your stay,
— SLDT Stay Inn, Sabbavaram`,
  },

  checkin_owner_sms: {
    enabled: true,
    body: `🟢 Checked In · {check_in_date}
{guest_name} · {guest_phone}
Room {room_numbers} · {reservation_number}
Total ₹{total} · Advance ₹{advance_paid} · Balance ₹{balance}`,
  },

  checkout_guest_sms: {
    enabled: true,
    body: `🙏 Thank you for staying with us, {guest_name}.

Invoice {invoice_number} · ₹{total}
View invoice: {invoice_link}

We hope you had a comfortable stay at SLDT Stay Inn.
For your next visit to Sabbavaram, message us anytime on this number — we'll prioritise your booking.

Safe travels,
— SLDT Stay Inn, Sabbavaram
{hotel_phone}`,
  },

  checkout_owner_sms: {
    enabled: true,
    body: `🔴 Checked Out · {check_out_date}
{guest_name}
{reservation_number} · Invoice {invoice_number}
Collected ₹{total}`,
  },

  otp_guest_sms: {
    enabled: true,
    body: `SLDT Stay Inn

Your check-in verification code is:

*{otp_code}*

Valid for {otp_minutes} minutes.
Do not share this code with anyone, including hotel staff.`,
  },
};

async function main() {
  const sql = postgres(process.env.DATABASE_URL!, { prepare: false });
  console.log("Applying final WhatsApp templates...");
  for (const [key, t] of Object.entries(T)) {
    await sql`
      insert into message_templates (key, subject, body, enabled)
      values (${key}, null, ${t.body}, ${t.enabled})
      on conflict (key) do update
      set body = excluded.body, enabled = excluded.enabled, updated_at = now()
    `;
    console.log(`  ${t.enabled ? "✓" : "·"} ${key}`);
  }
  await sql.end();
  console.log("Done.");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
