import { describe, expect, it } from "vitest";
import { calcGstBreakdown } from "./gst.js";

interface LineItem {
  quantity: number;
  rate: number;
  gstRate: number;
}

function totalInvoice(lines: LineItem[]) {
  let subtotal = 0;
  let gst = 0;
  for (const l of lines) {
    const amount = l.quantity * l.rate;
    const b = calcGstBreakdown(amount, l.gstRate);
    subtotal += amount;
    gst += b.gstAmount;
  }
  subtotal = +subtotal.toFixed(2);
  gst = +gst.toFixed(2);
  const cgst = +(gst / 2).toFixed(2);
  const sgst = +(gst - cgst).toFixed(2);
  return { subtotal, cgst, sgst, grandTotal: +(subtotal + gst).toFixed(2) };
}

describe("invoice totals", () => {
  it("computes 2-night room-only stay at 5%", () => {
    const t = totalInvoice([{ quantity: 2, rate: 1800, gstRate: 5 }]);
    expect(t.subtotal).toBe(3600);
    expect(t.cgst + t.sgst).toBe(180);
    expect(t.grandTotal).toBe(3780);
  });

  it("computes 3-night suite stay at 18%", () => {
    const t = totalInvoice([{ quantity: 3, rate: 9000, gstRate: 18 }]);
    expect(t.subtotal).toBe(27000);
    expect(t.cgst + t.sgst).toBe(4860);
    expect(t.grandTotal).toBe(31860);
  });

  it("combines room charges + extras with different GST rates", () => {
    const t = totalInvoice([
      { quantity: 2, rate: 5000, gstRate: 5 },
      { quantity: 1, rate: 800, gstRate: 18 },
      { quantity: 2, rate: 250, gstRate: 18 },
    ]);
    expect(t.subtotal).toBe(11300);
    expect(t.grandTotal).toBeCloseTo(11300 + 500 + 144 + 90, 2);
  });

  it("respects zero-GST exempt stays", () => {
    const t = totalInvoice([{ quantity: 5, rate: 800, gstRate: 0 }]);
    expect(t.subtotal).toBe(4000);
    expect(t.cgst).toBe(0);
    expect(t.sgst).toBe(0);
    expect(t.grandTotal).toBe(4000);
  });

  it("handles balance-due calculation", () => {
    const t = totalInvoice([{ quantity: 2, rate: 1800, gstRate: 5 }]);
    const advance = 1000;
    const balance = +(t.grandTotal - advance).toFixed(2);
    expect(balance).toBe(2780);
  });
});
