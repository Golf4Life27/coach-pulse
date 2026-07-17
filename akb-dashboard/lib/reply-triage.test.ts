import { describe, it, expect } from "vitest";
import { classifyReply, determineNewStatus, triageSellerReply } from "./reply-triage";

describe("classifyReply", () => {
  it("HARD rejection (compliance + gone-deals) wins even when a price is present", () => {
    expect(classifyReply("under contract").classification).toBe("rejection");
    expect(classifyReply("please remove my number").classification).toBe("rejection");
    expect(classifyReply("STOP").classification).toBe("rejection");
    expect(classifyReply("it sold last week for $90k").classification).toBe("rejection");
  });

  it("SOFT-NO (P1 2026-07-08): stance rejections classify and stay alive", () => {
    // The 2718 Ave I anchor case — died "L3: UNCLASSIFIED" under the old list:
    expect(classifyReply("No go").classification).toBe("soft_no");
    expect(classifyReply("no").classification).toBe("soft_no");
    expect(classifyReply("Nope").classification).toBe("soft_no");
    expect(classifyReply("not interested at $200k").classification).toBe("soft_no");
    expect(classifyReply("no thanks").classification).toBe("soft_no");
    expect(classifyReply("owner is not selling right now").classification).toBe("soft_no");
    expect(classifyReply("we're good, all set").classification).toBe("soft_no");
    expect(classifyReply("the house is not for sale").classification).toBe("soft_no");
    // pricing-flavored soft-nos:
    expect(classifyReply("too low").classification).toBe("soft_no");
    expect(classifyReply("seller is firm at asking").classification).toBe("soft_no");
    // bare-"no" must NOT fire inside longer unrelated sentences:
    expect(classifyReply("no problem, when can you close?").classification).not.toBe("soft_no");
  });

  it("counter needs BOTH a price token and counter language", () => {
    expect(classifyReply("seller is looking for $185,000").classification).toBe("counter");
    expect(classifyReply("can you come up to $190k?").classification).toBe("counter");
    // price but no counter language → interest, not counter
    expect(classifyReply("the price is $185,000").classification).toBe("interest");
  });

  // ── 2026-07-17 regressions: the machine talked past two humans ──────────

  it("NEGATED INTEREST (3226 Cloverhurst): 'aren't interested' is a soft-no, never interest", () => {
    // Verbatim — this classified INTEREST (0.9) and triggered a "glad
    // there's interest" auto-ack. The bare \binterested\b pattern matched
    // inside the negation.
    const cloverhurst = classifyReply(
      "Hi Alex! It's a fast no at $156K. The sellers aren't interested in low ball offers.",
    );
    expect(cloverhurst.classification).toBe("soft_no");
    // The follow-up correction, verbatim:
    expect(
      classifyReply(
        "You misread my text. There is no interest in any lowball offers. If you all aren't submitting an offer that is at or close to the listing price my clients are not interested. Thank you.",
      ).classification,
    ).toBe("soft_no");
    // Other negation shapes:
    expect(classifyReply("Seller isn't interested").classification).toBe("soft_no");
    expect(classifyReply("we are no longer interested").classification).toBe("soft_no");
    expect(classifyReply("that's a hard no").classification).toBe("soft_no");
    expect(classifyReply("It's a no for now").classification).toBe("soft_no");
    expect(classifyReply("quit lowballing us").classification).toBe("soft_no");
    // The un-negated forms still read as interest:
    expect(classifyReply("The seller is interested, call me").classification).toBe("interest");
  });

  it("negated-interest routes as a PRICING decision when lowball/price language is present", () => {
    const t = triageSellerReply(
      "Hi Alex! It's a fast no at $156K. The sellers aren't interested in low ball offers.",
      "Texted",
    );
    expect(t.classification).toBe("soft_no");
    expect(t.decisionKind).toBe("pricing");
    expect(t.suggestedReply).toBeTruthy(); // 2A re-engagement draft, operator-approved
  });

  it("MULTIPLIER COUNTER (7714 E Canfield): 'double it' is a counter with no $ token", () => {
    // Verbatim — both fell to UNKNOWN and the thread kept getting robo-bumped.
    expect(classifyReply("Youll need to double it").classification).toBe("counter");
    expect(
      classifyReply("I said you would have to double it. Im not sure how or why you would think my client would accept that.").classification,
    ).toBe("counter");
    expect(classifyReply("you'd have to double your offer").classification).toBe("counter");
  });

  it("interest patterns", () => {
    expect(classifyReply("yes send me the offer").classification).toBe("interest");
    expect(classifyReply("can you send proof of funds?").classification).toBe("interest");
  });

  it("blank / unmatched → unknown", () => {
    expect(classifyReply("").classification).toBe("unknown");
    expect(classifyReply("ok").classification).toBe("unknown");
  });

  it("rejection patches (2026-06-10): the Freeland phrase + other 'comparing offers' shapes", () => {
    // The exact reply we hit 2026-06-10 (13235 Freeland; first live reply).
    expect(classifyReply("Hi theyre in the process of accepting a much higher offer").classification).toBe("rejection");
    // Other 'comparing-to-another-offer' shapes that should also route to Dead.
    expect(classifyReply("we have a higher offer already").classification).toBe("rejection");
    expect(classifyReply("got a better offer this morning").classification).toBe("rejection");
    expect(classifyReply("seller is going with another buyer").classification).toBe("rejection");
    expect(classifyReply("property is in escrow").classification).toBe("rejection");
    expect(classifyReply("seller accepted an offer yesterday").classification).toBe("rejection");
  });

  it("the patches do NOT false-positive on our own outbound shapes or interest replies", () => {
    // 'cash offer at $X' is OUR template, but it's stripped by isSelfEchoOrAutoreply
    // BEFORE triage — the patches don't see it. Confirm the patches don't fire on
    // a generic 'send me a higher offer' which is INTEREST, not rejection.
    expect(classifyReply("can you send me a higher offer").classification).not.toBe("rejection");
    expect(classifyReply("yes interested").classification).toBe("interest");
  });

  it("acceptance: strong-buy signals classify as acceptance and are checked BEFORE rejection", () => {
    expect(classifyReply("send me the contract").classification).toBe("acceptance");
    expect(classifyReply("seller will take it").classification).toBe("acceptance");
    expect(classifyReply("we accept your offer").classification).toBe("acceptance");
    expect(classifyReply("your offer is accepted").classification).toBe("acceptance");
    expect(classifyReply("let's do it").classification).toBe("acceptance");
    // The rejection patch ("accepted ... offer" comparison shape) must NOT
    // eat a true acceptance:
    expect(classifyReply("seller accepted your offer, send the contract").classification).toBe("acceptance");
    // And the Freeland comparison shape stays a rejection:
    expect(classifyReply("theyre in the process of accepting a much higher offer").classification).toBe("rejection");
  });

  it("UNCLASSIFIED fallback preserved — ambiguous still routes to manual review (not bypassed)", () => {
    // The patches SHRINK the UNCLASSIFIED bucket toward rejection where the
    // signal is clear, but genuinely-ambiguous replies still land in unknown.
    // The fallback path (determineNewStatus("unknown", "Texted")) keeps the
    // record at Response Received for operator review — never Dead-by-default.
    expect(classifyReply("hmm let me check").classification).toBe("unknown");
    expect(classifyReply("call me later").classification).toBe("interest"); // existing 'call me' pattern wins
    expect(determineNewStatus("unknown", "Texted")).toBe("Response Received");
  });
});

describe("determineNewStatus", () => {
  it("rejection → Dead", () => {
    expect(determineNewStatus("rejection", "Texted")).toBe("Dead");
  });
  it("counter → Counter Received (resurrects Dead), no-op if already there", () => {
    expect(determineNewStatus("counter", "Texted")).toBe("Counter Received");
    expect(determineNewStatus("counter", "Dead")).toBe("Counter Received");
    expect(determineNewStatus("counter", "Counter Received")).toBeNull();
  });
  it("interest → Negotiating", () => {
    expect(determineNewStatus("interest", "Texted")).toBe("Negotiating");
  });
  it("unknown promotes only a still-Texted record", () => {
    expect(determineNewStatus("unknown", "Texted")).toBe("Response Received");
    expect(determineNewStatus("unknown", "Negotiating")).toBeNull();
  });
  it("unknown also promotes a Parked record (rebuild-stale-deal-handling 2026-06-14)", () => {
    // A Parked record is one that aged into the cold follow-up loop. A
    // belated reply on it is STILL the same Response-Received transition
    // — must promote so autoRunOnEngaged fires the re-price.
    expect(determineNewStatus("unknown", "Parked")).toBe("Response Received");
  });
});

describe("triageSellerReply — alert tiers (operator 2026-06-10; soft-no carve-out 2026-07-08)", () => {
  it("HARD rejection → tier_0_auto_close (system close, no alert)", () => {
    expect(triageSellerReply("under contract", "Texted").tier).toBe("tier_0_auto_close");
    expect(triageSellerReply("STOP", "Texted").tier).toBe("tier_0_auto_close");
  });

  it("soft-no → tier_1 with the 2A re-engagement draft; sticky number verbatim or ABSENT", () => {
    const t = triageSellerReply("No go", "Texted", { sentOfferUsd: 12_000, street: "2718 Ave I" });
    expect(t.classification).toBe("soft_no");
    expect(t.tier).toBe("tier_1_decision");
    expect(t.needsDecision).toBe(true);
    expect(t.queueStatus).toBe("Response Received");
    expect(t.suggestedReply).toContain("$12,000");
    expect(t.suggestedReply).toContain("2718 Ave I");
    // no delivery-stamped number → the draft carries NO dollar figure (never invents):
    expect(triageSellerReply("no thanks", "Texted", {}).suggestedReply).not.toMatch(/\$\d/);
    // price objection → pricing decision:
    expect(triageSellerReply("that's too low", "Texted").decisionKind).toBe("pricing");
    // soft-no never downgrades an advanced record:
    expect(triageSellerReply("not right now", "Negotiating").queueStatus).toBeNull();
    // "not interested" moved OUT of auto-close — it now queues for the operator:
    expect(triageSellerReply("not interested", "Texted").tier).toBe("tier_1_decision");
  });
  it("counter / interest / unknown → tier_1_decision", () => {
    expect(triageSellerReply("seller is looking for $185,000", "Texted").tier).toBe("tier_1_decision");
    expect(triageSellerReply("yes send me the offer", "Texted").tier).toBe("tier_1_decision");
    expect(triageSellerReply("hmm let me check", "Texted").tier).toBe("tier_1_decision");
  });
  it("acceptance → tier_2_urgent, status routes to Offer Accepted", () => {
    const t = triageSellerReply("seller will take it", "Texted");
    expect(t.tier).toBe("tier_2_urgent");
    expect(t.classification).toBe("acceptance");
    expect(t.queueStatus).toBe("Offer Accepted");
    expect(t.needsDecision).toBe(true);
  });
});

describe("triageSellerReply", () => {
  it("counter → pricing decision, HIGH, holds the floor in the reasoning", () => {
    const t = triageSellerReply("seller is looking for $185,000", "Texted");
    expect(t.classification).toBe("counter");
    expect(t.needsDecision).toBe(true);
    expect(t.decisionKind).toBe("pricing");
    expect(t.priority).toBe("HIGH");
    expect(t.queueStatus).toBe("Counter Received");
    expect(t.reasoning).toMatch(/sticky floor/i);
  });

  it("interest → engagement decision, HIGH, Negotiating", () => {
    const t = triageSellerReply("yes send me the offer", "Texted");
    expect(t.decisionKind).toBe("engagement");
    expect(t.priority).toBe("HIGH");
    expect(t.queueStatus).toBe("Negotiating");
  });

  it("rejection → no decision (downgrade), NORMAL, Dead", () => {
    const t = triageSellerReply("not interested, stop", "Texted");
    expect(t.needsDecision).toBe(false);
    expect(t.decisionKind).toBe("none");
    expect(t.queueStatus).toBe("Dead");
  });

  it("unknown genuine reply → review decision, only promotes a Texted record", () => {
    const t = triageSellerReply("ok", "Texted");
    expect(t.needsDecision).toBe(true);
    expect(t.decisionKind).toBe("review");
    expect(t.queueStatus).toBe("Response Received");
    const t2 = triageSellerReply("ok", "Negotiating");
    expect(t2.queueStatus).toBeNull(); // never downgrades an advanced record
  });
});
