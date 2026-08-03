import { z } from "zod";
import { ID_PROOF_TYPES } from "../enums.js";
import { GENDERS, ID_PROOF_NUMBER_RULES } from "./guest.js";

// Public QR surface (unauthenticated). Every payload here is typed by a
// stranger on their own phone — validate hard, trust nothing.

const phoneRegex = /^[6-9]\d{9}$/;
const gstinRegex = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;

// Optional browser geolocation attached to an unlock attempt. Advisory
// only — the API logs the distance to the hotel pin, it never hard-blocks.
const geoSchema = z
  .object({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    accuracyM: z.number().min(0).max(100000).optional(),
  })
  .optional();

// In-room QR: unlock the room page by proving you're the current guest —
// last 4 digits of the phone the booking was made with.
export const qrUnlockSchema = z.object({
  phoneLast4: z.string().regex(/^\d{4}$/, "Enter the last 4 digits of the booking phone"),
  geo: geoSchema,
});

// In-room QR: guest request. Kinds map to who gets notified; note is free
// text shown to staff.
export const QR_REQUEST_KINDS = ["cleaning", "amenity", "issue"] as const;
export type QrRequestKind = (typeof QR_REQUEST_KINDS)[number];

export const qrRequestSchema = z.object({
  key: z.string().min(10).max(500),
  kind: z.enum(QR_REQUEST_KINDS),
  note: z.string().max(300).optional(),
});

// Master QR: send the booking OTP to the guest's phone.
export const qrBookSendOtpSchema = z.object({
  phone: z.string().regex(phoneRegex, "Phone must be 10-digit Indian mobile"),
});

// Master QR: the self-booking itself. Same identity fields the walk-in form
// collects (KYC photos happen at the desk on confirm). Arrival is always
// TONIGHT; nights capped small — this is a front-desk companion, not an OTA.
export const qrBookSchema = z
  .object({
    phone: z.string().regex(phoneRegex, "Phone must be 10-digit Indian mobile"),
    otpCode: z.string().regex(/^\d{4,8}$/, "Invalid code"),
    fullName: z.string().min(2).max(100),
    email: z.string().email().optional().or(z.literal("")),
    gender: z.enum(GENDERS),
    idProofType: z.enum(ID_PROOF_TYPES),
    idProofNumber: z.string().min(4).max(50),
    // Address block — same fields the staff walk-in form collects, so a
    // self-booked guest is a complete record the desk can just confirm.
    nationality: z.string().max(60).default("Indian"),
    address: z.string().max(500).optional().or(z.literal("")),
    city: z.string().max(100).optional().or(z.literal("")),
    state: z.string().max(100).optional().or(z.literal("")),
    gstin: z.string().regex(gstinRegex, "Invalid GSTIN format").optional().or(z.literal("")),
    nights: z.number().int().min(1).max(3),
    numAdults: z.number().int().min(1).max(6),
    numChildren: z.number().int().min(0).max(6).default(0),
    roomIds: z.array(z.string().uuid()).min(1).max(3),
    specialRequests: z.string().max(300).optional(),
  })
  .superRefine((v, ctx) => {
    const rule = ID_PROOF_NUMBER_RULES[v.idProofType];
    if (rule && !rule.regex.test(v.idProofNumber)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["idProofNumber"], message: rule.message });
    }
  });

export type QrUnlockInput = z.infer<typeof qrUnlockSchema>;
export type QrRequestInput = z.infer<typeof qrRequestSchema>;
export type QrBookInput = z.infer<typeof qrBookSchema>;
