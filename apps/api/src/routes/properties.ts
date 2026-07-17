// Properties API.
//
// Today's surface is intentionally small:
//   GET  /properties/me   → the current property for the caller
//   GET  /properties      → list (admin only)
//   PATCH /properties/:id → edit (admin only)
//
// We deliberately do NOT expose POST /properties yet. Multi-property
// onboarding is a Phase 4 feature with billing implications; until
// then there's exactly one row (PRIMARY) and the API enforces it.

import { eq } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";
import { db } from "../db/client.js";
import { properties } from "../db/schema/properties.js";
import { resolveCurrentPropertyId } from "../lib/currentProperty.js";
import { fail, ok } from "../lib/response.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";

const router = Router();

router.get("/me", requireAuth, async (req, res) => {
  const id = await resolveCurrentPropertyId(req);
  const [row] = await db.select().from(properties).where(eq(properties.id, id)).limit(1);
  if (!row) return fail(res, 404, "NOT_FOUND", "Current property not found");
  return ok(res, row);
});

router.get("/", requireAuth, requirePermission("manage_settings"), async (_req, res) => {
  const rows = await db.select().from(properties);
  return ok(res, rows);
});

const propertyUpdateSchema = z.object({
  name: z.string().min(2).max(120).optional(),
  legalName: z.string().max(200).nullable().optional(),
  gstin: z.string().max(20).nullable().optional(),
  address: z.string().max(500).nullable().optional(),
  city: z.string().max(80).nullable().optional(),
  state: z.string().max(80).nullable().optional(),
  pincode: z.string().max(10).nullable().optional(),
  country: z.string().max(80).optional(),
  phone: z.string().max(40).nullable().optional(),
  email: z.string().email().nullable().optional(),
  timezone: z.string().max(40).optional(),
  currency: z.string().min(3).max(3).optional(),
  defaultCheckInTime: z
    .string()
    .regex(/^([01]?\d|2[0-3]):[0-5]\d$/)
    .optional(),
  defaultCheckOutTime: z
    .string()
    .regex(/^([01]?\d|2[0-3]):[0-5]\d$/)
    .optional(),
  latitude: z.coerce.number().min(-90).max(90).nullable().optional(),
  longitude: z.coerce.number().min(-180).max(180).nullable().optional(),
  isActive: z.boolean().optional(),
});

router.patch(
  "/:id",
  requireAuth,
  requirePermission("manage_settings"),
  validate(propertyUpdateSchema),
  async (req, res) => {
    const id = req.params.id!;
    const patch = req.body as z.infer<typeof propertyUpdateSchema>;
    const [updated] = await db
      .update(properties)
      .set({
        ...patch,
        // Drizzle's `numeric` columns accept number|string|null; coerce explicitly.
        latitude: patch.latitude == null ? null : String(patch.latitude),
        longitude: patch.longitude == null ? null : String(patch.longitude),
        updatedAt: new Date(),
      })
      .where(eq(properties.id, id))
      .returning();
    if (!updated) return fail(res, 404, "NOT_FOUND", "Property not found");
    return ok(res, updated);
  },
);

export default router;
