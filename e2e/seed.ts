// E2E seeder — run by global-setup under tsx with the harness's fake env
// (nothing here talks to Supabase/GoTrue; the auth shim means profiles only
// need rows, not real auth users). Seeds TWO tenants through the same
// provisioning path production signup uses, then writes the ids the suites
// assert on to e2e/.runtime/fixtures.json.

import { writeFileSync } from "node:fs";

import { db } from "../apps/api/src/db/client.js";
import {
  guests,
  invoices,
  reservationRooms,
  reservations,
  rooms,
  subscriptions,
} from "../apps/api/src/db/schema/index.js";
import { encrypt, last4 } from "../apps/api/src/lib/crypto.js";
import { provisionAdmin, provisionProperty } from "../apps/api/src/lib/provisionProperty.js";
import { seedRbacCatalog } from "../apps/api/src/lib/rbacCatalog.js";
import { FIXTURES_FILE, type Fixtures, type HotelFixture } from "./harness";

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

interface HotelSpec {
  hotelName: string;
  adminId: string;
  adminEmail: string;
  adminName: string;
  roomNumbers: string[];
  guestName: string;
  guestPhone: string;
  idProofNumber: string;
  reservationNumber: string;
  invoiceNumber: string;
  razorpaySubscriptionId: string;
}

async function seedHotel(spec: HotelSpec): Promise<HotelFixture> {
  const { propertyId } = await db.transaction(async (tx) =>
    provisionProperty(tx, { name: spec.hotelName }),
  );
  await db.transaction(async (tx) =>
    provisionAdmin(tx, {
      propertyId,
      profileId: spec.adminId,
      fullName: spec.adminName,
      email: spec.adminEmail,
    }),
  );

  await db.insert(subscriptions).values({
    propertyId,
    plan: "standard",
    status: "trialing",
    trialEndsAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
    razorpaySubscriptionId: spec.razorpaySubscriptionId,
  });

  const roomRows = await db
    .insert(rooms)
    .values(
      spec.roomNumbers.map((roomNumber) => ({
        propertyId,
        roomNumber,
        floor: Number(roomNumber[0]),
        roomType: "deluxe",
        baseRate: "1000.00",
      })),
    )
    .returning({ id: rooms.id, roomNumber: rooms.roomNumber });

  const [guest] = await db
    .insert(guests)
    .values({
      propertyId,
      fullName: spec.guestName,
      phone: spec.guestPhone,
      idProofType: "aadhaar",
      idProofNumberEncrypted: encrypt(spec.idProofNumber),
      idProofLast4: last4(spec.idProofNumber),
      gender: "male",
    })
    .returning({ id: guests.id });
  const guestId = guest!.id;

  const today = new Date();
  const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);
  const [reservation] = await db
    .insert(reservations)
    .values({
      reservationNumber: spec.reservationNumber,
      propertyId,
      guestId,
      checkInDate: isoDate(today),
      checkOutDate: isoDate(tomorrow),
      ratePerNight: "1000.00",
      subtotal: "1000.00",
      gstRate: "12.00",
      gstAmount: "120.00",
      grandTotal: "1120.00",
      balanceDue: "1120.00",
      status: "confirmed",
      bookingSource: "walkin",
      createdBy: spec.adminId,
    })
    .returning({ id: reservations.id });
  const reservationId = reservation!.id;

  await db.insert(reservationRooms).values({
    reservationId,
    roomId: roomRows[0]!.id,
    ratePerNight: "1000.00",
    guestId,
    status: "confirmed",
  });

  const [invoice] = await db
    .insert(invoices)
    .values({
      invoiceNumber: spec.invoiceNumber,
      propertyId,
      reservationId,
      guestId,
      hotelName: spec.hotelName,
      hotelAddress: "",
      hotelGstin: "",
      guestName: spec.guestName,
      subtotal: "1000.00",
      cgstRate: "6.00",
      cgstAmount: "60.00",
      sgstRate: "6.00",
      sgstAmount: "60.00",
      grandTotal: "1120.00",
      balanceDue: "1120.00",
      status: "issued",
      issueDate: isoDate(today),
      issuedBy: spec.adminId,
    })
    .returning({ id: invoices.id });

  return {
    hotelName: spec.hotelName,
    propertyId,
    adminId: spec.adminId,
    adminEmail: spec.adminEmail,
    roomIds: roomRows.map((r) => r.id),
    roomNumbers: roomRows.map((r) => r.roomNumber),
    guestId,
    guestName: spec.guestName,
    reservationId,
    reservationNumber: spec.reservationNumber,
    invoiceId: invoice!.id,
    razorpaySubscriptionId: spec.razorpaySubscriptionId,
  };
}

async function main(): Promise<void> {
  await seedRbacCatalog();

  // Disjoint names/numbers/phones across the two tenants so cross-tenant
  // bleed in any list or search is unambiguous in assertions.
  const hotelA = await seedHotel({
    hotelName: "Hotel Alpha",
    adminId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    adminEmail: "admin-a@e2e.stayvia.test",
    adminName: "Alpha Admin",
    roomNumbers: ["101", "102", "103"],
    guestName: "Alice Anderson",
    guestPhone: "9000000001",
    idProofNumber: "111122223333",
    reservationNumber: "RES-1001",
    invoiceNumber: "INV-1001",
    razorpaySubscriptionId: "sub_e2e_hotel_a",
  });

  const hotelB = await seedHotel({
    hotelName: "Hotel Beta",
    adminId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    adminEmail: "admin-b@e2e.stayvia.test",
    adminName: "Beta Admin",
    roomNumbers: ["201", "202"],
    guestName: "Bob Barnes",
    guestPhone: "9000000002",
    idProofNumber: "444455556666",
    reservationNumber: "RES-2001",
    invoiceNumber: "INV-2001",
    razorpaySubscriptionId: "sub_e2e_hotel_b",
  });

  const fixtures: Fixtures = { hotelA, hotelB };
  writeFileSync(FIXTURES_FILE, JSON.stringify(fixtures, null, 2));
  console.log(`Seeded 2 hotels → ${FIXTURES_FILE}`);
  process.exit(0);
}

main().catch((err) => {
  console.error("E2E seed failed:", err);
  process.exit(1);
});
