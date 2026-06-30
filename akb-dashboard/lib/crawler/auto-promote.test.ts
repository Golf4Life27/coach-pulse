// Pure tests for the crawler auto-promote decision.

import { describe, it, expect } from "vitest";
import { shouldAutoPromote, type AutoPromoteInput } from "./auto-promote";

function input(over: Partial<AutoPromoteInput> = {}): AutoPromoteInput {
  return {
    accepted: true,
    agentPhone: "(210) 555-1234",
    state: "TX",
    listPrice: 185000,
    // Operator 2026-06-09: a lead is never outreach-eligible without a
    // computed MAO. Default the fixture to a clean track-aware MAO so the
    // pre-existing tests keep their original intent (the new gate has its
    // own coverage below).
    underwrittenMao: 50000,
    ...over,
  };
}

describe("shouldAutoPromote", () => {
  it("promotes a clean accept with a normalizable phone, non-restricted state, AND an underwritten MAO", () => {
    expect(shouldAutoPromote(input())).toEqual({ promote: true, reason: null });
  });

  it("blocks promote when MAO is not underwritten (intake → underwrite → promote belt)", () => {
    expect(shouldAutoPromote(input({ underwrittenMao: null })).reason).toBe("mao_not_underwritten");
    expect(shouldAutoPromote(input({ underwrittenMao: 0 })).reason).toBe("mao_not_underwritten");
    expect(shouldAutoPromote(input({ underwrittenMao: -1 })).reason).toBe("mao_not_underwritten");
  });

  it("blocks a record the classifier did not accept (Review/condition-missing)", () => {
    expect(shouldAutoPromote(input({ accepted: false }))).toEqual({
      promote: false,
      reason: "not_accepted",
    });
  });

  it("blocks when the agent phone cannot normalize to a US number", () => {
    expect(shouldAutoPromote(input({ agentPhone: null })).reason).toBe("no_agent_phone");
    expect(shouldAutoPromote(input({ agentPhone: "" })).reason).toBe("no_agent_phone");
    expect(shouldAutoPromote(input({ agentPhone: "call the office" })).reason).toBe("no_agent_phone");
    expect(shouldAutoPromote(input({ agentPhone: "jane@kw.com" })).reason).toBe("no_agent_phone");
  });

  it("blocks a wholesale-restricted state", () => {
    for (const st of ["IL", "MO", "SC", "NC", "OK", "ND", " il "]) {
      expect(shouldAutoPromote(input({ state: st })).reason).toBe("wholesale_restricted_state");
    }
  });

  it("blocks when list price is missing or non-positive", () => {
    expect(shouldAutoPromote(input({ listPrice: null })).reason).toBe("list_price_missing");
    expect(shouldAutoPromote(input({ listPrice: 0 })).reason).toBe("list_price_missing");
  });

  it("surfaces the FIRST failing reason in priority order (not_accepted wins)", () => {
    // accepted=false should short-circuit even with a bad phone + restricted state.
    expect(
      shouldAutoPromote({ accepted: false, agentPhone: null, state: "IL", listPrice: null }).reason,
    ).toBe("not_accepted");
  });

  it("normalizes phone formats the same way H2 does (accepts dashed/parenthesized)", () => {
    expect(shouldAutoPromote(input({ agentPhone: "210-555-1234" })).promote).toBe(true);
    expect(shouldAutoPromote(input({ agentPhone: "+12105551234" })).promote).toBe(true);
  });

  // ── OPENER LANE (operator 2026-06-30) ──────────────────────────────────
  it("OPENER LANE: an opener-priceable record promotes WITHOUT a contract MAO", () => {
    // The rough opener computes its ceiling + self-gates at SEND time, so a
    // pre-computed contract MAO is not required to promote. Fix for the starved
    // autonomous queue: intake stopped writing a MAO in the 2026-06-12 keystone
    // rewrite, so every accept had been failing mao_not_underwritten.
    expect(shouldAutoPromote(input({ underwrittenMao: null, openerPriceable: true }))).toEqual({ promote: true, reason: null });
    expect(shouldAutoPromote(input({ underwrittenMao: 0, openerPriceable: true })).promote).toBe(true);
  });

  it("OPENER LANE still enforces the non-MAO gates (accept, phone, state, price)", () => {
    expect(shouldAutoPromote(input({ openerPriceable: true, accepted: false })).reason).toBe("not_accepted");
    expect(shouldAutoPromote(input({ openerPriceable: true, agentPhone: null })).reason).toBe("no_agent_phone");
    expect(shouldAutoPromote(input({ openerPriceable: true, state: "IL" })).reason).toBe("wholesale_restricted_state");
    expect(shouldAutoPromote(input({ openerPriceable: true, listPrice: 0 })).reason).toBe("list_price_missing");
  });

  it("CONTRACT LANE (openerPriceable false/absent) still requires the underwritten MAO", () => {
    expect(shouldAutoPromote(input({ underwrittenMao: null, openerPriceable: false })).reason).toBe("mao_not_underwritten");
    expect(shouldAutoPromote(input({ underwrittenMao: null })).reason).toBe("mao_not_underwritten");
  });
});
