import "dotenv/config";
import postgres from "postgres";

const SQL = `
do $$ begin
  if not exists (select 1 from pg_type where typname = 'otp_purpose') then
    -- using text columns; no enum types needed
    null;
  end if;
end $$;

create table if not exists otps (
  id uuid primary key default gen_random_uuid(),
  purpose text not null,
  channel text not null,
  target text not null,
  code_hash text not null,
  reservation_id uuid,
  guest_id uuid,
  expires_at timestamptz not null,
  attempts integer not null default 0,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_otps_target_purpose on otps(target, purpose);
create index if not exists idx_otps_reservation on otps(reservation_id);

create table if not exists notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references profiles(id) on delete cascade,
  type text not null,
  title text not null,
  body text not null,
  href text,
  payload jsonb,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_notifications_recipient_unread on notifications(recipient_id, read_at);
create index if not exists idx_notifications_recipient_created on notifications(recipient_id, created_at);

create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references profiles(id) on delete cascade,
  recipient_id uuid not null references profiles(id) on delete cascade,
  body text not null,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_messages_sender_created on messages(sender_id, created_at);
create index if not exists idx_messages_recipient_unread on messages(recipient_id, read_at);
create index if not exists idx_messages_pair on messages(sender_id, recipient_id, created_at);
`;

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL missing");
  const sql = postgres(url, { prepare: false });
  console.log("Applying otp/notifications/messages schema...");
  await sql.unsafe(SQL);
  console.log("✓ done");
  await sql.end();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
