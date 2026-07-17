import { boolean, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { ROLES } from "./enums.js";
import { properties } from "./properties.js";

export const profiles = pgTable(
  "profiles",
  {
    id: uuid("id").primaryKey(),
    fullName: text("full_name").notNull(),
    email: text("email").notNull().unique(),
    role: text("role", { enum: ROLES }).notNull(),
    isActive: boolean("is_active").notNull().default(true),
    phone: text("phone"),
    // Every staff account belongs to exactly one hotel. Nullable at the
    // column level (the auth user exists before the profile row during
    // signup) but treated as required by application code.
    propertyId: uuid("property_id").references(() => properties.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    propertyIdx: index("idx_profiles_property").on(t.propertyId),
  }),
);

export type Profile = typeof profiles.$inferSelect;
export type NewProfile = typeof profiles.$inferInsert;
