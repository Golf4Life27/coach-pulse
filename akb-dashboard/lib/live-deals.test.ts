import { describe, it, expect } from "vitest";
import { rankLiveDeals, ballInOurCourt, needsYouCount, type LiveDealRow } from "./live-deals";

function row(o: Partial<LiveDealRow> = {}): LiveDealRow {
  return {
    id: "rec0000000000001",
    address: "123 Main St, Atlanta, GA 30310",
    status: "Negotiating",
    contractPrice: 100_000,
    listPrice: 150_000,
    ceiling: 120_000,
    lastInboundAt: "2026-07-11T20:00:00Z",
    lastOutboundAt: "2026-07-11T18:00:00Z",
    sourceVersion: "v2_post_2026-05-26",
    draftReplyText: null,
    draftReplyMeta: null,
    ...o,
  };
}

describe("ballInOurCourt", () => {
  it("their reply with no later answer → our move", () => {
    expect(ballInOurCourt("2026-07-11T20:00:00Z", "2026-07-11T18:00:00Z")).toBe(true);
  });
  it("we answered after their reply → waiting on them", () => {
    expect(ballInOurCourt("2026-07-11T18:00:00Z", "2026-07-11T20:00:00Z")).toBe(false);
  });
  it("inbound but never any outbound → our move", () => {
    expect(ballInOurCourt("2026-07-11T20:00:00Z", null)).toBe(true);
  });
  it("no inbound at all → not our move", () => {
    expect(ballInOurCourt(null, "2026-07-11T20:00:00Z")).toBe(false);
  });
});

describe("recommended-reply drafts on the strip", () => {
  const queuedMeta = JSON.stringify({
    state: "queued",
    classification: "seller_costs",
    channel: "sms",
    generated_at: "2026-07-12T18:00:00Z",
    proposal_id: "jarvis_reply-1",
  });

  it("a queued draft forces needsYou and carries the text", () => {
    const [d] = rankLiveDeals([
      row({
        // we replied last (would be waiting-on-them) BUT a draft is queued
        lastInboundAt: "2026-07-12T09:00:00Z",
        lastOutboundAt: "2026-07-12T10:00:00Z",
        draftReplyText: "Bills get paid from proceeds at closing.",
        draftReplyMeta: queuedMeta,
      }),
    ]);
    expect(d.needsYou).toBe(true);
    expect(d.draft?.state).toBe("queued");
    expect(d.draft?.text).toContain("proceeds");
    expect(d.draft?.proposalId).toBe("jarvis_reply-1");
  });

  it("a HOLD renders reason, no text; sent/dismissed render nothing", () => {
    const [held] = rankLiveDeals([
      row({
        draftReplyText: "",
        draftReplyMeta: JSON.stringify({ state: "hold", classification: "disclosure_step", channel: "email", hold_reason: "operator_must_acknowledge_disclosure" }),
      }),
    ]);
    expect(held.draft?.state).toBe("hold");
    expect(held.draft?.text).toBeNull();
    expect(held.draft?.holdReason).toBe("operator_must_acknowledge_disclosure");
    const [sent] = rankLiveDeals([
      row({ draftReplyText: "x", draftReplyMeta: JSON.stringify({ state: "sent", channel: "sms", classification: "interest" }) }),
    ]);
    expect(sent.draft).toBeNull();
  });

  it("deal heat orders within needs-you: Accepted > Counter > Negotiating > Response", () => {
    const mk = (id: string, status: string) =>
      row({ id, status, lastInboundAt: "2026-07-12T09:00:00Z", lastOutboundAt: null });
    const deals = rankLiveDeals([
      mk("recRESP", "Response Received"),
      mk("recNEG", "Negotiating"),
      mk("recACC", "Offer Accepted"),
      mk("recCTR", "Counter Received"),
    ]);
    expect(deals.map((d) => d.id)).toEqual(["recACC", "recCTR", "recNEG", "recRESP"]);
  });
});

describe("rankLiveDeals", () => {
  it("includes legacy (pre-v2) records — the whole point", () => {
    // The 3123 Sunbeam class: a v1_legacy record actively negotiating.
    const deals = rankLiveDeals([
      row({ id: "recSUNBEAM00000001", address: "3123 Sunbeam St, Houston, TX 77051", sourceVersion: "v1_legacy" }),
    ]);
    expect(deals).toHaveLength(1);
    expect(deals[0].legacy).toBe(true);
    expect(deals[0].street).toBe("3123 Sunbeam St");
    expect(deals[0].href).toBe("/pipeline/recSUNBEAM00000001");
  });

  it("drops records not in a negotiation status", () => {
    const deals = rankLiveDeals([
      row({ id: "recA", status: "Texted" }),
      row({ id: "recB", status: "Dead" }),
      row({ id: "recC", status: "Counter Received" }),
    ]);
    expect(deals.map((d) => d.id)).toEqual(["recC"]);
  });

  it("ball-in-our-court deals rank ahead of waiting-on-them, even when older", () => {
    const waitingButNewer = row({
      id: "recWAIT",
      lastInboundAt: "2026-07-12T09:00:00Z",
      lastOutboundAt: "2026-07-12T10:00:00Z", // we replied last (newer activity)
    });
    const oursButOlder = row({
      id: "recOURS",
      lastInboundAt: "2026-07-12T08:00:00Z",
      lastOutboundAt: "2026-07-12T07:00:00Z", // they replied last (older activity)
    });
    const deals = rankLiveDeals([waitingButNewer, oursButOlder]);
    expect(deals.map((d) => d.id)).toEqual(["recOURS", "recWAIT"]);
    expect(needsYouCount(deals)).toBe(1);
  });

  it("within the same court, newest activity first", () => {
    const older = row({ id: "recOLD", lastInboundAt: "2026-07-10T12:00:00Z", lastOutboundAt: null });
    const newer = row({ id: "recNEW", lastInboundAt: "2026-07-12T12:00:00Z", lastOutboundAt: null });
    const deals = rankLiveDeals([older, newer]);
    expect(deals.map((d) => d.id)).toEqual(["recNEW", "recOLD"]);
  });

  it("headroom = ceiling − contract when both present; null when either missing", () => {
    expect(rankLiveDeals([row({ contractPrice: 113_750, ceiling: 137_800 })])[0].headroom).toBe(24_050);
    expect(rankLiveDeals([row({ ceiling: null })])[0].headroom).toBeNull();
    expect(rankLiveDeals([row({ contractPrice: null })])[0].headroom).toBeNull();
  });

  it("negative headroom is surfaced, not hidden (over-ceiling honesty)", () => {
    expect(rankLiveDeals([row({ contractPrice: 130_000, ceiling: 120_000 })])[0].headroom).toBe(-10_000);
  });
});
