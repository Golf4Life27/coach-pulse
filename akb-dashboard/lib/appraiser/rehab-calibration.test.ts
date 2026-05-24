// @agent: appraiser — rehab calibration tests (Phase 4B.1).

import { describe, it, expect } from "vitest";
import {
  BBC_TIERS,
  BBC_ANCHOR_PER_SQFT,
  marketTierForState,
  classifyBbcTierFromCondition,
  classifyBbcTierFromRate,
  applyMarketMultiplier,
  computeRehabRange,
  readMarketMultipliers,
} from "./rehab-calibration";

describe("BBC_ANCHOR_PER_SQFT — Bible v3 §4.2 anchors", () => {
  it("matches the spec rubric exactly", () => {
    expect(BBC_ANCHOR_PER_SQFT.Cosmetic).toBe(15);
    expect(BBC_ANCHOR_PER_SQFT.Light).toBe(22);
    expect(BBC_ANCHOR_PER_SQFT.Medium).toBe(30);
    expect(BBC_ANCHOR_PER_SQFT.Heavy).toBe(50);
    expect(BBC_ANCHOR_PER_SQFT.Gut).toBe(70);
  });
  it("exposes the canonical tier list", () => {
    expect(BBC_TIERS).toEqual(["Cosmetic", "Light", "Medium", "Heavy", "Gut"]);
  });
});

describe("marketTierForState", () => {
  it("maps TX to TX-Metro", () => {
    expect(marketTierForState("TX")).toBe("TX-Metro");
    expect(marketTierForState("tx")).toBe("TX-Metro");
    expect(marketTierForState(" TX ")).toBe("TX-Metro");
  });
  it("maps TN to TN-Distressed", () => {
    expect(marketTierForState("TN")).toBe("TN-Distressed");
  });
  it("maps MI to MI-Distressed", () => {
    expect(marketTierForState("MI")).toBe("MI-Distressed");
  });
  it("falls back to Conservative-Default for anything else", () => {
    expect(marketTierForState("CA")).toBe("Conservative-Default");
    expect(marketTierForState("FL")).toBe("Conservative-Default");
    expect(marketTierForState(null)).toBe("Conservative-Default");
    expect(marketTierForState(undefined)).toBe("Conservative-Default");
    expect(marketTierForState("")).toBe("Conservative-Default");
  });
});

describe("classifyBbcTierFromCondition", () => {
  it("maps the vision Condition labels to BBC tiers", () => {
    expect(classifyBbcTierFromCondition("Good")).toBe("Cosmetic");
    expect(classifyBbcTierFromCondition("Average")).toBe("Light");
    expect(classifyBbcTierFromCondition("Fair")).toBe("Medium");
    expect(classifyBbcTierFromCondition("Poor")).toBe("Heavy");
    expect(classifyBbcTierFromCondition("Disrepair")).toBe("Gut");
  });
  it("is case + whitespace tolerant", () => {
    expect(classifyBbcTierFromCondition(" disrepair ")).toBe("Gut");
    expect(classifyBbcTierFromCondition("POOR")).toBe("Heavy");
  });
  it("defaults unknown/null to Medium (conservative middle)", () => {
    expect(classifyBbcTierFromCondition(null)).toBe("Medium");
    expect(classifyBbcTierFromCondition(undefined)).toBe("Medium");
    expect(classifyBbcTierFromCondition("Mystery")).toBe("Medium");
    expect(classifyBbcTierFromCondition("")).toBe("Medium");
  });
});

describe("classifyBbcTierFromRate", () => {
  it("classifies at the anchor rates", () => {
    expect(classifyBbcTierFromRate(15)).toBe("Cosmetic");
    expect(classifyBbcTierFromRate(22)).toBe("Light");
    expect(classifyBbcTierFromRate(30)).toBe("Medium");
    expect(classifyBbcTierFromRate(50)).toBe("Heavy");
    expect(classifyBbcTierFromRate(70)).toBe("Gut");
  });
  it("uses midpoint thresholds for in-between rates", () => {
    // Cosmetic/Light midpoint = 18.5
    expect(classifyBbcTierFromRate(18.4)).toBe("Cosmetic");
    expect(classifyBbcTierFromRate(18.5)).toBe("Light");
    // Light/Medium midpoint = 26
    expect(classifyBbcTierFromRate(25.9)).toBe("Light");
    expect(classifyBbcTierFromRate(26)).toBe("Medium");
    // Medium/Heavy midpoint = 40
    expect(classifyBbcTierFromRate(39.9)).toBe("Medium");
    expect(classifyBbcTierFromRate(40)).toBe("Heavy");
    // Heavy/Gut midpoint = 60
    expect(classifyBbcTierFromRate(59.9)).toBe("Heavy");
    expect(classifyBbcTierFromRate(60)).toBe("Gut");
  });
  it("clamps high rates to Gut", () => {
    expect(classifyBbcTierFromRate(200)).toBe("Gut");
  });
  it("defaults null/zero/negative/non-finite to Cosmetic (lowest)", () => {
    expect(classifyBbcTierFromRate(null)).toBe("Cosmetic");
    expect(classifyBbcTierFromRate(undefined)).toBe("Cosmetic");
    expect(classifyBbcTierFromRate(0)).toBe("Cosmetic");
    expect(classifyBbcTierFromRate(-10)).toBe("Cosmetic");
    expect(classifyBbcTierFromRate(NaN)).toBe("Cosmetic");
    expect(classifyBbcTierFromRate(Infinity)).toBe("Cosmetic"); // non-finite guard
  });
});

describe("readMarketMultipliers", () => {
  it("returns documented defaults when env is empty", () => {
    const r = readMarketMultipliers({});
    expect(r["TX-Metro"]).toBe(1.0);
    expect(r["TN-Distressed"]).toBe(0.9);
    expect(r["MI-Distressed"]).toBe(0.85);
    expect(r["Conservative-Default"]).toBe(1.1);
  });
  it("honors env overrides when set", () => {
    const r = readMarketMultipliers({
      REHAB_MULT_TX_METRO: "1.05",
      REHAB_MULT_TN_DISTRESSED: "0.95",
    });
    expect(r["TX-Metro"]).toBe(1.05);
    expect(r["TN-Distressed"]).toBe(0.95);
    expect(r["MI-Distressed"]).toBe(0.85); // unchanged
  });
  it("ignores invalid env values (non-numeric, zero, negative)", () => {
    const r = readMarketMultipliers({
      REHAB_MULT_TX_METRO: "notanumber",
      REHAB_MULT_TN_DISTRESSED: "0",
      REHAB_MULT_MI_DISTRESSED: "-1",
    });
    expect(r["TX-Metro"]).toBe(1.0);
    expect(r["TN-Distressed"]).toBe(0.9);
    expect(r["MI-Distressed"]).toBe(0.85);
  });
});

describe("applyMarketMultiplier", () => {
  it("multiplies the base rate by the state's market tier multiplier", () => {
    expect(applyMarketMultiplier("TX", 30).rate).toBe(30);
    expect(applyMarketMultiplier("TN", 30).rate).toBe(27); // 30 × 0.9
    expect(applyMarketMultiplier("MI", 30).rate).toBe(25.5); // 30 × 0.85
    expect(applyMarketMultiplier("CA", 30).rate).toBe(33); // 30 × 1.1
  });
  it("returns the resolved market tier + multiplier alongside the rate", () => {
    const r = applyMarketMultiplier("TN", 50);
    expect(r.tier).toBe("TN-Distressed");
    expect(r.multiplier).toBe(0.9);
    expect(r.rate).toBe(45);
  });
});

describe("computeRehabRange — validation fixtures", () => {
  it("SA 1500sqft Medium → $45K mid (TX-Metro ×1.0)", () => {
    const r = computeRehabRange({ sqft: 1500, bbcTier: "Medium", state: "TX" });
    expect(r.rehab_mid).toBe(45_000); // 30 × 1.0 × 1500
    expect(r.market_tier).toBe("TX-Metro");
    expect(r.market_multiplier).toBe(1.0);
    expect(r.anchor_per_sqft).toBe(30);
    expect(r.calibrated_rate_per_sqft).toBe(30);
  });

  it("Memphis 1500sqft Heavy → $67500 mid (TN-Distressed ×0.9)", () => {
    const r = computeRehabRange({ sqft: 1500, bbcTier: "Heavy", state: "TN" });
    expect(r.rehab_mid).toBe(67_500); // 50 × 0.9 × 1500
    expect(r.market_tier).toBe("TN-Distressed");
    expect(r.market_multiplier).toBe(0.9);
    expect(r.calibrated_rate_per_sqft).toBe(45);
  });

  it("Detroit 1500sqft Gut → $89250 mid (MI-Distressed ×0.85)", () => {
    const r = computeRehabRange({ sqft: 1500, bbcTier: "Gut", state: "MI" });
    expect(r.rehab_mid).toBe(89_250); // 70 × 0.85 × 1500
    expect(r.market_tier).toBe("MI-Distressed");
    expect(r.market_multiplier).toBe(0.85);
    expect(r.calibrated_rate_per_sqft).toBe(59.5);
  });

  it("1219 E Highland Blvd cross-check — SA 1500sqft Medium → $45K rehab (feeds Phase 4A.1 $90K MAO)", () => {
    // The Phase 4A.1 anchor: 1219 E Highland (SA, 78210) with $60K rehab
    // gives $90K floor against $165K ARV. Phase 4B.1 with Medium tier
    // would give $45K rehab — different by $15K because the original
    // anchor used a Heavy-ish estimate. Validation here pins the
    // calibrated value so any drift surfaces.
    const r = computeRehabRange({ sqft: 1500, bbcTier: "Medium", state: "TX" });
    expect(r.rehab_mid).toBe(45_000);
    // Same property tier-promoted to Heavy:
    const heavy = computeRehabRange({ sqft: 1500, bbcTier: "Heavy", state: "TX" });
    expect(heavy.rehab_mid).toBe(75_000); // closer to the Phase 4A.1 $60K anchor
  });

  it("anywhere else 1500sqft Medium → $49500 mid (Conservative-Default ×1.1)", () => {
    const r = computeRehabRange({ sqft: 1500, bbcTier: "Medium", state: "CA" });
    expect(r.rehab_mid).toBe(49_500); // 30 × 1.1 × 1500
    expect(r.market_tier).toBe("Conservative-Default");
  });

  it("returns null mid/low/high when sqft is null", () => {
    const r = computeRehabRange({ sqft: null, bbcTier: "Medium", state: "TX" });
    expect(r.rehab_mid).toBeNull();
    expect(r.rehab_low).toBeNull();
    expect(r.rehab_high).toBeNull();
    // Calibration metadata still surfaced:
    expect(r.market_tier).toBe("TX-Metro");
    expect(r.calibrated_rate_per_sqft).toBe(30);
  });

  it("returns null mid/low/high when sqft is zero or negative", () => {
    expect(computeRehabRange({ sqft: 0, bbcTier: "Medium", state: "TX" }).rehab_mid).toBeNull();
    expect(computeRehabRange({ sqft: -100, bbcTier: "Medium", state: "TX" }).rehab_mid).toBeNull();
  });
});

describe("computeRehabRange — confidence band", () => {
  it("defaults band to 0.80 low / 1.30 high (matches rehab_rates.json default_low_pct/high_pct)", () => {
    const r = computeRehabRange({ sqft: 1000, bbcTier: "Medium", state: "TX" });
    expect(r.rehab_mid).toBe(30_000);
    expect(r.rehab_low).toBe(24_000); // 30000 × 0.80
    expect(r.rehab_high).toBe(39_000); // 30000 × 1.30
  });
  it("accepts caller-tightened band (e.g. high-confidence runs)", () => {
    const r = computeRehabRange({
      sqft: 1000,
      bbcTier: "Medium",
      state: "TX",
      bandLowFraction: 0.9,
      bandHighFraction: 1.15,
    });
    expect(r.rehab_low).toBe(27_000); // 30000 × 0.90
    expect(r.rehab_high).toBe(34_500); // 30000 × 1.15
  });
});

describe("computeRehabRange — env-override multipliers", () => {
  it("uses caller-supplied multipliers when provided", () => {
    const r = computeRehabRange({
      sqft: 1500,
      bbcTier: "Medium",
      state: "TX",
      multipliers: {
        "TX-Metro": 1.05,
        "TN-Distressed": 0.9,
        "MI-Distressed": 0.85,
        "Conservative-Default": 1.1,
      },
    });
    expect(r.rehab_mid).toBe(47_250); // 30 × 1.05 × 1500
    expect(r.market_multiplier).toBe(1.05);
  });
});
