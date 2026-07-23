import { describe, it, expect } from "vitest";
import { matchInboundToListing } from "./match";
import type { InboundMessage, MatchableListing } from "./types";

const sms = (sender: string): InboundMessage =>
  ({ channel: "sms", sender, body: "hi", externalId: "x", receivedAt: "2026-07-22T16:18:08Z" } as InboundMessage);

function l(o: Partial<MatchableListing> & { id: string }): MatchableListing {
  return { agentPhone: "+13137686286", agentEmail: null, outreachStatus: null, lastInboundAt: null, lastOutboundAt: null, ...o };
}

describe("matchInboundToListing — attribute to the active thread, not the first match", () => {
  it("picks the listing we most recently texted when one phone matches several", () => {
    const fielding = l({ id: "recSaintPatrick", lastOutboundAt: null, outreachStatus: "Negotiating" }); // never texted
    const holmes = l({ id: "recHolmes", lastOutboundAt: "2026-07-22T16:15:54Z", outreachStatus: "Texted" });
    // Even when the never-texted one is listed first, the real thread wins.
    expect(matchInboundToListing(sms("3137686286"), [fielding, holmes])?.id).toBe("recHolmes");
  });

  it("returns null when nothing matches the phone", () => {
    expect(matchInboundToListing(sms("2025550000"), [l({ id: "recA", agentPhone: "+13130000000" })])).toBeNull();
  });

  it("single match still returns that listing", () => {
    expect(matchInboundToListing(sms("3137686286"), [l({ id: "recOnly" })])?.id).toBe("recOnly");
  });
});
