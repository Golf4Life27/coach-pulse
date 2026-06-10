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
