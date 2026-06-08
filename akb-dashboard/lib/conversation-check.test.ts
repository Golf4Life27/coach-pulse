import { describe, it, expect } from "vitest";
import { classifyConversation, type InboundCheckMessage } from "./conversation-check";

const OUT_AT = "2026-05-06T18:00:00Z";

function msg(over: Partial<InboundCheckMessage>): InboundCheckMessage {
  return {
    direction: "incoming",
    body: "",
    createdAt: "2026-05-07T12:00:00Z",
    ...over,
  };
}

describe("classifyConversation — the 19 unverified verdict engine", () => {
  it("DOWNGRADES to Texted when no inbound after the outreach", () => {
    const r = classifyConversation([], OUT_AT);
    expect(r.verdict).toBe("downgrade_to_texted");
    if (r.verdict === "downgrade_to_texted") {
      expect(r.inboundCount).toBe(0);
      expect(r.reason).toBe("no_inbound_after_outreach");
    }
  });

  it("ignores inbounds BEFORE the outreach (pre-outreach noise)", () => {
    const r = classifyConversation(
      [msg({ createdAt: "2026-05-01T12:00:00Z", body: "totally unrelated" })],
      OUT_AT,
    );
    expect(r.verdict).toBe("downgrade_to_texted");
  });

  it("KEEPS Response Received on a non-rejection reply after outreach (the Strathmoor shape)", () => {
    const r = classifyConversation(
      [msg({ body: "Thanks for reaching out. What's your offer?" })],
      OUT_AT,
    );
    expect(r.verdict).toBe("keep_response_received");
    if (r.verdict === "keep_response_received") {
      expect(r.inboundCount).toBe(1);
      expect(r.firstInboundAt).toBe("2026-05-07T12:00:00Z");
    }
  });

  it("DOWNGRADES to Dead when every reply matches a rejection pattern", () => {
    const r = classifyConversation(
      [
        msg({ body: "No thanks", createdAt: "2026-05-07T12:00:00Z" }),
        msg({ body: "Take me off your list", createdAt: "2026-05-07T13:00:00Z" }),
      ],
      OUT_AT,
    );
    expect(r.verdict).toBe("downgrade_to_dead");
  });

  it("KEEPS Response Received when a mix of rejection + non-rejection", () => {
    // First message says "pass" but a second says "actually maybe?" — the
    // conversation isn't a hard no.
    const r = classifyConversation(
      [
        msg({ body: "pass", createdAt: "2026-05-07T12:00:00Z" }),
        msg({ body: "actually what's your number", createdAt: "2026-05-08T09:00:00Z" }),
      ],
      OUT_AT,
    );
    expect(r.verdict).toBe("keep_response_received");
  });

  it("ignores outgoing messages when counting replies", () => {
    const r = classifyConversation(
      [
        msg({ direction: "outgoing", body: "our follow-up" }),
        msg({ body: "ok will think about it", createdAt: "2026-05-07T13:00:00Z" }),
      ],
      OUT_AT,
    );
    expect(r.verdict).toBe("keep_response_received");
    if (r.verdict === "keep_response_received") expect(r.inboundCount).toBe(1);
  });

  it("returns UNCERTAIN when lastOutboundAt is null (defensive)", () => {
    expect(classifyConversation([msg({})], null).verdict).toBe("uncertain");
  });

  it("returns UNCERTAIN on unparseable lastOutboundAt", () => {
    expect(classifyConversation([msg({})], "not-a-date").verdict).toBe("uncertain");
  });

  it("rejection patterns are case-insensitive and word-boundary safe", () => {
    const r = classifyConversation([msg({ body: "NOT INTERESTED" })], OUT_AT);
    expect(r.verdict).toBe("downgrade_to_dead");
  });

  it("a message containing 'pass' as a substring inside another word does NOT trip rejection", () => {
    // "passable" → \bpass\b doesn't match
    const r = classifyConversation([msg({ body: "passable price, let's chat" })], OUT_AT);
    expect(r.verdict).toBe("keep_response_received");
  });
});
