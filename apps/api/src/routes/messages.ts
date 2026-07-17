import { and, asc, desc, eq, isNull, or, sql } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";
import { db } from "../db/client.js";
import { messages } from "../db/schema/messages.js";
import { profiles } from "../db/schema/profiles.js";
import { dispatchNotification } from "../lib/notify.js";
import { fail, ok } from "../lib/response.js";
import { requireAuth } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";

const router = Router();

router.get("/staff", requireAuth, async (req, res) => {
  const me = req.user!.id;
  const rows = await db
    .select({
      id: profiles.id,
      fullName: profiles.fullName,
      role: profiles.role,
      email: profiles.email,
    })
    .from(profiles)
    .where(and(eq(profiles.isActive, true), sql`${profiles.id} <> ${me}`))
    .orderBy(asc(profiles.fullName));
  return ok(res, { items: rows });
});

router.get("/threads", requireAuth, async (req, res) => {
  const me = req.user!.id;
  const result = await db.execute<{
    other_id: string;
    full_name: string;
    role: string;
    last_body: string;
    last_at: string;
    unread: number;
  }>(sql`
    with paired as (
      select
        case when sender_id = ${me} then recipient_id else sender_id end as other_id,
        body,
        created_at,
        recipient_id,
        read_at
      from messages
      where sender_id = ${me} or recipient_id = ${me}
    ),
    last_per as (
      select distinct on (other_id) other_id, body as last_body, created_at as last_at
      from paired
      order by other_id, created_at desc
    ),
    unread_per as (
      select other_id, count(*)::int as unread
      from paired
      where recipient_id = ${me} and read_at is null
      group by other_id
    )
    select
      lp.other_id,
      p.full_name,
      p.role,
      lp.last_body,
      lp.last_at,
      coalesce(up.unread, 0) as unread
    from last_per lp
    join profiles p on p.id = lp.other_id
    left join unread_per up on up.other_id = lp.other_id
    order by lp.last_at desc
  `);
  const items = Array.isArray(result) ? result : (result as { rows?: unknown[] }).rows ?? [];
  return ok(res, { items });
});

const threadQuery = z.object({
  with: z.string().uuid(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

router.get("/", requireAuth, validate(threadQuery, "query"), async (req, res) => {
  const me = req.user!.id;
  const { with: other, limit } = req.query as unknown as z.infer<typeof threadQuery>;

  const rows = await db
    .select()
    .from(messages)
    .where(
      or(
        and(eq(messages.senderId, me), eq(messages.recipientId, other)),
        and(eq(messages.senderId, other), eq(messages.recipientId, me)),
      ),
    )
    .orderBy(desc(messages.createdAt))
    .limit(limit);

  await db
    .update(messages)
    .set({ readAt: new Date() })
    .where(
      and(eq(messages.senderId, other), eq(messages.recipientId, me), isNull(messages.readAt)),
    );

  return ok(res, { items: rows.reverse() });
});

const sendSchema = z.object({
  recipientId: z.string().uuid(),
  body: z.string().min(1).max(2000),
});

router.post("/", requireAuth, validate(sendSchema), async (req, res) => {
  const me = req.user!.id;
  const { recipientId, body } = req.body as z.infer<typeof sendSchema>;

  if (recipientId === me) return fail(res, 400, "SELF", "Cannot message yourself");

  const [exists] = await db.select({ id: profiles.id }).from(profiles).where(eq(profiles.id, recipientId)).limit(1);
  if (!exists) return fail(res, 404, "NOT_FOUND", "Recipient not found");

  const [row] = await db
    .insert(messages)
    .values({ senderId: me, recipientId, body })
    .returning();

  void dispatchNotification({
    type: "message_received",
    title: `New message from ${req.user!.fullName}`,
    body: body.length > 80 ? `${body.slice(0, 80)}…` : body,
    href: `/messages?with=${me}`,
    payload: { messageId: row!.id, senderId: me },
    recipientIds: [recipientId],
  }).catch(() => {});

  return ok(res, row, 201);
});

export default router;
