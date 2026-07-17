import { db } from "../db/client.js";
import { nextReceiptSequence } from "./availability.js";
import { receiptNumber } from "./numbers.js";

type Db = typeof db;
type Exec = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

export async function generateReceiptNumber(exec: Exec = db): Promise<string> {
  const seq = await nextReceiptSequence("SLDT-RCP-%", exec);
  return receiptNumber(seq);
}
