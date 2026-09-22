import { describe, it, expect } from "vitest";
import {
  classifyBuyerReply,
  highestAmountUsd,
  isDispoBlastSubject,
  formatListingReplyNoteBlock,
  formatBuyerInterestLine,
  formatBuyerNoteLine,
  isOptOutReply,
  isMailerDaemonAddress,
  isBounceFailureSubject,
  classifyDripThreadMessages,
  formatDripBounceNoteLine,
  extractZipCodesFromReply,
  extractMaxPriceFromReply,
  captureBuyBoxFromReply,
  type DripThreadMessage,
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

  it("matches the new 'Contract assignment:' prefix", () => {
    expect(isDispoBlastSubject("Contract assignment: 123 Main St, Detroit - $200,000")).toBe(true);
  });

  it("matches the new prefix through Re:/Fwd: mutation", () => {
    expect(isDispoBlastSubject("Re: Contract assignment: 123 Main St, Detroit - $200,000")).toBe(true);
    expect(isDispoBlastSubject("Fwd: Re: Contract assignment: 123 Main St")).toBe(true);
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

describe("isOptOutReply", () => {
  it.each([
    "STOP",
    "stop",
    "Please remove me",
    "unsubscribe",
    "opt out please",
    "opt-out",
    "take me off this list",
    "no more emails please",
    "not interested in receiving these",
    "stop by anytime", // deliberately true — short reply, keep it simple
  ])("flags %j as an opt-out", (text) => {
    expect(isOptOutReply(text)).toBe(true);
  });

  it.each([
    "I'll take it, send the contract",
    "What's the ARV on this one?",
    "Can you send more photos",
    "",
    "   ",
  ])("does not flag %j as an opt-out", (text) => {
    expect(isOptOutReply(text)).toBe(false);
  });

  it("does not flag a long reply just because it contains 'stop'", () => {
    const long =
      "I'll take it, send the contract over and let's get this moving, don't stop now, " +
      "I've been looking for a deal like this for months and this fits my box exactly so " +
      "let's not slow down, get me the paperwork today please.";
    expect(long.length).toBeGreaterThan(200);
    expect(isOptOutReply(long)).toBe(false);
  });
});

// ── 2026-09-22 bug hunt: robust drip thread matching + bounces + capture ──

describe("isMailerDaemonAddress", () => {
  it.each([
    "mailer-daemon@googlemail.com",
    "MAILER-DAEMON@googlemail.com",
    "postmaster@example.com",
  ])("flags %s", (addr) => {
    expect(isMailerDaemonAddress(addr)).toBe(true);
  });

  it.each([
    "julius.florendo@crestcorerealty.com",
    "alex@akb-properties.com",
    null,
    undefined,
  ])("does not flag %j", (addr) => {
    expect(isMailerDaemonAddress(addr)).toBe(false);
  });
});

describe("isBounceFailureSubject", () => {
  it("flags a hard-bounce failure subject", () => {
    expect(isBounceFailureSubject("Delivery Status Notification (Failure)")).toBe(true);
  });

  it("does not flag a (Delay) notice", () => {
    expect(isBounceFailureSubject("Delivery Status Notification (Delay)")).toBe(false);
  });

  it("does not flag an unrelated subject", () => {
    expect(isBounceFailureSubject("Re: Quick question about your buy box")).toBe(false);
  });

  it("null/undefined subject is not a failure", () => {
    expect(isBounceFailureSubject(null)).toBe(false);
    expect(isBounceFailureSubject(undefined)).toBe(false);
  });
});

function msg(over: Partial<DripThreadMessage> = {}): DripThreadMessage {
  return {
    id: "m1",
    from: "buyer@example.com",
    subject: "Quick question about your buy box - AKB Solutions",
    body: "Here's my box.",
    date: "2026-09-21T16:09:00Z",
    threadId: "t1",
    ...over,
  };
}

describe("classifyDripThreadMessages", () => {
  const ourSend = msg({ id: "send1", from: "Alex <alex@akb-properties.com>", date: "2026-09-18T12:00:00Z", body: "" });

  it("counts a reply from a non-matching (but non-mailer-daemon, non-our) address", () => {
    const reply = msg({ id: "r1", from: "someone.else@otherdomain.com", date: "2026-09-21T16:09:00Z" });
    const r = classifyDripThreadMessages([ourSend, reply], new Set());
    expect(r.ourAddress).toBe("alex@akb-properties.com");
    expect(r.replies.map((m) => m.id)).toEqual(["r1"]);
    expect(r.bounces).toHaveLength(0);
  });

  it("excludes our own send (the earliest message) from replies", () => {
    const r = classifyDripThreadMessages([ourSend], new Set());
    expect(r.replies).toHaveLength(0);
    expect(r.bounces).toHaveLength(0);
  });

  it("excludes a later message that also comes from our own address", () => {
    const secondSend = msg({ id: "send2", from: "alex@akb-properties.com", date: "2026-09-24T15:30:00Z" });
    const r = classifyDripThreadMessages([ourSend, secondSend], new Set());
    expect(r.replies).toHaveLength(0);
  });

  it("routes a mailer-daemon Failure subject to bounces, not replies", () => {
    const bounce = msg({
      id: "b1",
      from: "mailer-daemon@googlemail.com",
      subject: "Delivery Status Notification (Failure)",
      date: "2026-09-21T16:10:00Z",
    });
    const r = classifyDripThreadMessages([ourSend, bounce], new Set());
    expect(r.bounces.map((m) => m.id)).toEqual(["b1"]);
    expect(r.replies).toHaveLength(0);
  });

  it("ignores a mailer-daemon Delay notice entirely (not a reply, not a bounce)", () => {
    const delay = msg({
      id: "d1",
      from: "mailer-daemon@googlemail.com",
      subject: "Delivery Status Notification (Delay)",
      date: "2026-09-21T16:10:00Z",
    });
    const r = classifyDripThreadMessages([ourSend, delay], new Set());
    expect(r.bounces).toHaveLength(0);
    expect(r.replies).toHaveLength(0);
  });

  it("excludes an already-cited message id", () => {
    const reply = msg({ id: "r1", from: "buyer@example.com" });
    const r = classifyDripThreadMessages([ourSend, reply], new Set(["r1"]));
    expect(r.replies).toHaveLength(0);
  });

  it("derives ourAddress from the earliest message regardless of input order", () => {
    const reply = msg({ id: "r1", from: "buyer@example.com", date: "2026-09-21T16:09:00Z" });
    const r = classifyDripThreadMessages([reply, ourSend], new Set());
    expect(r.ourAddress).toBe("alex@akb-properties.com");
    expect(r.replies.map((m) => m.id)).toEqual(["r1"]);
  });
});

describe("formatDripBounceNoteLine", () => {
  it("formats the standard bounce note line", () => {
    const line = formatDripBounceNoteLine({ dateIso: "2026-09-22T10:00:00Z", buyerEmail: "carolinaf90@yahoo.com" });
    expect(line).toBe("[2026-09-22] Drip email bounced (carolinaf90@yahoo.com)");
  });
});

describe("extractZipCodesFromReply", () => {
  it("finds a single ZIP", () => {
    expect(extractZipCodesFromReply("I only buy in 38116 right now.")).toEqual(["38116"]);
  });

  it("finds and dedupes several ZIPs, comma or otherwise separated", () => {
    expect(extractZipCodesFromReply("ZIPs: 38116, 38118 and 38116 again")).toEqual(["38116", "38118"]);
  });

  it("does not read a 5-digit price as a ZIP", () => {
    expect(extractZipCodesFromReply("Budget is $45000 for this one")).toEqual([]);
  });

  it("returns empty on no match", () => {
    expect(extractZipCodesFromReply("Sounds good, keep me posted.")).toEqual([]);
  });

  it("ignores a signature mailing address (state code or ZIP+4)", () => {
    expect(extractZipCodesFromReply("I buy in 78223.\n--\nJane, Invest Co\nSan Antonio, TX 78209")).toEqual(["78223"]);
    expect(extractZipCodesFromReply("PO Box 1, Austin TX  78701")).toEqual([]);
    expect(extractZipCodesFromReply("Office: 78209-1234")).toEqual([]);
  });

  it("null/undefined input is empty", () => {
    expect(extractZipCodesFromReply(null)).toEqual([]);
    expect(extractZipCodesFromReply(undefined)).toEqual([]);
  });
});

describe("extractMaxPriceFromReply", () => {
  it("parses 'under $100K'", () => {
    expect(extractMaxPriceFromReply("I can go under $100K on the right deal.")).toBe(100_000);
  });

  it("parses 'up to $250,000'", () => {
    expect(extractMaxPriceFromReply("Looking to spend up to $250,000.")).toBe(250_000);
  });

  it("parses a bare '$250k'", () => {
    expect(extractMaxPriceFromReply("My max is $250k.")).toBe(250_000);
  });

  it("parses a plain dollar amount with commas and no keyword", () => {
    expect(extractMaxPriceFromReply("Budget: $180,000")).toBe(180_000);
  });

  it("returns null when two dollar amounts appear with no ceiling keyword (ambiguous)", () => {
    expect(extractMaxPriceFromReply("Comps show $200k and $220k nearby.")).toBeNull();
  });

  it("returns null on no dollar amount", () => {
    expect(extractMaxPriceFromReply("Sounds good, keep me posted.")).toBeNull();
  });

  it("null/undefined input is null", () => {
    expect(extractMaxPriceFromReply(null)).toBeNull();
    expect(extractMaxPriceFromReply(undefined)).toBeNull();
  });
});

describe("captureBuyBoxFromReply", () => {
  it("captures both zips and max price from one reply", () => {
    const r = captureBuyBoxFromReply("I buy in 38116 and 38118, up to $150,000.");
    expect(r.zips).toEqual(["38116", "38118"]);
    expect(r.maxPriceUsd).toBe(150_000);
  });

  it("leaves fields empty when unsure", () => {
    const r = captureBuyBoxFromReply("Thanks, I'll think about it.");
    expect(r.zips).toEqual([]);
    expect(r.maxPriceUsd).toBeNull();
  });
});
