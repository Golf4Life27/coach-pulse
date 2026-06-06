// @agent: orchestrator — market-agnostic deal-math engine tests.
import { describe, it, expect } from "vitest";
import { evaluateDeal, evaluateCriteria } from "./deal-math";
import { listMarkets } from "./registry";
import type { Market } from "./registry";

// Detroit V1 row but with arv_source_verified flipped on, so we can test
// the math layer in isolation from the gate-on-source-verification.
const detroitLive = (() => {
  const det = listMarkets().find((m) => m.id === "detroit_mi")!;
  return { ...det, arv_source_verified: true };
})();

// Detroit with a tighter buy-box (for criteria tests).
const detroitWithCriteria: Market = {
  ...detroitLive,
  buyer_params: {
    arv_pct_max: 0.6461,
    max_rehab_usd: 68537,
    max_price_usd: 150000,
    criteria: {
      beds_min: 3,
      baths_min: 1,
      year_built_min: 1900,
      sqft_min: 800,
      sqft_max: 2500,
      property_types_allowed: ["sfr", "single family"],
    },
  },
};

describe("evaluateDeal — single formula, market-agnostic", () => {
  it("PASS — MAO = ARV × 64.61% − rehab − $5k fee; ≥ list", () => {
    // ARV $200k → 64.61% = 129,220. Rehab $30k. Fee $5k. MAO = 94,220.
    // List $90,000 → spread +$4,220 → PASS.
    const r = evaluateDeal({ arv: 200000, rehab: 30000, listPrice: 90000 }, detroitLive);
    expect(r.status).toBe("pass");
    expect(r.mao).toBe(94220);
    expect(r.spread).toBe(4220);
    expect(r.used.arv_pct_max).toBe(0.6461);
    expect(r.used.pricing_basis).toBe("list_price");
  });

  it("BLOCK on negative spread (math decisive)", () => {
    // Same MAO ~$94k, but list $120k → spread −$25,780 → BLOCK.
    const r = evaluateDeal({ arv: 200000, rehab: 30000, listPrice: 120000 }, detroitLive);
    expect(r.status).toBe("block");
    expect(r.gates.spread.ok).toBe(false);
  });

  it("BLOCK on rehab over Detroit max ($68,537)", () => {
    const r = evaluateDeal({ arv: 300000, rehab: 70000, listPrice: 50000 }, detroitLive);
    expect(r.status).toBe("block");
    expect(r.gates.rehab.ok).toBe(false);
  });

  it("BLOCK on price over Max_Price (when configured)", () => {
    const r = evaluateDeal({ arv: 400000, rehab: 30000, listPrice: 200000 }, detroitWithCriteria);
    expect(r.status).toBe("block");
    expect(r.gates.price.ok).toBe(false);
  });

  it("HOLD when ARV missing — never compute on guesses", () => {
    const r = evaluateDeal({ arv: null, rehab: 30000, listPrice: 90000 }, detroitLive);
    expect(r.status).toBe("hold");
    expect(r.mao).toBeNull();
    expect(r.reason).toContain("arv");
  });

  it("HOLD when rehab missing", () => {
    const r = evaluateDeal({ arv: 200000, rehab: null, listPrice: 90000 }, detroitLive);
    expect(r.status).toBe("hold");
  });

  it("HOLD when both list AND contract missing", () => {
    const r = evaluateDeal({ arv: 200000, rehab: 30000, listPrice: null }, detroitLive);
    expect(r.status).toBe("hold");
  });

  it("contract_price wins over list_price when both present (it IS the deal price)", () => {
    const r = evaluateDeal(
      { arv: 200000, rehab: 30000, listPrice: 50000, contractPrice: 60000 },
      detroitLive,
    );
    expect(r.used.pricing_basis).toBe("contract_price");
    expect(r.pricingFloor).toBe(60000);
  });

  it("HOLD when market is not live (Detroit before arv_source_verified)", () => {
    const detroitFromConfig = listMarkets().find((m) => m.id === "detroit_mi")!;
    const r = evaluateDeal({ arv: 200000, rehab: 30000, listPrice: 90000 }, detroitFromConfig);
    expect(r.status).toBe("hold");
    expect(r.reason).toContain("arv_source_verified");
  });

  it("HOLD when no market resolved (null)", () => {
    const r = evaluateDeal({ arv: 200000, rehab: 30000, listPrice: 90000 }, null);
    expect(r.status).toBe("hold");
    expect(r.gates.market_live.ok).toBe(false);
  });

  it("HOLD when buyer_params_present is false (dormant placeholder)", () => {
    const memphis = listMarkets().find((m) => m.id === "memphis_tn")!;
    const r = evaluateDeal({ arv: 200000, rehab: 30000, listPrice: 90000 }, memphis);
    expect(r.status).toBe("hold");
  });

  it("HOLD on restricted state (sourcing_allowed structurally false)", () => {
    // Forge an IL market — the registry-frozen state would already say
    // sourcing_allowed:false; this confirms the engine refuses to compute.
    const il: Market = {
      ...detroitLive,
      id: "chicago_il",
      state: "IL",
      sourcing_allowed: false,
    };
    const r = evaluateDeal({ arv: 200000, rehab: 30000, listPrice: 90000 }, il);
    expect(r.status).toBe("hold");
    expect(r.reason).toContain("sourcing_allowed");
  });

  it("wholesale fee override is respected", () => {
    // ARV 200k × 64.61% = 129,220. Rehab 30k. Fee override 10k. MAO=89,220.
    const r = evaluateDeal({ arv: 200000, rehab: 30000, listPrice: 80000, wholesaleFee: 10000 }, detroitLive);
    expect(r.mao).toBe(89220);
  });
});

describe("criteria gates", () => {
  it("PASS when subject fits all criteria", () => {
    const r = evaluateDeal(
      { arv: 200000, rehab: 30000, listPrice: 80000, beds: 3, baths: 2, yearBuilt: 1955, sqft: 1200, propertyType: "Single Family" },
      detroitWithCriteria,
    );
    expect(r.gates.criteria.ok).toBe(true);
    expect(r.status).toBe("pass");
  });

  it("BLOCK on beds below min", () => {
    const r = evaluateDeal(
      { arv: 200000, rehab: 30000, listPrice: 80000, beds: 2, baths: 2, yearBuilt: 1955, sqft: 1200, propertyType: "Single Family" },
      detroitWithCriteria,
    );
    expect(r.gates.criteria.ok).toBe(false);
    expect(r.status).toBe("block");
  });

  it("BLOCK on sqft above max", () => {
    const r = evaluateDeal(
      { arv: 200000, rehab: 30000, listPrice: 80000, beds: 3, baths: 2, yearBuilt: 1955, sqft: 3000, propertyType: "Single Family" },
      detroitWithCriteria,
    );
    expect(r.gates.criteria.ok).toBe(false);
  });

  it("BLOCK on disallowed property type", () => {
    const r = evaluateDeal(
      { arv: 200000, rehab: 30000, listPrice: 80000, beds: 3, baths: 2, yearBuilt: 1955, sqft: 1200, propertyType: "Multi Family" },
      detroitWithCriteria,
    );
    expect(r.gates.criteria.ok).toBe(false);
  });

  it("HOLD when a constrained criterion's input is null (insufficient info, not a hard fail)", () => {
    const r = evaluateDeal(
      { arv: 200000, rehab: 30000, listPrice: 80000, beds: null, baths: 2, yearBuilt: 1955, sqft: 1200, propertyType: "Single Family" },
      detroitWithCriteria,
    );
    // criteria gate fails but the failure is "input null", which surfaces as HOLD not BLOCK.
    expect(r.status).toBe("hold");
  });

  it("PASS when criteria object has no constraints (all null)", () => {
    // Detroit default (no criteria from JSON yet) — all null → trivially pass.
    const r = evaluateCriteria({ arv: 200000, rehab: 30000, listPrice: 80000 }, detroitLive);
    expect(r.ok).toBe(true);
  });
});
