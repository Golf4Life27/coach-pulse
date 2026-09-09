import { describe, it, expect } from "vitest";
import {
  decideAutoAnswer,
  composeSellerCosts,
  composeOfferFormat,
  AUTO_ANSWERABLE,
} from "./auto-answer";
import { IDENTITY_QUESTION_STANDING_ANSWER } from "@/lib/standing-answers";

const base = { inboundBody: "Who pays the back taxes?", live: true };

describe("the closed set — adding to it is a doctrine change", () => {
  it("answers exactly three classifications", () => {
    expect([...AUTO_ANSWERABLE].sort()).toEqual(["identity_question", "offer_format", "seller_costs"]);
  });

  it("identity_question is in the set (operator ruling 2026-09-09)", () => {
    expect(AUTO_ANSWERABLE.has("identity_question")).toBe(true);
  });

  it("REFUSES disclosure_step — the machine never acknowledges a legal disclosure", () => {
    const d = decideAutoAnswer({ ...base, classification: "disclosure_step" });
    expect(d.send).toBe(false);
    expect(d.refusal).toBe("not_auto_answerable");
    expect(d.body).toBeNull();
  });

  it("REFUSES appointment — the machine cannot commit the operator's calendar", () => {
    const d = decideAutoAnswer({ ...base, classification: "appointment" });
    expect(d.send).toBe(false);
    expect(d.refusal).toBe("not_auto_answerable");
  });

  it("REFUSES counter, acceptance and unknown — those are the operator's", () => {
    for (const c of ["counter", "acceptance", "unknown", "interest", "soft_no", "rejection"] as const) {
      expect(decideAutoAnswer({ ...base, classification: c }).send).toBe(false);
    }
  });
});

describe("the amount veto — a number makes it a counter, whatever else it says", () => {
  it("refuses the 9360 Cheyenne shape", () => {
    // The real miss this classification was created for: a costs question with
    // a price buried in it. Answering the costs question would ignore "$230k".
    const d = decideAutoAnswer({
      classification: "seller_costs",
      inboundBody: "There is a water bill, and a tax bill... And I need to be paid $230,000.",
      live: true,
    });
    expect(d.send).toBe(false);
    expect(d.refusal).toBe("amount_in_reply");
    expect(d.detail).toMatch(/counter wearing/);
  });

  it("catches shorthand amounts too", () => {
    const d = decideAutoAnswer({
      classification: "offer_format",
      inboundBody: "Email me the offer, but they want 230k",
      stickyOfferUsd: 74_500,
      live: true,
    });
    expect(d.refusal).toBe("amount_in_reply");
  });

  it("the veto outranks a missing sticky number — order matters", () => {
    // Both would refuse, but the amount is the more important fact to report:
    // "they countered" is actionable, "we had no number" is bookkeeping.
    const d = decideAutoAnswer({
      classification: "offer_format",
      inboundBody: "send it over, seller wants $180,000",
      stickyOfferUsd: null,
      live: true,
    });
    expect(d.refusal).toBe("amount_in_reply");
  });
});

describe("offer_format — restates the sticky number, never invents one", () => {
  it("sends the delivery-stamped number verbatim", () => {
    const d = decideAutoAnswer({
      classification: "offer_format",
      inboundBody: "Hi Alex, you can send any offers over to me and I'll present them to the seller.",
      stickyOfferUsd: 74_500,
      street: "256 Westchester Dr",
      live: true,
    });
    expect(d.send).toBe(true);
    expect(d.body).toContain("$74,500");
    expect(d.body).toContain("256 Westchester Dr");
    expect(d.body).toContain("as-is");
  });

  it("HOLDS when no sticky number exists — inventing a price is the one thing it must not do", () => {
    for (const sticky of [null, undefined, 0, NaN]) {
      const d = decideAutoAnswer({
        classification: "offer_format",
        inboundBody: "Please put it in writing.",
        stickyOfferUsd: sticky as number | null,
        live: true,
      });
      expect(d.send).toBe(false);
      expect(d.refusal).toBe("no_sticky_offer");
      expect(d.body).toBeNull();
    }
  });

  it("quotes exactly one number and it is the sticky one", () => {
    const body = composeOfferFormat({ stickyOfferUsd: 74_500, street: "256 Westchester Dr" });
    expect(body.match(/\$[\d,]+/g)).toEqual(["$74,500"]);
  });
});

describe("seller_costs — a policy answer, and it names no money", () => {
  it("sends the doctrine: paid from proceeds, never on top of the offer", () => {
    const d = decideAutoAnswer({
      classification: "seller_costs",
      inboundBody: "Who covers the back taxes and the commission?",
      street: "1617 5th St NW",
      live: true,
    });
    expect(d.send).toBe(true);
    expect(d.body).toMatch(/proceeds at closing/);
    expect(d.body).toMatch(/not on top of my offer/);
    expect(d.body).toMatch(/title company/);
  });

  it("contains NO dollar figure — quoting one would re-open a fixed price", () => {
    const body = composeSellerCosts({ street: "1617 5th St NW" });
    expect(body.match(/\$[\d,]+/g)).toBeNull();
  });

  it("reads cleanly with no street on the record", () => {
    const body = composeSellerCosts({ street: null });
    expect(body).not.toMatch(/ on ,/);
    expect(body.startsWith("Good question — those all come out of the seller's proceeds at closing,")).toBe(true);
  });
});

describe("identity_question — the operator-approved standing answer (ruling 2026-09-09)", () => {
  it("sends the standing answer verbatim, no sticky number required", () => {
    const d = decideAutoAnswer({
      classification: "identity_question",
      inboundBody: "Are you a wholesaler?",
      stickyOfferUsd: null,
      live: true,
    });
    expect(d.send).toBe(true);
    expect(d.body).toBe(IDENTITY_QUESTION_STANDING_ANSWER);
  });

  it("the amount veto still applies — a number makes it a counter, not an identity question", () => {
    const d = decideAutoAnswer({
      classification: "identity_question",
      inboundBody: "are you a wholesaler? we'd need 55k",
      live: true,
    });
    expect(d.send).toBe(false);
    expect(d.refusal).toBe("amount_in_reply");
  });
});

describe("the dark flag and the loop guard", () => {
  it("composes but does NOT send when the lane is dark — that is the dry-run", () => {
    const d = decideAutoAnswer({
      classification: "seller_costs",
      inboundBody: "Who pays the liens?",
      live: false,
    });
    expect(d.send).toBe(false);
    expect(d.refusal).toBe("lane_dark");
    // The body IS present — the whole point of the dry run is reading it.
    expect(d.body).toMatch(/proceeds at closing/);
  });

  it("answers a thread once, ever", () => {
    const d = decideAutoAnswer({
      classification: "seller_costs",
      inboundBody: "And who pays the water bill?",
      alreadyAutoAnswered: true,
      live: true,
    });
    expect(d.send).toBe(false);
    expect(d.refusal).toBe("already_answered");
    expect(d.detail).toMatch(/loop/);
  });
});
