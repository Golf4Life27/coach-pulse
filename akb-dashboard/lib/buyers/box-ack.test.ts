// @agent: scout — buy-box ack tests (operator ruling 2026-09-23, Spine
// recgpvLksvIVzgB2h, verbatim: "yes on the revised auto reply").

import { describe, it, expect } from "vitest";
import { shouldSendBoxAck, composeBoxAckEmail, buildBoxAckCard, gmailThreadLink } from "./box-ack";
import { findBannedCopy } from "@/lib/dispo/copy-guard";

function gate(over: Partial<Parameters<typeof shouldSendBoxAck>[0]> = {}) {
  return shouldSendBoxAck({
    boxCaptured: true,
    alreadyAcked: false,
    doNotContact: false,
    hasUsableEmail: true,
    killSwitchOn: false,
    capReached: false,
    ...over,
  });
}

describe("shouldSendBoxAck — routing", () => {
  it("sends when a box was captured and every gate is clear", () => {
    expect(gate()).toEqual({ action: "send" });
  });

  it("routes to a card when no box was captured", () => {
    expect(gate({ boxCaptured: false })).toEqual({ action: "card" });
  });

  it("never sends when the kill switch is on, even with a captured box", () => {
    expect(gate({ killSwitchOn: true })).toEqual({ action: "skip", reason: "kill_switch" });
  });

  it("never sends a second time — already-acked buyers are skipped", () => {
    expect(gate({ alreadyAcked: true })).toEqual({ action: "skip", reason: "already_acked" });
  });

  it("skips a buyer with no usable email", () => {
    expect(gate({ hasUsableEmail: false })).toEqual({ action: "skip", reason: "no_email" });
  });

  it("skips once the per-run send cap is reached", () => {
    expect(gate({ capReached: true })).toEqual({ action: "skip", reason: "cap_reached" });
  });

  it("Do Not Contact is checked FIRST — no send AND no card, even with a captured box", () => {
    expect(gate({ doNotContact: true })).toEqual({ action: "skip", reason: "do_not_contact" });
    expect(gate({ doNotContact: true, boxCaptured: false })).toEqual({ action: "skip", reason: "do_not_contact" });
  });

  it("a card is never gated by the kill switch, the once-ever marker, email, or the cap", () => {
    expect(gate({ boxCaptured: false, killSwitchOn: true })).toEqual({ action: "card" });
    expect(gate({ boxCaptured: false, alreadyAcked: true })).toEqual({ action: "card" });
    expect(gate({ boxCaptured: false, hasUsableEmail: false })).toEqual({ action: "card" });
    expect(gate({ boxCaptured: false, capReached: true })).toEqual({ action: "card" });
  });
});

describe("composeBoxAckEmail — copy", () => {
  it("passes guardBuyerCopy clean (no banned phrases)", () => {
    const { subject, body } = composeBoxAckEmail({ buyerName: "Jacob Horn", originalSubject: "Quick question about your buy box - AKB Solutions" });
    expect(findBannedCopy(subject)).toEqual([]);
    expect(findBannedCopy(body)).toEqual([]);
  });

  it("subject is Re: + the drip thread's original subject", () => {
    const { subject } = composeBoxAckEmail({ buyerName: "Jacob Horn", originalSubject: "Quick question about your buy box - AKB Solutions" });
    expect(subject).toBe("Re: Quick question about your buy box - AKB Solutions");
  });

  it("falls back to a generic subject when the original can't be read", () => {
    const { subject } = composeBoxAckEmail({ buyerName: "Jacob Horn", originalSubject: null });
    expect(subject).toBe("Re: your buy box");
  });

  it("carries the STOP line", () => {
    const { body } = composeBoxAckEmail({ buyerName: "Jacob Horn", originalSubject: null });
    expect(body).toContain("Reply STOP or remove and I will take you off the list.");
  });

  it("uses the buyer's first name", () => {
    const { body } = composeBoxAckEmail({ buyerName: "Jacob Horn", originalSubject: null });
    expect(body).toContain("Hi Jacob,");
  });

  it("falls back to 'there' when the buyer has no name on file", () => {
    const { body } = composeBoxAckEmail({ buyerName: null, originalSubject: null });
    expect(body).toContain("Hi there,");
  });

  it("carries no deal content — no dollar sign, no digits anywhere in the body", () => {
    const { body } = composeBoxAckEmail({ buyerName: "Jacob Horn", originalSubject: null });
    expect(body).not.toContain("$");
    expect(body).not.toMatch(/\d/);
  });

  it("is plain ASCII", () => {
    const { subject, body } = composeBoxAckEmail({ buyerName: "Jacob Horn", originalSubject: "Following up - your buy box for AKB Solutions" });
    expect(subject).toMatch(/^[\x00-\x7F]*$/);
    expect(body).toMatch(/^[\x00-\x7F]*$/);
  });

  it("signs off as Alex, AKB Solutions", () => {
    const { body } = composeBoxAckEmail({ buyerName: "Jacob Horn", originalSubject: null });
    expect(body).toContain("Alex\nAKB Solutions");
  });
});

describe("gmailThreadLink", () => {
  it("forms a mail.google.com deep link from a thread id", () => {
    expect(gmailThreadLink("thread123")).toBe("https://mail.google.com/mail/u/0/#all/thread123");
  });

  it("returns null for a null thread id", () => {
    expect(gmailThreadLink(null)).toBeNull();
  });
});

describe("buildBoxAckCard", () => {
  const NOW = "2026-09-23T12:00:00Z";

  it("ids the card buyer-drip-reply-<buyerId>", () => {
    const card = buildBoxAckCard({ buyerId: "recBUYER1", buyerName: "Jacob Horn", replyBody: "Not buying right now, but I do referrals for a fee.", threadId: "thread123", nowIso: NOW });
    expect(card.id).toBe("buyer-drip-reply-recBUYER1");
  });

  it("titles the card with the buyer's name", () => {
    const card = buildBoxAckCard({ buyerId: "recBUYER1", buyerName: "Jacob Horn", replyBody: "text", threadId: null, nowIso: NOW });
    expect(card.title).toBe("Buyer replied to buy-box email: Jacob Horn");
  });

  it("falls back to 'buyer' in the title when the name is blank", () => {
    const card = buildBoxAckCard({ buyerId: "recBUYER1", buyerName: null, replyBody: "text", threadId: null, nowIso: NOW });
    expect(card.title).toBe("Buyer replied to buy-box email: buyer");
  });

  it("excerpts the reply body to 300 chars and includes the Gmail thread link when a thread id is present", () => {
    const longReply = "x".repeat(500);
    const card = buildBoxAckCard({ buyerId: "recBUYER1", buyerName: "Jacob Horn", replyBody: longReply, threadId: "thread123", nowIso: NOW });
    expect(card.why).toContain("x".repeat(300));
    expect(card.why).not.toContain("x".repeat(301));
    expect(card.why).toContain("https://mail.google.com/mail/u/0/#all/thread123");
    expect(card.href).toBe("https://mail.google.com/mail/u/0/#all/thread123");
  });

  it("omits the thread link when no thread id is available", () => {
    const card = buildBoxAckCard({ buyerId: "recBUYER1", buyerName: "Jacob Horn", replyBody: "text", threadId: null, nowIso: NOW });
    expect(card.why).toBe("text");
    expect(card.href).toBeNull();
  });

  it("sets a future expiresAt (required by the priorities anti-staleness gate)", () => {
    const card = buildBoxAckCard({ buyerId: "recBUYER1", buyerName: "Jacob Horn", replyBody: "text", threadId: null, nowIso: NOW });
    expect(Date.parse(card.expiresAt)).toBeGreaterThan(Date.parse(NOW));
  });

  it("never carries a dollar figure — no send is in play on this card", () => {
    const card = buildBoxAckCard({ buyerId: "recBUYER1", buyerName: "Jacob Horn", replyBody: "text", threadId: null, nowIso: NOW });
    expect(card.revenueUsd).toBeNull();
  });
});
