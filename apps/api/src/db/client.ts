import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "../config/env.js";
import * as schema from "./schema/index.js";

const queryClient = postgres(env.DATABASE_URL, {
  // The Supabase session-mode pooler caps total clients at 15. With a
  // single app process that left room, but dev restarts overlap (the old
  // process's connections take idle_timeout seconds to drain) and we hit
  // "EMAXCONNSESSION: max clients reached". Keeping max well under the
  // pooler cap means an overlapping restart can't exhaust it. Bump back
  // up only if a higher-capacity pooler/direct connection is configured.
  max: 5,
  idle_timeout: 20,
  connect_timeout: 10,
  prepare: false,
});

export const db = drizzle(queryClient, { schema });
export type DB = typeof db;
