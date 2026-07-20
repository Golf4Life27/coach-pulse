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

  it("surfaces the inbound excerpt so the card shows what we're replying to", () => {
    const [d] = rankLiveDeals([
      row({
        draftReplyText: "Bills get paid from proceeds at closing.",
        draftReplyMeta: JSON.stringify({
          state: "queued",
          classification: "seller_costs",
          channel: "sms",
          inbound_excerpt: "Who covers the back taxes and water bill?",
          proposal_id: "jarvis_reply-9",
        }),
      }),
    ]);
    expect(d.draft?.inboundExcerpt).toBe("Who covers the back taxes and water bill?");
  });

  it("inboundExcerpt is null when the meta predates the field (blockquote hides)", () => {
    const [d] = rankLiveDeals([
      row({ draftReplyText: "reply", draftReplyMeta: queuedMeta }),
    ]);
    expect(d.draft?.inboundExcerpt).toBeNull();
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

describe("decision weight — critical decisions rank above courtesy chatter (operator 2026-07-20)", () => {
  // The Mayland/Mayfield inversion, verbatim: a fresher courtesy "Thanks!"
  // queued draft outranked a day-older $27k counter the guardrails HELD.
  const courtesyMeta = JSON.stringify({
    state: "queued",
    classification: "unknown",
    channel: "sms",
    inbound_excerpt: "Thanks!",
    proposal_id: "jarvis_reply-courtesy",
  });
  const heldCounterMeta = JSON.stringify({
    state: "hold",
    classification: "seller_costs",
    channel: "email",
    inbound_excerpt: "willing to meet you at $27,000",
    hold_reason: "draft_exceeds_ceiling ($27,000 > $19,500)",
    proposal_id: "jarvis_reply-mayfield",
  });
  const actionableMeta = JSON.stringify({
    state: "queued",
    classification: "counter",
    channel: "sms",
    inbound_excerpt: "Might consider $100000-$115000",
    proposal_id: "jarvis_reply-counter",
  });

  it("a HELD counter outranks a fresher courtesy reply", () => {
    const ranked = rankLiveDeals([
      row({
        id: "recMAYLAND0000001",
        address: "1150 Mayland Cir SW",
        status: "Response Received",
        lastInboundAt: "2026-07-14T20:00:00Z", // fresher
        draftReplyText: "Still here if anything shifts.",
        draftReplyMeta: courtesyMeta,
      }),
      row({
        id: "recMAYFIELD000001",
        address: "2208 Mayfield Ave SW",
        status: "Response Received",
        lastInboundAt: "2026-07-13T20:00:00Z", // a day older
        draftReplyMeta: heldCounterMeta,
      }),
    ]);
    expect(ranked[0].id).toBe("recMAYFIELD000001");
  });

  it("money-critical statuses lead even without drafts; actionable queued beats courtesy", () => {
    const ranked = rankLiveDeals([
      row({ id: "recCOURTESY000001", status: "Response Received", lastInboundAt: "2026-07-16T20:00:00Z", draftReplyText: "ok", draftReplyMeta: courtesyMeta }),
      row({ id: "recACTIONABLE0001", status: "Response Received", lastInboundAt: "2026-07-14T20:00:00Z", draftReplyText: "counter text", draftReplyMeta: actionableMeta }),
      row({ id: "recCOUNTERRECV001", status: "Counter Received", lastInboundAt: "2026-07-12T20:00:00Z" }),
    ]);
    expect(ranked.map((d) => d.id)).toEqual([
      "recCOUNTERRECV001", // weight 0: money-critical status
      "recACTIONABLE0001", // weight 1: negotiation-bearing queued draft
      "recCOURTESY000001", // weight 2: courtesy chatter, despite freshest inbound
    ]);
  });

  it("recency still breaks ties inside a tier", () => {
    const ranked = rankLiveDeals([
      row({ id: "recOLDHOLD0000001", status: "Response Received", lastInboundAt: "2026-07-10T20:00:00Z", draftReplyMeta: heldCounterMeta }),
      row({ id: "recNEWHOLD0000001", status: "Response Received", lastInboundAt: "2026-07-15T20:00:00Z", draftReplyMeta: heldCounterMeta }),
    ]);
    expect(ranked[0].id).toBe("recNEWHOLD0000001");
  });
});
