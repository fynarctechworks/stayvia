import { integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { profiles } from "./profiles.js";

// Offline desktop credentials. One row per staff profile that can log in on
// the desk. Provisioned during the last online session (POST
// /auth/provision-local) so the exact same people who log in via the cloud can
// log in offline.
//
// `passwordHash` mirrors the cloud password (set at provision time); `pinHash`
// is the fast 6-digit desk-unlock secret. Both are salted scrypt
// (lib/localAuth.ts). Lockout state is persisted here so an app restart can't
// reset a brute-force lockout.
export const localCredentials = pgTable("local_credentials", {
  profileId: uuid("profile_id")
    .primaryKey()
    .references(() => profiles.id, { onDelete: "cascade" }),
  passwordHash: text("password_hash"),
  pinHash: text("pin_hash"),
  failedAttempts: integer("failed_attempts").notNull().default(0),
  lockedUntil: timestamp("locked_until", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type LocalCredential = typeof localCredentials.$inferSelect;
export type NewLocalCredential = typeof localCredentials.$inferInsert;
