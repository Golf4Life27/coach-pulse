// Pure tests for the crawler auto-promote decision.

import { describe, it, expect } from "vitest";
import { shouldAutoPromote, type AutoPromoteInput } from "./auto-promote";

function input(over: Partial<AutoPromoteInput> = {}): AutoPromoteInput {
  return {
    accepted: true,
    agentPhone: "(210) 555-1234",
    state: "TX",
    listPrice: 185000,
    ...over,
  };
}

describe("shouldAutoPromote", () => {
  it("promotes a clean accept with a normalizable phone in a non-restricted state", () => {
    expect(shouldAutoPromote(input())).toEqual({ promote: true, reason: null });
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
});
