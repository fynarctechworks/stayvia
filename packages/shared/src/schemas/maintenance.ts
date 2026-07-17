import { z } from "zod";

export const MAINTENANCE_CATEGORIES = [
  "electrical",
  "plumbing",
  "ac_hvac",
  "furniture",
  "fixtures",
  "appliances",
  "cleanliness",
  "safety",
  "structural",
  "other",
] as const;
export type MaintenanceCategory = (typeof MAINTENANCE_CATEGORIES)[number];

export const MAINTENANCE_SEVERITIES = ["low", "normal", "urgent"] as const;
export type MaintenanceSeverity = (typeof MAINTENANCE_SEVERITIES)[number];

export const MAINTENANCE_STATUSES = [
  "open",
  "in_progress",
  "resolved",
  "cancelled",
] as const;
export type MaintenanceStatus = (typeof MAINTENANCE_STATUSES)[number];

export const MAINTENANCE_CATEGORY_LABELS: Record<MaintenanceCategory, string> = {
  electrical: "Electrical",
  plumbing: "Plumbing",
  ac_hvac: "AC / HVAC",
  furniture: "Furniture",
  fixtures: "Fixtures",
  appliances: "Appliances",
  cleanliness: "Cleanliness",
  safety: "Safety",
  structural: "Structural",
  other: "Other",
};

export const MAINTENANCE_SEVERITY_LABELS: Record<MaintenanceSeverity, string> = {
  low: "Low",
  normal: "Normal",
  urgent: "Urgent",
};

export const MAINTENANCE_STATUS_LABELS: Record<MaintenanceStatus, string> = {
  open: "Open",
  in_progress: "In progress",
  resolved: "Resolved",
  cancelled: "Cancelled",
};

// All fields required at create-time. The product rule is that
// every new issue must carry enough context for a technician to act
// (room, category, severity, title, description) and a budget
// estimate for the owner to plan around — partial drafts aren't
// useful and dilute the issue log.
export const maintenanceCreateSchema = z.object({
  roomId: z.string().uuid(),
  category: z.enum(MAINTENANCE_CATEGORIES),
  severity: z.enum(MAINTENANCE_SEVERITIES),
  title: z.string().min(3).max(200),
  description: z.string().min(3).max(2000),
  costEstimate: z.coerce.number().nonnegative(),
});

export const maintenanceUpdateSchema = z.object({
  category: z.enum(MAINTENANCE_CATEGORIES).optional(),
  severity: z.enum(MAINTENANCE_SEVERITIES).optional(),
  title: z.string().min(3).max(200).optional(),
  description: z.string().max(2000).optional().nullable(),
  status: z.enum(MAINTENANCE_STATUSES).optional(),
  assignedTo: z.string().uuid().optional().nullable(),
  resolutionNotes: z.string().max(2000).optional().nullable(),
  costEstimate: z.coerce.number().nonnegative().optional().nullable(),
  costActual: z.coerce.number().nonnegative().optional().nullable(),
});

export const maintenanceCommentSchema = z.object({
  body: z.string().min(1).max(2000),
});

export const maintenanceListQuerySchema = z.object({
  status: z.enum(MAINTENANCE_STATUSES).optional(),
  statuses: z.string().optional(),
  category: z.enum(MAINTENANCE_CATEGORIES).optional(),
  severity: z.enum(MAINTENANCE_SEVERITIES).optional(),
  room_id: z.string().uuid().optional(),
  assigned_to: z.string().uuid().optional(),
  search: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(25),
});

export type MaintenanceCreateInput = z.infer<typeof maintenanceCreateSchema>;
export type MaintenanceUpdateInput = z.infer<typeof maintenanceUpdateSchema>;
export type MaintenanceCommentInput = z.infer<typeof maintenanceCommentSchema>;
