// @agent: maverick — external-quo summarizer tests.

import { describe, it, expect } from "vitest";
import { summarizeMessages } from "./external-quo";

describe("external-quo summarizeMessages", () => {
  it("finds the most recent outbound + inbound timestamps separately", () => {
    const r = summarizeMessages([
      { direction: "outgoing", createdAt: "2026-05-14T10:00:00Z" },
      { direction: "outgoing", createdAt: "2026-05-15T10:00:00Z" }, // newer
      { direction: "incoming", createdAt: "2026-05-13T10:00:00Z" },
      { direction: "incoming", createdAt: "2026-05-14T22:00:00Z" }, // newer
    ]);
    expect(r.most_recent_outbound_at).toBe("2026-05-15T10:00:00Z");
    expect(r.most_recent_inbound_at).toBe("2026-05-14T22:00:00Z");
    expect(r.messages_last_24h).toBe(4);
  });

  it("accepts both 'incoming'/'outgoing' and 'inbound'/'outbound' direction labels", () => {
    const r = summarizeMessages([
      { direction: "outbound", createdAt: "2026-05-15T10:00:00Z" },
      { direction: "inbound", createdAt: "2026-05-15T11:00:00Z" },
    ]);
    expect(r.most_recent_outbound_at).toBe("2026-05-15T10:00:00Z");
    expect(r.most_recent_inbound_at).toBe("2026-05-15T11:00:00Z");
  });

  it("handles empty input cleanly — api_responsive still true (we got a response)", () => {
    const r = summarizeMessages([]);
    expect(r).toMatchObject({
      api_responsive: true,
      api_key_configured: true,
      most_recent_outbound_at: null,
      most_recent_inbound_at: null,
      messages_last_24h: 0,
    });
  });

  it("skips messages missing createdAt without breaking", () => {
    const r = summarizeMessages([
      { direction: "outbound" },
      { direction: "outbound", createdAt: "2026-05-15T10:00:00Z" },
    ]);
    expect(r.most_recent_outbound_at).toBe("2026-05-15T10:00:00Z");
    expect(r.messages_last_24h).toBe(2);
  });
});
