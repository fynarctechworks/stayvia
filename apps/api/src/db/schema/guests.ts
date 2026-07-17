import { sql } from "drizzle-orm";
import {
  boolean,
  date,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { ID_PROOF_TYPES } from "./enums.js";
import { profiles } from "./profiles.js";
import { properties } from "./properties.js";

export const FOLLOW_UP_STATUSES = ["pending", "done", "cancelled"] as const;
export const GENDERS = ["male", "female", "other", "prefer_not_to_say"] as const;
export type Gender = (typeof GENDERS)[number];

export const guests = pgTable(
  "guests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Phase 2: guest profiles are per-property. A guest who stays at
    // two properties has two rows (intentional — keeps property data
    // walls clean). Back-filled to PRIMARY by migration 0013.
    propertyId: uuid("property_id")
      .notNull()
      .references(() => properties.id),
    fullName: text("full_name").notNull(),
    phone: text("phone").notNull(),
    email: text("email"),
    idProofType: text("id_proof_type", { enum: ID_PROOF_TYPES }).notNull(),
    idProofNumberEncrypted: text("id_proof_number_encrypted").notNull(),
    idProofLast4: text("id_proof_last4").notNull(),
    address: text("address"),
    city: text("city"),
    state: text("state"),
    nationality: text("nationality").notNull().default("Indian"),
    // Migration 0020. NULL on legacy rows; new guests require it.
    gender: text("gender", { enum: GENDERS }),
    dateOfBirth: date("date_of_birth"),
    companyName: text("company_name"),
    gstin: text("gstin"),
    notes: text("notes"),
    tags: text("tags").array().notNull().default(sql`ARRAY[]::text[]`),
    idProofPhotoFront: text("id_proof_photo_front"),
    idProofPhotoBack: text("id_proof_photo_back"),
    guestPhoto: text("guest_photo"),
    kycVerifiedAt: timestamp("kyc_verified_at", { withTimezone: true }),
    kycVerifiedBy: uuid("kyc_verified_by"),
    // Phase 1 commercial flags. Surfaced as ribbons / badges on the
    // GuestProfile page and consulted by the reservation create flow
    // (blacklist auto-blocks new bookings; VIP highlights the row).
    isVip: boolean("is_vip").notNull().default(false),
    isBlacklisted: boolean("is_blacklisted").notNull().default(false),
    blacklistReason: text("blacklist_reason"),
    blacklistedAt: timestamp("blacklisted_at", { withTimezone: true }),
    blacklistedBy: uuid("blacklisted_by").references(() => profiles.id),
    // Structured guest preferences. Known keys (extensible): smoking
    // (bool), floor ("low"|"mid"|"high"), pillow ("soft"|"firm"),
    // wakeup_time (HH:MM), dietary (string[]). The room-assignment
    // picker reads this to prefer matching rooms.
    preferences: jsonb("preferences").notNull().default(sql`'{}'::jsonb`),
    // DPDP Act 2023 consent timestamp. Null = not consented (default).
    // Marketing dispatch helpers MUST check this before sending.
    marketingConsentAt: timestamp("marketing_consent_at", { withTimezone: true }),
    marketingConsentChannel: text("marketing_consent_channel"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    phoneUnique: uniqueIndex("idx_guests_phone_unique").on(t.phone),
    fullNameSearch: index("idx_guests_full_name").using(
      "gin",
      sql`to_tsvector('english', ${t.fullName})`,
    ),
  }),
);

export type Guest = typeof guests.$inferSelect;
export type NewGuest = typeof guests.$inferInsert;

// Phone history — see migration 0022. Lets /guests/:phone URLs keep
// resolving after a guest updates their phone number. Exactly one row
// per guest has valid_to IS NULL (their current phone).
export const guestPhoneHistory = pgTable(
  "guest_phone_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    guestId: uuid("guest_id")
      .notNull()
      .references(() => guests.id, { onDelete: "cascade" }),
    phone: text("phone").notNull(),
    validFrom: timestamp("valid_from", { withTimezone: true })
      .notNull()
      .defaultNow(),
    validTo: timestamp("valid_to", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    phoneIdx: index("idx_phone_history_phone").on(t.phone),
    guestIdx: index("idx_phone_history_guest").on(t.guestId, t.validFrom),
  }),
);

export const guestNotes = pgTable(
  "guest_notes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    guestId: uuid("guest_id")
      .notNull()
      .references(() => guests.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    authorId: uuid("author_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    guestIdx: index("idx_guest_notes_guest").on(t.guestId),
  }),
);

export const guestFollowUps = pgTable(
  "guest_follow_ups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    guestId: uuid("guest_id")
      .notNull()
      .references(() => guests.id, { onDelete: "cascade" }),
    task: text("task").notNull(),
    dueDate: date("due_date").notNull(),
    status: text("status", { enum: FOLLOW_UP_STATUSES }).notNull().default("pending"),
    assignedTo: uuid("assigned_to"),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => ({
    guestIdx: index("idx_guest_followups_guest").on(t.guestId),
    statusIdx: index("idx_guest_followups_status_due").on(t.status, t.dueDate),
  }),
);
