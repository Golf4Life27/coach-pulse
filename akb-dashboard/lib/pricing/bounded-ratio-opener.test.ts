import { describe, it, expect } from "vitest";
import {
  computeBoundedRatioOpener,
  agentInventoryAsk,
  RATIO_DEFAULT,
  MAX_RATIO_OPENER_USD,
  MIN_RATIO_OPENER_USD,
} from "./bounded-ratio-opener";

describe("the cheap opener — needs ONLY a list price", () => {
  it("prices off list with no ARV, no rehab, no vendor call", () => {
    // This is the whole point: 270 records with no rehab estimate can now be
    // texted, because asking a question does not require underwriting.
    const r = computeBoundedRatioOpener({ list: 60_000, city: "Detroit" });
    expect(r.opener).toBe(33_000); // 0.55 × 60,000
    expect(r.basis).toBe("ratio_of_list");
  });

  it("holds without a list price rather than improvising", () => {
    const r = computeBoundedRatioOpener({ list: null, city: "Detroit" });
    expect(r.opener).toBeNull();
    expect(r.holdReason).toBe("no_list_price");
  });

  it("opens below the April 65% that bought unprofitable acceptances", () => {
    expect(RATIO_DEFAULT).toBeLessThan(0.65);
  });
});

describe("GUARD 1 — the Blackmoor guard", () => {
  it("refuses to take a ratio of a garbage list price", () => {
    // Blackmoor: 0.65 × $130,000 list on a ~$40,000 house = $84,500 sent.
    // A $130k ask is above what a Rust Belt metro supports, so there is no
    // ratio of it worth computing.
    const r = computeBoundedRatioOpener({ list: 130_000, city: "Detroit" });
    expect(r.opener).toBeNull();
    expect(r.holdReason).toBe("list_above_buy_box_ceiling");
  });

  it("still allows a high ask in a metro that supports it", () => {
    const r = computeBoundedRatioOpener({ list: 130_000, city: "Atlanta" });
    expect(r.opener).toBe(71_500);
  });
});

describe("GUARD 2 — $/sqft, independent of the seller's ask", () => {
  it("caps the opener when the ask outruns what the block is worth", () => {
    // 900 sqft at a $40/sqft renovated ceiling = $36,000, well under
    // 0.55 × $85,000 = $46,750.
    const r = computeBoundedRatioOpener({
      list: 85_000,
      city: "Detroit",
      sqft: 900,
      zipPsfCeiling: 40,
    });
    expect(r.opener).toBe(36_000);
    expect(r.basis).toBe("psf_capped");
  });

  it("does not raise a number when the band is generous", () => {
    const r = computeBoundedRatioOpener({
      list: 60_000,
      city: "Detroit",
      sqft: 2_000,
      zipPsfCeiling: 100,
    });
    expect(r.opener).toBe(33_000); // ratio still governs
  });

  it("skips the bound when sqft or the band is unknown", () => {
    expect(computeBoundedRatioOpener({ list: 60_000, city: "Detroit", sqft: null, zipPsfCeiling: 40 }).opener).toBe(33_000);
    expect(computeBoundedRatioOpener({ list: 60_000, city: "Detroit", sqft: 900, zipPsfCeiling: null }).opener).toBe(33_000);
  });
});

describe("GUARD 3 — real data may only lower the number", () => {
  it("uses the value-anchored MAO when it is lower", () => {
    const r = computeBoundedRatioOpener({
      list: 80_000,
      city: "Detroit",
      valueAnchoredMao: 28_000,
    });
    expect(r.opener).toBe(28_000);
    expect(r.basis).toBe("value_anchored_capped");
  });

  it("NEVER raises the number to meet a generous MAO", () => {
    // The reconciliation that makes this safe: better data cannot inflate an
    // offer, only restrain it.
    const r = computeBoundedRatioOpener({
      list: 60_000,
      city: "Detroit",
      valueAnchoredMao: 90_000,
    });
    expect(r.opener).toBe(33_000);
    expect(r.basis).toBe("ratio_of_list");
  });
});

describe("GUARD 4 — absolute dollars, because proportion cannot bound risk", () => {
  it("holds an opener above the exposure ceiling", () => {
    const r = computeBoundedRatioOpener({ list: 200_000, city: "Boise" });
    // Boise has no tier, so the global $150k ask ceiling applies first.
    expect(r.opener).toBeNull();
    expect(r.holdReason).toBe("list_above_buy_box_ceiling");
  });

  it("holds an insultingly small opener", () => {
    const r = computeBoundedRatioOpener({ list: 20_000, city: "Detroit" });
    expect(r.opener).toBeNull();
    expect(r.holdReason).toBe("below_min_opener");
    expect(MIN_RATIO_OPENER_USD).toBe(15_000);
  });

  it("keeps an absolute ceiling separate from the proportional one", () => {
    expect(MAX_RATIO_OPENER_USD).toBeGreaterThan(0);
  });
});

describe("the agent inventory ask", () => {
  it("gives the agent a second way to say yes and names no number", () => {
    const ask = agentInventoryAsk();
    expect(ask).toMatch(/needs work|seller who needs speed/i);
    expect(ask).not.toMatch(/\$\d/);
  });
});
