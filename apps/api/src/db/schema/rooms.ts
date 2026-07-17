import {
  boolean,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { ROOM_STATUSES } from "./enums.js";
import { properties } from "./properties.js";

export const rooms = pgTable(
  "rooms",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    propertyId: uuid("property_id")
      .notNull()
      .references(() => properties.id),
    // Unique per hotel (was global) — hotel B can also have a room 201.
    roomNumber: text("room_number").notNull(),
    floor: integer("floor").notNull(),
    roomType: text("room_type").notNull(),
    baseRate: numeric("base_rate", { precision: 10, scale: 2 }).notNull(),
    maxOccupancy: integer("max_occupancy").notNull().default(2),
    hasAc: boolean("has_ac").notNull().default(true),
    hasTv: boolean("has_tv").notNull().default(true),
    hasWifi: boolean("has_wifi").notNull().default(true),
    status: text("status", { enum: ROOM_STATUSES }).notNull().default("available"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    propertyRoomNumberUnique: uniqueIndex("uq_rooms_property_room_number").on(
      t.propertyId,
      t.roomNumber,
    ),
    propertyIdx: index("idx_rooms_property").on(t.propertyId),
  }),
);

export type Room = typeof rooms.$inferSelect;
export type NewRoom = typeof rooms.$inferInsert;
