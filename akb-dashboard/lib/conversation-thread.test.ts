import { describe, it, expect } from "vitest";
import { selectThreadListing, type ThreadCandidate } from "./conversation-thread";

function c(overrides: Partial<ThreadCandidate> & { id: string }): ThreadCandidate {
  return { lastInboundAt: null, lastOutboundAt: null, outreachStatus: null, ...overrides };
}

describe("selectThreadListing — the Gharian Carver fan-out fix", () => {
  it("returns null for no candidates, the one for a single candidate", () => {
    expect(selectThreadListing([])).toBeNull();
    const only = c({ id: "recA" });
    expect(selectThreadListing([only])).toBe(only);
  });

  it("picks the deal we most recently texted (the active thread)", () => {
    // Fielding: older outbound; Gilchrist: we texted it last → the reply is Gilchrist's.
    const fielding = c({ id: "recFielding", lastOutboundAt: "2026-07-12T15:30:00Z", outreachStatus: "Negotiating" });
    const gilchrist = c({ id: "recGilchrist", lastOutboundAt: "2026-07-22T21:29:00Z", outreachStatus: "Response Received" });
    expect(selectThreadListing([fielding, gilchrist])?.id).toBe("recGilchrist");
    // order-independent
    expect(selectThreadListing([gilchrist, fielding])?.id).toBe("recGilchrist");
  });

  it("falls back to most-recent inbound when outbounds tie / are absent", () => {
    const a = c({ id: "recA", lastInboundAt: "2026-07-20T10:00:00Z" });
    const b = c({ id: "recB", lastInboundAt: "2026-07-22T09:27:00Z" });
    expect(selectThreadListing([a, b])?.id).toBe("recB");
  });

  it("falls back to deal heat, then id, when timestamps tie", () => {
    const resp = c({ id: "recResp", outreachStatus: "Response Received" });
    const counter = c({ id: "recCounter", outreachStatus: "Counter Received" });
    expect(selectThreadListing([resp, counter])?.id).toBe("recCounter"); // hotter status wins
    const x = c({ id: "recX", outreachStatus: "Negotiating" });
    const y = c({ id: "recY", outreachStatus: "Negotiating" });
    expect(selectThreadListing([x, y])?.id).toBe("recX"); // id tiebreak, stable
  });

  it("outbound recency outranks a hotter-but-staler sibling", () => {
    // A hotter status (Counter) but we last texted the cooler one → thread is the cooler one.
    const hotStale = c({ id: "recHot", lastOutboundAt: "2026-07-10T00:00:00Z", outreachStatus: "Counter Received" });
    const coolFresh = c({ id: "recCool", lastOutboundAt: "2026-07-22T00:00:00Z", outreachStatus: "Response Received" });
    expect(selectThreadListing([hotStale, coolFresh])?.id).toBe("recCool");
  });
});
