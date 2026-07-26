// Proves the targeting doctrine is wired the SAME way live and in preview:
// the shared signal mappers behave as specified, and feeding them into
// evaluateLowballEligibility reproduces the h2-outreach gate's decision +
// its `lowball_not_eligible_<tier>` skip reason.
import { describe, it, expect } from "vitest";
import { listingLanguageDistress, visionDistress } from "@/lib/lowball-signals";
import { evaluateLowballEligibility } from "@/lib/lowball-eligibility";
import { resolveCumulativeDom } from "@/lib/attom/cumulative-dom";
import type { Listing } from "@/lib/types";

function listing(over: Partial<Listing>): Listing {
  return {
    id: "rec1",
    dom: null,
    distressScore: null,
    distressBucket: null,
    redFlags: null,
    ...over,
  } as unknown as Listing;
}

describe("listingLanguageDistress (shared proxy)", () => {
  it("is true on a positive distress score", () => {
    expect(listingLanguageDistress(listing({ distressScore: 3 }))).toBe(true);
  });
  it("is false on a zero / null score with no bucket", () => {
    expect(listingLanguageDistress(listing({ distressScore: 0 }))).toBe(false);
    expect(listingLanguageDistress(listing({}))).toBe(false);
  });
  it("reads the distress bucket case-insensitively", () => {
    expect(listingLanguageDistress(listing({ distressBucket: "HIGH distress" }))).toBe(true);
    expect(listingLanguageDistress(listing({ distressBucket: "Motivated seller" }))).toBe(true);
    expect(listingLanguageDistress(listing({ distressBucket: "clean" }))).toBe(false);
  });
});

describe("visionDistress (shared proxy)", () => {
  it("is true on a non-empty red-flag array", () => {
    expect(visionDistress(listing({ redFlags: ["roof"] } as Partial<Listing>))).toBe(true);
  });
  it("is false on an empty array, empty string, or the literal '[]'", () => {
    expect(visionDistress(listing({ redFlags: [] } as Partial<Listing>))).toBe(false);
    expect(visionDistress(listing({ redFlags: "" } as unknown as Partial<Listing>))).toBe(false);
    expect(visionDistress(listing({ redFlags: "[]" } as unknown as Partial<Listing>))).toBe(false);
  });
  it("is true on a non-empty string of flags", () => {
    expect(visionDistress(listing({ redFlags: "water damage" } as unknown as Partial<Listing>))).toBe(true);
  });
});

/** Mirrors the h2-outreach pricing-loop gate exactly. */
function gateDecision(l: Listing): { eligible: boolean; skipReason: string | null } {
  const dom = resolveCumulativeDom({ mlsDomV2: l.dom });
  const r = evaluateLowballEligibility({
    cumulativeDom: dom.cumulativeDom,
    relistSuspected: dom.relistSuspected,
    listingLanguageDistress: listingLanguageDistress(l),
    visionDistress: visionDistress(l),
    visionConditionLabel: l.distressBucket ?? null,
  });
  return {
    eligible: r.eligible,
    skipReason: r.eligible ? null : `lowball_not_eligible_${r.tier}`,
  };
}

describe("h2-outreach eligibility wiring", () => {
  it("DOM >= 60 is eligible ALONE — the bulk of the cohort, so volume does not collapse", () => {
    expect(gateDecision(listing({ dom: 60 })).eligible).toBe(true);
    expect(gateDecision(listing({ dom: 400 })).eligible).toBe(true);
  });

  it("under 60 with CORROBORATED language + vision is eligible", () => {
    const l = listing({ dom: 20, distressScore: 2, redFlags: ["gutted"] } as Partial<Listing>);
    expect(gateDecision(l).eligible).toBe(true);
  });

  it("under 60 with a LONE signal skips as lowball_not_eligible_not_eligible_unsure", () => {
    const langOnly = gateDecision(listing({ dom: 20, distressScore: 2 }));
    expect(langOnly.eligible).toBe(false);
    expect(langOnly.skipReason).toBe("lowball_not_eligible_not_eligible_unsure");

    const visionOnly = gateDecision(
      listing({ dom: 20, redFlags: ["roof"] } as Partial<Listing>),
    );
    expect(visionOnly.eligible).toBe(false);
    expect(visionOnly.skipReason).toBe("lowball_not_eligible_not_eligible_unsure");
  });

  it("under 60 and clean skips as lowball_not_eligible_not_eligible_clean", () => {
    const r = gateDecision(listing({ dom: 10 }));
    expect(r.eligible).toBe(false);
    expect(r.skipReason).toBe("lowball_not_eligible_not_eligible_clean");
  });

  it("UNKNOWN DOM is never treated as >= threshold — uncertainty errs toward not sending", () => {
    const r = gateDecision(listing({ dom: null }));
    expect(r.eligible).toBe(false);
    expect(r.skipReason).toBe("lowball_not_eligible_not_eligible_clean");
  });

  it("every skip reason carries the lowball_not_eligible_ prefix the operator greps for", () => {
    for (const l of [listing({ dom: 10 }), listing({ dom: 20, distressScore: 1 })]) {
      expect(gateDecision(l).skipReason).toMatch(/^lowball_not_eligible_/);
    }
  });
});
