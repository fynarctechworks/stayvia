// Admin-only activity log exporter. Streams a CSV of every activity_log
// entry in a chosen date range. Useful for periodic compliance reviews and
// internal audits.
//
// Permission: manage_staff (admin equivalent). The OWASP doc lists audit
// access as a sensitive capability so we don't expose it to ordinary
// staff roles.

import { format, startOfMonth } from "date-fns";
import { and, asc, desc, eq, gte, lte } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";
import { db } from "../db/client.js";
import { activityLog } from "../db/schema/activity.js";
import { profiles } from "../db/schema/profiles.js";
import { logActivity } from "../lib/activity.js";
import { propertyDayEnd, propertyDayStart } from "../lib/propertyTime.js";
import { fail } from "../lib/response.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";

const router = Router();

const exportSchema = z.object({
  date_from: z.string().date().optional(),
  date_to: z.string().date().optional(),
  // Hard upper bound. We don't want a stray request asking for the full
  // history to spike memory.
  limit: z.coerce.number().int().min(1).max(50000).default(10000),
});

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = typeof value === "string" ? value : JSON.stringify(value);
  // Strip CR/LF and tabs so a single row never spans multiple CSV lines.
  // Wrap with quotes if the value contains comma, quote, or newline.
  const cleaned = s.replace(/[\r\n\t]+/g, " ");
  if (/[",]/.test(cleaned)) {
    return `"${cleaned.replace(/"/g, '""')}"`;
  }
  return cleaned;
}

router.get(
  "/activity.csv",
  requireAuth,
  requirePermission("manage_staff"),
  async (req, res) => {
    const parsed = exportSchema.safeParse(req.query);
    if (!parsed.success) {
      return fail(res, 400, "VALIDATION_ERROR", "Invalid query");
    }
    const { date_from, date_to, limit } = parsed.data;

    // Property-local (IST) day bounds — the old version mixed a
    // server-local start with a UTC end-of-day.
    const from = date_from ? propertyDayStart(date_from) : startOfMonth(new Date());
    const to = date_to ? propertyDayEnd(date_to) : new Date();

    const conditions = [gte(activityLog.createdAt, from), lte(activityLog.createdAt, to)];

    const rows = await db
      .select({
        id: activityLog.id,
        action: activityLog.action,
        entityType: activityLog.entityType,
        entityId: activityLog.entityId,
        description: activityLog.description,
        ipAddress: activityLog.ipAddress,
        metadata: activityLog.metadata,
        createdAt: activityLog.createdAt,
        performedByName: profiles.fullName,
        performedByEmail: profiles.email,
      })
      .from(activityLog)
      .leftJoin(profiles, eq(profiles.id, activityLog.performedBy))
      .where(and(...conditions))
      .orderBy(desc(activityLog.createdAt), asc(activityLog.id))
      .limit(limit);

    const filename = `activity_${format(from, "yyyyMMdd")}_${format(to, "yyyyMMdd")}.csv`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    // No caching of audit exports — these contain sensitive data.
    res.setHeader("Cache-Control", "no-store");

    const headers = [
      "timestamp",
      "action",
      "entity_type",
      "entity_id",
      "performed_by",
      "performed_by_email",
      "ip_address",
      "description",
      "metadata",
    ];
    res.write(headers.join(",") + "\n");
    for (const r of rows) {
      const line = [
        r.createdAt.toISOString(),
        r.action,
        r.entityType,
        r.entityId,
        r.performedByName ?? "",
        r.performedByEmail ?? "",
        r.ipAddress ?? "",
        r.description,
        r.metadata ? JSON.stringify(r.metadata) : "",
      ]
        .map(csvEscape)
        .join(",");
      res.write(line + "\n");
    }
    res.end();

    // Log the export action itself — auditing the audit access.
    await logActivity({
      action: "audit_export",
      entityType: "activity_log",
      entityId: req.user!.id,
      description: `Activity log exported (${rows.length} rows, ${format(from, "dd MMM yyyy")} → ${format(to, "dd MMM yyyy")})`,
      performedBy: req.user!.id,
      ipAddress: req.ip,
      metadata: { rowCount: rows.length, from: from.toISOString(), to: to.toISOString() },
    });
  },
);

export default router;
