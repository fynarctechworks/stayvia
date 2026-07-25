// Properties — the tenancy root. Tenant = hotel = one row here.
//
// Every operational row (rooms/reservations/invoices/payments/guests/
// settings/…) carries property_id pointing at its hotel. Rows are created
// by lib/provisionProperty.ts (seed + public signup); there is no
// bootstrap/PRIMARY row convention any more.

import { sql } from "drizzle-orm";
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
  // Migration 0013 — permanent token behind the hotel's master QR (front
  // desk / lobby). Public catalog + self-booking pages resolve it.
  qrToken: text("qr_token")
    .notNull()
    .default(sql`encode(gen_random_bytes(16), 'hex')`),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Property = typeof properties.$inferSelect;
export type NewProperty = typeof properties.$inferInsert;
