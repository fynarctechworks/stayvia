import { z } from "zod";
import { ID_PROOF_TYPES } from "../enums.js";

const phoneRegex = /^[6-9]\d{9}$/;
const gstinRegex = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;

export const GENDERS = ["male", "female", "other", "prefer_not_to_say"] as const;
export type Gender = (typeof GENDERS)[number];

export const guestCreateSchema = z.object({
  fullName: z.string().min(2).max(100),
  phone: z.string().regex(phoneRegex, "Phone must be 10-digit Indian mobile"),
  email: z.string().email().optional().nullable(),
  // Required for new guests. Legacy rows are NULL — keep update
  // schema's gender optional so an edit doesn't force the staff to
  // fill it for old records they haven't touched.
  gender: z.enum(GENDERS),
  idProofType: z.enum(ID_PROOF_TYPES),
  idProofNumber: z.string().min(4).max(50),
  address: z.string().max(500).optional().nullable(),
  city: z.string().max(100).optional().nullable(),
  state: z.string().max(100).optional().nullable(),
  nationality: z.string().max(60).default("Indian"),
  dateOfBirth: z.string().date().optional().nullable(),
  companyName: z.string().max(200).optional().nullable(),
  gstin: z
    .string()
    .regex(gstinRegex, "Invalid GSTIN format")
    .optional()
    .nullable()
    .or(z.literal("")),
  notes: z.string().max(1000).optional().nullable(),
});

// Update is fully optional (PATCH semantics), including gender so we
// don't force fills on legacy rows.
//
// `nationality` is overridden to drop the .default("Indian") that
// otherwise leaks in via .partial(). Without this, a PUT that only
// changes the phone would silently overwrite the existing nationality
// with "Indian" — fine for new guests, wrong for guests already
// stored as something else.
export const guestUpdateSchema = guestCreateSchema.partial().extend({
  nationality: z.string().max(60).optional(),
});

export const guestListQuerySchema = z.object({
  search: z.string().optional(),
  tag: z.string().optional(),
  has_followup: z.enum(["true", "false"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(25),
});

export const GUEST_TAGS = [
  "first_time",
  "vip",
  "corporate",
  "repeat",
  "blacklist",
  "long_stay",
  "high_value",
] as const;
export type GuestTag = (typeof GUEST_TAGS)[number];

export const guestTagsSchema = z.object({
  tags: z.array(z.string().min(1).max(32)).max(10),
});

export const guestNoteCreateSchema = z.object({
  body: z.string().min(1).max(2000),
});

export const FOLLOW_UP_STATUSES = ["pending", "done", "cancelled"] as const;
export type FollowUpStatus = (typeof FOLLOW_UP_STATUSES)[number];

export const followUpCreateSchema = z.object({
  task: z.string().min(1).max(300),
  dueDate: z.string().date(),
  assignedTo: z.string().uuid().optional().nullable(),
});

export const followUpUpdateSchema = z.object({
  status: z.enum(FOLLOW_UP_STATUSES).optional(),
  task: z.string().min(1).max(300).optional(),
  dueDate: z.string().date().optional(),
  assignedTo: z.string().uuid().optional().nullable(),
});

export const guestDuplicateQuerySchema = z.object({
  phone: z.string().optional(),
  email: z.string().optional(),
  id_type: z.enum(ID_PROOF_TYPES).optional(),
  id_number: z.string().optional(),
});

export type GuestCreateInput = z.infer<typeof guestCreateSchema>;
export type GuestUpdateInput = z.infer<typeof guestUpdateSchema>;
