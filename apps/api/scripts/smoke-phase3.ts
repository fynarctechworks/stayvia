// Phase 3 smoke — runs against a THROWAWAY local Postgres (never Supabase).
// Exercises the signup-provisioning transaction path directly (the same
// functions routes/public.ts calls, with fake Supabase user ids) for two
// hotels, then drives requireActiveSubscription through every lifecycle
// state at the function level.
//
//   DATABASE_URL=postgresql://postgres@localhost:5439/stayvia_smoke \
//     npx tsx scripts/smoke-phase3.ts
//
// (Other required env vars can be dummies — nothing here talks to Supabase.)

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Request, Response } from "express";
import { env } from "../src/config/env.js";
import { db } from "../src/db/client.js";
import { profiles } from "../src/db/schema/profiles.js";
import { userRoles } from "../src/db/schema/rbac.js";
import { settings } from "../src/db/schema/settings.js";
import { subscriptions } from "../src/db/schema/subscriptions.js";
import { provisionAdmin, provisionProperty } from "../src/lib/provisionProperty.js";
import { seedRbacCatalog } from "../src/lib/rbacCatalog.js";
import {
  invalidateSubscriptionCache,
  requireActiveSubscription,
} from "../src/middleware/subscription.js";

let failures = 0;
function check(label: string, cond: boolean) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
}

// Same flow as POST /public/signup after createUser succeeds.
async function signupProvision(hotelName: string, ownerName: string, email: string) {
  const fakeSupabaseUserId = randomUUID();
  await seedRbacCatalog();
  const { propertyId } = await db.transaction(async (tx) => {
    const provisioned = await provisionProperty(tx, { name: hotelName });
    await provisionAdmin(tx, {
      propertyId: provisioned.propertyId,
      profileId: fakeSupabaseUserId,
      fullName: ownerName,
      email,
      phone: null,
    });
    await tx.insert(subscriptions).values({
      propertyId: provisioned.propertyId,
      plan: "standard",
      status: "trialing",
      trialEndsAt: new Date(Date.now() + env.TRIAL_DAYS * 24 * 60 * 60 * 1000),
    });
    return provisioned;
  });
  return { propertyId, userId: fakeSupabaseUserId };
}

// Function-level middleware harness: fake req/res, capture status + next().
async function runGate(propertyId: string) {
  let statusCode = 0;
  let nextCalled = false;
  let body: unknown;
  const req = { propertyId } as Request;
  const res = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(payload: unknown) {
      body = payload;
      return this;
    },
  } as unknown as Response;
  invalidateSubscriptionCache(propertyId);
  await requireActiveSubscription(req, res, () => {
    nextCalled = true;
  });
  return { statusCode, nextCalled, body };
}

async function main() {
  console.log("=== Phase 3 smoke: two-hotel signup provisioning ===");
  const a = await signupProvision("Smoke Hotel A", "Owner A", "owner-a@smoke.local");
  const b = await signupProvision("Smoke Hotel B", "Owner B", "owner-b@smoke.local");
  console.log(`hotel A propertyId=${a.propertyId}`);
  console.log(`hotel B propertyId=${b.propertyId}`);
  check("two distinct properties provisioned", a.propertyId !== b.propertyId);

  const [profileA] = await db.select().from(profiles).where(eq(profiles.id, a.userId)).limit(1);
  const [profileB] = await db.select().from(profiles).where(eq(profiles.id, b.userId)).limit(1);
  check("admin A profile wired to hotel A", profileA?.propertyId === a.propertyId && profileA?.role === "admin");
  check("admin B profile wired to hotel B", profileB?.propertyId === b.propertyId && profileB?.role === "admin");

  const [roleA] = await db.select().from(userRoles).where(eq(userRoles.userId, a.userId)).limit(1);
  check("admin A has a user_roles assignment", !!roleA);

  const [settingsA] = await db.select().from(settings).where(eq(settings.propertyId, a.propertyId)).limit(1);
  check("hotel A settings row created with hotel name", settingsA?.hotelName === "Smoke Hotel A");

  const [subA] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.propertyId, a.propertyId))
    .limit(1);
  check(
    `subscription A trialing on 'standard' with ${env.TRIAL_DAYS}-day trial`,
    subA?.status === "trialing" &&
      subA?.plan === "standard" &&
      !!subA?.trialEndsAt &&
      subA.trialEndsAt > new Date(),
  );

  console.log("\n=== requireActiveSubscription lifecycle (hotel A) ===");
  const trialing = await runGate(a.propertyId);
  check("trialing (trial not over) passes", trialing.nextCalled && trialing.statusCode === 0);

  await db
    .update(subscriptions)
    .set({ trialEndsAt: new Date(Date.now() - 24 * 60 * 60 * 1000) })
    .where(eq(subscriptions.propertyId, a.propertyId));
  const expired = await runGate(a.propertyId);
  check("expired trial blocked with 402", !expired.nextCalled && expired.statusCode === 402);

  await db
    .update(subscriptions)
    .set({ status: "active" })
    .where(eq(subscriptions.propertyId, a.propertyId));
  const active = await runGate(a.propertyId);
  check("active passes", active.nextCalled && active.statusCode === 0);

  await db
    .update(subscriptions)
    .set({ status: "past_due" })
    .where(eq(subscriptions.propertyId, a.propertyId));
  const pastDue = await runGate(a.propertyId);
  check("past_due blocked with 402", !pastDue.nextCalled && pastDue.statusCode === 402);

  // Tenancy sanity: hotel B is untouched by A's lifecycle churn.
  const hotelB = await runGate(b.propertyId);
  check("hotel B still trialing and passes (isolation)", hotelB.nextCalled);

  console.log(failures === 0 ? "\nSMOKE OK — all checks passed" : `\nSMOKE FAILED — ${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Smoke crashed:", err);
  process.exit(1);
});
