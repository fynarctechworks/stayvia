// One-off: remove ALL objects from the kyc-docs bucket. Safe to run only
// when guest rows have been wiped (every object is then orphaned). Files
// are laid out as `${guestId}/${side}-${token}.jpg`, so we list top-level
// "folders" then list + remove the objects inside each.
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  process.exit(1);
}

const BUCKET = "kyc-docs";
const supabase = createClient(url, key, { auth: { persistSession: false } });

async function listAll(prefix) {
  // Page through a prefix (Supabase caps list at 100 by default).
  const out = [];
  let offset = 0;
  for (;;) {
    const { data, error } = await supabase.storage
      .from(BUCKET)
      .list(prefix, { limit: 100, offset });
    if (error) throw new Error(`list "${prefix}" failed: ${error.message}`);
    if (!data || data.length === 0) break;
    out.push(...data);
    if (data.length < 100) break;
    offset += data.length;
  }
  return out;
}

try {
  const folders = await listAll("");
  let removed = 0;
  const allPaths = [];

  for (const entry of folders) {
    // A folder has no `id`; a file at the root has one. Handle both.
    if (entry.id === null || entry.id === undefined) {
      const files = await listAll(entry.name);
      for (const f of files) allPaths.push(`${entry.name}/${f.name}`);
    } else {
      allPaths.push(entry.name);
    }
  }

  if (allPaths.length === 0) {
    console.log("kyc-docs bucket is already empty.");
    process.exit(0);
  }

  // remove() takes up to 1000 paths per call.
  for (let i = 0; i < allPaths.length; i += 1000) {
    const batch = allPaths.slice(i, i + 1000);
    const { error } = await supabase.storage.from(BUCKET).remove(batch);
    if (error) throw new Error(`remove batch failed: ${error.message}`);
    removed += batch.length;
  }

  console.log(`removed ${removed} object(s) from kyc-docs.`);
} catch (err) {
  console.error("wipe failed:", err.message);
  process.exitCode = 1;
}
