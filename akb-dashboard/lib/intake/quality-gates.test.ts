// Phase 1.4 + 1.5 + 1.7 / Q.5 — intake-gate tests.

import { describe, it, expect } from "vitest";
import {
  detectOffMarketLanguage,
  runIntakeGates,
  scoreFlipKeywords,
  validateAgentPhone,
} from "./quality-gates";

describe("detectOffMarketLanguage (1.4)", () => {
  it("flags off-market signals", () => {
    expect(detectOffMarketLanguage("This property is under contract").action).toBe("manual_review");
    expect(detectOffMarketLanguage("Sale pending sale").action).toBe("manual_review");
    expect(detectOffMarketLanguage("Off the market last week").action).toBe("manual_review");
    expect(detectOffMarketLanguage("Just sold to neighbor").action).toBe("manual_review");
  });

  it("passes clean listing text", () => {
    expect(detectOffMarketLanguage("3BR/2BA brick home, motivated seller").action).toBe("pass");
  });

  it("returns matches list for audit", () => {
    const r = detectOffMarketLanguage("This is under contract and pending sale");
    expect(r.matches).toContain("under_contract");
    expect(r.matches).toContain("pending_sale");
  });

  it("empty body passes", () => {
    expect(detectOffMarketLanguage("").action).toBe("pass");
    expect(detectOffMarketLanguage(null).action).toBe("pass");
    expect(detectOffMarketLanguage(undefined).action).toBe("pass");
  });
});

describe("scoreFlipKeywords (1.5)", () => {
  it("low-score → pass", () => {
    const r = scoreFlipKeywords("New roof installed last year");
    expect(r.score).toBe(1);
    expect(r.action).toBe("pass");
  });

  it("4-6 matches → manual_review", () => {
    const r = scoreFlipKeywords(
      "Recently renovated turnkey property — granite, quartz, stainless steel, upgraded throughout",
    );
    expect(r.score).toBeGreaterThanOrEqual(4);
    expect(r.action).toBe("manual_review");
  });

  it("7+ matches → reject (likely competing flipper)", () => {
    const r = scoreFlipKeywords(
      "Brand new, completely remodeled, just flipped, turnkey, move-in ready, granite, quartz, stainless, custom upgraded",
    );
    expect(r.score).toBeGreaterThanOrEqual(7);
    expect(r.action).toBe("reject");
  });

  it("returns matched keywords for audit", () => {
    const r = scoreFlipKeywords("granite countertops and stainless appliances");
    expect(r.matched_keywords.length).toBeGreaterThan(0);
  });

  it("empty body → score 0 / pass", () => {
    expect(scoreFlipKeywords(null).score).toBe(0);
    expect(scoreFlipKeywords(null).action).toBe("pass");
  });
});

describe("validateAgentPhone (1.7)", () => {
  it("standard formats pass", () => {
    expect(validateAgentPhone("(210) 555-0100").action).toBe("pass");
    expect(validateAgentPhone("+1 210 555 0100").action).toBe("pass");
    expect(validateAgentPhone("2105550100").action).toBe("pass");
    expect(validateAgentPhone("210.555.0100").action).toBe("pass");
  });

  it("non-numeric chars → manual_review", () => {
    expect(validateAgentPhone("call me at the office").action).toBe("manual_review");
    expect(validateAgentPhone("agent@example.com").action).toBe("manual_review");
  });

  it("too few digits → manual_review", () => {
    expect(validateAgentPhone("555-12").action).toBe("manual_review");
  });

  it("too many digits → manual_review (e.g., concatenated phones)", () => {
    expect(validateAgentPhone("21055501002105550100").action).toBe("manual_review");
  });

  it("empty/null passes (handled separately)", () => {
    expect(validateAgentPhone("").action).toBe("pass");
    expect(validateAgentPhone(null).action).toBe("pass");
  });
});

describe("runIntakeGates (combined)", () => {
  it("returns worst action across all three gates", () => {
    const r = runIntakeGates({
      body: "Brand new, completely remodeled, just flipped, turnkey, move-in ready, granite, quartz",
      agent_phone: "(210) 555-0100",
    });
    expect(r.action).toBe("reject"); // flip score reject wins
  });

  it("all-clean → pass", () => {
    const r = runIntakeGates({
      body: "Motivated seller, vacant property, owner relocated.",
      agent_phone: "(210) 555-0100",
    });
    expect(r.action).toBe("pass");
  });

  it("off-market + valid phone + low flip score → manual_review", () => {
    const r = runIntakeGates({
      body: "This property is pending sale.",
      agent_phone: "(210) 555-0100",
    });
    expect(r.action).toBe("manual_review");
  });
});
