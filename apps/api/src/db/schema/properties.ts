// Properties (multi-property scaffolding).
//
// SLDT Stay Inn is a single property today. The bootstrap row with
// code='PRIMARY' is created by migration 0013 from the existing
// settings table; every operational row (rooms/reservations/invoices/
// payments/guests) carries property_id pointing at it. This lets the
// API run a single set of queries that already scope to a property,
// so the day we add a second one we just have to expose the picker
// in the UI.

import {
  boolean,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const properties = pgTable("properties", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  legalName: text("legal_name"),
  gstin: text("gstin"),
  address: text("address"),
  city: text("city"),
  state: text("state"),
  country: text("country").notNull().default("India"),
  pincode: text("pincode"),
  phone: text("phone"),
  email: text("email"),
  timezone: text("timezone").notNull().default("Asia/Kolkata"),
  currency: text("currency").notNull().default("INR"),
  defaultCheckInTime: text("default_check_in_time").notNull().default("12:00"),
  defaultCheckOutTime: text("default_check_out_time").notNull().default("11:00"),
  latitude: numeric("latitude", { precision: 9, scale: 6 }),
  longitude: numeric("longitude", { precision: 9, scale: 6 }),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Property = typeof properties.$inferSelect;
export type NewProperty = typeof properties.$inferInsert;

// The well-known code for the single-property bootstrap row. The API
// resolves "current property" by looking this up until multi-property
// is exposed in the UI.
export const PRIMARY_PROPERTY_CODE = "PRIMARY" as const;
