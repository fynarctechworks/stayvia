import { eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { guestLedger, type LedgerEntryType } from "../db/schema/guestLedger.js";
import { guests } from "../db/schema/guests.js";

type Db = typeof db;
type Exec = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

export async function getGuestBalance(guestId: string, exec: Exec = db): Promise<number> {
  const rows = await exec
    .select({
      balance: sql<string>`
        COALESCE(SUM(CASE
          WHEN ${guestLedger.entryType} IN ('credit_issued','adjustment') THEN ${guestLedger.amount}::numeric
          WHEN ${guestLedger.entryType} IN ('credit_used','cashout') THEN -${guestLedger.amount}::numeric
          ELSE 0
        END), 0)::text
      `,
    })
    .from(guestLedger)
    .where(eq(guestLedger.guestId, guestId));
  return Number(rows[0]?.balance ?? "0");
}

export async function addLedgerEntry(input: {
  guestId: string;
  entryType: LedgerEntryType;
  amount: number;
  // The hotel the entry belongs to. Optional convenience: when omitted it
  // is derived from the guest row (the guest pins the tenant) — pass it
  // when the caller already has it to save the lookup.
  propertyId?: string;
  reservationId?: string | null;
  invoiceId?: string | null;
  paymentId?: string | null;
  note?: string | null;
  createdBy?: string | null;
  tx?: typeof db;
}) {
  const exec = input.tx ?? db;
  let propertyId = input.propertyId;
  if (!propertyId) {
    const [guest] = await exec
      .select({ propertyId: guests.propertyId })
      .from(guests)
      .where(eq(guests.id, input.guestId))
      .limit(1);
    if (!guest) throw new Error(`Guest ${input.guestId} not found for ledger entry`);
    propertyId = guest.propertyId;
  }
  const [row] = await exec
    .insert(guestLedger)
    .values({
      guestId: input.guestId,
      propertyId,
      entryType: input.entryType,
      amount: String(input.amount.toFixed(2)),
      reservationId: input.reservationId ?? null,
      invoiceId: input.invoiceId ?? null,
      paymentId: input.paymentId ?? null,
      note: input.note ?? null,
      createdBy: input.createdBy ?? null,
    })
    .returning();
  return row!;
}
