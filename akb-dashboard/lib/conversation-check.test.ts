import { describe, it, expect } from "vitest";
import { classifyConversation, isSelfEchoOrAutoreply, type InboundCheckMessage } from "./conversation-check";

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

// ─────────────────────────────────────────────────────────────────────
// Self-echo + bot-autoreply downgrade classes (operator 2026-06-08).
// Forward-only — applies to NEW conversation checks; no back-cohort run.
// ─────────────────────────────────────────────────────────────────────

describe("classifyConversation — self-echo downgrade", () => {
  it("DOWNGRADES to Texted when the only inbound echoes our H2 template", () => {
    const r = classifyConversation(
      [msg({ body: "This is Alex with AKB Solutions. I am interested in your listing at 346 Modder Ave." })],
      OUT_AT,
    );
    expect(r.verdict).toBe("downgrade_to_texted");
    if (r.verdict === "downgrade_to_texted") {
      expect(r.reason).toContain("echo_or_autoreply");
    }
  });

  it("catches the 'cash offer / quick close' template echo", () => {
    const r = classifyConversation(
      [msg({ body: "I would like to make a cash offer at $65,000 with a quick close. Is the seller open to offers in that range?" })],
      OUT_AT,
    );
    expect(r.verdict).toBe("downgrade_to_texted");
  });

  it("KEEPS Response Received when echo is alongside a real reply", () => {
    const r = classifyConversation(
      [
        msg({ body: "This is Alex with AKB Solutions...", createdAt: "2026-05-07T12:00:00Z" }),
        msg({ body: "Yeah I can do 70k", createdAt: "2026-05-07T13:00:00Z" }),
      ],
      OUT_AT,
    );
    expect(r.verdict).toBe("keep_response_received");
    if (r.verdict === "keep_response_received") {
      expect(r.inboundCount).toBe(1);
      expect(r.reason).toContain("filtered 1 echo/autoreply");
    }
  });
});

describe("classifyConversation — bot-autoreply downgrade", () => {
  it("DOWNGRADES on a classic out-of-office", () => {
    const r = classifyConversation(
      [msg({ body: "I'm currently out of the office and will respond to you as soon as I return." })],
      OUT_AT,
    );
    expect(r.verdict).toBe("downgrade_to_texted");
  });

  it("DOWNGRADES on 'number no longer in service'", () => {
    const r = classifyConversation(
      [msg({ body: "This number is no longer in service." })],
      OUT_AT,
    );
    expect(r.verdict).toBe("downgrade_to_texted");
  });

  it("DOWNGRADES on 'thank you for your interest' brokerage autoreply", () => {
    const r = classifyConversation(
      [msg({ body: "Thank you for your interest in this property. An agent will respond shortly." })],
      OUT_AT,
    );
    expect(r.verdict).toBe("downgrade_to_texted");
  });

  it("DOWNGRADES on explicit 'do not reply'", () => {
    const r = classifyConversation(
      [msg({ body: "DO NOT REPLY — this is an automated message." })],
      OUT_AT,
    );
    expect(r.verdict).toBe("downgrade_to_texted");
  });

  it("KEEPS Response Received when autoreply precedes a real follow-up reply", () => {
    const r = classifyConversation(
      [
        msg({ body: "Out of office until Monday.", createdAt: "2026-05-07T09:00:00Z" }),
        msg({ body: "OK so I'm back — what's your offer again?", createdAt: "2026-05-08T10:00:00Z" }),
      ],
      OUT_AT,
    );
    expect(r.verdict).toBe("keep_response_received");
    if (r.verdict === "keep_response_received") expect(r.inboundCount).toBe(1);
  });

  it("DOWNGRADES when echo + autoreply are the ONLY messages (no real human reply)", () => {
    const r = classifyConversation(
      [
        msg({ body: "This is Alex with AKB Solutions...", createdAt: "2026-05-07T09:00:00Z" }),
        msg({ body: "Auto-reply: out of office.", createdAt: "2026-05-07T10:00:00Z" }),
      ],
      OUT_AT,
    );
    expect(r.verdict).toBe("downgrade_to_texted");
    if (r.verdict === "downgrade_to_texted") expect(r.reason).toContain("2 filtered");
  });
});

describe("isSelfEchoOrAutoreply (live-triage export)", () => {
  it("true on our H2 template reflected back (self-echo)", () => {
    expect(isSelfEchoOrAutoreply("This is Alex with AKB Solutions. Interested in your listing at 1 Main St.")).toBe(true);
    expect(isSelfEchoOrAutoreply("I would like to make a cash offer at $65,000 with a quick close.")).toBe(true);
  });
  it("true on bot autoreplies", () => {
    expect(isSelfEchoOrAutoreply("Out of office until Monday.")).toBe(true);
    expect(isSelfEchoOrAutoreply("This number is no longer in service.")).toBe(true);
    expect(isSelfEchoOrAutoreply("Thank you for your interest in this property.")).toBe(true);
  });
  it("false on a genuine human reply", () => {
    expect(isSelfEchoOrAutoreply("Yeah I can do 70k, call me")).toBe(false);
    expect(isSelfEchoOrAutoreply("not interested")).toBe(false); // a real (if negative) human reply
  });
  it("false on null/empty", () => {
    expect(isSelfEchoOrAutoreply(null)).toBe(false);
    expect(isSelfEchoOrAutoreply("")).toBe(false);
  });
});
