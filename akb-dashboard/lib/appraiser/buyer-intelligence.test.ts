// @agent: appraiser — buyer intelligence dual-track tests (Phase 4C.1).

import { describe, it, expect } from "vitest";
import {
  computeFlipperMao,
  computeLandlordMao,
  computeDualTrack,
  getMarketCapRate,
  readMarketCapRates,
} from "./buyer-intelligence";

describe("readMarketCapRates", () => {
  it("returns documented defaults when env is empty", () => {
    const r = readMarketCapRates({});
    expect(r["TX-Metro"]).toBeCloseTo(0.08, 4);
    expect(r["TN-Distressed"]).toBeCloseTo(0.10, 4);
    expect(r["MI-Distressed"]).toBeCloseTo(0.09, 4);
    expect(r["Conservative-Default"]).toBeCloseTo(0.09, 4);
  });
  it("honors env overrides when set to valid decimals 0<n<1", () => {
    const r = readMarketCapRates({
      BUYER_CAP_RATE_TX_METRO: "0.075",
      BUYER_CAP_RATE_TN_DISTRESSED: "0.11",
    });
    expect(r["TX-Metro"]).toBeCloseTo(0.075, 4);
    expect(r["TN-Distressed"]).toBeCloseTo(0.11, 4);
    expect(r["MI-Distressed"]).toBeCloseTo(0.09, 4);
  });
  it("ignores invalid env values (non-numeric, zero, negative, ≥1)", () => {
    const r = readMarketCapRates({
      BUYER_CAP_RATE_TX_METRO: "notanumber",
      BUYER_CAP_RATE_TN_DISTRESSED: "0",
      BUYER_CAP_RATE_MI_DISTRESSED: "-0.05",
      BUYER_CAP_RATE_DEFAULT: "1.5",
    });
    expect(r["TX-Metro"]).toBeCloseTo(0.08, 4);
    expect(r["TN-Distressed"]).toBeCloseTo(0.10, 4);
    expect(r["MI-Distressed"]).toBeCloseTo(0.09, 4);
    expect(r["Conservative-Default"]).toBeCloseTo(0.09, 4);
  });
});

describe("getMarketCapRate", () => {
  it("maps state code to the right tier + rate", () => {
    expect(getMarketCapRate("TX")).toEqual({ rate: 0.08, tier: "TX-Metro" });
    expect(getMarketCapRate("TN")).toEqual({ rate: 0.10, tier: "TN-Distressed" });
    expect(getMarketCapRate("MI")).toEqual({ rate: 0.09, tier: "MI-Distressed" });
    expect(getMarketCapRate("CA")).toEqual({ rate: 0.09, tier: "Conservative-Default" });
    expect(getMarketCapRate(null)).toEqual({ rate: 0.09, tier: "Conservative-Default" });
  });
});

describe("computeFlipperMao", () => {
  it("computes arv − rehab − wholesale_fee", () => {
    expect(
      computeFlipperMao({ arvMid: 165_000, estRehab: 60_000, wholesaleFee: 15_000 }),
    ).toBe(90_000);
  });
  it("clamps to 0 when subtraction would go negative", () => {
    expect(
      computeFlipperMao({ arvMid: 50_000, estRehab: 60_000, wholesaleFee: 15_000 }),
    ).toBe(0);
  });
  it("defaults wholesale_fee to 15000 when null", () => {
    expect(
      computeFlipperMao({ arvMid: 200_000, estRehab: 30_000, wholesaleFee: null }),
    ).toBe(155_000);
  });
  it("returns null when arvMid is missing", () => {
    expect(
      computeFlipperMao({ arvMid: null, estRehab: 60_000, wholesaleFee: 15_000 }),
    ).toBeNull();
  });
  it("returns null when estRehab is missing", () => {
    expect(
      computeFlipperMao({ arvMid: 165_000, estRehab: null, wholesaleFee: 15_000 }),
    ).toBeNull();
  });
});

describe("computeLandlordMao", () => {
  it("computes (rent × 12) / cap_rate − rehab − wholesale_fee", () => {
    // $1100 × 12 = $13200; / 0.10 = $132000; − $60000 − $15000 = $57000
    expect(
      computeLandlordMao({
        monthlyRent: 1100,
        capRate: 0.10,
        estRehab: 60_000,
        wholesaleFee: 15_000,
      }),
    ).toBe(57_000);
  });
  it("clamps to 0 when subtraction would go negative", () => {
    // Tiny rent + big rehab → negative → clamp 0
    expect(
      computeLandlordMao({
        monthlyRent: 200,
        capRate: 0.10,
        estRehab: 60_000,
        wholesaleFee: 15_000,
      }),
    ).toBe(0);
  });
  it("returns null when monthlyRent is null/zero/negative", () => {
    const base = { capRate: 0.10, estRehab: 60_000, wholesaleFee: 15_000 };
    expect(computeLandlordMao({ ...base, monthlyRent: null })).toBeNull();
    expect(computeLandlordMao({ ...base, monthlyRent: 0 })).toBeNull();
    expect(computeLandlordMao({ ...base, monthlyRent: -100 })).toBeNull();
  });
  it("returns null when estRehab is missing", () => {
    expect(
      computeLandlordMao({
        monthlyRent: 1500,
        capRate: 0.08,
        estRehab: null,
        wholesaleFee: 15_000,
      }),
    ).toBeNull();
  });
  it("returns null when capRate is invalid", () => {
    const base = { monthlyRent: 1500, estRehab: 60_000, wholesaleFee: 15_000 };
    expect(computeLandlordMao({ ...base, capRate: 0 })).toBeNull();
    expect(computeLandlordMao({ ...base, capRate: -0.05 })).toBeNull();
    expect(computeLandlordMao({ ...base, capRate: NaN })).toBeNull();
    expect(computeLandlordMao({ ...base, capRate: Infinity })).toBeNull();
  });
  it("defaults wholesale_fee to 15000 when null", () => {
    // $1500 × 12 / 0.08 = $225000; − $60000 − $15000 = $150000
    expect(
      computeLandlordMao({
        monthlyRent: 1500,
        capRate: 0.08,
        estRehab: 60_000,
        wholesaleFee: null,
      }),
    ).toBe(150_000);
  });
});

describe("computeDualTrack — validation fixtures per market", () => {
  it("SA flipper-dominant: high ARV + modest rent (TX-Metro 8%)", () => {
    // ARV $300K → flipper = 300-60-15 = $225K
    // Rent $1500 × 12 / 0.08 = $225K → landlord = 225-60-15 = $150K
    // Flipper wins by $75K.
    const r = computeDualTrack({
      arvMid: 300_000,
      estRehab: 60_000,
      wholesaleFee: 15_000,
      monthlyRent: 1500,
      state: "TX",
    });
    expect(r.flipper_mao).toBe(225_000);
    expect(r.landlord_mao).toBe(150_000);
    expect(r.dominant_track).toBe("flipper");
    expect(r.dominant_value).toBe(225_000);
    expect(r.modifier_inputs.cap_rate).toBeCloseTo(0.08, 4);
    expect(r.modifier_inputs.cap_rate_tier).toBe("TX-Metro");
  });

  it("Memphis landlord-dominant: modest ARV + decent rent (TN-Distressed 10%)", () => {
    // ARV $120K → flipper = 120-60-15 = $45K
    // Rent $1100 × 12 / 0.10 = $132K → landlord = 132-60-15 = $57K
    // Landlord wins by $12K — the canonical "money on the table" case.
    const r = computeDualTrack({
      arvMid: 120_000,
      estRehab: 60_000,
      wholesaleFee: 15_000,
      monthlyRent: 1100,
      state: "TN",
    });
    expect(r.flipper_mao).toBe(45_000);
    expect(r.landlord_mao).toBe(57_000);
    expect(r.dominant_track).toBe("landlord");
    expect(r.dominant_value).toBe(57_000);
    expect(r.modifier_inputs.cap_rate_tier).toBe("TN-Distressed");
  });

  it("Detroit landlord-strongly-dominant: low ARV + decent rent (MI-Distressed 9%)", () => {
    // ARV $80K → flipper = 80-60-15 = $5K
    // Rent $1000 × 12 / 0.09 = $133333; − 60 − 15 ≈ $58333
    // Landlord wins by ~$53K — the Sturtevant-pattern creative-finance case.
    const r = computeDualTrack({
      arvMid: 80_000,
      estRehab: 60_000,
      wholesaleFee: 15_000,
      monthlyRent: 1000,
      state: "MI",
    });
    expect(r.flipper_mao).toBe(5_000);
    expect(r.landlord_mao).toBeGreaterThan(50_000);
    expect(r.landlord_mao).toBeLessThan(60_000);
    expect(r.dominant_track).toBe("landlord");
  });

  it("1219 E Highland Blvd cross-check: Phase 4A.1 flipper $90K vs SA dual-track", () => {
    // Phase 4A.1 anchor: ARV $165K + Rehab $60K + Wholesale $15K → flipper $90K.
    // Add a representative SA rent ($1400/mo) at 8% cap:
    //   Landlord = 1400 × 12 / 0.08 − 60 − 15 = $210K − $75K = $135K.
    // Landlord wins by $45K — same property, +50% buyer-facing MAO under
    // dual-track. The K.3 integration will make this the new floor in
    // mao-range.ts, validating the brief's "money on the table" framing.
    const r = computeDualTrack({
      arvMid: 165_000,
      estRehab: 60_000,
      wholesaleFee: 15_000,
      monthlyRent: 1400,
      state: "TX",
    });
    expect(r.flipper_mao).toBe(90_000);
    expect(r.landlord_mao).toBe(135_000);
    expect(r.dominant_track).toBe("landlord");
    expect(r.dominant_value).toBe(135_000);
  });

  it("anywhere-else default cap rate: CA → Conservative-Default 9%", () => {
    const r = computeDualTrack({
      arvMid: 200_000,
      estRehab: 50_000,
      wholesaleFee: 15_000,
      monthlyRent: 1800,
      state: "CA",
    });
    expect(r.modifier_inputs.cap_rate).toBeCloseTo(0.09, 4);
    expect(r.modifier_inputs.cap_rate_tier).toBe("Conservative-Default");
  });
});

describe("computeDualTrack — edge cases", () => {
  it("no rent → flipper-only, flipper wins by default (landlord null)", () => {
    const r = computeDualTrack({
      arvMid: 165_000,
      estRehab: 60_000,
      wholesaleFee: 15_000,
      monthlyRent: null,
      state: "TX",
    });
    expect(r.flipper_mao).toBe(90_000);
    expect(r.landlord_mao).toBeNull();
    expect(r.dominant_track).toBe("flipper");
    expect(r.dominant_value).toBe(90_000);
  });

  it("no rent + no arv → neither, dominant_value null", () => {
    const r = computeDualTrack({
      arvMid: null,
      estRehab: 60_000,
      wholesaleFee: 15_000,
      monthlyRent: null,
      state: "TX",
    });
    expect(r.flipper_mao).toBeNull();
    expect(r.landlord_mao).toBeNull();
    expect(r.dominant_track).toBe("neither");
    expect(r.dominant_value).toBeNull();
  });

  it("tie within $1000 → dominant_track=tie, dominant_value=max", () => {
    // Manufactured tie: pick numbers so flipper = $80K, landlord = $80.5K
    // ARV $155K → flipper = 155-60-15 = $80K
    // For landlord = $80.5K: 80.5 + 60 + 15 = $155.5K = rent × 12 / cap_rate
    //   At cap 0.10: rent × 12 = 15550 → rent = 1295.83/mo
    const r = computeDualTrack({
      arvMid: 155_000,
      estRehab: 60_000,
      wholesaleFee: 15_000,
      monthlyRent: 1296,
      state: "TN", // 10% cap
      capRates: {
        "TX-Metro": 0.08,
        "TN-Distressed": 0.10,
        "MI-Distressed": 0.09,
        "Conservative-Default": 0.09,
      },
    });
    expect(r.flipper_mao).toBe(80_000);
    // Math: 1296 × 12 / 0.10 = 155520; − 60000 − 15000 = 80520
    expect(r.landlord_mao).toBe(80_520);
    expect(Math.abs(r.flipper_mao! - r.landlord_mao!)).toBeLessThan(1000);
    expect(r.dominant_track).toBe("tie");
    expect(r.dominant_value).toBe(80_520); // max(80000, 80520)
  });

  it("both tracks clamp to 0 (negative inputs) → tie at 0, dominant 0", () => {
    const r = computeDualTrack({
      arvMid: 50_000, // too low
      estRehab: 60_000,
      wholesaleFee: 15_000,
      monthlyRent: 100, // too low
      state: "TX",
    });
    expect(r.flipper_mao).toBe(0);
    expect(r.landlord_mao).toBe(0);
    expect(r.dominant_track).toBe("tie"); // within $1000 = tie
    expect(r.dominant_value).toBe(0);
  });

  it("missing arv but rent present → landlord-only, landlord wins", () => {
    const r = computeDualTrack({
      arvMid: null,
      estRehab: 60_000,
      wholesaleFee: 15_000,
      monthlyRent: 1500,
      state: "TX",
    });
    expect(r.flipper_mao).toBeNull();
    expect(r.landlord_mao).toBe(150_000);
    expect(r.dominant_track).toBe("landlord");
    expect(r.dominant_value).toBe(150_000);
  });

  it("modifier_inputs surfaces all inputs (including null monthly_rent for Phase 13)", () => {
    const r = computeDualTrack({
      arvMid: 165_000,
      estRehab: 60_000,
      wholesaleFee: 15_000,
      monthlyRent: null,
      state: "TN",
    });
    expect(r.modifier_inputs).toMatchObject({
      arv_mid: 165_000,
      est_rehab: 60_000,
      wholesale_fee: 15_000,
      monthly_rent: null,
      cap_rate_tier: "TN-Distressed",
      state: "TN",
    });
    expect(r.modifier_inputs.cap_rate).toBeCloseTo(0.10, 4);
  });
});
