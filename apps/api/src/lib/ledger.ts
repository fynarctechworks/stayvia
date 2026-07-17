import { eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { guestLedger, type LedgerEntryType } from "../db/schema/guestLedger.js";

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
  reservationId?: string | null;
  invoiceId?: string | null;
  paymentId?: string | null;
  note?: string | null;
  createdBy?: string | null;
  tx?: typeof db;
}) {
  const exec = input.tx ?? db;
  const [row] = await exec
    .insert(guestLedger)
    .values({
      guestId: input.guestId,
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
