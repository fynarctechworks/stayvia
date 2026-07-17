import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { profiles } from "./profiles.js";
import { properties } from "./properties.js";

export const activityLog = pgTable(
  "activity_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Nullable: platform-level events have no hotel. Stamped from the
    // request tenant for everything else so the trail filters per hotel.
    propertyId: uuid("property_id").references(() => properties.id),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    description: text("description").notNull(),
    performedBy: uuid("performed_by")
      .notNull()
      .references(() => profiles.id),
    ipAddress: text("ip_address"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    propertyCreatedIdx: index("idx_activity_property_created").on(t.propertyId, t.createdAt),
  }),
);

export type ActivityLog = typeof activityLog.$inferSelect;
export type NewActivityLog = typeof activityLog.$inferInsert;
