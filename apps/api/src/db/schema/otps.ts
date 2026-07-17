import { index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const OTP_PURPOSES = ["checkin", "guest_verify", "password_change"] as const;
export type OtpPurpose = (typeof OTP_PURPOSES)[number];

export const OTP_CHANNELS = ["sms", "email"] as const;
export type OtpChannel = (typeof OTP_CHANNELS)[number];

export const otps = pgTable(
  "otps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    purpose: text("purpose", { enum: OTP_PURPOSES }).notNull(),
    channel: text("channel", { enum: OTP_CHANNELS }).notNull(),
    target: text("target").notNull(),
    codeHash: text("code_hash").notNull(),
    reservationId: uuid("reservation_id"),
    guestId: uuid("guest_id"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    // Client IP that originated the OTP send. Used for per-IP rate limiting
    // (catches scripted abuse that rotates targets). Optional because old
    // rows pre-date this column.
    ipAddress: text("ip_address"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    targetIdx: index("idx_otps_target_purpose").on(t.target, t.purpose),
    reservationIdx: index("idx_otps_reservation").on(t.reservationId),
    ipIdx: index("idx_otps_ip_created").on(t.ipAddress, t.createdAt),
  }),
);

export type Otp = typeof otps.$inferSelect;
export type NewOtp = typeof otps.$inferInsert;
