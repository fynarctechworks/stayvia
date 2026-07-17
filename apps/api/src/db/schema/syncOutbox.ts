import { bigint, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

// Phase 2 sync capture (populated by the sync_capture() DB trigger — see
// migration 0052). One row per change to a syncable business table, in
// change_seq (causal) order. The desk pusher drains un-pushed rows to the
// cloud replica; the cloud upserts by row_id and dedups by change_seq.
export const syncOutbox = pgTable("sync_outbox", {
  changeSeq: bigint("change_seq", { mode: "number" }).primaryKey(),
  tableName: text("table_name").notNull(),
  op: text("op", { enum: ["I", "U", "D"] }).notNull(),
  rowId: uuid("row_id").notNull(),
  // Full post-image for I/U; null for D.
  rowData: jsonb("row_data"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  pushedAt: timestamp("pushed_at", { withTimezone: true }),
});

export type SyncOutboxRow = typeof syncOutbox.$inferSelect;
