import { describe, expect, it } from "vitest";

function overlaps(a1: string, a2: string, b1: string, b2: string) {
  const aStart = new Date(a1).getTime();
  const aEnd = new Date(a2).getTime();
  const bStart = new Date(b1).getTime();
  const bEnd = new Date(b2).getTime();
  return aStart < bEnd && bStart < aEnd;
}

describe("date range overlap (half-open [checkIn, checkOut))", () => {
  it("detects strict overlap", () => {
    expect(overlaps("2026-04-10", "2026-04-15", "2026-04-12", "2026-04-14")).toBe(true);
  });

  it("treats touching back-to-back stays as non-overlapping", () => {
    expect(overlaps("2026-04-10", "2026-04-12", "2026-04-12", "2026-04-14")).toBe(false);
    expect(overlaps("2026-04-12", "2026-04-14", "2026-04-10", "2026-04-12")).toBe(false);
  });

  it("detects partial overlap on the left", () => {
    expect(overlaps("2026-04-10", "2026-04-14", "2026-04-08", "2026-04-11")).toBe(true);
  });

  it("detects partial overlap on the right", () => {
    expect(overlaps("2026-04-10", "2026-04-14", "2026-04-13", "2026-04-20")).toBe(true);
  });

  it("detects fully contained stays", () => {
    expect(overlaps("2026-04-10", "2026-04-20", "2026-04-12", "2026-04-14")).toBe(true);
    expect(overlaps("2026-04-12", "2026-04-14", "2026-04-10", "2026-04-20")).toBe(true);
  });

  it("returns false for stays that are far apart", () => {
    expect(overlaps("2026-04-01", "2026-04-05", "2026-05-01", "2026-05-05")).toBe(false);
  });

  it("returns false for single-night back-to-back turnovers", () => {
    expect(overlaps("2026-04-10", "2026-04-11", "2026-04-11", "2026-04-12")).toBe(false);
  });
});
