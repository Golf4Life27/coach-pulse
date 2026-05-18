// Phase 4D / L.3 — BroCard pricing classifier tests.
//
// Pure-function tests for classifyBroCardPricing. Covers the four
// render-mode states the BroCard surface ships (flipper-dominant,
// landlord-dominant, legacy-only, no-math-yet) plus the v1.3 envelope
// shape (soft ceiling, exceeds_soft_ceiling, dual_track bubble,
// rehab_source badge gate). Validation anchors:
//
//   - 1219 E Highland Blvd 78210 (canonical Phase 4 fixture): $165K
//     ARV + $60K rehab + $1400/mo rent at TX 8% cap → landlord $135K
//     beats flipper $90K, exceeds soft ceiling at 75% of $163K list.
//   - K.1 flipper-dominant SA fixture (high ARV, low rent).
//   - Memphis landlord-dominant (TN 10% cap rate).
//   - Detroit landlord-strongly-dominant (MI 9% cap rate).
//
// Posture per the codebase rule (vitest.config.ts): pure-function unit
// tests only — no React / JSX / DOM. PricingBlock.tsx itself is not
// covered here; the classifier IS the visual contract surface and
// changes to it would break the render in a way these tests catch.

import { describe, it, expect } from "vitest";
import { classifyBroCardPricing, type PricingClassifierListing } from "./pricing";

// Minimal listing factory — every field nullable so individual tests
// only set the fields they care about.
function makeListing(
  overrides: Partial<PricingClassifierListing> = {},
): PricingClassifierListing {
  return {
    realArvMedian: null,
    estRehab: null,
    estRehabMid: null,
    wholesaleFeeTarget: null,
    buyerProfitTarget: null,
    listPrice: null,
    sellerMotivationScore: null,
    estimatedMonthlyRent: null,
    state: null,
    outreachOfferPrice: null,
    contractOfferPrice: null,
    ...overrides,
  };
}

describe("classifyBroCardPricing — mode gate", () => {
  it("phase4 when ARV + rehab produce a floor (flipper-only)", () => {
    const p = classifyBroCardPricing(
      makeListing({
        realArvMedian: 200_000,
        estRehabMid: 40_000,
        wholesaleFeeTarget: 15_000,
        listPrice: 150_000,
      }),
    );
    expect(p.mode).toBe("phase4");
  });

  it("phase4 when dual-track inputs produce a landlord-dominant floor", () => {
    // 1219 E Highland canonical: dominant_value drives the floor.
    const p = classifyBroCardPricing(
      makeListing({
        realArvMedian: 165_000,
        estRehab: 60_000,
        wholesaleFeeTarget: 15_000,
        listPrice: 163_000,
        estimatedMonthlyRent: 1400,
        state: "TX",
      }),
    );
    expect(p.mode).toBe("phase4");
  });

  it("phase4 when landlord-only path produces a floor (no ARV, has rent+state+rehab)", () => {
    // ARV missing → flipper null. Rent + state + rehab → landlord
    // computable. computeMaoRange's null-ARV branch falls through to
    // dual_track.dominant_value, which our classifier hits as a
    // non-null floor.
    const p = classifyBroCardPricing(
      makeListing({
        realArvMedian: null,
        estRehab: 40_000,
        wholesaleFeeTarget: 15_000,
        estimatedMonthlyRent: 1500,
        state: "TX",
        listPrice: 120_000,
      }),
    );
    expect(p.mode).toBe("phase4");
  });

  it("legacy when math can't produce a floor but outreachOfferPrice is set", () => {
    const p = classifyBroCardPricing(
      makeListing({
        // No ARV + no rehab → math layer produces null floor.
        outreachOfferPrice: 95_000,
        listPrice: 145_000,
      }),
    );
    expect(p.mode).toBe("legacy");
    if (p.mode === "legacy") {
      expect(p.outreach_offer_price).toBe(95_000);
      expect(p.contract_offer_price).toBeNull();
      expect(p.list_price).toBe(145_000);
    }
  });

  it("legacy when only contractOfferPrice is set", () => {
    const p = classifyBroCardPricing(
      makeListing({
        contractOfferPrice: 110_000,
        listPrice: 150_000,
      }),
    );
    expect(p.mode).toBe("legacy");
    if (p.mode === "legacy") {
      expect(p.outreach_offer_price).toBeNull();
      expect(p.contract_offer_price).toBe(110_000);
    }
  });

  it("no_math when all pricing fields null", () => {
    const p = classifyBroCardPricing(makeListing({}));
    expect(p.mode).toBe("no_math");
    if (p.mode === "no_math") {
      expect(p.list_price).toBeNull();
    }
  });

  it("no_math when only listPrice is set (no math, no offers)", () => {
    const p = classifyBroCardPricing(makeListing({ listPrice: 180_000 }));
    expect(p.mode).toBe("no_math");
    if (p.mode === "no_math") {
      expect(p.list_price).toBe(180_000);
    }
  });

  it("legacy treats $0 / negative offer-price as no legacy data (falls through to no_math)", () => {
    const p = classifyBroCardPricing(
      makeListing({ outreachOfferPrice: 0, contractOfferPrice: 0, listPrice: 100_000 }),
    );
    expect(p.mode).toBe("no_math");
  });
});

describe("classifyBroCardPricing — Phase 4 envelope shape", () => {
  it("populates floor / target / list_price / soft_ceiling / exceeds_soft_ceiling", () => {
    const p = classifyBroCardPricing(
      makeListing({
        realArvMedian: 200_000,
        estRehabMid: 50_000,
        wholesaleFeeTarget: 15_000,
        listPrice: 160_000,
      }),
    );
    if (p.mode !== "phase4") throw new Error("expected phase4 mode");
    expect(p.range.floor).toBe(135_000); // 200 − 50 − 15
    expect(p.range.target).toBe(135_000); // motivation null → target = floor
    expect(p.range.list_price).toBe(160_000);
    expect(p.range.soft_ceiling).toBe(120_000); // 75% of 160K
    expect(p.range.exceeds_soft_ceiling).toBe(true); // 135K > 120K
  });

  it("soft_ceiling is 75% of list (rounded)", () => {
    const p = classifyBroCardPricing(
      makeListing({
        realArvMedian: 100_000,
        estRehabMid: 30_000,
        wholesaleFeeTarget: 15_000,
        listPrice: 163_000, // 75% = 122,250
      }),
    );
    if (p.mode !== "phase4") throw new Error("expected phase4 mode");
    expect(p.range.soft_ceiling).toBe(122_250);
  });

  it("exceeds_soft_ceiling false when target below soft ceiling", () => {
    const p = classifyBroCardPricing(
      makeListing({
        realArvMedian: 100_000,
        estRehabMid: 30_000,
        wholesaleFeeTarget: 15_000,
        listPrice: 200_000, // soft ceiling 150K, floor only 55K
      }),
    );
    if (p.mode !== "phase4") throw new Error("expected phase4 mode");
    expect(p.range.floor).toBe(55_000);
    expect(p.range.soft_ceiling).toBe(150_000);
    expect(p.range.exceeds_soft_ceiling).toBe(false);
  });

  it("rehab_source = phase_4b_calibrated when estRehabMid present", () => {
    const p = classifyBroCardPricing(
      makeListing({
        realArvMedian: 200_000,
        estRehabMid: 45_000, // Phase 4B.1 calibrated
        estRehab: 60_000, // legacy (should be ignored — calibrated wins)
        wholesaleFeeTarget: 15_000,
        listPrice: 150_000,
      }),
    );
    if (p.mode !== "phase4") throw new Error("expected phase4 mode");
    expect(p.range.modifier_inputs.rehab_source).toBe("phase_4b_calibrated");
    expect(p.range.modifier_inputs.est_rehab).toBe(45_000); // confirms which value was used
  });

  it("rehab_source = legacy_est_rehab when only estRehab present", () => {
    const p = classifyBroCardPricing(
      makeListing({
        realArvMedian: 200_000,
        estRehab: 60_000, // legacy only
        wholesaleFeeTarget: 15_000,
        listPrice: 150_000,
      }),
    );
    if (p.mode !== "phase4") throw new Error("expected phase4 mode");
    expect(p.range.modifier_inputs.rehab_source).toBe("legacy_est_rehab");
    expect(p.range.modifier_inputs.est_rehab).toBe(60_000);
  });
});

describe("classifyBroCardPricing — dual_track bubble shape", () => {
  it("dual_track is null when monthlyRent missing (flipper-only payload)", () => {
    const p = classifyBroCardPricing(
      makeListing({
        realArvMedian: 200_000,
        estRehabMid: 50_000,
        wholesaleFeeTarget: 15_000,
        listPrice: 150_000,
        state: "TX", // state alone is insufficient — rent gate
      }),
    );
    if (p.mode !== "phase4") throw new Error("expected phase4 mode");
    expect(p.range.dual_track).toBeNull();
  });

  it("dual_track surfaces cap_rate + cap_rate_tier for TX-Metro 8%", () => {
    const p = classifyBroCardPricing(
      makeListing({
        realArvMedian: 165_000,
        estRehab: 60_000,
        wholesaleFeeTarget: 15_000,
        listPrice: 163_000,
        estimatedMonthlyRent: 1400,
        state: "TX",
      }),
    );
    if (p.mode !== "phase4") throw new Error("expected phase4 mode");
    expect(p.range.dual_track).not.toBeNull();
    expect(p.range.dual_track?.cap_rate).toBeCloseTo(0.08, 4);
    expect(p.range.dual_track?.cap_rate_tier).toBe("TX-Metro");
  });

  it("dual_track cap_rate_tier = TN-Distressed 10% for Memphis (TN)", () => {
    const p = classifyBroCardPricing(
      makeListing({
        realArvMedian: 95_000,
        estRehab: 30_000,
        wholesaleFeeTarget: 15_000,
        listPrice: 89_000,
        estimatedMonthlyRent: 1100,
        state: "TN",
      }),
    );
    if (p.mode !== "phase4") throw new Error("expected phase4 mode");
    expect(p.range.dual_track?.cap_rate).toBeCloseTo(0.10, 4);
    expect(p.range.dual_track?.cap_rate_tier).toBe("TN-Distressed");
  });

  it("dual_track cap_rate_tier = MI-Distressed 9% for Detroit (MI)", () => {
    const p = classifyBroCardPricing(
      makeListing({
        realArvMedian: 80_000,
        estRehab: 35_000,
        wholesaleFeeTarget: 15_000,
        listPrice: 75_000,
        estimatedMonthlyRent: 1200,
        state: "MI",
      }),
    );
    if (p.mode !== "phase4") throw new Error("expected phase4 mode");
    expect(p.range.dual_track?.cap_rate).toBeCloseTo(0.09, 4);
    expect(p.range.dual_track?.cap_rate_tier).toBe("MI-Distressed");
  });

  it("dual_track flipper-dominant: dominant_track = flipper", () => {
    // High ARV, low rent → flipper wins.
    const p = classifyBroCardPricing(
      makeListing({
        realArvMedian: 300_000,
        estRehab: 40_000,
        wholesaleFeeTarget: 15_000,
        listPrice: 250_000,
        estimatedMonthlyRent: 1200, // low for the ARV
        state: "TX",
      }),
    );
    if (p.mode !== "phase4") throw new Error("expected phase4 mode");
    expect(p.range.dual_track?.dominant_track).toBe("flipper");
    expect(p.range.dual_track?.flipper_mao).toBe(245_000); // 300 − 40 − 15
  });

  it("dual_track 'neither' edge case (no ARV, no rent — no dual_track path)", () => {
    // Without rent + state, dual_track ISN'T eligible → null at the
    // computeMaoRange layer. This is the flipper-only-but-no-ARV case
    // which collapses to floor=null → legacy/no_math mode.
    const p = classifyBroCardPricing(
      makeListing({
        estRehabMid: 40_000,
        listPrice: 100_000,
      }),
    );
    expect(p.mode).toBe("no_math"); // floor=null, no offer-prices set
  });
});

describe("classifyBroCardPricing — validation anchor: 1219 E Highland 78210", () => {
  it("renders the canonical landlord-dominant Phase 4 envelope", () => {
    // Per the v1.3 amendment + Phase 4C.1 K.3:
    //   ARV $165K, Rehab $60K, Wholesale $15K, Rent $1400/mo, TX 8% cap
    //   → flipper $90K, landlord $135K (wins), list ~$163K
    //   → soft ceiling $122,250 (75% of $163K)
    //   → exceeds soft ceiling: 135K > 122,250
    const p = classifyBroCardPricing(
      makeListing({
        realArvMedian: 165_000,
        estRehab: 60_000,
        wholesaleFeeTarget: 15_000,
        listPrice: 163_000,
        estimatedMonthlyRent: 1400,
        state: "TX",
      }),
    );
    if (p.mode !== "phase4") throw new Error("expected phase4 mode");
    // Floor is dominant_value, which is landlord MAO.
    expect(p.range.floor).toBe(135_000);
    expect(p.range.target).toBe(135_000); // motivation null → target = floor
    expect(p.range.list_price).toBe(163_000);
    expect(p.range.soft_ceiling).toBe(122_250);
    expect(p.range.exceeds_soft_ceiling).toBe(true);
    expect(p.range.dual_track).not.toBeNull();
    expect(p.range.dual_track?.flipper_mao).toBe(90_000);
    expect(p.range.dual_track?.landlord_mao).toBe(135_000);
    expect(p.range.dual_track?.dominant_track).toBe("landlord");
    expect(p.range.dual_track?.dominant_value).toBe(135_000);
    expect(p.range.dual_track?.cap_rate).toBeCloseTo(0.08, 4);
    expect(p.range.dual_track?.cap_rate_tier).toBe("TX-Metro");
    // Rehab provided via legacy estRehab field → source = legacy_est_rehab.
    expect(p.range.modifier_inputs.rehab_source).toBe("legacy_est_rehab");
    expect(p.range.modifier_inputs.monthly_rent).toBe(1400);
    expect(p.range.modifier_inputs.state).toBe("TX");
  });
});

describe("classifyBroCardPricing — validation fixtures from K.1 / J.1 suite", () => {
  it("Memphis landlord-dominant: TN-Distressed 10% cap", () => {
    // Per K.1 Memphis canonical: high rent-to-ARV ratio → landlord wins.
    const p = classifyBroCardPricing(
      makeListing({
        realArvMedian: 95_000,
        estRehab: 30_000,
        wholesaleFeeTarget: 15_000,
        listPrice: 89_000,
        estimatedMonthlyRent: 1100,
        state: "TN",
      }),
    );
    if (p.mode !== "phase4") throw new Error("expected phase4 mode");
    // flipper = 95 − 30 − 15 = 50K
    // landlord = 1100 × 12 / 0.10 − 30 − 15 = 132 − 45 = 87K
    expect(p.range.dual_track?.flipper_mao).toBe(50_000);
    expect(p.range.dual_track?.landlord_mao).toBe(87_000);
    expect(p.range.dual_track?.dominant_track).toBe("landlord");
    expect(p.range.floor).toBe(87_000);
  });

  it("Detroit landlord-strongly-dominant: MI-Distressed 9% cap, legacy rehab badge", () => {
    // Sturtevant creative-finance pattern from K.1. Pre-4B.1 record →
    // only legacy estRehab populated, no estRehabMid → rehab_source
    // = legacy_est_rehab (Pulse signal for future re-calibration).
    const p = classifyBroCardPricing(
      makeListing({
        realArvMedian: 80_000,
        estRehab: 35_000, // pre-4B.1
        wholesaleFeeTarget: 15_000,
        listPrice: 75_000,
        estimatedMonthlyRent: 1200,
        state: "MI",
      }),
    );
    if (p.mode !== "phase4") throw new Error("expected phase4 mode");
    // flipper = 80 − 35 − 15 = 30K
    // landlord = 1200 × 12 / 0.09 − 35 − 15 = 160K − 50K = 110K
    expect(p.range.dual_track?.flipper_mao).toBe(30_000);
    expect(p.range.dual_track?.landlord_mao).toBeCloseTo(110_000, -2);
    expect(p.range.dual_track?.dominant_track).toBe("landlord");
    expect(p.range.modifier_inputs.rehab_source).toBe("legacy_est_rehab");
  });

  it("flipper-dominant fixture: high ARV, no rent on file", () => {
    // No rent → dual_track is null entirely (gate is rent+state both
    // present). Floor falls back to flipper-only math.
    const p = classifyBroCardPricing(
      makeListing({
        realArvMedian: 250_000,
        estRehabMid: 35_000,
        wholesaleFeeTarget: 15_000,
        listPrice: 220_000,
      }),
    );
    if (p.mode !== "phase4") throw new Error("expected phase4 mode");
    expect(p.range.floor).toBe(200_000); // 250 − 35 − 15
    expect(p.range.dual_track).toBeNull();
    expect(p.range.modifier_inputs.rehab_source).toBe("phase_4b_calibrated");
  });
});

describe("classifyBroCardPricing — legacy / no_math fixtures", () => {
  it("legacy fixture: pre-4A.1 record with outreach + contract offer-prices", () => {
    const p = classifyBroCardPricing(
      makeListing({
        // No ARV or rehab → no Phase 4 floor.
        outreachOfferPrice: 65_000, // sticky 65%-of-list at outreach time
        contractOfferPrice: 72_000, // operative at negotiation/DD
        listPrice: 100_000,
      }),
    );
    expect(p.mode).toBe("legacy");
    if (p.mode === "legacy") {
      expect(p.outreach_offer_price).toBe(65_000);
      expect(p.contract_offer_price).toBe(72_000);
      expect(p.list_price).toBe(100_000);
    }
  });

  it("no_math fixture: brand-new record with only listPrice set", () => {
    const p = classifyBroCardPricing(
      makeListing({
        listPrice: 145_000,
      }),
    );
    expect(p.mode).toBe("no_math");
    if (p.mode === "no_math") {
      expect(p.list_price).toBe(145_000);
    }
  });
});
