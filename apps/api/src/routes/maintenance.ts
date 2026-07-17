// Maintenance issue tracking. Per-room ledger + property-wide list.
import {
  maintenanceCommentSchema,
  maintenanceCreateSchema,
  maintenanceListQuerySchema,
  maintenanceUpdateSchema,
} from "@hoteldesk/shared";
import { and, asc, count, desc, eq, inArray, sql } from "drizzle-orm";
import { Router } from "express";
import { db } from "../db/client.js";
import {
  maintenanceIssueComments,
  maintenanceIssues,
} from "../db/schema/maintenance.js";
import { profiles } from "../db/schema/profiles.js";
import { rooms } from "../db/schema/rooms.js";
import { logActivity } from "../lib/activity.js";
import { resolveCurrentPropertyId } from "../lib/currentProperty.js";
import { fail, list, ok } from "../lib/response.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";

const router = Router();

async function loadIssueDetail(issueId: string) {
  const rows = await db
    .select({
      issue: maintenanceIssues,
      room: {
        id: rooms.id,
        roomNumber: rooms.roomNumber,
        roomType: rooms.roomType,
        floor: rooms.floor,
      },
    })
    .from(maintenanceIssues)
    .innerJoin(rooms, eq(rooms.id, maintenanceIssues.roomId))
    .where(eq(maintenanceIssues.id, issueId))
    .limit(1);
  if (!rows.length) return null;
  const { issue, room } = rows[0]!;

  const profileIds = Array.from(
    new Set(
      [
        issue.reportedBy,
        issue.assignedTo ?? undefined,
        issue.resolvedBy ?? undefined,
      ].filter((v): v is string => !!v),
    ),
  );
  const profileRows = profileIds.length
    ? await db
        .select({ id: profiles.id, fullName: profiles.fullName })
        .from(profiles)
        .where(inArray(profiles.id, profileIds))
    : [];
  const pMap = new Map(profileRows.map((p) => [p.id, p.fullName]));

  const comments = await db
    .select({
      id: maintenanceIssueComments.id,
      body: maintenanceIssueComments.body,
      createdAt: maintenanceIssueComments.createdAt,
      authorId: maintenanceIssueComments.authorId,
      authorName: profiles.fullName,
    })
    .from(maintenanceIssueComments)
    .innerJoin(profiles, eq(profiles.id, maintenanceIssueComments.authorId))
    .where(eq(maintenanceIssueComments.issueId, issueId))
    .orderBy(asc(maintenanceIssueComments.createdAt));

  return {
    ...issue,
    room,
    reportedByName: pMap.get(issue.reportedBy) ?? null,
    assignedToName: issue.assignedTo ? pMap.get(issue.assignedTo) ?? null : null,
    resolvedByName: issue.resolvedBy ? pMap.get(issue.resolvedBy) ?? null : null,
    comments,
  };
}

router.get(
  "/",
  requireAuth,
  requirePermission("view_maintenance"),
  validate(maintenanceListQuerySchema, "query"),
  async (req, res) => {
    const parsed = maintenanceListQuerySchema.parse(req.query);
    const {
      status,
      statuses,
      category,
      severity,
      room_id,
      assigned_to,
      search,
      page,
      per_page,
    } = parsed;

    const conditions = [];
    if (status) conditions.push(eq(maintenanceIssues.status, status));
    if (statuses) {
      const stList = statuses
        .split(",")
        .map((s) => s.trim())
        .filter((s): s is "open" | "in_progress" | "resolved" | "cancelled" =>
          ["open", "in_progress", "resolved", "cancelled"].includes(s),
        );
      if (stList.length > 0) {
        conditions.push(inArray(maintenanceIssues.status, stList));
      }
    }
    if (category) conditions.push(eq(maintenanceIssues.category, category));
    if (severity) conditions.push(eq(maintenanceIssues.severity, severity));
    if (room_id) conditions.push(eq(maintenanceIssues.roomId, room_id));
    if (assigned_to)
      conditions.push(eq(maintenanceIssues.assignedTo, assigned_to));
    if (search) {
      conditions.push(
        sql`(${maintenanceIssues.title} ILIKE ${"%" + search + "%"}
             OR ${maintenanceIssues.description} ILIKE ${"%" + search + "%"})`,
      );
    }

    const where = conditions.length ? and(...conditions) : undefined;
    const offset = (page - 1) * per_page;

    const severityOrder = sql`CASE ${maintenanceIssues.severity}
      WHEN 'urgent' THEN 0
      WHEN 'normal' THEN 1
      WHEN 'low' THEN 2
      ELSE 3 END`;

    const [rows, totalRows] = await Promise.all([
      db
        .select({
          id: maintenanceIssues.id,
          roomId: maintenanceIssues.roomId,
          roomNumber: rooms.roomNumber,
          roomType: rooms.roomType,
          floor: rooms.floor,
          category: maintenanceIssues.category,
          severity: maintenanceIssues.severity,
          title: maintenanceIssues.title,
          status: maintenanceIssues.status,
          reportedAt: maintenanceIssues.reportedAt,
          reportedByName: profiles.fullName,
          assignedTo: maintenanceIssues.assignedTo,
          resolvedAt: maintenanceIssues.resolvedAt,
          costActual: maintenanceIssues.costActual,
        })
        .from(maintenanceIssues)
        .innerJoin(rooms, eq(rooms.id, maintenanceIssues.roomId))
        .innerJoin(profiles, eq(profiles.id, maintenanceIssues.reportedBy))
        .where(where)
        .orderBy(severityOrder, desc(maintenanceIssues.reportedAt))
        .limit(per_page)
        .offset(offset),
      db.select({ count: count() }).from(maintenanceIssues).where(where),
    ]);

    return list(res, rows, {
      total: totalRows[0]?.count ?? 0,
      page,
      per_page,
    });
  },
);

router.get(
  "/:id",
  requireAuth,
  requirePermission("view_maintenance"),
  async (req, res) => {
    const id = req.params.id!;
    const detail = await loadIssueDetail(id);
    if (!detail) return fail(res, 404, "NOT_FOUND", "Issue not found");
    return ok(res, detail);
  },
);

router.post(
  "/",
  requireAuth,
  requirePermission("manage_maintenance"),
  validate(maintenanceCreateSchema),
  async (req, res) => {
    const input = req.body as import("@hoteldesk/shared").MaintenanceCreateInput;
    const propertyId = await resolveCurrentPropertyId(req);

    const [created] = await db
      .insert(maintenanceIssues)
      .values({
        propertyId,
        roomId: input.roomId,
        category: input.category,
        severity: input.severity ?? "normal",
        title: input.title,
        description: input.description ?? null,
        costEstimate: input.costEstimate?.toString() ?? null,
        reportedBy: req.user!.id,
      })
      .returning();

    await logActivity({
      action: "maintenance_issue_created",
      entityType: "maintenance_issue",
      entityId: created!.id,
      description: `Maintenance: ${input.title} (${input.severity ?? "normal"}, ${input.category})`,
      performedBy: req.user!.id,
      ipAddress: req.ip,
    });

    const detail = await loadIssueDetail(created!.id);
    return ok(res, detail, 201);
  },
);

router.patch(
  "/:id",
  requireAuth,
  requirePermission("manage_maintenance"),
  validate(maintenanceUpdateSchema),
  async (req, res) => {
    const id = req.params.id!;
    const input = req.body as import("@hoteldesk/shared").MaintenanceUpdateInput;

    const [before] = await db
      .select()
      .from(maintenanceIssues)
      .where(eq(maintenanceIssues.id, id))
      .limit(1);
    if (!before) return fail(res, 404, "NOT_FOUND", "Issue not found");

    const flippingToResolved =
      input.status === "resolved" && before.status !== "resolved";
    if (
      flippingToResolved &&
      (!input.resolutionNotes || input.resolutionNotes.trim() === "")
    ) {
      return fail(
        res,
        400,
        "RESOLUTION_NOTES_REQUIRED",
        "Resolution notes are required when marking an issue resolved.",
      );
    }

    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (input.category !== undefined) patch.category = input.category;
    if (input.severity !== undefined) patch.severity = input.severity;
    if (input.title !== undefined) patch.title = input.title;
    if (input.description !== undefined) patch.description = input.description;
    if (input.status !== undefined) patch.status = input.status;
    if (input.assignedTo !== undefined) patch.assignedTo = input.assignedTo;
    if (input.resolutionNotes !== undefined) {
      patch.resolutionNotes = input.resolutionNotes;
    }
    if (input.costEstimate !== undefined) {
      patch.costEstimate = input.costEstimate?.toString() ?? null;
    }
    if (input.costActual !== undefined) {
      patch.costActual = input.costActual?.toString() ?? null;
    }
    if (flippingToResolved) {
      patch.resolvedBy = req.user!.id;
      patch.resolvedAt = new Date();
    }

    await db
      .update(maintenanceIssues)
      .set(patch)
      .where(eq(maintenanceIssues.id, id));

    await logActivity({
      action: "maintenance_issue_updated",
      entityType: "maintenance_issue",
      entityId: id,
      description: `Maintenance updated${input.status ? `: → ${input.status}` : ""}`,
      performedBy: req.user!.id,
      ipAddress: req.ip,
    });

    const detail = await loadIssueDetail(id);
    return ok(res, detail);
  },
);

router.post(
  "/:id/comments",
  requireAuth,
  requirePermission("manage_maintenance"),
  validate(maintenanceCommentSchema),
  async (req, res) => {
    const id = req.params.id!;
    const { body } = req.body as { body: string };

    const [exists] = await db
      .select({ id: maintenanceIssues.id })
      .from(maintenanceIssues)
      .where(eq(maintenanceIssues.id, id))
      .limit(1);
    if (!exists) return fail(res, 404, "NOT_FOUND", "Issue not found");

    const [created] = await db
      .insert(maintenanceIssueComments)
      .values({
        issueId: id,
        authorId: req.user!.id,
        body,
      })
      .returning();

    await db
      .update(maintenanceIssues)
      .set({ updatedAt: new Date() })
      .where(eq(maintenanceIssues.id, id));

    return ok(res, created, 201);
  },
);

export default router;
