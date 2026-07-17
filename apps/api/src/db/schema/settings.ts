import { sql } from "drizzle-orm";
import {
  boolean,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  time,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export type ShortStayBand = {
  label: string;
  hours: number;
  rate: number;
};

export const settings = pgTable("settings", {
  id: uuid("id").primaryKey().defaultRandom(),
  hotelName: text("hotel_name").notNull(),
  hotelAddress: text("hotel_address").notNull(),
  // Optional precise location pin. Captured via "Use current location" in
  // Settings or pasted manually from Google Maps. Drives the property
  // location link shown to guests in their booking SMS.
  hotelLatitude: numeric("hotel_latitude", { precision: 9, scale: 6 }),
  hotelLongitude: numeric("hotel_longitude", { precision: 9, scale: 6 }),
  hotelPhone: text("hotel_phone").notNull(),
  hotelEmail: text("hotel_email"),
  ownerPhone: text("owner_phone"),
  ownerNotifyEnabled: boolean("owner_notify_enabled").notNull().default(true),
  // Whether guest OTP verification is required before a check-in is
  // completed. On by default. When off, New Reservation skips the OTP step
  // entirely (no code sent, no modal) and the create is accepted with
  // skipOtp. A property-wide policy, not a per-booking choice.
  otpRequiredForCheckin: boolean("otp_required_for_checkin").notNull().default(true),
  wifiSsid: text("wifi_ssid"),
  wifiPassword: text("wifi_password"),
  hotelGstin: text("hotel_gstin").notNull(),
  hotelLogoUrl: text("hotel_logo_url"),
  checkInTime: time("check_in_time").notNull().default("12:00"),
  checkOutTime: time("check_out_time").notNull().default("11:00"),
  currencySymbol: text("currency_symbol").notNull().default("₹"),
  invoicePrefix: text("invoice_prefix").notNull().default("INV"),
  gstSlabExemptBelow: numeric("gst_slab_exempt_below", { precision: 10, scale: 2 })
    .notNull()
    .default("1000"),
  gstSlabLowRate: numeric("gst_slab_low_rate", { precision: 5, scale: 2 }).notNull().default("5"),
  gstSlabLowMax: numeric("gst_slab_low_max", { precision: 10, scale: 2 })
    .notNull()
    .default("7500"),
  gstSlabHighRate: numeric("gst_slab_high_rate", { precision: 5, scale: 2 })
    .notNull()
    .default("18"),
  additionalChargeDefaultGst: numeric("additional_charge_default_gst", { precision: 5, scale: 2 })
    .notNull()
    .default("18"),

  // 'exclusive' (legacy): rate is net, GST is added on top → grand total
  //   = rate × (1 + gstRate/100). ₹1000 + 5% → ₹1050.
  // 'inclusive' (default): rate already contains GST → net is extracted
  //   backwards. ₹1000 at 5% → ₹952.38 net + ₹47.62 GST = ₹1000 grand.
  // Only honoured by NEW reservation creates and the recalc helper.
  // Existing reservation rows keep whatever totals they were created with.
  gstMode: text("gst_mode", { enum: ["exclusive", "inclusive"] as const })
    .notNull()
    .default("inclusive"),

  docPrimaryColor: text("doc_primary_color").notNull().default("#0F3D2E"),
  docAccentColor: text("doc_accent_color").notNull().default("#B08A4A"),
  docInvoiceTitle: text("doc_invoice_title").notNull().default("Tax Invoice"),
  docReceiptTitle: text("doc_receipt_title").notNull().default("Payment Receipt"),
  docFooterText: text("doc_footer_text").notNull().default("Thank you for staying with us."),
  docTermsText: text("doc_terms_text"),
  docSignatoryLabel: text("doc_signatory_label").notNull().default("Authorised Signatory"),
  docInvoicePageSize: text("doc_invoice_page_size").notNull().default("A4"),
  // Receipts default to A5 — they're a single-stay slip, not a full
  // tax-invoice document. A4 leaves a lot of empty space at the bottom
  // when printed.
  docReceiptPageSize: text("doc_receipt_page_size").notNull().default("A5"),
  docShowLogo: boolean("doc_show_logo").notNull().default(true),
  docShowGstin: boolean("doc_show_gstin").notNull().default(true),
  docShowTerms: boolean("doc_show_terms").notNull().default(false),
  docShowSignature: boolean("doc_show_signature").notNull().default(true),

  // Migration 0021 — arrival reminder / no-show watch settings.
  arrivalReminderHoursBefore: integer("arrival_reminder_hours_before")
    .notNull()
    .default(24),
  noShowCutoffHours: integer("no_show_cutoff_hours").notNull().default(6),

  // Migration 0024 — soft access gate for the Complimentary report.
  // NULL = no gate (the report toggle just reveals the tab). Any
  // non-empty value enables the prompt before reveal. Validated
  // server-side via POST /settings/unlock-complimentary so the code
  // doesn't sit in the JS bundle.
  complimentaryUnlockCode: text("complimentary_unlock_code"),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const roomTypes = pgTable("room_types", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  label: text("label").notNull(),
  defaultRate: numeric("default_rate", { precision: 10, scale: 2 }).notNull(),
  maxOccupancy: numeric("max_occupancy").notNull().default("2"),
  // Per-night charge for each extra person (extra bed) over a room's
  // base max_occupancy, for rooms of this type. 0 (the default) means
  // extra beds are not offered — the booking form hides the stepper.
  extraPersonRate: numeric("extra_person_rate", { precision: 10, scale: 2 })
    .notNull()
    .default("0"),
  description: text("description"),
  isActive: boolean("is_active").notNull().default(true),
  // Day-use bands shown on the reservation form when stay_type='short_stay'.
  // Each row is {label, hours, rate}; the user can also enter a custom
  // duration that is priced pro-rata from the closest band.
  shortStayBands: jsonb("short_stay_bands")
    .$type<ShortStayBand[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Settings = typeof settings.$inferSelect;
export type NewSettings = typeof settings.$inferInsert;
export type RoomTypeRow = typeof roomTypes.$inferSelect;
