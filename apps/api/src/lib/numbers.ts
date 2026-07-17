const fmt4 = (n: number) => String(n).padStart(4, "0");

export function reservationNumber(seq: number) {
  return `SLDT-RES-${fmt4(seq)}`;
}

export function invoiceNumber(_prefix: string, seq: number) {
  // _prefix kept for back-compat with callers that pass settings.invoicePrefix
  return `SLDT-INV-${fmt4(seq)}`;
}

export function receiptNumber(seq: number) {
  return `SLDT-RCP-${fmt4(seq)}`;
}

export function creditNoteNumber(seq: number) {
  return `SLDT-CN-${fmt4(seq)}`;
}
