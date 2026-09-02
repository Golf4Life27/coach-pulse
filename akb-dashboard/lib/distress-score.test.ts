// Distress score (+ A1 spread-term drop) — unit tests.

import { describe, it, expect } from "vitest";
import { computeDistressScore } from "./distress-score";

describe("computeDistressScore", () => {
  it("default (spread ON) reproduces the live formula — fresh high-list scores High via spread", () => {
    // 4357 W Philadelphia: List 189,900, MAO 123,500 (0.65×list), DOM 6, 0 drops.
    const r = computeDistressScore({ dom: 6, priceDrops: 0, listPrice: 189900, mao: 123500 });
    // 6/30 + 0 + (189,900−123,500)/10,000 = 0.2 + 6.64 = 6.84 → High.
    expect(r.score).toBe(6.84);
    expect(r.bucket).toBe("High");
    expect(r.pass).toBe(true);
  });

  it("A1 (spread OFF) drops the same fresh listing to Low — distress fails", () => {
    const r = computeDistressScore({ dom: 6, priceDrops: 0, listPrice: 189900, mao: 123500, dropSpreadTerm: true });
    expect(r.score).toBe(0.2); // 6/30 only
    expect(r.bucket).toBe("Low");
    expect(r.pass).toBe(false);
  });

  it("A1 keeps a genuinely-aged listing (DOM ≥ 90) — distress passes on aging alone", () => {
    // 13004 Wilfred: DOM 262.
    const r = computeDistressScore({ dom: 262, priceDrops: 0, listPrice: 77000, mao: 50000, dropSpreadTerm: true });
    expect(r.score).toBe(8.73); // 262/30
    expect(r.bucket).toBe("High");
    expect(r.pass).toBe(true);
  });

  it("A1 keeps a price-dropped listing even when fresh (drops drive distress)", () => {
    const r = computeDistressScore({ dom: 10, priceDrops: 2, listPrice: 120000, mao: 78000, dropSpreadTerm: true });
    expect(r.score).toBe(4.33); // 10/30 + 2*2 = 0.33 + 4
    expect(r.pass).toBe(true);
  });

  it("BLANK guard: DOM 0 (listed today) → null score, regardless of spread", () => {
    expect(computeDistressScore({ dom: 0, priceDrops: 0, listPrice: 200000, mao: 100000 }).score).toBeNull();
    expect(computeDistressScore({ dom: null, priceDrops: 0, listPrice: 200000, mao: 100000 }).pass).toBe(false);
  });

  it("spread term ignores a null MAO (no spurious distress from a missing opener)", () => {
    const r = computeDistressScore({ dom: 30, priceDrops: 0, listPrice: 200000, mao: null });
    expect(r.score).toBe(1); // 30/30 only — spread term needs both List and MAO
    expect(r.pass).toBe(false);
  });
});
