import "dotenv/config";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import postgres from "postgres";

const HOTEL_NAME = "SLDT Stay Inn";
const HOTEL_ADDRESS = "Sabbavaram, Visakhapatnam, Andhra Pradesh";
const LOGO_PATH = resolve("../web/public/logo.jpg");
const BUCKET = "public-assets";
const OBJECT_KEY = "sldt-logo.jpg";

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  const supaUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!dbUrl || !supaUrl || !serviceKey) throw new Error("Missing env vars");

  const sql = postgres(dbUrl, { prepare: false });
  const supa = createClient(supaUrl, serviceKey, { auth: { persistSession: false } });

  console.log("1) Ensuring public bucket exists...");
  const { data: buckets } = await supa.storage.listBuckets();
  if (!buckets?.find((b) => b.name === BUCKET)) {
    const { error } = await supa.storage.createBucket(BUCKET, { public: true });
    if (error && !error.message.includes("already exists")) {
      throw error;
    }
    console.log(`   ✓ created bucket "${BUCKET}"`);
  } else {
    console.log(`   ✓ bucket "${BUCKET}" already exists`);
  }

  console.log("2) Uploading logo...");
  const bytes = readFileSync(LOGO_PATH);
  const { error: upErr } = await supa.storage
    .from(BUCKET)
    .upload(OBJECT_KEY, bytes, {
      contentType: "image/jpeg",
      upsert: true,
    });
  if (upErr) throw upErr;
  const { data: pub } = supa.storage.from(BUCKET).getPublicUrl(OBJECT_KEY);
  const logoUrl = pub.publicUrl;
  console.log(`   ✓ uploaded → ${logoUrl}`);

  console.log("3) Updating settings row...");
  const result = await sql`
    update settings
    set hotel_name = ${HOTEL_NAME},
        hotel_address = ${HOTEL_ADDRESS},
        hotel_logo_url = ${logoUrl},
        updated_at = now()
    returning hotel_name, hotel_logo_url
  `;
  console.log("   ✓ settings:", result[0]);

  await sql.end();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
