import { describe, expect, it } from "vitest";
import { calcGstBreakdown, getGstRate } from "./gst.js";

describe("getGstRate", () => {
  it("returns 0% for rates below ₹1000 (exempt)", () => {
    expect(getGstRate(500)).toBe(0);
    expect(getGstRate(999.99)).toBe(0);
    expect(getGstRate(0)).toBe(0);
  });

  it("returns 5% at the ₹1000 boundary", () => {
    expect(getGstRate(1000)).toBe(5);
    expect(getGstRate(1000.01)).toBe(5);
  });

  it("returns 5% for rates between ₹1000 and ₹7500", () => {
    expect(getGstRate(2500)).toBe(5);
    expect(getGstRate(5000)).toBe(5);
    expect(getGstRate(7500)).toBe(5);
  });

  it("returns 18% above ₹7500", () => {
    expect(getGstRate(7500.01)).toBe(18);
    expect(getGstRate(9999)).toBe(18);
    expect(getGstRate(15000)).toBe(18);
    expect(getGstRate(100000)).toBe(18);
  });

  it("honors custom slabs", () => {
    const custom = { exemptBelow: 500, lowRate: 12, lowMax: 5000, highRate: 28 };
    expect(getGstRate(499, custom)).toBe(0);
    expect(getGstRate(500, custom)).toBe(12);
    expect(getGstRate(5000, custom)).toBe(12);
    expect(getGstRate(5001, custom)).toBe(28);
  });
});

describe("calcGstBreakdown", () => {
  it("splits GST into equal CGST + SGST halves", () => {
    const b = calcGstBreakdown(10000, 18);
    expect(b.gstAmount).toBe(1800);
    expect(b.cgstAmount).toBe(900);
    expect(b.sgstAmount).toBe(900);
    expect(b.cgstRate).toBe(9);
    expect(b.sgstRate).toBe(9);
    expect(b.grandTotal).toBe(11800);
  });

  // Inclusive mode uses simple-percent-of-gross per the owner's decision
  // (not the strict inverse-extraction formula). ₹1000 @ 5% → GST is 5%
  // of 1000 = 50, net = 950. Cleaner round numbers, matches how the
  // owner verbally quotes the bill.
  it("inclusive mode: GST is rate × gross (5% on 1000 → 50)", () => {
    const b = calcGstBreakdown(1000, 5, "inclusive");
    expect(b.grandTotal).toBe(1000);
    expect(b.subtotal).toBe(950);
    expect(b.gstAmount).toBe(50);
    expect(b.cgstAmount).toBe(25);
    expect(b.sgstAmount).toBe(25);
  });

  it("inclusive mode: 18% on 10000 → 1800 GST, 8200 net", () => {
    const b = calcGstBreakdown(10000, 18, "inclusive");
    expect(b.grandTotal).toBe(10000);
    expect(b.subtotal).toBe(8200);
    expect(b.gstAmount).toBe(1800);
  });

  it("inclusive mode at 0% leaves the amount untouched", () => {
    const b = calcGstBreakdown(800, 0, "inclusive");
    expect(b.grandTotal).toBe(800);
    expect(b.subtotal).toBe(800);
    expect(b.gstAmount).toBe(0);
  });

  it("handles zero-rate tariffs", () => {
    const b = calcGstBreakdown(800, 0);
    expect(b.gstAmount).toBe(0);
    expect(b.cgstAmount).toBe(0);
    expect(b.sgstAmount).toBe(0);
    expect(b.grandTotal).toBe(800);
  });

  it("handles 5% slab", () => {
    const b = calcGstBreakdown(2000, 5);
    expect(b.gstAmount).toBe(100);
    expect(b.cgstAmount).toBe(50);
    expect(b.sgstAmount).toBe(50);
    expect(b.grandTotal).toBe(2100);
  });

  it("splits odd-paisa amounts without losing a paisa", () => {
    const b = calcGstBreakdown(123.45, 18);
    expect(b.gstAmount).toBe(22.22);
    expect(b.cgstAmount + b.sgstAmount).toBe(b.gstAmount);
    expect(b.grandTotal).toBe(+(123.45 + 22.22).toFixed(2));
  });

  it("is correct for 3-night stay totals", () => {
    const subtotal = 3 * 1800;
    const b = calcGstBreakdown(subtotal, 5);
    expect(b.gstAmount).toBe(270);
    expect(b.grandTotal).toBe(5670);
  });

  it("is correct for premium suite (18%)", () => {
    const subtotal = 2 * 12000;
    const b = calcGstBreakdown(subtotal, 18);
    expect(b.gstAmount).toBe(4320);
    expect(b.grandTotal).toBe(28320);
  });

  it("compounds across mixed charges correctly", () => {
    const rooms = 5000;
    const extras = 1200;
    const roomGst = calcGstBreakdown(rooms, 5);
    const extrasGst = calcGstBreakdown(extras, 18);
    const totalGst = +(roomGst.gstAmount + extrasGst.gstAmount).toFixed(2);
    const total = +(rooms + extras + totalGst).toFixed(2);
    expect(total).toBe(6666);
  });
});
