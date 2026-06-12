import { describe, it, expect } from "vitest";
import { computeFlipperMax } from "./flipper-lane";
import { computeInvestorMao, computeYourMao, DEFAULT_WHOLESALE_FEE } from "./pre-contract-math";

describe("computeFlipperMax — Tier C (buyer Min_Deal_Spread, dollars)", () => {
  it("ARV $150k − spread $40k → flipperValue $110k", () => {
    const r = computeFlipperMax({ arv: 150_000, margin: { kind: "buyer_min_deal_spread", dollars: 40_000 } });
    expect(r.status).toBe("ok");
    expect(r.flipperValue).toBe(110_000);
    expect(r.marginDollars).toBe(40_000);
  });
  it("end-to-end through the SAME landlord-lane math: − rehab − fee", () => {
    const r = computeFlipperMax({ arv: 150_000, margin: { kind: "buyer_min_deal_spread", dollars: 40_000 } });
    const investorMao = computeInvestorMao(r.flipperValue, 35_000);
    const yourMao = computeYourMao(investorMao, DEFAULT_WHOLESALE_FEE);
    expect(investorMao).toBe(75_000);
    expect(yourMao).toBe(70_000);
  });
});

describe("computeFlipperMax — Tier B (market arv_pct_max, fraction)", () => {
  it("Detroit 0.6461: ARV $150k → flipperValue = ARV × 0.6461", () => {
    const r = computeFlipperMax({ arv: 150_000, margin: { kind: "market_arv_pct_max", arvPctMax: 0.6461 } });
    expect(r.status).toBe("ok");
    // margin = 150000 × (1 − 0.6461) = 53085; flipperValue = 96915
    expect(r.marginDollars).toBe(53_085);
    expect(r.flipperValue).toBe(96_915);
  });
});

describe("HOLD discipline — no fabricated inputs", () => {
  it("null ARV → HOLD with explicit reason", () => {
    const r = computeFlipperMax({ arv: null, margin: { kind: "buyer_min_deal_spread", dollars: 40_000 } });
    expect(r.status).toBe("hold");
    expect(r.missing).toContain("arv");
    expect(r.flipperValue).toBeNull();
  });
  it("null margin → HOLD (no per-market / per-buyer-type defaults, ever)", () => {
    const r = computeFlipperMax({ arv: 150_000, margin: null });
    expect(r.status).toBe("hold");
    expect(r.missing).toContain("margin");
  });
  it("zero/negative spread → HOLD", () => {
    expect(computeFlipperMax({ arv: 150_000, margin: { kind: "buyer_min_deal_spread", dollars: 0 } }).status).toBe("hold");
    expect(computeFlipperMax({ arv: 150_000, margin: { kind: "buyer_min_deal_spread", dollars: -5 } }).status).toBe("hold");
  });
  it("arv_pct_max outside (0,1) → HOLD (corrupt registry row, not full-ARV buyer)", () => {
    expect(computeFlipperMax({ arv: 150_000, margin: { kind: "market_arv_pct_max", arvPctMax: 0 } }).status).toBe("hold");
    expect(computeFlipperMax({ arv: 150_000, margin: { kind: "market_arv_pct_max", arvPctMax: 1 } }).status).toBe("hold");
    expect(computeFlipperMax({ arv: 150_000, margin: { kind: "market_arv_pct_max", arvPctMax: 1.2 } }).status).toBe("hold");
  });
  it("margin ≥ ARV → HOLD, never a zero/negative buyer max", () => {
    const r = computeFlipperMax({ arv: 50_000, margin: { kind: "buyer_min_deal_spread", dollars: 60_000 } });
    expect(r.status).toBe("hold");
    expect(r.reason).toContain("no positive buyer max");
  });
});
