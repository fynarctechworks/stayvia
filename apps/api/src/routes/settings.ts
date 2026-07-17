import {
  roomTypeCreateSchema,
  roomTypeUpdateSchema,
  settingsUpdateSchema,
  staffCreateSchema,
  staffUpdateSchema,
  unlockSettingsCodeSchema,
} from "@stayvia/shared";
import { and, asc, count as sqlCount, eq, sql } from "drizzle-orm";
import { Router } from "express";
import { db } from "../db/client.js";
import { profiles } from "../db/schema/profiles.js";
import { roles, userRoles } from "../db/schema/rbac.js";
import { reservationRooms } from "../db/schema/reservations.js";
import { rooms } from "../db/schema/rooms.js";
import { roomTypes, settings } from "../db/schema/settings.js";
import { logActivity } from "../lib/activity.js";
import { publishSettingsInvalidation } from "../lib/redis.js";
import { fail, ok } from "../lib/response.js";
import { invalidateSettings } from "../lib/settings.js";
import {
  TEMPLATE_DEFAULTS,
  getAllTemplatesForUI,
  upsertTemplate,
} from "../lib/templates.js";
import { supabaseAdmin } from "../lib/supabase.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";

const router = Router();

router.get("/", requireAuth, requirePermission("manage_settings"), async (_req, res) => {
  const rows = await db.select().from(settings).limit(1);
  const types = await db.select().from(roomTypes).orderBy(asc(roomTypes.label));
  // Mask the unlock code even from admins — they can SET it but they
  // shouldn't see the existing value (a colleague over their shoulder
  // would be enough). The UI uses the boolean to decide whether to
  // show "Set code" or "Change code" + "Clear".
  const s = rows[0] ?? null;
  const masked = s
    ? {
        ...s,
        complimentaryUnlockCode: s.complimentaryUnlockCode ? "" : null,
        hasComplimentaryUnlockCode: !!s.complimentaryUnlockCode,
      }
    : null;
  return ok(res, { settings: masked, roomTypes: types });
});

router.get("/public", requireAuth, async (_req, res) => {
  const rows = await db
    .select({
      hotelName: settings.hotelName,
      hotelAddress: settings.hotelAddress,
      hotelLatitude: settings.hotelLatitude,
      hotelLongitude: settings.hotelLongitude,
      hotelPhone: settings.hotelPhone,
      hotelEmail: settings.hotelEmail,
      ownerPhone: settings.ownerPhone,
      hotelGstin: settings.hotelGstin,
      hotelLogoUrl: settings.hotelLogoUrl,
      checkInTime: settings.checkInTime,
      checkOutTime: settings.checkOutTime,
      gstSlabExemptBelow: settings.gstSlabExemptBelow,
      gstSlabLowRate: settings.gstSlabLowRate,
      gstSlabLowMax: settings.gstSlabLowMax,
      gstSlabHighRate: settings.gstSlabHighRate,
      // Drives the rate-vs-grand-total interpretation on NewReservation.
      gstMode: settings.gstMode,
      // Property-wide OTP policy — NewReservation reads this to decide
      // whether to run the OTP step before creating a booking.
      otpRequiredForCheckin: settings.otpRequiredForCheckin,
      // 0024 — only a BOOLEAN of whether the gate is configured. The
      // actual code never leaves the server. The Reports UI uses this
      // to decide whether to open the auth prompt before revealing
      // the secondary tabs.
      complimentaryUnlockCode: settings.complimentaryUnlockCode,
    })
    .from(settings)
    .limit(1);
  const row = rows[0] ?? null;
  if (!row) return ok(res, null);
  // Strip the actual code from the response — only the boolean flag
  // reaches the client. Renamed to "complimentaryGateEnabled" so the
  // client-side field name doesn't shout "this is the unlock code".
  const { complimentaryUnlockCode, ...rest } = row;
  return ok(res, {
    ...rest,
    complimentaryGateEnabled: !!complimentaryUnlockCode,
  });
});

router.put("/", requireAuth, requirePermission("manage_settings"), validate(settingsUpdateSchema), async (req, res) => {
  const input = req.body as Record<string, unknown>;
  const rows = await db.select().from(settings).limit(1);
  if (!rows.length) return fail(res, 404, "NOT_FOUND", "Settings not initialized");
  const update: Record<string, unknown> = { updatedAt: new Date() };
  for (const [k, v] of Object.entries(input)) if (v !== undefined) update[k] = v;
  const [updated] = await db
    .update(settings)
    .set(update)
    .where(eq(settings.id, rows[0]!.id))
    .returning();
  // Mask the unlock code on the response so the value we just wrote
  // doesn't bounce back in plaintext. Same masking rule as the GET.
  const maskedUpdated = updated
    ? {
        ...updated,
        complimentaryUnlockCode: updated.complimentaryUnlockCode ? "" : null,
        hasComplimentaryUnlockCode: !!updated.complimentaryUnlockCode,
      }
    : null;
  invalidateSettings();
  await publishSettingsInvalidation();
  await logActivity({
    action: "settings_updated",
    entityType: "settings",
    entityId: updated!.id,
    description: "Hotel settings updated",
    performedBy: req.user!.id,
    ipAddress: req.ip,
  });
  return ok(res, maskedUpdated);
});

// Verify a staff-typed access code. Generic name on purpose — the
// endpoint, the request body, and the error message intentionally
// don't reveal WHAT the code unlocks. The Reports UI calls this when
// staff clicks "More" so the network tab doesn't shout
// "/unlock-complimentary". Returns 200/{ ok: true } on match, 401 on
// miss or when no code is configured. We deliberately don't
// distinguish "wrong code" from "no code set" so a sniffer can't tell
// whether the gate is active.
router.post(
  "/verify-access-code",
  requireAuth,
  validate(unlockSettingsCodeSchema),
  async (req, res) => {
    const { code } = req.body as { code: string };
    const rows = await db
      .select({ stored: settings.complimentaryUnlockCode })
      .from(settings)
      .limit(1);
    const stored = rows[0]?.stored ?? null;
    if (!stored || stored !== code) {
      return fail(res, 401, "INVALID_CODE", "Incorrect code");
    }
    return ok(res, { ok: true });
  },
);

router.get("/room-types", requireAuth, requirePermission("view_rooms", "manage_settings"), async (req, res) => {
  const includeArchived = req.query.all === "true";
  const rows = await db
    .select()
    .from(roomTypes)
    .where(includeArchived ? undefined : eq(roomTypes.isActive, true))
    .orderBy(asc(roomTypes.label));
  return ok(res, rows);
});

router.post(
  "/room-types",
  requireAuth,
  requirePermission("manage_settings"),
  validate(roomTypeCreateSchema),
  async (req, res) => {
    const input = req.body as {
      slug: string;
      label: string;
      defaultRate: number;
      maxOccupancy: number;
      extraPersonRate: number;
      description?: string | null;
      isActive: boolean;
      shortStayBands?: Array<{ label: string; hours: number; rate: number }>;
    };

    const dup = await db.select({ id: roomTypes.id }).from(roomTypes).where(eq(roomTypes.slug, input.slug)).limit(1);
    if (dup.length) return fail(res, 409, "DUPLICATE_SLUG", "A room type with this slug already exists");

    const [row] = await db
      .insert(roomTypes)
      .values({
        slug: input.slug,
        label: input.label,
        defaultRate: String(input.defaultRate),
        maxOccupancy: String(input.maxOccupancy),
        extraPersonRate: String(input.extraPersonRate ?? 0),
        description: input.description ?? null,
        isActive: input.isActive,
        shortStayBands: input.shortStayBands ?? [],
      })
      .returning();

    await logActivity({
      action: "room_type_created",
      entityType: "room_type",
      entityId: row!.id,
      description: `Room type added: ${row!.label}`,
      performedBy: req.user!.id,
      ipAddress: req.ip,
    });
    return ok(res, row, 201);
  },
);

router.put(
  "/room-types/:id",
  requireAuth,
  requirePermission("manage_settings"),
  validate(roomTypeUpdateSchema),
  async (req, res) => {
    const id = req.params.id!;
    const input = req.body as Record<string, unknown>;

    const existing = await db.select().from(roomTypes).where(eq(roomTypes.id, id)).limit(1);
    if (!existing.length) return fail(res, 404, "NOT_FOUND", "Room type not found");
    const oldSlug = existing[0]!.slug;

    const update: Record<string, unknown> = { updatedAt: new Date() };
    for (const [k, v] of Object.entries(input)) {
      if (v === undefined) continue;
      if (k === "defaultRate" || k === "maxOccupancy" || k === "extraPersonRate")
        update[k] = String(v);
      else update[k] = v;
    }

    const newSlug = typeof input.slug === "string" ? input.slug : oldSlug;
    if (newSlug !== oldSlug) {
      const conflict = await db
        .select({ id: roomTypes.id })
        .from(roomTypes)
        .where(eq(roomTypes.slug, newSlug))
        .limit(1);
      if (conflict.length && conflict[0]!.id !== id) {
        return fail(res, 409, "DUPLICATE_SLUG", "Slug already taken");
      }
    }

    // When the default rate changes, cascade it to the physical rooms of
    // this type that are STILL sitting at the old default — i.e. rooms the
    // staff never gave a custom per-room price. Rooms with an override
    // (base_rate != old default) are left untouched. Existing reservations
    // and invoices snapshot ratePerNight at booking time (see
    // reservations.ts / invoiceBuilder.ts), so they are never re-priced —
    // only future bookings pick up the new rate.
    const oldDefaultRate = existing[0]!.defaultRate;
    const newDefaultRate =
      typeof update.defaultRate === "string" ? update.defaultRate : oldDefaultRate;
    const rateChanged = Number(newDefaultRate) !== Number(oldDefaultRate);

    let cascadedRooms = 0;
    const row = await db.transaction(async (tx) => {
      const [r] = await tx.update(roomTypes).set(update).where(eq(roomTypes.id, id)).returning();
      if (newSlug !== oldSlug) {
        await tx.update(rooms).set({ roomType: newSlug, updatedAt: new Date() }).where(eq(rooms.roomType, oldSlug));
        await tx
          .update(reservationRooms)
          .set({ soldAsType: newSlug })
          .where(eq(reservationRooms.soldAsType, oldSlug));
      }
      if (rateChanged) {
        const bumped = await tx
          .update(rooms)
          .set({ baseRate: String(newDefaultRate), updatedAt: new Date() })
          .where(and(eq(rooms.roomType, newSlug), eq(rooms.baseRate, String(oldDefaultRate))))
          .returning({ id: rooms.id });
        cascadedRooms = bumped.length;
      }
      return r;
    });

    await logActivity({
      action: "room_type_updated",
      entityType: "room_type",
      entityId: id,
      description: [
        `Room type updated: ${row!.label}`,
        newSlug !== oldSlug ? ` (slug: ${oldSlug} → ${newSlug})` : "",
        rateChanged
          ? ` · default rate ₹${Number(oldDefaultRate).toFixed(0)} → ₹${Number(newDefaultRate).toFixed(0)}${cascadedRooms ? ` (${cascadedRooms} room${cascadedRooms === 1 ? "" : "s"} resynced)` : ""}`
          : "",
      ].join(""),
      performedBy: req.user!.id,
      ipAddress: req.ip,
    });
    return ok(res, { ...row, cascadedRooms });
  },
);

router.delete("/room-types/:id", requireAuth, requirePermission("manage_settings"), async (req, res) => {
  const id = req.params.id!;
  // Two modes:
  //   - default ("safe delete"): hard-delete only when no rooms still
  //     reference the slug. If rooms do reference it, return 409 with
  //     the count so the UI can prompt the operator to reassign first.
  //   - ?force=true ("force delete"): delete the room type AND null
  //     out room.room_type on every dependent room. Use with care; the
  //     orphaned rooms keep an empty type slug until the operator
  //     edits them.
  const force = String(req.query.force ?? "").toLowerCase() === "true";

  const existing = await db.select().from(roomTypes).where(eq(roomTypes.id, id)).limit(1);
  if (!existing.length) return fail(res, 404, "NOT_FOUND", "Room type not found");

  const dependentRooms = await db
    .select({ id: rooms.id, roomNumber: rooms.roomNumber })
    .from(rooms)
    .where(eq(rooms.roomType, existing[0]!.slug));

  if (dependentRooms.length && !force) {
    return fail(
      res,
      409,
      "IN_USE",
      `Cannot delete: ${dependentRooms.length} room(s) still use this type. Reassign them to another type first, or pass force=true to detach them automatically.`,
      {
        roomCount: dependentRooms.length,
        rooms: dependentRooms.slice(0, 20).map((r) => r.roomNumber),
      },
    );
  }

  // If force=true and rooms reference it, detach them first inside a
  // transaction so the cascade is atomic with the delete.
  await db.transaction(async (tx) => {
    if (dependentRooms.length) {
      await tx
        .update(rooms)
        .set({ roomType: "", updatedAt: new Date() })
        .where(eq(rooms.roomType, existing[0]!.slug));
    }
    await tx.delete(roomTypes).where(eq(roomTypes.id, id));
  });
  await logActivity({
    action: "room_type_deleted",
    entityType: "room_type",
    entityId: id,
    description: dependentRooms.length
      ? `Room type force-deleted: ${existing[0]!.label} (${dependentRooms.length} rooms detached)`
      : `Room type deleted: ${existing[0]!.label}`,
    performedBy: req.user!.id,
    ipAddress: req.ip,
    metadata: { force, detached: dependentRooms.length },
  });
  return ok(res, { deleted: true, detached: dependentRooms.length });
});

// ============ MESSAGE TEMPLATES ============

router.get("/templates", requireAuth, requirePermission("manage_templates"), async (_req, res) => {
  const items = await getAllTemplatesForUI();
  return ok(res, { items });
});

router.put("/templates/:key", requireAuth, requirePermission("manage_templates"), async (req, res) => {
  const key = req.params.key;
  if (!key || !(key in TEMPLATE_DEFAULTS)) {
    return fail(res, 400, "INVALID_KEY", "Unknown template key");
  }
  const input = req.body as { subject?: string | null; body?: string; enabled?: boolean };
  if (input.body !== undefined && input.body.trim() === "") {
    return fail(res, 400, "EMPTY_BODY", "Body cannot be empty");
  }
  await upsertTemplate(key as keyof typeof TEMPLATE_DEFAULTS, input);
  await logActivity({
    action: "template_updated",
    entityType: "template",
    entityId: key,
    description: `Template ${key} updated`,
    performedBy: req.user!.id,
    ipAddress: req.ip,
  });
  return ok(res, { ok: true });
});

router.post("/templates/:key/reset", requireAuth, requirePermission("manage_templates"), async (req, res) => {
  const key = req.params.key;
  if (!key || !(key in TEMPLATE_DEFAULTS)) {
    return fail(res, 400, "INVALID_KEY", "Unknown template key");
  }
  const def = TEMPLATE_DEFAULTS[key as keyof typeof TEMPLATE_DEFAULTS];
  await upsertTemplate(key as keyof typeof TEMPLATE_DEFAULTS, {
    subject: def.subject ?? null,
    body: def.body,
    enabled: true,
  });
  return ok(res, { ok: true });
});

// ============ STAFF ============

const staffRouter = Router();

staffRouter.get("/", requireAuth, requirePermission("manage_staff"), async (_req, res) => {
  const rows = await db.select().from(profiles).orderBy(profiles.fullName);
  return ok(res, rows);
});

staffRouter.post("/", requireAuth, requirePermission("manage_staff"), validate(staffCreateSchema), async (req, res) => {
  const input = req.body as {
    email: string;
    password: string;
    fullName: string;
    role: "admin" | "frontdesk" | "housekeeping";
    phone?: string;
  };

  const { data, error } = await supabaseAdmin.auth.admin.createUser({
    email: input.email,
    password: input.password,
    email_confirm: true,
  });
  if (error || !data.user) return fail(res, 400, "AUTH_ERROR", error?.message ?? "Create failed");
  const userId = data.user.id;

  const [profile] = await db
    .insert(profiles)
    .values({
      id: userId,
      fullName: input.fullName,
      email: input.email,
      role: input.role,
      phone: input.phone ?? null,
      isActive: true,
    })
    .returning();

  // Map to RBAC user_roles. Falls back silently if the role row doesn't exist
  // (shouldn't happen — system roles are seeded — but don't block staff creation).
  const [r] = await db.select({ id: roles.id }).from(roles).where(eq(roles.key, input.role)).limit(1);
  if (r) {
    await db
      .insert(userRoles)
      .values({ userId, roleId: r.id, assignedBy: req.user!.id })
      .onConflictDoNothing();
  }

  await logActivity({
    action: "staff_created",
    entityType: "profile",
    entityId: userId,
    description: `Staff added: ${input.fullName} (${input.role})`,
    performedBy: req.user!.id,
    ipAddress: req.ip,
  });
  return ok(res, profile, 201);
});

staffRouter.put(
  "/:id",
  requireAuth,
  requirePermission("manage_staff"),
  validate(staffUpdateSchema),
  async (req, res) => {
    const id = req.params.id!;
    const input = req.body as {
      fullName?: string;
      role?: "admin" | "frontdesk" | "housekeeping";
      isActive?: boolean;
      phone?: string | null;
      email?: string;
      password?: string;
    };

    if (input.role && id === req.user!.id && input.role !== "admin") {
      return fail(res, 400, "SELF_DEMOTE", "You cannot change your own role away from admin");
    }
    if (input.isActive === false && id === req.user!.id) {
      return fail(res, 400, "SELF_DEACTIVATE", "You cannot deactivate yourself");
    }

    if (input.email || input.password) {
      const authUpdate: { email?: string; password?: string } = {};
      if (input.email) authUpdate.email = input.email;
      if (input.password) authUpdate.password = input.password;
      const { error } = await supabaseAdmin.auth.admin.updateUserById(id, authUpdate);
      if (error) return fail(res, 400, "AUTH_ERROR", error.message);
    }

    const profilePatch: Record<string, unknown> = { updatedAt: new Date() };
    if (input.fullName !== undefined) profilePatch.fullName = input.fullName;
    if (input.role !== undefined) profilePatch.role = input.role;
    if (input.isActive !== undefined) profilePatch.isActive = input.isActive;
    if (input.phone !== undefined) profilePatch.phone = input.phone;
    if (input.email !== undefined) profilePatch.email = input.email;

    const [updated] = await db
      .update(profiles)
      .set(profilePatch)
      .where(eq(profiles.id, id))
      .returning();
    if (!updated) return fail(res, 404, "NOT_FOUND", "Staff not found");

    const changes: string[] = [];
    if (input.fullName) changes.push("name");
    if (input.role) changes.push("role");
    if (input.email) changes.push("email");
    if (input.password) changes.push("password");
    if (input.phone !== undefined) changes.push("phone");
    if (input.isActive !== undefined) changes.push(input.isActive ? "reactivated" : "deactivated");

    await logActivity({
      action: "staff_updated",
      entityType: "profile",
      entityId: id,
      description: `Staff updated: ${updated.fullName}${changes.length ? ` (${changes.join(", ")})` : ""}`,
      performedBy: req.user!.id,
      ipAddress: req.ip,
    });
    return ok(res, updated);
  },
);

staffRouter.delete("/:id", requireAuth, requirePermission("manage_staff"), async (req, res) => {
  const id = req.params.id!;
  if (id === req.user!.id) return fail(res, 400, "SELF_DEACTIVATE", "You cannot deactivate yourself");
  const [updated] = await db
    .update(profiles)
    .set({ isActive: false, updatedAt: new Date() })
    .where(eq(profiles.id, id))
    .returning();
  if (!updated) return fail(res, 404, "NOT_FOUND", "Staff not found");

  await logActivity({
    action: "staff_deactivated",
    entityType: "profile",
    entityId: id,
    description: `Staff deactivated: ${updated.fullName}`,
    performedBy: req.user!.id,
    ipAddress: req.ip,
  });
  return ok(res, updated);
});

staffRouter.delete("/:id/hard", requireAuth, requirePermission("manage_staff"), async (req, res) => {
  const id = req.params.id!;
  if (id === req.user!.id) return fail(res, 400, "SELF_DELETE", "You cannot delete yourself");

  const [target] = await db.select().from(profiles).where(eq(profiles.id, id)).limit(1);
  if (!target) return fail(res, 404, "NOT_FOUND", "Staff not found");

  const adminCount = await db
    .select({ n: sqlCount() })
    .from(profiles)
    .where(and(eq(profiles.role, "admin"), eq(profiles.isActive, true)));
  if (target.role === "admin" && Number(adminCount[0]?.n ?? 0) <= 1) {
    return fail(res, 400, "LAST_ADMIN", "Cannot delete the last active admin");
  }

  const referenceCheck = await db.execute(sql`
    select
      coalesce((select count(*) from reservations where created_by = ${id} or checked_in_by = ${id} or checked_out_by = ${id}), 0)::int as res_count,
      coalesce((select count(*) from invoices where issued_by = ${id} or voided_by = ${id}), 0)::int as inv_count,
      coalesce((select count(*) from payments where received_by = ${id}), 0)::int as pay_count,
      coalesce((select count(*) from activity_log where performed_by = ${id}), 0)::int as act_count
  `);
  const counts = (Array.isArray(referenceCheck) ? referenceCheck[0] : (referenceCheck as { rows?: unknown[] }).rows?.[0]) as
    | { res_count: number; inv_count: number; pay_count: number; act_count: number }
    | undefined;

  if (counts && (counts.res_count + counts.inv_count + counts.pay_count + counts.act_count) > 0) {
    return fail(
      res,
      409,
      "HAS_HISTORY",
      `Cannot delete: this user is linked to ${counts.res_count} reservation(s), ${counts.inv_count} invoice(s), ${counts.pay_count} payment(s), ${counts.act_count} activity log(s). Use Deactivate to preserve history.`,
    );
  }

  await db.delete(profiles).where(eq(profiles.id, id));
  const { error } = await supabaseAdmin.auth.admin.deleteUser(id);
  if (error) {
    return fail(res, 500, "AUTH_DELETE_FAILED", `Profile deleted but auth user removal failed: ${error.message}`);
  }

  await logActivity({
    action: "staff_deleted",
    entityType: "profile",
    entityId: id,
    description: `Staff permanently deleted: ${target.fullName} (${target.email})`,
    performedBy: req.user!.id,
    ipAddress: req.ip,
  });
  return ok(res, { id, deleted: true });
});

export { router as settingsRouter, staffRouter };
