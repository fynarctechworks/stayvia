import { expect, test, type APIRequestContext } from "@playwright/test";

import { API_URL, loadFixtures, mintToken, type Fixtures } from "./harness";

// Tenant isolation, asserted at the API boundary with minted JWTs (the
// E2E auth shim verifies them locally). Hotel A's admin must never see —
// or touch — any row seeded for hotel B, and vice versa. Cross-tenant ids
// must be indistinguishable from nonexistent ones (404, never 403).

let fx: Fixtures;
let tokenA: string;
let tokenB: string;

test.beforeAll(() => {
  fx = loadFixtures();
  tokenA = mintToken(fx.hotelA.adminId, fx.hotelA.adminEmail);
  tokenB = mintToken(fx.hotelB.adminId, fx.hotelB.adminEmail);
});

function opts(token: string) {
  return { headers: { authorization: `Bearer ${token}` } };
}

async function getJson(
  request: APIRequestContext,
  path: string,
  token: string,
  expectedStatus = 200,
) {
  const res = await request.get(`${API_URL}${path}`, opts(token));
  expect(res.status(), `GET ${path}`).toBe(expectedStatus);
  return res.json();
}

test.describe("tenant isolation — hotel A's admin", () => {
  test("reservation list contains only A's reservations", async ({ request }) => {
    const json = await getJson(request, "/reservations", tokenA);
    const ids = (json.data as Array<{ id: string }>).map((r) => r.id);
    expect(ids).toContain(fx.hotelA.reservationId);
    expect(ids).not.toContain(fx.hotelB.reservationId);
  });

  test("guest list contains only A's guests", async ({ request }) => {
    const json = await getJson(request, "/guests", tokenA);
    const ids = (json.data as Array<{ id: string }>).map((g) => g.id);
    expect(ids).toContain(fx.hotelA.guestId);
    expect(ids).not.toContain(fx.hotelB.guestId);
  });

  test("room list is exactly A's rooms", async ({ request }) => {
    const json = await getJson(request, "/rooms", tokenA);
    const ids = (json.data as Array<{ id: string }>).map((r) => r.id);
    expect(ids.sort()).toEqual([...fx.hotelA.roomIds].sort());
    for (const bRoom of fx.hotelB.roomIds) expect(ids).not.toContain(bRoom);
  });

  test("staff list contains only A's profiles", async ({ request }) => {
    const json = await getJson(request, "/staff", tokenA);
    const rows = json.data as Array<{ id: string; propertyId: string }>;
    expect(rows.map((s) => s.id)).toContain(fx.hotelA.adminId);
    expect(rows.map((s) => s.id)).not.toContain(fx.hotelB.adminId);
    for (const row of rows) expect(row.propertyId).toBe(fx.hotelA.propertyId);
  });

  test("B's reservation is 404 by uuid and by number", async ({ request }) => {
    await getJson(request, `/reservations/${fx.hotelB.reservationId}`, tokenA, 404);
    await getJson(request, `/reservations/${fx.hotelB.reservationNumber}`, tokenA, 404);
  });

  test("B's guest is 404", async ({ request }) => {
    await getJson(request, `/guests/${fx.hotelB.guestId}`, tokenA, 404);
  });

  test("B's invoice is 404", async ({ request }) => {
    await getJson(request, `/invoices/${fx.hotelB.invoiceId}`, tokenA, 404);
  });

  test("PATCH on B's room status is 404 and leaves the room untouched", async ({ request }) => {
    const res = await request.patch(
      `${API_URL}/rooms/${fx.hotelB.roomIds[0]}/status`,
      { ...opts(tokenA), data: { status: "maintenance" } },
    );
    expect(res.status()).toBe(404);
    // As B: the room is still available — the write really was rejected,
    // not just hidden.
    const room = await getJson(request, `/rooms/${fx.hotelB.roomIds[0]}`, tokenB);
    expect(room.data.status).toBe("available");
  });

  test("search never returns B's rows", async ({ request }) => {
    for (const q of [
      fx.hotelB.guestName.split(" ")[0]!, // "Bob"
      fx.hotelB.reservationNumber, // "RES-2001"
      fx.hotelB.roomNumbers[0]!, // "201"
    ]) {
      const json = await getJson(request, `/search?q=${encodeURIComponent(q)}`, tokenA);
      expect(json.data.guests, `q=${q}`).toEqual([]);
      expect(json.data.reservations, `q=${q}`).toEqual([]);
      expect(json.data.rooms, `q=${q}`).toEqual([]);
    }
  });

  test("dashboard occupancy counts A's rooms only", async ({ request }) => {
    const json = await getJson(request, "/dashboard", tokenA);
    expect(json.data.occupancy.total).toBe(fx.hotelA.roomIds.length); // 3
  });
});

test.describe("tenant isolation — hotel B's admin (symmetric spot-checks)", () => {
  test("lists exclude A's rows", async ({ request }) => {
    const reservations = await getJson(request, "/reservations", tokenB);
    const resIds = (reservations.data as Array<{ id: string }>).map((r) => r.id);
    expect(resIds).toContain(fx.hotelB.reservationId);
    expect(resIds).not.toContain(fx.hotelA.reservationId);

    const rooms = await getJson(request, "/rooms", tokenB);
    const roomIds = (rooms.data as Array<{ id: string }>).map((r) => r.id);
    expect(roomIds.sort()).toEqual([...fx.hotelB.roomIds].sort());
  });

  test("A's reservation and guest are 404", async ({ request }) => {
    await getJson(request, `/reservations/${fx.hotelA.reservationId}`, tokenB, 404);
    await getJson(request, `/guests/${fx.hotelA.guestId}`, tokenB, 404);
  });

  test("dashboard occupancy counts B's rooms only", async ({ request }) => {
    const json = await getJson(request, "/dashboard", tokenB);
    expect(json.data.occupancy.total).toBe(fx.hotelB.roomIds.length); // 2
  });
});
