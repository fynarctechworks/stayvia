import { createHmac } from "node:crypto";

import { expect, test, type APIRequestContext } from "@playwright/test";

import {
  API_URL,
  E2E_WEBHOOK_SECRET,
  loadFixtures,
  mintToken,
  runSql,
  type Fixtures,
} from "./harness";

// Billing lifecycle at the API boundary: the subscription gate (402
// SUBSCRIPTION_REQUIRED) around business routes, the always-reachable
// /billing surface, and the Razorpay webhook (HMAC over the raw body IS the
// authentication). Subscription states are flipped directly in the
// throwaway DB — the API runs with SUBSCRIPTION_CACHE_TTL_MS=0 so flips are
// visible on the next request. Tests in this file are order-dependent
// (workers: 1, fullyParallel: false keeps them serial in file order).

let fx: Fixtures;
let tokenA: string;

test.beforeAll(() => {
  fx = loadFixtures();
  tokenA = mintToken(fx.hotelA.adminId, fx.hotelA.adminEmail);
});

// Whatever happened above, later suites must find hotel A unlocked again.
test.afterAll(async () => {
  await runSql((sql) =>
    sql`UPDATE subscriptions
        SET status = 'trialing', trial_ends_at = now() + interval '14 days', updated_at = now()
        WHERE property_id = ${fx.hotelA.propertyId}`,
  );
});

function opts(token: string) {
  return { headers: { authorization: `Bearer ${token}` } };
}

// Any subscription-gated business endpoint works; the reservation list is
// cheap and already exercised by the isolation suite.
async function businessStatus(request: APIRequestContext): Promise<number> {
  const res = await request.get(`${API_URL}/reservations`, opts(tokenA));
  return res.status();
}

async function expireTrial(): Promise<void> {
  await runSql((sql) =>
    sql`UPDATE subscriptions
        SET status = 'trialing', trial_ends_at = now() - interval '1 day', updated_at = now()
        WHERE property_id = ${fx.hotelA.propertyId}`,
  );
}

test.describe("billing lifecycle — hotel A", () => {
  test("an in-trial hotel passes the subscription gate", async ({ request }) => {
    expect(await businessStatus(request)).toBe(200);
  });

  test("an expired trial locks business routes with 402 but not /billing", async ({ request }) => {
    await expireTrial();

    const locked = await request.get(`${API_URL}/reservations`, opts(tokenA));
    expect(locked.status()).toBe(402);
    const body = await locked.json();
    expect(body.error.code).toBe("SUBSCRIPTION_REQUIRED");

    // Billing is how a hotel pays its way back in — always reachable.
    const billing = await request.get(`${API_URL}/billing`, opts(tokenA));
    expect(billing.status()).toBe(200);
    const billingBody = await billing.json();
    expect(billingBody.data.status).toBe("trialing");
    expect(billingBody.data.locked).toBe(true);
  });

  test("an active subscription unlocks business routes again", async ({ request }) => {
    await runSql((sql) =>
      sql`UPDATE subscriptions
          SET status = 'active', current_period_end = now() + interval '30 days', updated_at = now()
          WHERE property_id = ${fx.hotelA.propertyId}`,
    );
    expect(await businessStatus(request)).toBe(200);
  });

  test("a signed subscription.activated webhook flips an expired hotel to active", async ({
    request,
  }) => {
    await expireTrial();
    expect(await businessStatus(request)).toBe(402);

    const nowSec = Math.floor(Date.now() / 1000);
    const payload = JSON.stringify({
      event: "subscription.activated",
      payload: {
        subscription: {
          entity: {
            id: fx.hotelA.razorpaySubscriptionId,
            current_start: nowSec,
            current_end: nowSec + 30 * 24 * 60 * 60,
          },
        },
      },
    });
    const signature = createHmac("sha256", E2E_WEBHOOK_SECRET).update(payload).digest("hex");

    const res = await request.post(`${API_URL}/billing/webhook`, {
      headers: { "content-type": "application/json", "x-razorpay-signature": signature },
      data: payload,
    });
    expect(res.status()).toBe(200);
    expect((await res.json()).data.processed).toBe(true);

    const billing = await request.get(`${API_URL}/billing`, opts(tokenA));
    expect((await billing.json()).data.status).toBe("active");
    expect(await businessStatus(request)).toBe(200);
  });

  test("a webhook with a bad signature is rejected and changes nothing", async ({ request }) => {
    const payload = JSON.stringify({
      event: "subscription.cancelled",
      payload: {
        subscription: { entity: { id: fx.hotelA.razorpaySubscriptionId } },
      },
    });
    const res = await request.post(`${API_URL}/billing/webhook`, {
      headers: {
        "content-type": "application/json",
        "x-razorpay-signature": createHmac("sha256", "wrong-secret").update(payload).digest("hex"),
      },
      data: payload,
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error.code).toBe("INVALID_SIGNATURE");

    // Still active — the forged cancel never landed.
    const billing = await request.get(`${API_URL}/billing`, opts(tokenA));
    expect((await billing.json()).data.status).toBe("active");
  });
});
