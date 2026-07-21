import { describe, expect, it } from "vitest";
import { roomBillableNights, sumRoomAmount } from "./nights.js";

// These tests encode the invariant that repeatedly broke: a room is billed
// for ITS OWN nights, never the whole reservation's span. Each case mirrors a
// real production shape that produced a wrong bill.

const stay = { checkInDate: "2026-07-19", checkOutDate: "2026-07-24" }; // 5 nights

describe("roomBillableNights", () => {
  it("unsegmented room bills the full stay", () => {
    expect(roomBillableNights({}, stay)).toBe(5);
    expect(roomBillableNights({ effectiveFrom: null, effectiveTo: null }, stay)).toBe(5);
  });

  it("a swap leg bills only its segment", () => {
    // Guest in 101 for night 1, swapped to 102 for nights 2-5.
    expect(
      roomBillableNights({ effectiveFrom: "2026-07-19", effectiveTo: "2026-07-20" }, stay),
    ).toBe(1);
    expect(
      roomBillableNights({ effectiveFrom: "2026-07-20", effectiveTo: "2026-07-24" }, stay),
    ).toBe(4);
  });

  it("a mid-stay added room bills only its own window", () => {
    expect(
      roomBillableNights({ effectiveFrom: "2026-07-21", effectiveTo: "2026-07-22" }, stay),
    ).toBe(1);
  });

  it("short-stay rooms are one flat unit regardless of dates", () => {
    expect(
      roomBillableNights(
        { effectiveFrom: null, effectiveTo: null },
        { checkInDate: "2026-07-19", checkOutDate: "2026-07-19", stayType: "short_stay" },
      ),
    ).toBe(1);
  });

  it("never returns less than one night", () => {
    expect(
      roomBillableNights({ effectiveFrom: "2026-07-20", effectiveTo: "2026-07-20" }, stay),
    ).toBe(1);
  });
});

describe("sumRoomAmount", () => {
  it("bills a swapped + added-room stay per segment, not per full stay", () => {
    // The exact RES-0001 shape that shipped a ₹23,500 bill for a ₹9,200 stay.
    const rooms = [
      { ratePerNight: "1700.00", effectiveFrom: "2026-07-19", effectiveTo: "2026-07-20" }, // 101 · 1n
      { ratePerNight: "1500.00", effectiveFrom: "2026-07-20", effectiveTo: "2026-07-24" }, // 102 · 4n
      { ratePerNight: "1500.00", effectiveFrom: "2026-07-21", effectiveTo: "2026-07-22" }, // 104 · 1n
    ];
    // 1700*1 + 1500*4 + 1500*1 = 9200 — NOT 3 rooms × 5 nights = 23500.
    expect(sumRoomAmount(rooms, stay)).toBe(9200);
  });

  it("a plain multi-room booking bills every room for the whole stay", () => {
    const rooms = [{ ratePerNight: 2000 }, { ratePerNight: 1500 }];
    expect(sumRoomAmount(rooms, stay)).toBe((2000 + 1500) * 5);
  });

  it("handles inclusive-mode decimal rates without drift", () => {
    const rooms = [{ ratePerNight: "1499.99", effectiveFrom: null, effectiveTo: null }];
    expect(sumRoomAmount(rooms, stay)).toBe(7499.95);
  });
});
