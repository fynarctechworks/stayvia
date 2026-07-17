import { bigint, pgTable, primaryKey, text, uuid } from "drizzle-orm/pg-core";
import { properties } from "./properties.js";

// Per-hotel document counters — replaces the legacy global Postgres
// sequences. One row per (hotel, counter), created lazily on first use by
// nextDocNumber (lib/numbers.ts) via an atomic INSERT ... ON CONFLICT
// upsert. The row lock serializes concurrent allocations exactly like
// nextval() did, but per hotel, so each hotel's GST invoice sequence
// stays unbroken.
export const DOC_COUNTERS = ["reservation", "invoice", "receipt", "credit_note"] as const;
export type DocCounter = (typeof DOC_COUNTERS)[number];

export const propertyCounters = pgTable(
  "property_counters",
  {
    propertyId: uuid("property_id")
      .notNull()
      .references(() => properties.id),
    counter: text("counter", { enum: DOC_COUNTERS }).notNull(),
    value: bigint("value", { mode: "number" }).notNull().default(0),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.propertyId, t.counter] }),
  }),
);

export type PropertyCounter = typeof propertyCounters.$inferSelect;
