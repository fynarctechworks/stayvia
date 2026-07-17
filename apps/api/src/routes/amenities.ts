// Amenities catalog + per-room amenities + per-room image gallery.
// Phase 1 added the normalised model alongside the legacy has_ac /
// has_tv / has_wifi booleans on `rooms`. Room create/edit handlers
// continue to maintain the boolean shadow for back-compat — see
// rooms.ts. New consumers should prefer this route.

import { and, asc, eq, inArray } from "drizzle-orm";
import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { db } from "../db/client.js";
import {
  amenities,
  roomAmenities,
  roomImages,
} from "../db/schema/amenities.js";
import { rooms } from "../db/schema/rooms.js";
import { logActivity } from "../lib/activity.js";
import { invalidateDashboard } from "../lib/redis.js";
import { fail, ok } from "../lib/response.js";
import { uploadPublicFile } from "../lib/storage.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";

const router = Router();

// Reuse multer config (memory storage, image-only). Cap at 8 MB / 8
// files per upload — enough for a hotel listing's worth of shots and
// matches the KYC upload guard in routes/guests.ts.
const ALLOWED_IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 8 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_IMAGE_MIMES.has(file.mimetype)) {
      cb(new Error("Only JPEG, PNG, or WEBP images are accepted"));
      return;
    }
    cb(null, true);
  },
});

// -------------------- Amenities catalog --------------------

router.get("/amenities", requireAuth, async (_req, res) => {
  const rows = await db
    .select()
    .from(amenities)
    .where(eq(amenities.isActive, true))
    .orderBy(asc(amenities.sortOrder), asc(amenities.label));
  return ok(res, rows);
});

const amenityUpsertSchema = z.object({
  key: z
    .string()
    .min(2)
    .max(48)
    .regex(/^[a-z0-9_]+$/, "key must be lowercase letters, digits, underscores"),
  label: z.string().min(2).max(80),
  icon: z.string().max(40).nullable().optional(),
  category: z.string().max(40).default("general"),
  isActive: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(9999).default(100),
});

router.post(
  "/amenities",
  requireAuth,
  requirePermission("manage_settings"),
  validate(amenityUpsertSchema),
  async (req, res) => {
    const input = req.body as z.infer<typeof amenityUpsertSchema>;
    const [row] = await db.insert(amenities).values(input).onConflictDoUpdate({
      target: amenities.key,
      set: {
        label: input.label,
        icon: input.icon ?? null,
        category: input.category,
        isActive: input.isActive,
        sortOrder: input.sortOrder,
      },
    }).returning();
    return ok(res, row);
  },
);

// -------------------- Per-room amenities --------------------

router.get(
  "/rooms/:roomId/amenities",
  requireAuth,
  requirePermission("view_rooms"),
  async (req, res) => {
    const roomId = req.params.roomId!;
    const rows = await db
      .select({
        id: amenities.id,
        key: amenities.key,
        label: amenities.label,
        icon: amenities.icon,
        category: amenities.category,
        sortOrder: amenities.sortOrder,
      })
      .from(roomAmenities)
      .innerJoin(amenities, eq(amenities.id, roomAmenities.amenityId))
      .where(eq(roomAmenities.roomId, roomId))
      .orderBy(asc(amenities.sortOrder));
    return ok(res, rows);
  },
);

const setAmenitiesSchema = z.object({
  amenityIds: z.array(z.string().uuid()).max(64),
});

router.put(
  "/rooms/:roomId/amenities",
  requireAuth,
  requirePermission("edit_rooms"),
  validate(setAmenitiesSchema),
  async (req, res) => {
    const roomId = req.params.roomId!;
    const { amenityIds } = req.body as z.infer<typeof setAmenitiesSchema>;

    const [exists] = await db
      .select({ id: rooms.id })
      .from(rooms)
      .where(eq(rooms.id, roomId))
      .limit(1);
    if (!exists) return fail(res, 404, "NOT_FOUND", "Room not found");

    // Validate every amenityId resolves to an active row before writing.
    // Saves a useless FK round-trip and gives a clearer error.
    if (amenityIds.length) {
      const found = await db
        .select({ id: amenities.id })
        .from(amenities)
        .where(and(inArray(amenities.id, amenityIds), eq(amenities.isActive, true)));
      if (found.length !== amenityIds.length) {
        return fail(res, 400, "INVALID_AMENITIES", "One or more amenity ids are unknown or inactive");
      }
    }

    await db.transaction(async (tx) => {
      await tx.delete(roomAmenities).where(eq(roomAmenities.roomId, roomId));
      if (amenityIds.length) {
        await tx
          .insert(roomAmenities)
          .values(amenityIds.map((amenityId) => ({ roomId, amenityId })));
      }
    });

    await logActivity({
      action: "room_amenities_updated",
      entityType: "room",
      entityId: roomId,
      description: `Amenities updated (${amenityIds.length} set)`,
      performedBy: req.user!.id,
      ipAddress: req.ip,
    });
    await invalidateDashboard();
    return ok(res, { count: amenityIds.length });
  },
);

// -------------------- Per-room images --------------------

router.get(
  "/rooms/:roomId/images",
  requireAuth,
  requirePermission("view_rooms"),
  async (req, res) => {
    const roomId = req.params.roomId!;
    const rows = await db
      .select()
      .from(roomImages)
      .where(eq(roomImages.roomId, roomId))
      .orderBy(asc(roomImages.sortOrder));
    return ok(res, rows);
  },
);

router.post(
  "/rooms/:roomId/images",
  requireAuth,
  requirePermission("edit_rooms"),
  upload.array("files", 8),
  async (req, res) => {
    const roomId = req.params.roomId!;
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (!files.length) {
      return fail(res, 400, "NO_FILES", "No image files received");
    }
    const [exists] = await db
      .select({ id: rooms.id })
      .from(rooms)
      .where(eq(rooms.id, roomId))
      .limit(1);
    if (!exists) return fail(res, 404, "NOT_FOUND", "Room not found");

    // Upload to the public `documents` bucket under a per-room prefix
    // so deleting a room can prune the prefix in one go later.
    const safeName = (s: string) => s.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 60);
    const inserted = await Promise.all(
      files.map(async (f) => {
        const path = `rooms/${roomId}/${Date.now()}-${safeName(f.originalname)}`;
        const url = await uploadPublicFile(path, f.buffer, f.mimetype);
        if (!url) {
          throw new Error("Failed to upload room image to storage");
        }
        const [row] = await db
          .insert(roomImages)
          .values({
            roomId,
            url,
            storagePath: path,
            createdBy: req.user!.id,
          })
          .returning();
        return row;
      }),
    );

    await logActivity({
      action: "room_images_added",
      entityType: "room",
      entityId: roomId,
      description: `Added ${inserted.length} image${inserted.length === 1 ? "" : "s"}`,
      performedBy: req.user!.id,
      ipAddress: req.ip,
    });
    return ok(res, inserted);
  },
);

const imageUpdateSchema = z.object({
  caption: z.string().max(240).nullable().optional(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
  isPrimary: z.boolean().optional(),
});

router.patch(
  "/rooms/:roomId/images/:imageId",
  requireAuth,
  requirePermission("edit_rooms"),
  validate(imageUpdateSchema),
  async (req, res) => {
    const { roomId, imageId } = req.params as { roomId: string; imageId: string };
    const input = req.body as z.infer<typeof imageUpdateSchema>;
    const patch: Record<string, unknown> = {};
    if (input.caption !== undefined) patch.caption = input.caption;
    if (input.sortOrder !== undefined) patch.sortOrder = input.sortOrder;

    const updated = await db.transaction(async (tx) => {
      // Setting is_primary=true must first clear any existing primary
      // for this room — the partial unique index would reject otherwise.
      if (input.isPrimary === true) {
        await tx
          .update(roomImages)
          .set({ isPrimary: false })
          .where(and(eq(roomImages.roomId, roomId), eq(roomImages.isPrimary, true)));
        patch.isPrimary = true;
      } else if (input.isPrimary === false) {
        patch.isPrimary = false;
      }
      const [row] = await tx
        .update(roomImages)
        .set(patch)
        .where(and(eq(roomImages.id, imageId), eq(roomImages.roomId, roomId)))
        .returning();
      return row;
    });
    if (!updated) return fail(res, 404, "NOT_FOUND", "Image not found");
    return ok(res, updated);
  },
);

router.delete(
  "/rooms/:roomId/images/:imageId",
  requireAuth,
  requirePermission("edit_rooms"),
  async (req, res) => {
    const { roomId, imageId } = req.params as { roomId: string; imageId: string };
    const [deleted] = await db
      .delete(roomImages)
      .where(and(eq(roomImages.id, imageId), eq(roomImages.roomId, roomId)))
      .returning();
    if (!deleted) return fail(res, 404, "NOT_FOUND", "Image not found");
    // We intentionally don't delete the bucket object on row delete —
    // Supabase bucket cleanup is a separate background job (also handles
    // the "user uploaded then never saved" case).
    return ok(res, { deleted: imageId });
  },
);

export default router;
