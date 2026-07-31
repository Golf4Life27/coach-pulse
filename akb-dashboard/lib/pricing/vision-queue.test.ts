import { describe, it, expect } from "vitest";
import {
  routeHolds,
  isMachineResolvableHold,
  restsOnPlaceholderRehab,
  drainOutcome,
  PLACEHOLDER_REHAB_HOLD_REASON,
  PLACEHOLDER_REHAB_SOURCE,
} from "./vision-queue";
import { priceOpenerWithSeed } from "@/lib/opener-pricing";
import type { ZipArvSeed } from "@/lib/zip-arv-seed-store";

describe("256 Westchester Dr — the defect this exists to stop", () => {
  // rec reckHdag4kCuTyNj1. Renovated 4/2, 1,902 sqft, listed $234,900, 380 DOM.
  // Texted $74,500 on 2026-07-31. Agent: "No where close, their bottom line is
  // $230k." Reconstructed: ARV = $117.65/sqft × 1,902 ≈ $223,772 (right),
  // placeholder rehab 0.30×ARV = $67,132 (house needed $0), fee $15k,
  // 0.70×ARV − rehab − fee = $74,500.
  const westchesterSeed: ZipArvSeed = {
    zip: "35215", renovatedPerSqft: 117.65, arvLowPerSqft: 100, compCount: 8,
    confidence: "STRONG", dontPrice: false, source: "rentcast_avm", market: "Birmingham",
    state: "AL", fetchedAt: null, receiptsJson: null, recordId: "recSeed",
  };

  const price = (over: Record<string, unknown> = {}) =>
    priceOpenerWithSeed({
      listPrice: 234_900,
      storedArv: null,
      estRehabMid: null,   // ← no vision ran: DOM 380 took the "no vision needed" path
      estRehab: null,
      sqft: 1_902,
      arvPctMax: 0.70,
      wholesaleFee: 15_000,
      anchorPct: 1.0,
      seed: westchesterSeed,
      ...over,
    });

  it("HOLDS instead of texting a number built on an invented renovation", () => {
    const r = price();
    expect(r.result.opener).toBeNull();
    expect(r.basisLabel).toBe(PLACEHOLDER_REHAB_HOLD_REASON);
    expect(r.result.ceilingSource).toBe(PLACEHOLDER_REHAB_SOURCE);
  });

  it("names the guessed rehab in the detail — the ARV was never the problem", () => {
    const r = price();
    // The ARV is right (~$224k vs the agent's $230k). The detail must say the
    // REHAB was invented, or the next reader re-litigates the ARV.
    expect(r.arvUsed).toBeGreaterThan(200_000);
    expect(r.arvUsed).toBeLessThan(240_000);
    expect(r.result.detail).toMatch(/placeholder rehab/i);
  });

  it("SENDS the same house once a real vision rehab exists", () => {
    // The hold is about the missing rehab, not about this listing. A genuine
    // $0-ish rehab on a turnkey house prices near value and may send.
    const r = price({ estRehabMid: 5_000 });
    expect(r.result.opener).not.toBeNull();
    expect(r.result.basis).toBe("arv_buybox");
    // And the number is now defensible rather than insulting.
    expect(r.result.opener!).toBeGreaterThan(130_000);
  });
});

describe("routeHolds — the vision bucket must not join the h2_opener_hold pile", () => {
  it("splits machine work from operator decisions", () => {
    const { toVisionQueue, toOperatorProposals } = routeHolds([
      { reason: PLACEHOLDER_REHAB_HOLD_REASON },
      { reason: "below_min_offer_floor" },
      { reason: "mao_not_underwritten" },
      { reason: PLACEHOLDER_REHAB_HOLD_REASON },
      { reason: "lowball_not_eligible_not_eligible_clean" },
    ]);
    expect(toVisionQueue).toHaveLength(2);
    expect(toOperatorProposals).toHaveLength(3);
  });

  it("is an EXACT match, never a prefix — a permissive test re-buries them", () => {
    expect(isMachineResolvableHold(PLACEHOLDER_REHAB_HOLD_REASON)).toBe(true);
    expect(isMachineResolvableHold(`${PLACEHOLDER_REHAB_HOLD_REASON}_extra`)).toBe(false);
    expect(isMachineResolvableHold("placeholder")).toBe(false);
    expect(isMachineResolvableHold(null)).toBe(false);
    expect(isMachineResolvableHold(undefined)).toBe(false);
  });

  it("an empty run routes nothing to either lane", () => {
    const r = routeHolds([]);
    expect(r.toVisionQueue).toEqual([]);
    expect(r.toOperatorProposals).toEqual([]);
  });
});

describe("restsOnPlaceholderRehab", () => {
  it("catches the named source", () => {
    expect(restsOnPlaceholderRehab({ basis: PLACEHOLDER_REHAB_SOURCE })).toBe(true);
  });

  it("defends in depth: a buybox opener with NO vision rehab is placeholder-priced", () => {
    expect(restsOnPlaceholderRehab({ basis: "rough_buybox_arv", estRehabMid: null })).toBe(true);
  });

  it("does not fire when a vision rehab is present", () => {
    expect(restsOnPlaceholderRehab({ basis: "rough_buybox_arv", estRehabMid: 22_000 })).toBe(false);
    expect(restsOnPlaceholderRehab({ basis: "rough_buybox_arv", estRehab: 22_000 })).toBe(false);
  });

  it("does not fire on a hold that never produced a buybox number", () => {
    expect(restsOnPlaceholderRehab({ basis: "hold_no_value_basis" })).toBe(false);
    expect(restsOnPlaceholderRehab({ basis: null })).toBe(false);
  });
});

describe("drainOutcome", () => {
  it("a usable vision rehab RELEASES the record back to the send path", () => {
    expect(drainOutcome(18_500)).toBe("cleared");
  });

  it("anything else parks it in the operator's bucket", () => {
    // No photos, vision threw, zero/negative — all need a human eye.
    expect(drainOutcome(null)).toBe("vision_failed");
    expect(drainOutcome(undefined)).toBe("vision_failed");
    expect(drainOutcome(0)).toBe("vision_failed");
  });
});
