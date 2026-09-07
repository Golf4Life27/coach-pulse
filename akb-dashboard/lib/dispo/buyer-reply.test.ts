import { describe, it, expect } from "vitest";
import {
  classifyBuyerReply,
  highestAmountUsd,
  isDispoBlastSubject,
  formatListingReplyNoteBlock,
  formatBuyerInterestLine,
  formatBuyerNoteLine,
} from "./buyer-reply";

const ASSIGNMENT_PRICE = 200_000; // 90% floor = $180,000

describe("classifyBuyerReply — buyer_interest", () => {
  it("explicit ask for the contract", () => {
    const r = classifyBuyerReply("I'll take it, send me the contract.", ASSIGNMENT_PRICE);
    expect(r.classification).toBe("buyer_interest");
  });

  it("bare yes with an ask for docs", () => {
    const r = classifyBuyerReply("Yes! We want this one, please send docs.", ASSIGNMENT_PRICE);
    expect(r.classification).toBe("buyer_interest");
  });

  it("named number at/above 90% of assignment price reads as a live offer", () => {
    const r = classifyBuyerReply("We can do $210k cash, close in 7 days.", ASSIGNMENT_PRICE);
    expect(r.classification).toBe("buyer_interest");
    expect(r.amountUsd).toBe(210_000);
  });

  it("proof of funds attached counts as interest even with no dollar figure", () => {
    const r = classifyBuyerReply("Proof of funds attached, ready to close whenever.", ASSIGNMENT_PRICE);
    expect(r.classification).toBe("buyer_interest");
    expect(r.amountUsd).toBeNull();
  });
});

describe("classifyBuyerReply — buyer_pass", () => {
  it("not interested, overpriced", () => {
    const r = classifyBuyerReply("Not interested, way overpriced for this area.", ASSIGNMENT_PRICE);
    expect(r.classification).toBe("buyer_pass");
  });

  it("bare pass", () => {
    const r = classifyBuyerReply("Pass, already have too much in this zip.", ASSIGNMENT_PRICE);
    expect(r.classification).toBe("buyer_pass");
  });

  it("bare no", () => {
    const r = classifyBuyerReply("No, thank you though.", ASSIGNMENT_PRICE);
    expect(r.classification).toBe("buyer_pass");
  });

  it("explicit decline outranks a number in the same message", () => {
    // Mirrors the seller-side rule: a decline next to a lowball number must
    // never read as a live offer just because a dollar sign is present.
    const r = classifyBuyerReply("No, too high — I'd only ever do $120k on this street.", ASSIGNMENT_PRICE);
    expect(r.classification).toBe("buyer_pass");
    expect(r.amountUsd).toBe(120_000);
  });
});

describe("classifyBuyerReply — buyer_question", () => {
  it("plain question about the deal", () => {
    const r = classifyBuyerReply("What's the ARV and rehab estimate on this one?", ASSIGNMENT_PRICE);
    expect(r.classification).toBe("buyer_question");
  });

  it("asks for photos / availability", () => {
    const r = classifyBuyerReply("Is this still available? Can I get more photos?", ASSIGNMENT_PRICE);
    expect(r.classification).toBe("buyer_question");
  });

  it("named number below the 90% floor is a counter, not resolved here — defaults to question", () => {
    const r = classifyBuyerReply("Could you do $145,000? That's my max.", ASSIGNMENT_PRICE);
    expect(r.classification).toBe("buyer_question");
    expect(r.amountUsd).toBe(145_000);
  });

  it("no assignment price on record — a number never auto-qualifies as interest", () => {
    const r = classifyBuyerReply("We can do $210k cash.", null);
    expect(r.classification).toBe("buyer_question");
  });

  it("ambiguous reply with no signal defaults to question, never silently drops to pass", () => {
    const r = classifyBuyerReply("Thinking about it, will let you know.", ASSIGNMENT_PRICE);
    expect(r.classification).toBe("buyer_question");
  });

  it("empty body defaults to question", () => {
    const r = classifyBuyerReply("", ASSIGNMENT_PRICE);
    expect(r.classification).toBe("buyer_question");
    expect(r.amountUsd).toBeNull();
  });
});

describe("highestAmountUsd", () => {
  it("picks the largest of several named amounts", () => {
    expect(highestAmountUsd("Maybe $150k, or I could stretch to $180,000 for the right terms.")).toBe(180_000);
  });

  it("null when no amount is present", () => {
    expect(highestAmountUsd("Sounds interesting, tell me more.")).toBeNull();
  });
});

describe("isDispoBlastSubject", () => {
  it("matches the blast subject verbatim", () => {
    expect(isDispoBlastSubject("Off-market: 123 Main St, Detroit — $200,000")).toBe(true);
  });

  it("matches through Re:/Fwd: mutation", () => {
    expect(isDispoBlastSubject("Re: Off-market: 123 Main St, Detroit — $200,000")).toBe(true);
    expect(isDispoBlastSubject("Fwd: Re: Off-market: 123 Main St")).toBe(true);
  });

  it("rejects an unrelated subject", () => {
    expect(isDispoBlastSubject("Question about your listing")).toBe(false);
  });

  it("null/undefined subject is not a match", () => {
    expect(isDispoBlastSubject(null)).toBe(false);
    expect(isDispoBlastSubject(undefined)).toBe(false);
  });
});

describe("formatListingReplyNoteBlock", () => {
  it("carries the Gmail marker in the same form the seller path writes, so extractCitedGmailIds dedupes it", () => {
    const block = formatListingReplyNoteBlock({
      msgId: "18f2a9c1b3d4e5f6",
      threadId: "18f2a9c1b3d4e000",
      date: "2026-09-07T14:30:00.000Z",
      buyerName: "Ali Fawaz",
      buyerEmail: "ali@fawazcapital.com",
      classification: "buyer_interest",
      amountUsd: 190_000,
      body: "I'll take it, send me the contract.",
      ingestedAt: "2026-09-07T14:31:00.000Z",
    });
    expect(block).toContain("DISPO BUYER REPLY (buyer_interest) from Ali Fawaz <ali@fawazcapital.com>");
    expect(block).toContain("I'll take it, send me the contract.");
    expect(block).toMatch(/\[Gmail inbound msg 18f2a9c1b3d4e5f6 thread=18f2a9c1b3d4e000 ts=2026-09-07T14:30:00\.000Z src=dispo_buyer_reply ingested_at=2026-09-07T14:31:00\.000Z\]/);
  });
});

describe("formatBuyerInterestLine", () => {
  it("matches the spec'd structured form with an amount", () => {
    const line = formatBuyerInterestLine({
      buyerName: "Ali Fawaz",
      buyerEmail: "ali@fawazcapital.com",
      amountUsd: 190_000,
      body: "I'll take it, send me the contract.",
      nowIso: "2026-09-07T14:31:00.000Z",
    });
    expect(line).toBe(
      "[DISPO BUYER INTEREST 2026-09-07T14:31:00.000Z] Ali Fawaz ali@fawazcapital.com $190,000: I'll take it, send me the contract.",
    );
  });

  it("falls back to 'no number' when no amount was named", () => {
    const line = formatBuyerInterestLine({
      buyerName: "Ali Fawaz",
      buyerEmail: "ali@fawazcapital.com",
      amountUsd: null,
      body: "Ready to close, proof of funds attached.",
      nowIso: "2026-09-07T14:31:00.000Z",
    });
    expect(line).toContain("no number");
  });

  it("truncates the body excerpt to 200 chars", () => {
    const longBody = "x".repeat(400);
    const line = formatBuyerInterestLine({
      buyerName: "Ali",
      buyerEmail: "ali@x.com",
      amountUsd: null,
      body: longBody,
      nowIso: "2026-09-07T14:31:00.000Z",
    });
    expect(line.endsWith("x".repeat(200))).toBe(true);
  });
});

describe("formatBuyerNoteLine", () => {
  it("is a compact one-liner naming classification and amount", () => {
    const line = formatBuyerNoteLine({
      classification: "buyer_pass",
      amountUsd: null,
      address: "123 Main St",
      nowIso: "2026-09-07T14:31:00.000Z",
    });
    expect(line).toContain("buyer_pass");
    expect(line).toContain("123 Main St");
    expect(line).toContain("no number");
  });
});
