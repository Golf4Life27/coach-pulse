import { describe, it, expect } from "vitest";
import { anchoredOpenerGate } from "./your-mao-opener-gate";

// Opener caps on the ROUGH OPENER CEILING (lib/rough-opener-ceiling),
// anchored by the per-market anchor. Keystone 2026-06-13, Flag-2.

describe("anchoredOpenerGate — Detroit launch shape (anchor 0.90)", () => {
  it("opener = round(anchor × rough ceiling)", () => {
    const r = anchoredOpenerGate({ ceiling: 27_261, anchorPct: 0.90, priceable: true });
    expect(r.ok).toBe(true);
    expect(r.opener).toBe(24_535); // Rosemary rough ceiling × 0.90
    expect(r.reason).toBe("ok");
  });
  it("Frisbee rough ceiling 76,298 × 0.90 = 68,668", () => {
    expect(anchoredOpenerGate({ ceiling: 76_298, anchorPct: 0.90, priceable: true }).opener).toBe(68_668);
  });
});

describe("HARD GATE — ceiling null/≤0", () => {
  it("null ceiling → ceiling_missing, refused", () => {
    const r = anchoredOpenerGate({ ceiling: null, anchorPct: 0.90, priceable: true });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("ceiling_missing");
    expect(r.opener).toBeNull();
  });
  it("undefined ceiling → refused", () => {
    expect(anchoredOpenerGate({ ceiling: undefined, anchorPct: 0.90, priceable: true }).ok).toBe(false);
  });
  it("ceiling 0 → ceiling_non_penciling", () => {
    const r = anchoredOpenerGate({ ceiling: 0, anchorPct: 0.90, priceable: true });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("ceiling_non_penciling");
  });
  it("ceiling < 0 → ceiling_non_penciling", () => {
    const r = anchoredOpenerGate({ ceiling: -500, anchorPct: 0.90, priceable: true });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("ceiling_non_penciling");
  });
});

describe("market gate + anchor validity", () => {
  it("unpriceable market → market_not_priceable (checked before ceiling)", () => {
    const r = anchoredOpenerGate({ ceiling: null, anchorPct: 1.00, priceable: false });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("market_not_priceable");
  });
  it("invalid anchor → anchor_invalid, refusing to send blind", () => {
    const r = anchoredOpenerGate({ ceiling: 30_000, anchorPct: null, priceable: true });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("anchor_invalid");
  });
});
