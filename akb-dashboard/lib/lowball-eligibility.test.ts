import { describe, it, expect } from "vitest";
import { evaluateLowballEligibility, LOWBALL_DOM_THRESHOLD_DAYS } from "./lowball-eligibility";

describe("evaluateLowballEligibility — time-on-market decides", () => {
  it("≥60d cumulative DOM is eligible ALONE, no vision needed", () => {
    const r = evaluateLowballEligibility({
      cumulativeDom: 87,
      listingLanguageDistress: false,
      visionDistress: false,
    });
    expect(r.eligible).toBe(true);
    expect(r.tier).toBe("dom_ge_threshold");
    expect(r.decidedBy).toBe("time_on_market");
  });

  it("exactly at threshold (60) is eligible", () => {
    const r = evaluateLowballEligibility({
      cumulativeDom: LOWBALL_DOM_THRESHOLD_DAYS,
      listingLanguageDistress: false,
      visionDistress: false,
    });
    expect(r.eligible).toBe(true);
  });

  it("one day under threshold + clean → NOT eligible", () => {
    const r = evaluateLowballEligibility({
      cumulativeDom: LOWBALL_DOM_THRESHOLD_DAYS - 1,
      listingLanguageDistress: false,
      visionDistress: false,
    });
    expect(r.eligible).toBe(false);
    expect(r.tier).toBe("not_eligible_clean");
  });
});

describe("vision only ADDS, never decides alone", () => {
  it("under 60 + BOTH language and vision agree → eligible (corroborated)", () => {
    const r = evaluateLowballEligibility({
      cumulativeDom: 20,
      listingLanguageDistress: true,
      visionDistress: true,
      matchedLanguagePhrases: ["cash only", "needs work"],
      visionConditionLabel: "as_is",
    });
    expect(r.eligible).toBe(true);
    expect(r.tier).toBe("distress_corroborated");
    expect(r.decidedBy).toBe("distress_corroboration");
  });

  it("under 60 + vision distress ALONE (hallucination guard) → NOT eligible", () => {
    const r = evaluateLowballEligibility({
      cumulativeDom: 20,
      listingLanguageDistress: false,
      visionDistress: true, // lone vision flag — the water_damage hallucination case
    });
    expect(r.eligible).toBe(false);
    expect(r.tier).toBe("not_eligible_unsure");
  });

  it("under 60 + listing language ALONE → NOT eligible (not corroborated)", () => {
    const r = evaluateLowballEligibility({
      cumulativeDom: 20,
      listingLanguageDistress: true,
      visionDistress: false,
    });
    expect(r.eligible).toBe(false);
    expect(r.tier).toBe("not_eligible_unsure");
  });
});

describe("uncertainty errs toward NOT sending", () => {
  it("null DOM + no distress → not eligible (DOM unknown is never ≥ threshold)", () => {
    const r = evaluateLowballEligibility({
      cumulativeDom: null,
      listingLanguageDistress: false,
      visionDistress: false,
    });
    expect(r.eligible).toBe(false);
    expect(r.tier).toBe("not_eligible_clean");
  });

  it("relist-suspected lower bound under threshold does NOT get promoted over the line", () => {
    // mls_dom_v2 shows 53, relist suspected — true cumulative may be higher,
    // but we never fabricate the crossing. Eligible only via corroboration.
    const r = evaluateLowballEligibility({
      cumulativeDom: 53,
      relistSuspected: true,
      listingLanguageDistress: false,
      visionDistress: false,
    });
    expect(r.eligible).toBe(false);
    expect(r.tier).toBe("not_eligible_unsure"); // surfaced, not promoted
  });

  it("relist-suspected + corroborated distress → eligible via corroboration path", () => {
    const r = evaluateLowballEligibility({
      cumulativeDom: 53,
      relistSuspected: true,
      listingLanguageDistress: true,
      visionDistress: true,
    });
    expect(r.eligible).toBe(true);
    expect(r.tier).toBe("distress_corroborated");
  });
});
