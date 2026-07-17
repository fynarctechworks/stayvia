export interface GstSlabs {
  exemptBelow: number;
  lowRate: number;
  lowMax: number;
  highRate: number;
}

export const DEFAULT_SLABS: GstSlabs = {
  exemptBelow: 1000,
  lowRate: 5,
  lowMax: 7500,
  highRate: 18,
};

export function getGstRate(ratePerNight: number, slabs: GstSlabs = DEFAULT_SLABS): number {
  if (ratePerNight < slabs.exemptBelow) return 0;
  if (ratePerNight <= slabs.lowMax) return slabs.lowRate;
  return slabs.highRate;
}

export type GstMode = "exclusive" | "inclusive";

// Compute the GST breakdown given an `amount` and a `mode`.
//
// In 'exclusive' mode (legacy):
//   amount is the NET subtotal. GST is added on top.
//   ₹1000 @ 5% → subtotal 1000, gst 50, grand 1050.
//
// In 'inclusive' mode (simple-percentage-of-gross, per owner decision):
//   amount is the GROSS price the guest pays. GST is computed as
//   gstRate % OF the gross (not extracted via inverse formula). The
//   subtotal is whatever is left after that GST is set aside.
//   ₹1000 @ 5% → grand 1000, gst 50, subtotal 950.
//
//   This is mathematically simpler (round numbers, no rounding drift
//   between net+gst and grand) and matches how the owner verbally quotes
//   the bill. NB: strict GST law expects net = grand / (1 + r/100); we
//   diverge from that on purpose so the invoice reads cleanly.
//
// Callers should treat `subtotal` as the net (what to store in
// reservations.subtotal / invoice line-item amount fields) and
// `grandTotal` as what the guest actually pays.
export function calcGstBreakdown(amount: number, gstRate: number, mode: GstMode = "exclusive") {
  const r = gstRate / 100;
  let subtotal: number;
  let grandTotal: number;
  let gstAmount: number;

  if (mode === "inclusive") {
    grandTotal = +amount.toFixed(2);
    gstAmount = +(grandTotal * r).toFixed(2);
    subtotal = +(grandTotal - gstAmount).toFixed(2);
  } else {
    subtotal = +amount.toFixed(2);
    gstAmount = +(subtotal * r).toFixed(2);
    grandTotal = +(subtotal + gstAmount).toFixed(2);
  }

  const cgstAmount = +(gstAmount / 2).toFixed(2);
  const sgstAmount = +(gstAmount - cgstAmount).toFixed(2);
  return {
    subtotal,
    gstAmount,
    cgstRate: gstRate / 2,
    sgstRate: gstRate / 2,
    cgstAmount,
    sgstAmount,
    grandTotal,
  };
}
