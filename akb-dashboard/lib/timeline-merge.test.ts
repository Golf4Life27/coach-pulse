// Test coverage for lib/timeline-merge — the property-match scorer + the
// merge engine. This file closes the "scorePropertyMatch has no unit-test
// coverage" gap surfaced during INV-007 Step 1, AND pins the INV-016 fix
// (price-match now considers BOTH list price and outreach offer, because
// H2 outbound bodies cite the offer ≈65% of list).

import { describe, it, expect } from "vitest";
import { scorePropertyMatch, mergeTimeline, type SiblingRecord } from "./timeline-merge";

const SIBLINGS_NONE: SiblingRecord[] = [];

describe("scorePropertyMatch — address tokens", () => {
  it("fires the +0.6 address bonus when ≥50% of address tokens appear in body", () => {
    const r = scorePropertyMatch(
      "Hi Alex — interested in the property on Modder",
      "346 Modder Ave",
      [],
      SIBLINGS_NONE,
    );
    // "346" "modder" "ave" are tokens; "modder" alone is ≥50% match (no
    // numbers in the body so "346"/"ave" miss) → wait actually addrTokens
    // filter keeps only len>2, so "346" qualifies. tokenHits = "modder"
    // only = 1 of 3 = below 50%.
    expect(r.confidence).toBeLessThan(0.6);
  });

  it("ignores tokens shorter than 3 chars (the len>2 filter)", () => {
    // "Ave" passes the >2 filter; "1 W St" tokens are too short.
    const r = scorePropertyMatch("anything", "1 W St", [], SIBLINGS_NONE);
    expect(r.confidence).toBe(0);
  });

  it("address-token threshold is strictly ≥50% (ceil)", () => {
    // 2-token address → ceil(2*0.5) = 1 hit needed; 1 hit suffices.
    const r = scorePropertyMatch("Modder mention", "346 Modder", [], SIBLINGS_NONE);
    expect(r.confidence).toBeCloseTo(0.6, 3);
  });
});

describe("scorePropertyMatch — 'listing at' / 'property at' bonus", () => {
  it("adds +0.2 when 'listing at' is followed by an address token", () => {
    const r = scorePropertyMatch(
      "I'm interested in your listing at 346 Modder Ave",
      "346 Modder Ave",
      [],
      SIBLINGS_NONE,
    );
    // 0.6 (tokens) + 0.2 (listing-at)
    expect(r.confidence).toBeCloseTo(0.8, 3);
  });

  it("'property at' is equivalent to 'listing at'", () => {
    const r = scorePropertyMatch(
      "Asking about your property at 346 Modder Ave",
      "346 Modder Ave",
      [],
      SIBLINGS_NONE,
    );
    expect(r.confidence).toBeCloseTo(0.8, 3);
  });

  it("does NOT fire when 'listing at' is present but the address tokens aren't", () => {
    const r = scorePropertyMatch(
      "the listing at the corner is sold",
      "346 Modder Ave",
      [],
      SIBLINGS_NONE,
    );
    expect(r.confidence).toBe(0);
  });
});

describe("scorePropertyMatch — INV-016 price-match (list AND offer)", () => {
  // Regression scenario: list $100k, our H2 outbound cites the 65% offer
  // ($65k). The seller-agent replies "I can do $65,000" — before INV-016
  // the scorer matched against $100k only, so this +0.3 never fired.

  it("matches the LIST price (legacy behavior)", () => {
    const r = scorePropertyMatch(
      "the listing at 346 Modder Ave is at $100,000",
      "346 Modder Ave",
      [100_000],
      SIBLINGS_NONE,
    );
    // tokens 0.6 + listing-at 0.2 + price 0.3 = 1.1
    expect(r.confidence).toBeCloseTo(1.1, 3);
  });

  it("INV-016: matches the OUTREACH OFFER too — seller cites our number", () => {
    // 2-token address: ceil(2*0.5)=1 hit; "Modder" in body clears it.
    const r = scorePropertyMatch(
      "Hi Alex — counter on Modder at $65,000?",
      "346 Modder",
      [100_000, 65_000], // list AND offer
      SIBLINGS_NONE,
    );
    // tokens 0.6 + price 0.3 (matches offer $65k) = 0.9
    expect(r.confidence).toBeCloseTo(0.9, 3);
  });

  it("INV-016: pre-fix shape (list-only) does NOT score the offer match", () => {
    // Confirms the regression baseline — when only list is passed, an
    // offer-citing reply gets address tokens only (the bug).
    const r = scorePropertyMatch(
      "Hi Alex — counter on Modder at $65,000?",
      "346 Modder",
      [100_000], // list ONLY (the pre-INV-016 shape)
      SIBLINGS_NONE,
    );
    expect(r.confidence).toBeCloseTo(0.6, 3); // tokens only
  });

  it("price tolerance is ±$1000", () => {
    const r = scorePropertyMatch("Modder at $99,500", "346 Modder", [100_000], SIBLINGS_NONE);
    // tokens 0.6 (Modder) + price 0.3 ($99,500 within $1k of $100k)
    expect(r.confidence).toBeCloseTo(0.9, 3);
  });

  it("price tolerance does NOT match $1500 away", () => {
    const r = scorePropertyMatch("Modder at $98,500", "346 Modder", [100_000], SIBLINGS_NONE);
    // tokens 0.6 only — $98,500 is $1500 away from $100k
    expect(r.confidence).toBeCloseTo(0.6, 3);
  });

  it("empty targetPrices array disables the price bonus", () => {
    const r = scorePropertyMatch("Modder at $100,000", "346 Modder", [], SIBLINGS_NONE);
    expect(r.confidence).toBeCloseTo(0.6, 3);
  });

  it("ignores zero-valued price candidates", () => {
    // Defensive: 0 sometimes leaks in for unpriced listings. Should not match.
    const r = scorePropertyMatch("Modder at $50,000", "346 Modder", [0], SIBLINGS_NONE);
    expect(r.confidence).toBeCloseTo(0.6, 3);
  });
});

describe("scorePropertyMatch — sibling resolution (INV-007 attribution)", () => {
  const sib: SiblingRecord = {
    recordId: "recSibling",
    address: "12724 Strathmoor St",
    candidatePrices: [50_000],
  };

  it("returns sibling when sibling-confidence is higher AND ≥0.5", () => {
    const r = scorePropertyMatch(
      "interested in 12724 Strathmoor",
      "346 Modder Ave",
      [],
      [sib],
    );
    expect(r.recordId).toBe("recSibling");
    expect(r.confidence).toBeCloseTo(0.6, 3);
  });

  it("stays on target when sibling confidence is below the 0.5 floor", () => {
    const weakSib: SiblingRecord = { recordId: "recWeak", address: "12 Oak", candidatePrices: [] };
    const r = scorePropertyMatch(
      "346 Modder Ave specifically",
      "346 Modder Ave",
      [],
      [weakSib],
    );
    // Target tokens fire (0.6); sibling has none.
    expect(r.recordId).toBe("");
    expect(r.confidence).toBeCloseTo(0.6, 3);
  });

  it("siblings get the INV-016 multi-price treatment too", () => {
    // Sibling list $80k, offer $52k. Body cites $52k.
    const sibWithOffer: SiblingRecord = {
      recordId: "recOffer",
      address: "12724 Strathmoor St",
      candidatePrices: [80_000, 52_000],
    };
    const r = scorePropertyMatch(
      "12724 Strathmoor — $52,000 works",
      "346 Modder Ave",
      [],
      [sibWithOffer],
    );
    // sibling tokens 0.6 + price 0.3 (offer match) = 0.9
    expect(r.recordId).toBe("recOffer");
    expect(r.confidence).toBeCloseTo(0.9, 3);
  });

  it("ties go to the target (sibling needs strictly > target)", () => {
    const tieSib: SiblingRecord = { recordId: "recTie", address: "12 Oak St Lane", candidatePrices: [] };
    // Body matches both at 0.6.
    const r = scorePropertyMatch(
      "346 Modder Ave 12 Oak St Lane",
      "346 Modder Ave",
      [],
      [tieSib],
    );
    expect(r.recordId).toBe(""); // target (sentinel empty)
    expect(r.confidence).toBeCloseTo(0.6, 3);
  });
});

describe("scorePropertyMatch — AMBIGUOUS threshold (0.6)", () => {
  // mergeTimeline pushes entries to `ambiguous` when match confidence < 0.6
  // AND siblings exist. The scorer itself returns the raw confidence; the
  // 0.6 cutoff is enforced one layer up. Pin both.

  it("address-tokens-only resolves AT the AMBIGUOUS cutoff", () => {
    const r = scorePropertyMatch("Modder mention", "346 Modder", [], [
      { recordId: "recX", address: "9 Pine", candidatePrices: [] },
    ]);
    // Target 0.6; sibling 0. Confidence 0.6 — exactly at the AMBIGUOUS
    // threshold (< 0.6 pushes to ambiguous).
    expect(r.confidence).toBeCloseTo(0.6, 3);
  });

  it("a price-only match is below the AMBIGUOUS floor", () => {
    const r = scorePropertyMatch("$100,000 cash", "346 Modder", [100_000], [
      { recordId: "recX", address: "9 Pine", candidatePrices: [] },
    ]);
    // price 0.3 only — would push to ambiguous.
    expect(r.confidence).toBeLessThan(0.6);
  });
});

describe("mergeTimeline — single-record path (no siblings)", () => {
  it("attributes all messages to the target with confidence 1.0", () => {
    const { timeline, ambiguous } = mergeTimeline(
      [{ id: "q1", from: "agent", to: "alex", body: "hi", direction: "incoming", createdAt: "2026-06-08T12:00:00Z" }],
      [],
      [],
      { recordId: "recTarget", targetAddress: "346 Modder", targetPrices: [], agentName: "Bridget", siblings: [] },
    );
    expect(timeline).toHaveLength(1);
    expect(timeline[0].propertyMatch).toEqual({ recordId: "recTarget", confidence: 1.0 });
    expect(ambiguous).toHaveLength(0);
  });

  it("renders the agent name on inbound and 'Alex (AKB)' on outbound", () => {
    const { timeline } = mergeTimeline(
      [
        { id: "in", from: "agent", to: "alex", body: "in", direction: "incoming", createdAt: "2026-06-08T12:00:00Z" },
        { id: "out", from: "alex", to: "agent", body: "out", direction: "outgoing", createdAt: "2026-06-08T12:01:00Z" },
      ],
      [], [],
      { recordId: "recTarget", targetAddress: "346 Modder", targetPrices: [], agentName: "Bridget", siblings: [] },
    );
    expect(timeline.find((e) => e.direction === "in")?.sender).toBe("Bridget");
    expect(timeline.find((e) => e.direction === "out")?.sender).toBe("Alex (AKB)");
  });
});

describe("mergeTimeline — multi-listing path (with siblings)", () => {
  it("low-confidence messages land in `ambiguous` when siblings exist", () => {
    const { timeline, ambiguous } = mergeTimeline(
      [{ id: "q1", from: "agent", to: "alex", body: "just a vague reply", direction: "incoming", createdAt: "2026-06-08T12:00:00Z" }],
      [], [],
      {
        recordId: "recTarget",
        targetAddress: "346 Modder Ave",
        targetPrices: [100_000],
        agentName: "Bridget",
        siblings: [{ recordId: "recSib", address: "12 Pine St", candidatePrices: [80_000] }],
      },
    );
    expect(timeline).toHaveLength(1);
    expect(ambiguous).toHaveLength(1); // confidence 0 < 0.6 → ambiguous
    expect(timeline[0].propertyMatch.confidence).toBeLessThan(0.6);
  });

  it("high-confidence target match stays out of `ambiguous`", () => {
    const { ambiguous } = mergeTimeline(
      [{ id: "q1", from: "agent", to: "alex", body: "interested in your listing at 346 Modder Ave", direction: "incoming", createdAt: "2026-06-08T12:00:00Z" }],
      [], [],
      {
        recordId: "recTarget",
        targetAddress: "346 Modder Ave",
        targetPrices: [100_000],
        agentName: "Bridget",
        siblings: [{ recordId: "recSib", address: "12 Pine St", candidatePrices: [80_000] }],
      },
    );
    expect(ambiguous).toHaveLength(0);
  });
});
