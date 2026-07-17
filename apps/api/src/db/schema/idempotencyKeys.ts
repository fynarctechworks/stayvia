import { index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

// Records of recently-completed idempotent requests. When a client retries
// a mutating call with the same Idempotency-Key header, we return the
// stored response body verbatim instead of re-executing the handler.
//
// Scoped to (user, route, key) so two different staff using the same UUID
// don't collide. The request_hash is a sha256 of the canonical body — if
// the client retries with a *different* body under the same key (almost
// certainly a bug), we return 409 rather than risk corrupting state.
//
// Cleaned up by a periodic GC sweep + on insert when we encounter a stale row.
export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    // (userId, routeKey, key) is effectively the primary key. We use a
    // composite via a unique text id so Drizzle stays simple.
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    routeKey: text("route_key").notNull(),
    key: text("key").notNull(),
    requestHash: text("request_hash").notNull(),
    statusCode: integer("status_code").notNull(),
    responseBody: text("response_body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    expiryIdx: index("idx_idempotency_expiry").on(t.expiresAt),
  }),
);

export type IdempotencyKey = typeof idempotencyKeys.$inferSelect;
