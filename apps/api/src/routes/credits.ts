import { sql } from "drizzle-orm";
import { Router } from "express";
import { db } from "../db/client.js";
import { ok } from "../lib/response.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";

const router = Router();

// Lists every guest with a non-zero wallet balance, computed by summing
// each guest's ledger entries in one SQL pass. credit_issued + positive
// adjustments add to the balance; credit_used + cashout + negative
// adjustments subtract. Guests with zero (or near-zero, accounting for
// floating-point) balance are excluded so the page stays focused.
router.get(
  "/guests",
  requireAuth,
  requirePermission("view_revenue"),
  async (_req, res) => {
    const rows = await db.execute<{
      guest_id: string;
      full_name: string;
      phone: string;
      email: string | null;
      balance: string;
      last_activity_at: string | null;
      entry_count: number;
    }>(sql`
      SELECT
        g.id            AS guest_id,
        g.full_name     AS full_name,
        g.phone         AS phone,
        g.email         AS email,
        COALESCE(SUM(
          CASE
            WHEN gl.entry_type IN ('credit_issued','adjustment') THEN gl.amount::numeric
            WHEN gl.entry_type IN ('credit_used','cashout') THEN -gl.amount::numeric
            ELSE 0
          END
        ), 0)::text     AS balance,
        MAX(gl.created_at)::text AS last_activity_at,
        COUNT(gl.id)::int        AS entry_count
      FROM guests g
      INNER JOIN guest_ledger gl ON gl.guest_id = g.id
      GROUP BY g.id, g.full_name, g.phone, g.email
      HAVING COALESCE(SUM(
        CASE
          WHEN gl.entry_type IN ('credit_issued','adjustment') THEN gl.amount::numeric
          WHEN gl.entry_type IN ('credit_used','cashout') THEN -gl.amount::numeric
          ELSE 0
        END
      ), 0) > 0.009
      ORDER BY balance DESC
    `);

    const guests = rows.map((r) => ({
      guestId: r.guest_id,
      fullName: r.full_name,
      phone: r.phone,
      email: r.email,
      balance: Number(r.balance),
      lastActivityAt: r.last_activity_at,
      entryCount: r.entry_count,
    }));

    const totalCredit = guests.reduce((s, g) => s + g.balance, 0);

    return ok(res, {
      guests,
      totalCredit,
      guestCount: guests.length,
    });
  },
);

export default router;
