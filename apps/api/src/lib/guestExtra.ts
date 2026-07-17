// Fetches the optional "guest extra" payload (booker gender + linked
// co-guests) used by renderInvoicePdf / renderReceiptPdf. Kept in a
// shared helper so every invoice/receipt path produces the same
// printed output without duplicating the same join.

import { asc, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { guests } from "../db/schema/guests.js";
import { reservationCoGuests, reservations } from "../db/schema/reservations.js";

export interface PrintedCoGuest {
  fullName: string;
  phone: string;
  gender: string | null;
  idProofType: string;
  idProofLast4: string;
}

export interface GuestExtra {
  gender: string | null;
  coGuests: PrintedCoGuest[];
}

export async function loadGuestExtra(reservationId: string): Promise<GuestExtra> {
  // Booker gender.
  const [r] = await db
    .select({ guestId: reservations.guestId })
    .from(reservations)
    .where(eq(reservations.id, reservationId))
    .limit(1);
  let gender: string | null = null;
  if (r?.guestId) {
    const [bg] = await db
      .select({ gender: guests.gender })
      .from(guests)
      .where(eq(guests.id, r.guestId))
      .limit(1);
    gender = bg?.gender ?? null;
  }

  // Co-guests, ordered by position.
  const coGuestRows = await db
    .select({
      fullName: guests.fullName,
      phone: guests.phone,
      gender: guests.gender,
      idProofType: guests.idProofType,
      idProofLast4: guests.idProofLast4,
    })
    .from(reservationCoGuests)
    .innerJoin(guests, eq(guests.id, reservationCoGuests.guestId))
    .where(eq(reservationCoGuests.reservationId, reservationId))
    .orderBy(asc(reservationCoGuests.position));

  return { gender, coGuests: coGuestRows };
}
