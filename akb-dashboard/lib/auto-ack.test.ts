import { describe, it, expect, afterEach } from "vitest";
import {
  AUTO_ACK_TEMPLATE,
  autoAckClaimKey,
  autoAckLive,
  autoAckStaticSkip,
} from "./auto-ack";
import { isNumberFreeBody } from "./auto-close";

describe("Tier-1 auto-ack — template + claim key (pure)", () => {
  it("the approved template is number-free and price-free", () => {
    expect(isNumberFreeBody(AUTO_ACK_TEMPLATE)).toBe(true);
    expect(AUTO_ACK_TEMPLATE).not.toContain("$");
  });

  it("the template signals a human follow-up (warm hold, not a close)", () => {
    expect(AUTO_ACK_TEMPLATE.toLowerCase()).toContain("follow up");
  });

  it("claim key is per-record (max one ack per thread ever) and distinct from auto-close", () => {
    expect(autoAckClaimKey("recABC")).toBe("auto_ack:recABC");
    expect(autoAckClaimKey("recABC")).toBe(autoAckClaimKey("recABC"));
    expect(autoAckClaimKey("recXYZ")).not.toBe(autoAckClaimKey("recABC"));
    // Different namespace than the Tier-0 close — the two never collide.
    expect(autoAckClaimKey("recABC")).not.toBe("auto_close:recABC");
  });
});

describe("autoAckLive — default OFF flag gate", () => {
  const prior = process.env.REPLY_AUTO_ACK_LIVE;
  afterEach(() => {
    if (prior === undefined) delete process.env.REPLY_AUTO_ACK_LIVE;
    else process.env.REPLY_AUTO_ACK_LIVE = prior;
  });

  it("is false when the env is unset (default OFF — watched-first)", () => {
    delete process.env.REPLY_AUTO_ACK_LIVE;
    expect(autoAckLive()).toBe(false);
  });

  it("is false for any value other than the exact string 'true'", () => {
    process.env.REPLY_AUTO_ACK_LIVE = "TRUE";
    expect(autoAckLive()).toBe(false);
    process.env.REPLY_AUTO_ACK_LIVE = "1";
    expect(autoAckLive()).toBe(false);
    process.env.REPLY_AUTO_ACK_LIVE = "yes";
    expect(autoAckLive()).toBe(false);
  });

  it("is true only for the exact string 'true'", () => {
    process.env.REPLY_AUTO_ACK_LIVE = "true";
    expect(autoAckLive()).toBe(true);
  });
});

describe("autoAckStaticSkip — the no-I/O gate order", () => {
  const ok = {
    live: true,
    classification: "interest",
    body: AUTO_ACK_TEMPLATE,
    inboundBody: "Yes, very interested — send over the proof of funds.",
    toE164: "+13135551234",
    doNotText: false,
  };

  it("passes (null) when every static precondition is met", () => {
    expect(autoAckStaticSkip(ok)).toBeNull();
  });

  it("skips not_live when the flag is off — checked first", () => {
    expect(autoAckStaticSkip({ ...ok, live: false })).toBe("not_live");
  });

  it("skips not_interest for every non-interest classification", () => {
    for (const c of ["counter", "acceptance", "rejection", "unknown", ""]) {
      expect(autoAckStaticSkip({ ...ok, classification: c })).toBe("not_interest");
    }
  });

  it("refuses a template that ever drifts to carry a number", () => {
    expect(autoAckStaticSkip({ ...ok, body: "I can do $50,000" })).toBe("template_contains_numbers");
  });

  it("skips no_phone when the destination is empty", () => {
    expect(autoAckStaticSkip({ ...ok, toE164: "" })).toBe("no_phone");
  });

  it("skips do_not_text when the agent has opted out (TCPA)", () => {
    expect(autoAckStaticSkip({ ...ok, doNotText: true })).toBe("do_not_text");
  });

  it("enforces order: not_live wins even when other preconditions also fail", () => {
    expect(
      autoAckStaticSkip({ live: false, classification: "counter", body: "$50k", inboundBody: "no", toE164: "", doNotText: true }),
    ).toBe("not_live");
  });

  // ── The 3226 Cloverhurst regression (2026-07-17) ────────────────────────
  // "It's a fast no at $156K. The sellers aren't interested in low ball
  // offers." was classified INTEREST (0.9) and this module sent "glad
  // there's interest". The vetoes fact-check the RAW inbound so a classifier
  // miss can never reach the send again.
  it("VETO: the verbatim Cloverhurst rejection never gets an interest ack, even classified interest", () => {
    expect(
      autoAckStaticSkip({
        ...ok,
        inboundBody: "Hi Alex! It's a fast no at $156K. The sellers aren't interested in low ball offers.",
      }),
    ).toBe("inbound_contains_no_language");
  });

  it("VETO: no-language in any phrasing blocks the ack", () => {
    for (const body of [
      "We aren't interested.",
      "Seller isn't really interested in that",
      "There is no interest in any lowball offers.",
      "That's a hard no from the seller",
      "It's a pass for us",
      "not for sale anymore",
      "no thanks",
    ]) {
      expect(autoAckStaticSkip({ ...ok, inboundBody: body })).toBe("inbound_contains_no_language");
    }
  });

  it("VETO: a priced reply is a negotiation — humans only, never a canned ack", () => {
    for (const body of [
      "Sure, can you do $150,000?",
      "Seller wants 185k",
      "We are at 210,000 firm",
    ]) {
      expect(autoAckStaticSkip({ ...ok, inboundBody: body })).toBe("inbound_contains_price");
    }
  });

  it("a genuinely warm, number-free inbound still acks", () => {
    expect(
      autoAckStaticSkip({ ...ok, inboundBody: "Yes! The seller would love a cash offer. Send the details." }),
    ).toBeNull();
  });
});
