import { describe, it, expect } from "vitest";
import { buildReplyAlertBody, alertAction, alertRecommendation } from "./reply-alert";

describe("buildReplyAlertBody — tiered, decision-first (operator 2026-06-10)", () => {
  it("tier 1 counter: leads with DECISION NEEDED, short address, action, recommendation with real numbers, link", () => {
    const { body, priceGap } = buildReplyAlertBody({
      recordId: "recVOZVgXT0GPenAt",
      address: "15864 Tracey St, Detroit, MI 48227",
      tier: "tier_1_decision",
      classification: "counter",
      outreachOfferPrice: 48750,
      underwrittenMao: 50000,
    });
    expect(body).toMatch(/^DECISION NEEDED: 15864 Tracey St\./);
    expect(body).toContain("Agent countered");
    expect(body).toContain("Recommend: hold at $48,750 (MAO $50,000)");
    expect(body).toContain("/pipeline/recVOZVgXT0GPenAt");
    expect(priceGap).toBe(false);
  });

  it("tier 1 counter with MISSING numbers: falls back to 'hold sticky opener' + flags the gap — never fabricates", () => {
    const { body, priceGap } = buildReplyAlertBody({
      recordId: "recA",
      address: "1 Main St, Detroit, MI",
      tier: "tier_1_decision",
      classification: "counter",
      outreachOfferPrice: null,
      underwrittenMao: null,
    });
    expect(body).toContain("Recommend: hold sticky opener");
    expect(body).not.toContain("$"); // no invented number anywhere
    expect(priceGap).toBe(true);
  });

  it("tier 1 interest: 'advance to offer or DD'", () => {
    const { body } = buildReplyAlertBody({
      recordId: "recB",
      address: "2 Oak St, Detroit, MI",
      tier: "tier_1_decision",
      classification: "interest",
    });
    expect(body).toContain("Agent is interested");
    expect(body).toContain("Recommend: advance to offer or DD");
  });

  it("tier 1 unknown: 'operator review'", () => {
    const { body } = buildReplyAlertBody({
      recordId: "recC",
      address: "3 Elm St, Detroit, MI",
      tier: "tier_1_decision",
      classification: "unknown",
    });
    expect(body).toContain("Agent replied, intent unclear");
    expect(body).toContain("Recommend: operator review");
  });

  it("tier 2 acceptance: ACT NOW prefix, action, link — no recommendation line", () => {
    const { body } = buildReplyAlertBody({
      recordId: "recD",
      address: "4 Pine St, Detroit, MI 48227",
      tier: "tier_2_urgent",
      classification: "acceptance",
    });
    expect(body).toMatch(/^ACT NOW: 4 Pine St\./);
    expect(body).toContain("Seller said yes, draft contract");
    expect(body).toContain("/pipeline/recD");
    expect(body).not.toContain("Recommend:");
  });

  it("STANDING RULE: the body never includes the inbound text (it is not even an input)", () => {
    // The type no longer accepts inboundBody — compile-time enforcement.
    // Runtime spot-check: nothing in the composed body except the decision
    // scaffolding + record facts.
    const { body } = buildReplyAlertBody({
      recordId: "recE",
      address: "5 Cedar St",
      tier: "tier_1_decision",
      classification: "interest",
    });
    expect(body).toBe(
      `DECISION NEEDED: 5 Cedar St. Agent is interested. Recommend: advance to offer or DD. ${body.split(" ").pop()}`,
    );
  });

  it("missing address falls back gracefully", () => {
    const { body } = buildReplyAlertBody({
      recordId: "recF",
      address: null,
      tier: "tier_1_decision",
      classification: "unknown",
    });
    expect(body).toContain("unknown address");
  });
});

describe("alertAction / alertRecommendation", () => {
  it("maps every classification to an action", () => {
    expect(alertAction("counter")).toBe("Agent countered");
    expect(alertAction("interest")).toBe("Agent is interested");
    expect(alertAction("acceptance")).toBe("Seller said yes, draft contract");
    expect(alertAction("unknown")).toBe("Agent replied, intent unclear");
  });

  it("counter recommendation requires BOTH opener and MAO present", () => {
    expect(alertRecommendation({ recordId: "r", address: null, tier: "tier_1_decision", classification: "counter", outreachOfferPrice: 48750, underwrittenMao: null }).priceGap).toBe(true);
    expect(alertRecommendation({ recordId: "r", address: null, tier: "tier_1_decision", classification: "counter", outreachOfferPrice: null, underwrittenMao: 50000 }).priceGap).toBe(true);
  });
});

// THE 2026-08-06 MISS (257 Chalmers Dr NW, 2241 1st St): a bare "No" paged the
// operator as "intent unclear". classifyReply had matched it exactly, triage
// had already drafted the re-engagement — only the alert's switch was missing
// a case, so the system reported confusion it did not have.
describe("alertAction covers EVERY classification triage can produce", () => {
  it("names a soft no instead of calling it unclear", () => {
    expect(alertAction("soft_no")).toBe("Agent declined, re-engagement drafted");
  });

  it("names the high-intent replies that were also falling through", () => {
    // An agent proposing a showing is the closest thing to a yes that exists
    // before a contract. It must never render as confusion.
    expect(alertAction("appointment")).toBe("Agent proposed a showing/call time");
    expect(alertAction("offer_format")).toBe("Agent wants the offer in writing");
    expect(alertAction("seller_costs")).toBe("Agent asked who pays what");
    expect(alertAction("disclosure_step")).toBe("Compliance disclosure — needs you personally");
  });

  it("reserves 'intent unclear' for the ONLY case that is genuinely unclear", () => {
    expect(alertAction("unknown")).toBe("Agent replied, intent unclear");
  });

  it("no classification but 'unknown' may claim confusion", () => {
    // Guards the regression directly: if a future classification renders as
    // "intent unclear", it is either genuinely unknown or this test fails.
    const named = ["acceptance", "counter", "interest", "rejection", "soft_no",
      "offer_format", "appointment", "seller_costs", "disclosure_step"] as const;
    for (const c of named) {
      expect(alertAction(c)).not.toMatch(/intent unclear/);
    }
  });
});
