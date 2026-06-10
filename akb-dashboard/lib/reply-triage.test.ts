import { describe, it, expect } from "vitest";
import { classifyReply, determineNewStatus, triageSellerReply } from "./reply-triage";

describe("classifyReply", () => {
  it("rejection wins even when a price is present", () => {
    expect(classifyReply("not interested at $200k").classification).toBe("rejection");
    expect(classifyReply("under contract").classification).toBe("rejection");
    expect(classifyReply("please remove my number").classification).toBe("rejection");
  });

  it("counter needs BOTH a price token and counter language", () => {
    expect(classifyReply("seller is looking for $185,000").classification).toBe("counter");
    expect(classifyReply("can you come up to $190k?").classification).toBe("counter");
    // price but no counter language → interest, not counter
    expect(classifyReply("the price is $185,000").classification).toBe("interest");
  });

  it("interest patterns", () => {
    expect(classifyReply("yes send me the offer").classification).toBe("interest");
    expect(classifyReply("can you send proof of funds?").classification).toBe("interest");
  });

  it("blank / unmatched → unknown", () => {
    expect(classifyReply("").classification).toBe("unknown");
    expect(classifyReply("ok").classification).toBe("unknown");
  });

  it("rejection patches (2026-06-10): the Freeland phrase + other 'comparing offers' shapes", () => {
    // The exact reply we hit 2026-06-10 (13235 Freeland; first live reply).
    expect(classifyReply("Hi theyre in the process of accepting a much higher offer").classification).toBe("rejection");
    // Other 'comparing-to-another-offer' shapes that should also route to Dead.
    expect(classifyReply("we have a higher offer already").classification).toBe("rejection");
    expect(classifyReply("got a better offer this morning").classification).toBe("rejection");
    expect(classifyReply("seller is going with another buyer").classification).toBe("rejection");
    expect(classifyReply("property is in escrow").classification).toBe("rejection");
    expect(classifyReply("seller accepted an offer yesterday").classification).toBe("rejection");
  });

  it("the patches do NOT false-positive on our own outbound shapes or interest replies", () => {
    // 'cash offer at $X' is OUR template, but it's stripped by isSelfEchoOrAutoreply
    // BEFORE triage — the patches don't see it. Confirm the patches don't fire on
    // a generic 'send me a higher offer' which is INTEREST, not rejection.
    expect(classifyReply("can you send me a higher offer").classification).not.toBe("rejection");
    expect(classifyReply("yes interested").classification).toBe("interest");
  });

  it("UNCLASSIFIED fallback preserved — ambiguous still routes to manual review (not bypassed)", () => {
    // The patches SHRINK the UNCLASSIFIED bucket toward rejection where the
    // signal is clear, but genuinely-ambiguous replies still land in unknown.
    // The fallback path (determineNewStatus("unknown", "Texted")) keeps the
    // record at Response Received for operator review — never Dead-by-default.
    expect(classifyReply("hmm let me check").classification).toBe("unknown");
    expect(classifyReply("call me later").classification).toBe("interest"); // existing 'call me' pattern wins
    expect(determineNewStatus("unknown", "Texted")).toBe("Response Received");
  });
});

describe("determineNewStatus", () => {
  it("rejection → Dead", () => {
    expect(determineNewStatus("rejection", "Texted")).toBe("Dead");
  });
  it("counter → Counter Received (resurrects Dead), no-op if already there", () => {
    expect(determineNewStatus("counter", "Texted")).toBe("Counter Received");
    expect(determineNewStatus("counter", "Dead")).toBe("Counter Received");
    expect(determineNewStatus("counter", "Counter Received")).toBeNull();
  });
  it("interest → Negotiating", () => {
    expect(determineNewStatus("interest", "Texted")).toBe("Negotiating");
  });
  it("unknown promotes only a still-Texted record", () => {
    expect(determineNewStatus("unknown", "Texted")).toBe("Response Received");
    expect(determineNewStatus("unknown", "Negotiating")).toBeNull();
  });
});

describe("triageSellerReply", () => {
  it("counter → pricing decision, HIGH, holds the floor in the reasoning", () => {
    const t = triageSellerReply("seller is looking for $185,000", "Texted");
    expect(t.classification).toBe("counter");
    expect(t.needsDecision).toBe(true);
    expect(t.decisionKind).toBe("pricing");
    expect(t.priority).toBe("HIGH");
    expect(t.queueStatus).toBe("Counter Received");
    expect(t.reasoning).toMatch(/sticky floor/i);
  });

  it("interest → engagement decision, HIGH, Negotiating", () => {
    const t = triageSellerReply("yes send me the offer", "Texted");
    expect(t.decisionKind).toBe("engagement");
    expect(t.priority).toBe("HIGH");
    expect(t.queueStatus).toBe("Negotiating");
  });

  it("rejection → no decision (downgrade), NORMAL, Dead", () => {
    const t = triageSellerReply("not interested, stop", "Texted");
    expect(t.needsDecision).toBe(false);
    expect(t.decisionKind).toBe("none");
    expect(t.queueStatus).toBe("Dead");
  });

  it("unknown genuine reply → review decision, only promotes a Texted record", () => {
    const t = triageSellerReply("ok", "Texted");
    expect(t.needsDecision).toBe(true);
    expect(t.decisionKind).toBe("review");
    expect(t.queueStatus).toBe("Response Received");
    const t2 = triageSellerReply("ok", "Negotiating");
    expect(t2.queueStatus).toBeNull(); // never downgrades an advanced record
  });
});
