import { db } from "../db/client.js";
import { nextDocNumber, receiptNumber } from "./numbers.js";

type Db = typeof db;
type Exec = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

// Receipt numbers are per hotel — callers pass the tenant explicitly
// (usually the propertyId of the invoice/reservation being paid).
export async function generateReceiptNumber(exec: Exec, propertyId: string): Promise<string> {
  const seq = await nextDocNumber(exec, propertyId, "receipt");
  return receiptNumber(seq);
}
