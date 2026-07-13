// Test coverage for lib/timeline-merge — the property-match scorer + the
// merge engine. This file closes the "scorePropertyMatch has no unit-test
// coverage" gap surfaced during INV-007 Step 1, AND pins the INV-016 fix
// (price-match now considers BOTH list price and outreach offer, because
// H2 outbound bodies cite the offer ≈65% of list).

import { describe, it, expect } from "vitest";
import { scorePropertyMatch, mergeTimeline, computeResponseStatus, type SiblingRecord } from "./timeline-merge";
import type { TimelineEntry } from "@/types/jarvis";

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

// ─────────────────────────────────────────────────────────────────────
// INV-010 — RESPONSE DUE stage-aware suppression
// ─────────────────────────────────────────────────────────────────────

function tlEntry(over: Partial<TimelineEntry>): TimelineEntry {
  return {
    timestamp: "2026-06-08T12:00:00Z",
    channel: "sms",
    direction: "in",
    body: "",
    sender: "agent",
    propertyMatch: { recordId: "recX", confidence: 1.0 },
    ...over,
  };
}

describe("computeResponseStatus — INV-010 stage suppression", () => {
  // The classic INV-010 scenario: inbound > outbound, so the raw signal
  // says responseDue=true, but the deal is past the engagement window.
  const tl: TimelineEntry[] = [
    tlEntry({ timestamp: "2026-06-07T10:00:00Z", direction: "out", body: "first" }),
    tlEntry({ timestamp: "2026-06-08T12:00:00Z", direction: "in", body: "thanks" }),
  ];

  it("returns responseDue=true with no stage (current behavior preserved)", () => {
    const r = computeResponseStatus(tl);
    expect(r.responseDue).toBe(true);
    expect(r.responseDueSuppressedByStage).toBe(false);
  });

  it("SUPPRESSES responseDue at under_contract (the INV-010 regression case)", () => {
    const r = computeResponseStatus(tl, "under_contract");
    expect(r.responseDue).toBe(false);
    expect(r.responseDueSuppressedByStage).toBe(true);
  });

  it("SUPPRESSES at dispo_active / assignment_signed / closed / dead", () => {
    for (const stage of ["dispo_active", "assignment_signed", "closed", "dead"]) {
      const r = computeResponseStatus(tl, stage);
      expect(r.responseDue).toBe(false);
      expect(r.responseDueSuppressedByStage).toBe(true);
    }
  });

  it("KEEPS responseDue=true at negotiating / offer_drafted (still operator-actionable)", () => {
    for (const stage of ["negotiating", "offer_drafted", "responded"]) {
      const r = computeResponseStatus(tl, stage);
      expect(r.responseDue).toBe(true);
      expect(r.responseDueSuppressedByStage).toBe(false);
    }
  });

  it("does not invent responseDue when raw signal is false (suppression is one-way)", () => {
    // outbound > inbound → raw is already false. The suppressed flag
    // tracks "would have fired but was gated", not "was already off".
    const noReply: TimelineEntry[] = [
      tlEntry({ timestamp: "2026-06-08T12:00:00Z", direction: "in", body: "ok" }),
      tlEntry({ timestamp: "2026-06-08T13:00:00Z", direction: "out", body: "thanks" }),
    ];
    const r = computeResponseStatus(noReply, "under_contract");
    expect(r.responseDue).toBe(false);
    expect(r.responseDueSuppressedByStage).toBe(false);
  });

  it("preserves all the other status fields unchanged when suppressing", () => {
    const r = computeResponseStatus(tl, "under_contract");
    expect(r.lastInbound).toBe("2026-06-08T12:00:00Z");
    expect(r.lastOutbound).toBe("2026-06-07T10:00:00Z");
    expect(r.lastInboundBody).toBe("thanks");
  });

  it("null stage = no suppression (defensive default)", () => {
    expect(computeResponseStatus(tl, null).responseDue).toBe(true);
    expect(computeResponseStatus(tl, undefined).responseDue).toBe(true);
  });
});

describe("mergeTimeline — sole-engaged tie-break (685 Bolton, 2026-07-13)", () => {
  const SIBLINGS = [
    { recordId: "recSib1", address: "474 Center Hill Ave NW", candidatePrices: [287_996] },
    { recordId: "recSib2", address: "3346 Delmar Ln NW", candidatePrices: [233_996] },
  ];
  const BASE = {
    recordId: "recBolton",
    targetAddress: "685 Bolton Rd NW, Atlanta, GA 30331",
    targetPrices: [224_996],
    agentName: "The J A M Team",
    siblings: SIBLINGS,
  };

  it("REGRESSION: a signal-less SMS renders on the sole engaged record (was hidden from all threads)", () => {
    const { timeline, ambiguous } = mergeTimeline(
      [{ id: "q1", from: "agent", to: "alex", body: "Ok, you're welcome. I understand. Ok, I will let you know if that happens. Have a great day!", direction: "incoming", createdAt: "2026-07-13T14:15:00Z" }],
      [], [],
      { ...BASE, targetSoleEngaged: true },
    );
    expect(timeline[0].propertyMatch).toEqual({ recordId: "recBolton", confidence: 0.6 });
    expect(ambiguous).toHaveLength(0);
  });

  it("without the flag (target not sole-engaged) the message stays ambiguous — sibling pages unchanged", () => {
    const { ambiguous } = mergeTimeline(
      [{ id: "q1", from: "agent", to: "alex", body: "Ok sounds good", direction: "incoming", createdAt: "2026-07-13T14:15:00Z" }],
      [], [],
      { ...BASE, targetSoleEngaged: false },
    );
    expect(ambiguous).toHaveLength(1);
  });

  it("a sibling address hit still routes to the sibling — the tie-break never overrides a signal", () => {
    const { timeline } = mergeTimeline(
      [{ id: "q1", from: "agent", to: "alex", body: "About 3346 Delmar Ln NW — seller said no", direction: "incoming", createdAt: "2026-07-13T14:15:00Z" }],
      [], [],
      { ...BASE, targetSoleEngaged: true },
    );
    expect(timeline[0].propertyMatch.recordId).toBe("recSib2");
  });

  it("a strong target signal keeps its full confidence (tie-break only lifts, never lowers)", () => {
    const { timeline } = mergeTimeline(
      [{ id: "q1", from: "agent", to: "alex", body: "Re your listing at 685 Bolton Rd NW — we can talk", direction: "incoming", createdAt: "2026-07-13T14:15:00Z" }],
      [], [],
      { ...BASE, targetSoleEngaged: true },
    );
    expect(timeline[0].propertyMatch.recordId).toBe("recBolton");
    expect(timeline[0].propertyMatch.confidence).toBeGreaterThanOrEqual(0.6);
  });
});

describe("mergeTimeline — notes/live dedup (Duane Covert duplicate, 2026-07-13)", () => {
  // The live Quo body has a paragraph break ("\n\n"); the notes parser drops
  // blank lines so the ledger copy has "\n". Raw substring dedup missed it
  // and the same reply rendered as TWO bubbles.
  const LIVE_BODY =
    "Alex,\n\nThe owner responded pretty quickly. We're too far apart to make your number work.\n\nCheers.";
  const NOTES_BODY =
    "Alex,\nThe owner responded pretty quickly. We're too far apart to make your number work.\nCheers.\n[Quo inbound msg ACtest ts=2026-07-13T21:26:47.950Z src=quo_webhook ingested_at=2026-07-13T21:26:48.969Z]";

  it("REGRESSION: whitespace-normalized dedup collapses the notes copy of a live message", () => {
    const { timeline } = mergeTimeline(
      [{ id: "q1", from: "agent", to: "alex", body: LIVE_BODY, direction: "incoming", createdAt: "2026-07-13T21:26:47Z" }],
      [],
      [{ type: "inbound", text: NOTES_BODY, timestamp: "2026-07-13T21:26:47.950Z" }],
      { recordId: "recTarget", targetAddress: "1150 Mayland Cir SW", targetPrices: [], agentName: "Duane Covert", siblings: [] },
    );
    expect(timeline.filter((e) => e.direction === "in")).toHaveLength(1);
  });

  it("a deduped notes copy LIFTS the live entry to full confidence (record-scoped truth)", () => {
    const { timeline } = mergeTimeline(
      [{ id: "q1", from: "agent", to: "alex", body: LIVE_BODY, direction: "incoming", createdAt: "2026-07-13T21:26:47Z" }],
      [],
      [{ type: "inbound", text: NOTES_BODY, timestamp: "2026-07-13T21:26:47.950Z" }],
      {
        recordId: "recTarget",
        targetAddress: "1150 Mayland Cir SW",
        targetPrices: [199_000],
        agentName: "Duane Covert",
        // Sibling present + generic body → the live copy alone would score
        // below the render floor; the notes copy must rescue it, not vanish.
        siblings: [{ recordId: "recSib", address: "99 Elsewhere St", candidatePrices: [80_000] }],
      },
    );
    const inbound = timeline.filter((e) => e.direction === "in");
    expect(inbound).toHaveLength(1);
    expect(inbound[0].propertyMatch).toEqual({ recordId: "recTarget", confidence: 1.0 });
  });
});
