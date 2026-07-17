import { and, count, desc, eq, isNull } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";
import { db } from "../db/client.js";
import { notifications } from "../db/schema/notifications.js";
import { fail, ok } from "../lib/response.js";
import { requireAuth } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";

const router = Router();

const listQuery = z.object({
  unreadOnly: z.enum(["true", "false"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

router.get("/", requireAuth, validate(listQuery, "query"), async (req, res) => {
  const { unreadOnly, limit } = req.query as unknown as z.infer<typeof listQuery>;
  const me = req.user!.id;

  const where =
    unreadOnly === "true"
      ? and(eq(notifications.recipientId, me), isNull(notifications.readAt))
      : eq(notifications.recipientId, me);

  const rows = await db
    .select()
    .from(notifications)
    .where(where)
    .orderBy(desc(notifications.createdAt))
    .limit(limit);

  const [unread] = await db
    .select({ n: count() })
    .from(notifications)
    .where(and(eq(notifications.recipientId, me), isNull(notifications.readAt)));

  return ok(res, { items: rows, unreadCount: Number(unread?.n ?? 0) });
});

router.post("/:id/read", requireAuth, async (req, res) => {
  const id = req.params.id!;
  const me = req.user!.id;

  const updated = await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(eq(notifications.id, id), eq(notifications.recipientId, me)))
    .returning({ id: notifications.id });

  if (updated.length === 0) return fail(res, 404, "NOT_FOUND", "Notification not found");
  return ok(res, { id, read: true });
});

router.post("/read-all", requireAuth, async (req, res) => {
  const me = req.user!.id;
  await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(eq(notifications.recipientId, me), isNull(notifications.readAt)));
  return ok(res, { ok: true });
});

export default router;
