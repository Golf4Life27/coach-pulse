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
import { classifyReply, determineNewStatus, triageSellerReply } from "./reply-triage";

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

  it("Schylbea 'closer to the asking price' (2026-08-24 read as counter; operator rule 2026-09-03 makes it list-anchored)", () => {
    const schylbea =
      "There is a family situation that must close without any drawn out " +
      "payments and needs to be closer to the asking price";
    expect(label(schylbea)).toBe("list_anchored");
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

// ── 2026-09-05: nine of nineteen replies in one day landed UNCLASSIFIED, one
// hostile message scored INTEREST, one auto-responder flipped a record to
// Negotiating, and "closer to asking" was tagged COUNTER with no number. The
// hourly triage session closed every one by hand (spine rec24GkAwhWOyHLrv
// and the 15:10Z–19:10Z wakes). Verbatim, typos kept.
describe("eval: the 2026-09-05 corpus (operator: 'Fix the classifier')", () => {
  it("hostile with a dollar figure inside the insult (4708 S Rosette) — was INTEREST", () => {
    expect(
      label(
        "And where would you possibly get the idea that a solid would take $100,000 less " +
          "there's a lot of people that would probably buy it at that stay in your market and stay out of our",
      ),
    ).toBe("hostile");
  });

  it("opt-out in plain words plus an offer in hand (1212 W Chambers) — was UNCLASSIFIED", () => {
    expect(label("We have an offer right now.Over asking, please don't bother me anymore")).toBe("rejection");
  });

  it("sarcastic list anchor (925 Sims: 'not even in the same State')", () => {
    // "around 250" on a $250,000 list — the rule parks it silent either way.
    const c = label("Seller would like to land around 250. We arent even in the same State let alone ballpark on price...");
    expect(["hostile", "list_anchored", "flat_no"]).toContain(c);
  });

  it("under contract in new words (1313 Hartford: 'buttoned up a contract') — was UNCLASSIFIED", () => {
    expect(label("We just buttoned up a contract on that property but thanks for reaching out t")).toBe("rejection");
  });

  it("flat no: 'won't consider that price range' (521 Birch) — was UNCLASSIFIED", () => {
    expect(label("He won't consider that price range ")).toBe("flat_no");
  });

  it("agent-only contract form request (10238 E Watson) stays offer_format, not a decline", () => {
    expect(
      label("Hello Alex, I only present offers to my seller on an AAR contract. If you would like to send one, I can it to the seller."),
    ).toBe("offer_format");
  });

  it("hostile + payoff wall (1939 Delwood: 'Lol she owes over 200k… put in the work') — was UNCLASSIFIED", () => {
    expect(label("Lol she owes over 200k you clearly know what is owed if you did your due diligence. Put in the work furst")).toBe("hostile");
  });

  it("stated floor with a k-figure and no $ (820 W Keefe) — was UNCLASSIFIED, is a counter", () => {
    expect(label("Sorry Alex, we'd have to be over 100k. It's rented for 2100 so it's worth more than that. Cash cow ")).toBe("counter");
  });

  it("'They need closer to asking sorry' (194 Brownlee) — was COUNTER with no number", () => {
    expect(label("They need closer to asking sorry")).toBe("list_anchored");
  });

  it("out-of-office autoresponder (6100 Gertrude) — was INTEREST → Negotiating", () => {
    expect(
      label(
        "You've reached me outside business hours. I can't wait to talk shop when I'm back in the office. " +
          "For questions about any interested properties, email us at info@dwellingnetwork.com.  Dwellingnetwork.com",
      ),
    ).toBe("auto_reply");
  });

  it("flat polite no (114 Bailey: 'would not be open to that ballpark') — was UNCLASSIFIED", () => {
    expect(label("No, they would not be open to that ballpark")).toBe("flat_no");
  });

  it("dismissive close (3550 E New York: 'doesn't need work… good luck to you') — was UNCLASSIFIED", () => {
    expect(
      label(
        "The home on New York doesn't need work and the seller isn't looking for \"speed\", he is looking for a fair offer. " +
          "Thanks for your interest and good luck to you",
      ),
    ).toBe("flat_no");
  });

  it("cost-anchored decline (1945 Atkinson: 'He paid more for it than that') — was UNCLASSIFIED", () => {
    expect(label("He paid more for it than that. ")).toBe("flat_no");
    expect(label("Hi, that not in the ballpark. He paid 30k for it")).toBe("flat_no");
  });

  it("identity question (6561 Firwood: 'are you a whole saler?') — was UNCLASSIFIED", () => {
    expect(label("Alex sre you a whole saler?")).toBe("identity_question");
    expect(label("Are you going to try to assign the contract")).toBe("identity_question");
  });

  it("list-anchored with the list price quoted (1011 Center) — was INTEREST → Negotiating", () => {
    expect(
      label(
        "Good evening! I have cc'd my co-listing agent, Kathy Baize, on this text. I presented your offer (below) to our Clients " +
          "this evening and they have respectfully declined. That aside, you are welcome to submit a new offer more inline with current list price of $130K. Respectfully,\nJames",
      ),
    ).toBe("list_anchored");
  });

  it("sarcastic 'add another $100,000' (4086 E Montecito) — was INTEREST → Negotiating", () => {
    expect(label("Add another $100,000 to that number and we can make it work!  The last offer I received was for $245,000!")).toBe("hostile");
  });

  it("'Not even close.' (9552 E Irene) and 'I'm sorry her reply is no.' (1333 Weller) — were UNCLASSIFIED", () => {
    expect(label("Not even close. ")).toBe("flat_no");
    expect(label("I'm sorry her reply is no.")).toBe("flat_no");
  });

  it("value-anchored hold-and-lease decline (4376 Hovenweep) parks silent", () => {
    expect(
      label("Hello\nNo he's not interested in anything in that range. It's worth far more than that. He'll hold it and lease it. \nNot the greatest market for sellers. \nHave a nice weekend. "),
    ).not.toBe("interest");
  });

  it("multiple offers above ours (19350 Glastonbury) — was UNCLASSIFIED, is a gone-deal", () => {
    expect(
      label("Hello thank you for contacting me.  We have multiple offers for their property all above 31,000 so the seller will not consider that. Thank you for your interest."),
    ).toBe("rejection");
  });

  it("agent redirect (66 Victor Ave, 9/4: office manager names the agent)", () => {
    expect(label("Jim Conard (937-974-7758) is the agent handling that property, please reach out to him directly.")).toBe("agent_redirect");
  });

  it("guard: the P1 soft-no anchors and the money-bearing shapes are untouched", () => {
    expect(label("No go")).toBe("soft_no");
    expect(label("no thanks")).toBe("soft_no");
    expect(label("The owner is willing to accept that deal. ")).toBe("acceptance");
    expect(label("Would you be willing to make a cash offer?")).toBe("interest");
    expect(label("seller is looking for $185,000")).toBe("counter");
    expect(label("Definitely in the ballpark.... Fixing to put together a short sale ..")).toBe("interest");
  });
});

describe("eval: the silent classes route to Parked with no draft, no close, no alert", () => {
  it("hostile → tier_0_silent, Parked, needsDecision false", () => {
    const t = triageSellerReply("Lol do your due diligence. Put in the work first", "Negotiating");
    expect(t.classification).toBe("hostile");
    expect(t.tier).toBe("tier_0_silent");
    expect(t.needsDecision).toBe(false);
    expect(t.queueStatus).toBe("Parked");
    expect(t.suggestedReply).toBeNull();
  });

  it("a flat no never yanks a record that already has paper moving", () => {
    expect(determineNewStatus("flat_no", "Offer Accepted")).toBeNull();
    expect(determineNewStatus("flat_no", "Counter Received")).toBeNull();
    expect(determineNewStatus("flat_no", "Parked")).toBeNull();
    expect(determineNewStatus("flat_no", "Texted")).toBe("Parked");
    expect(determineNewStatus("list_anchored", "Response Received")).toBe("Parked");
  });

  it("auto-reply leaves the record exactly where it was", () => {
    const t = triageSellerReply("You've reached me outside business hours.", "Texted");
    expect(t.tier).toBe("tier_0_silent");
    expect(t.queueStatus).toBeNull();
  });

  it("identity question is a live tier-1 thread with no auto-draft", () => {
    const t = triageSellerReply("Alex sre you a whole saler?", "Texted");
    expect(t.tier).toBe("tier_1_decision");
    expect(t.queueStatus).toBe("Response Received");
    expect(t.needsDecision).toBe(true);
  });
});
