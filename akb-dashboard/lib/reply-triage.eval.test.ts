// REPLY-READER EVAL CORPUS — real inbound replies, verbatim, from the Spine's
// documented classifier incidents. @agent: sentry
//
// Build-queue item ② (operator ruling 2026-08-30, rec8eZG5hH16FFyF2): at
// 100-200 sends/day the classifier IS the revenue path — every miss below
// either buried money (Mcguffey's acceptance: 11 days of silence; Sussex's
// cash-pivot: auto-closed Dead) or paged noise. Each case cites its incident.
// The rule for this file: real text only, exactly as received (typos kept).
// Add every future miss here FIRST, watch it fail, then fix the pattern.

import { describe, it, expect } from "vitest";
import { classifyReply } from "./reply-triage";

const label = (body: string) => classifyReply(body).classification;

describe("eval: the documented misses (each was live-misclassified before 2026-08-30)", () => {
  it("Mcguffey acceptance (2026-08-19, sat 11 days as unknown/0.4)", () => {
    expect(label("The owner is willing to accept that deal. ")).toBe("acceptance");
  });

  it("Sussex cash-pivot (2026-08-24, tier-0 auto-killed by unanchored \"he's not\")", () => {
    const sussex =
      "He's not interested in financing. He wants to sell outright. " +
      "Let me know if that's an option. We can negotiate a price.";
    expect(label(sussex)).toBe("interest");
  });

  it("McKellar cash-offer invitation (2026-08-23, no page fired)", () => {
    expect(label("Would you be willing to make a cash offer?")).toBe("interest");
  });

  it("Schylbea directional counter (2026-08-24, paged 'intent unclear')", () => {
    const schylbea =
      "There is a family situation that must close without any drawn out " +
      "payments and needs to be closer to the asking price";
    expect(label(schylbea)).toBe("counter");
  });

  it("Leeds showing-protocol (2026-08-22, mislabeled 'appointment')", () => {
    const leeds =
      "Per the seller: no offers via email, text, nor phone prior to an " +
      "in-person showing. No seller financing.";
    expect(label(leeds)).not.toBe("appointment");
  });

  it("Richter-class 'not available' decline (2026-08-20, paged as interest)", () => {
    expect(label("Sorry, the property is not available")).toBe("soft_no");
  });

  it("template-echo affirmation reads as interest (2805 N Main, launch night)", () => {
    expect(label("Definitely in the ballpark.... Fixing to put together a short sale ..")).toBe(
      "interest",
    );
  });

  it("negated ballpark echo does NOT read as interest", () => {
    expect(label("Unfortunately that's not in the ballpark for my seller")).not.toBe("interest");
  });

  it("'seller firm on price' reads as a pricing soft-no (9251 Plainview, launch night)", () => {
    expect(
      label(
        "This property is moved in condition. No land contract, needs no repairs, seller firm on price or close to it.",
      ),
    ).toBe("soft_no");
  });

  it("STOP stays a hard opt-out rejection whatever surrounds it", () => {
    expect(label("Stop")).toBe("rejection");
  });
});

describe("eval: pinned correct behavior (must survive every pattern change)", () => {
  it("elliptical 'no he's not.' stays a rejection (2026-07-26 anchor case)", () => {
    expect(label("I'm sorry but no he's not. That's an insane ask.")).not.toBe("interest");
  });

  it("'Seller is not. He may not counter' stays a rejection (2026-07-26)", () => {
    expect(label("Seller is not. He may not counter")).toBe("rejection");
  });

  it("competing cash offer in hand stays a rejection (Fairfield 2026-08-22)", () => {
    expect(label("We already have a cash offer of 170,000")).toBe("rejection");
  });

  it("negated interest stays soft_no (3226 Cloverhurst 2026-07-17)", () => {
    expect(
      label("It's a fast no at $156K. The sellers aren't interested in low ball offers."),
    ).toBe("soft_no");
  });

  it("Kentfield terms counter-interest reads as engagement, not a kill (2026-08-22)", () => {
    const kentfield =
      "Owner own it free and but is interested in financing the property. " +
      "Especially not with only 10% down.";
    expect(["interest", "counter"]).toContain(label(kentfield));
  });

  it("Canfield multiplier counter (2026-07-17 anchor)", () => {
    expect(label("Youll need to double it")).toBe("counter");
    expect(
      label(
        "I said you would have to double it. Im not sure how or why you would think my client would accept that.",
      ),
    ).toBe("counter");
  });

  it("sarcastic 'would accept that' never reads as acceptance (Canfield 2026-07-12)", () => {
    expect(
      label("Im not sure how or why you would think my client would accept that."),
    ).not.toBe("acceptance");
  });

  it("clarifying question on the number routes to review, never a kill (Roselawn 2026-08-29)", () => {
    const l = label("Youre offer is 47500 total?");
    expect(l).not.toBe("rejection");
    expect(l).not.toBe("acceptance");
  });

  it("'sold yesterday' stays a gone-deal rejection (15003 Manor 2026-08-20)", () => {
    expect(label("It sold yesterday")).toBe("rejection");
  });

  it("wrong number stays out of every money label (419 Cumberland 2026-08-22)", () => {
    const l = label("Wrong number");
    expect(["unknown", "soft_no"]).toContain(l);
  });

  it("a real scheduling ask still reads appointment", () => {
    expect(label("Can we schedule a showing for Tuesday?")).toBe("appointment");
  });
});
