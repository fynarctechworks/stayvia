// Phase 1 — normalised room amenities and images. Replaces the
// hard-coded has_ac / has_tv / has_wifi booleans on rooms (those columns
// stay for back-compat for one or two releases; the room create / edit
// API writes BOTH so legacy consumers don't break, then we drop the
// booleans in a later migration).
//
// Amenities are a small catalog (15-20 rows) seeded by migration 0011
// and editable by admins. room_amenities is the M2M. room_images is a
// straight has-many keyed on room_id with sort_order + a single
// is_primary flag enforced by a unique partial index.

import {
  boolean,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { profiles } from "./profiles.js";
import { rooms } from "./rooms.js";

export const amenities = pgTable("amenities", {
  id: uuid("id").primaryKey().defaultRandom(),
  key: text("key").notNull().unique(),
  label: text("label").notNull(),
  icon: text("icon"),
  category: text("category").notNull().default("general"),
  isActive: boolean("is_active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(100),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const roomAmenities = pgTable(
  "room_amenities",
  {
    roomId: uuid("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),
    amenityId: uuid("amenity_id")
      .notNull()
      .references(() => amenities.id, { onDelete: "cascade" }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.roomId, t.amenityId] }),
  }),
);

export const roomImages = pgTable(
  "room_images",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    roomId: uuid("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    storagePath: text("storage_path"),
    caption: text("caption"),
    sortOrder: integer("sort_order").notNull().default(100),
    isPrimary: boolean("is_primary").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").references(() => profiles.id),
  },
  (t) => ({
    byRoom: index("idx_room_images_room").on(t.roomId, t.sortOrder),
    // One primary image per room — partial unique index, enforced in DB
    // by migration 0011.
    onePrimaryPerRoom: uniqueIndex("uq_room_images_one_primary").on(t.roomId),
  }),
);

export type Amenity = typeof amenities.$inferSelect;
export type NewAmenity = typeof amenities.$inferInsert;
export type RoomAmenity = typeof roomAmenities.$inferSelect;
export type RoomImage = typeof roomImages.$inferSelect;
export type NewRoomImage = typeof roomImages.$inferInsert;
