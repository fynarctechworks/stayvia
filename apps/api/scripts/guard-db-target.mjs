// Safety guard for destructive DB scripts (migrate / seed).
//
// These scripts mutate whatever DATABASE_URL points at. On a dev machine the
// prod connection string can be a copy/paste or a stray NODE_ENV away, so we
// refuse to run against a NON-LOCAL host unless the operator explicitly opts
// in with ALLOW_REMOTE_DB=1.
//
// "Local" = the Supabase CLI / docker hosts. Anything else (a *.supabase.com
// pooler, an RDS endpoint, a public IP) is treated as remote and blocked.
const LOCAL_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "host.docker.internal",
  "postgres", // docker-compose service name
  "supabase_db_hoteldesk",
]);

export function assertLocalDbTarget(databaseUrl) {
  if (!databaseUrl) return; // the caller already errors on missing URL
  if (process.env.ALLOW_REMOTE_DB === "1") {
    console.warn(
      "⚠️  ALLOW_REMOTE_DB=1 set — running against a possibly REMOTE database. Proceed with care.",
    );
    return;
  }

  let host;
  try {
    host = new URL(databaseUrl).hostname.toLowerCase();
  } catch {
    // Unparseable URL — let the script's own validation handle it.
    return;
  }

  if (!LOCAL_HOSTS.has(host)) {
    console.error(
      `\n✋ Refusing to run: DATABASE_URL points at a non-local host "${host}".\n` +
        `   This script mutates the database. To protect production, it only runs\n` +
        `   against a local DB by default.\n\n` +
        `   If you really mean to target this host, re-run with ALLOW_REMOTE_DB=1.\n`,
    );
    process.exit(1);
  }
}
