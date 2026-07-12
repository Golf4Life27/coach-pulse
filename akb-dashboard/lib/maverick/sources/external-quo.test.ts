// @agent: maverick — external-quo summarizer tests.
//
// 2026-07-12 probe fix (spine rec17krmeSuttdyNy companion): the source now
// summarizes CONVERSATION activity (lastActivityAt window counts) because
// the messages endpoint requires `participants` and cannot enumerate the
// line — the old shape 400'd forever and reported the line dead while it
// carried ~55 messages in 48h.

import { describe, it, expect } from "vitest";
import { summarizeConversations } from "./external-quo";

const SINCE = new Date("2026-07-11T15:00:00Z"); // 24h window anchor

describe("external-quo summarizeConversations", () => {
  it("counts only conversations with activity inside the window", () => {
    const r = summarizeConversations(
      [
        { lastActivityAt: "2026-07-12T14:00:00Z" }, // in window
        { lastActivityAt: "2026-07-12T04:56:00Z" }, // in window
        { lastActivityAt: "2026-07-01T10:00:00Z" }, // stale — outside
      ],
      SINCE,
    );
    expect(r.messages_last_24h).toBe(2);
    expect(r.api_responsive).toBe(true);
    expect(r.api_key_configured).toBe(true);
  });

  it("REGRESSION 2026-07-12: a demonstrably-active line reads as active, never 0", () => {
    // The 815 line carried ~55 messages across many conversations in 48h
    // while the old probe reported 0. Any non-empty in-window activity must
    // produce a non-zero count.
    const conversations = Array.from({ length: 12 }, (_, i) => ({
      lastActivityAt: `2026-07-12T0${i % 10}:15:00Z`,
    }));
    const r = summarizeConversations(conversations, SINCE);
    expect(r.messages_last_24h).toBeGreaterThan(0);
    expect(r.messages_last_24h).toBe(12);
  });

  it("surfaces the newest activity timestamp on both recency fields", () => {
    const r = summarizeConversations(
      [
        { lastActivityAt: "2026-07-12T04:56:00Z" },
        { lastActivityAt: "2026-07-12T14:00:00Z" }, // newest
        { lastActivityAt: "2026-07-11T22:43:20Z" },
      ],
      SINCE,
    );
    expect(r.most_recent_outbound_at).toBe("2026-07-12T14:00:00Z");
    expect(r.most_recent_inbound_at).toBe("2026-07-12T14:00:00Z");
  });

  it("handles empty input cleanly — api_responsive still true (we got a response)", () => {
    const r = summarizeConversations([], SINCE);
    expect(r).toMatchObject({
      api_responsive: true,
      api_key_configured: true,
      most_recent_outbound_at: null,
      most_recent_inbound_at: null,
      messages_last_24h: 0,
    });
  });

  it("skips conversations with missing or unparseable lastActivityAt", () => {
    const r = summarizeConversations(
      [{ lastActivityAt: null }, { lastActivityAt: "not-a-date" }, { lastActivityAt: "2026-07-12T10:00:00Z" }],
      SINCE,
    );
    expect(r.messages_last_24h).toBe(1);
    expect(r.most_recent_outbound_at).toBe("2026-07-12T10:00:00Z");
  });
});
