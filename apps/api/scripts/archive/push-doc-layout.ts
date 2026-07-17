import "dotenv/config";
import postgres from "postgres";

const SQL = `
alter table settings
  add column if not exists doc_primary_color text not null default '#0F3D2E',
  add column if not exists doc_accent_color text not null default '#B08A4A',
  add column if not exists doc_invoice_title text not null default 'Tax Invoice',
  add column if not exists doc_receipt_title text not null default 'Payment Receipt',
  add column if not exists doc_footer_text text not null default 'Thank you for staying with us.',
  add column if not exists doc_terms_text text,
  add column if not exists doc_signatory_label text not null default 'Authorised Signatory',
  add column if not exists doc_invoice_page_size text not null default 'A4',
  add column if not exists doc_receipt_page_size text not null default 'A5',
  add column if not exists doc_show_logo boolean not null default true,
  add column if not exists doc_show_gstin boolean not null default true,
  add column if not exists doc_show_terms boolean not null default false,
  add column if not exists doc_show_signature boolean not null default true;
`;

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL missing");
  const sql = postgres(url, { prepare: false });
  console.log("Adding document layout columns...");
  await sql.unsafe(SQL);
  console.log("✓ done");
  await sql.end();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
