import { describe, it, expect } from "vitest";
import {
  BUMP_MAX_ATTEMPTS,
  BUMP_GAP_DAYS,
  extractStickyOffer,
  bumpVerdict,
  selectBumpDue,
  liveThreadPhoneIndex,
  buildBumpMessage,
  buildBumpSentNote,
  isBumpReverifyCandidate,
  partitionReverifyBatch,
} from "./bump-lane";
import { SOURCE_VERSION_V2 } from "@/lib/source-version";
import type { Listing } from "@/lib/types";

const NOW = new Date("2026-07-11T16:00:00Z");

function hoursAgo(h: number): string {
  return new Date(NOW.getTime() - h * 3_600_000).toISOString();
}

const SENT_NOTE =
  "[H2 sent 2026-07-08T15:00:12.345Z] Quo msg MSGabc123: Hi Sam, this is Alex " +
  "with AKB Solutions. I'd like to make a cash offer of $37,250 on 24806 Frisbee St. " +
  "As-is, no repairs or cleanout, and we close on your timeline.";

function texted(overrides: Partial<Listing> = {}): Listing {
  return {
    id: "recBUMP000000001",
    address: "24806 Frisbee St, Detroit, MI 48219",
    city: "Detroit",
    zip: "48219",
    listPrice: 69_900,
    mao: null,
    dom: null,
    offerTier: null,
    liveStatus: "Active",
    executionPath: "Auto Proceed",
    outreachStatus: "Texted",
    lastOutreachDate: null,
    agentName: "Sam Hantosh",
    agentPhone: "(313) 555-0142",
    agentEmail: null,
    verificationUrl: "https://example.com/listing",
    notes: SENT_NOTE,
    distressScore: null,
    distressBucket: null,
    bedrooms: 3,
    bathrooms: 1,
    buildingSqFt: 1100,
    yearBuilt: 1948,
    portfolioDetected: false,
    stageCalc: null,
    approvedForOutreach: true,
    flipScore: null,
    offMarketOverride: false,
    restrictionText: null,
    ddChecklist: null,
    doNotText: false,
    state: "MI",
    sourceVersion: SOURCE_VERSION_V2,
    actionHoldUntil: null,
    actionCardState: null,
    lastInboundAt: null,
    lastOutboundAt: hoursAgo(BUMP_GAP_DAYS[0] * 24 + 1), // just past day 3
    lastEmailOutreachDate: null,
    envelopeId: null,
    followUpCount: 0,
    lastVerified: hoursAgo(2),
    ...overrides,
  };
}

describe("extractStickyOffer", () => {
  it("parses the amount from a first-touch delivery stamp", () => {
    const s = extractStickyOffer(SENT_NOTE);
    expect(s).not.toBeNull();
    expect(s!.offer).toBe(37_250);
    expect(s!.iso).toBe("2026-07-08T15:00:12.345Z");
  });

  it("takes the LAST stamp when several exist (bump stamps included)", () => {
    const notes =
      SENT_NOTE +
      "\n\n[misc note] something unrelated $999,999" +
      "\n\n[H2 bump 1 sent 2026-07-11T16:05:00.000Z] Quo msg MSGdef456: Hi Sam, " +
      "Alex with AKB Solutions — following up on 24806 Frisbee St. My cash offer " +
      "of $37,250 still stands.";
    const s = extractStickyOffer(notes);
    expect(s).not.toBeNull();
    expect(s!.offer).toBe(37_250);
    expect(s!.iso).toBe("2026-07-11T16:05:00.000Z");
  });

  it("returns null when there is no delivery stamp (field is never a fallback)", () => {
    expect(extractStickyOffer(null)).toBeNull();
    expect(extractStickyOffer("")).toBeNull();
    expect(extractStickyOffer("Called agent, waiting on callback. Offer $50,000 discussed.")).toBeNull();
  });

  it("returns null when the stamp body carries no parseable amount", () => {
    expect(
      extractStickyOffer("[H2 sent 2026-07-08T15:00:00Z] Quo msg MSGx: Hi there, checking in."),
    ).toBeNull();
  });

  it("parses plain amounts without thousands separators", () => {
    const s = extractStickyOffer("[H2 sent 2026-07-08T15:00:00Z] Quo msg MSGx: offer of $9500 today");
    expect(s!.offer).toBe(9_500);
  });
});

describe("bumpVerdict", () => {
  it("is due for attempt 1 just past the day-3 gap", () => {
    const v = bumpVerdict(texted(), NOW);
    expect(v).toEqual({ due: true, attempt: 1, reason: null });
  });

  it("is NOT due before the day-3 gap", () => {
    const v = bumpVerdict(texted({ lastOutboundAt: hoursAgo(BUMP_GAP_DAYS[0] * 24 - 2) }), NOW);
    expect(v.due).toBe(false);
    expect(v.reason).toBe("not_yet_due");
  });

  it("is due for attempt 2 only after the day-4 gap from bump 1", () => {
    const notYet = bumpVerdict(
      texted({ followUpCount: 1, lastOutboundAt: hoursAgo(BUMP_GAP_DAYS[1] * 24 - 2) }),
      NOW,
    );
    expect(notYet.due).toBe(false);
    expect(notYet.reason).toBe("not_yet_due");

    const due = bumpVerdict(
      texted({ followUpCount: 1, lastOutboundAt: hoursAgo(BUMP_GAP_DAYS[1] * 24 + 1) }),
      NOW,
    );
    expect(due).toEqual({ due: true, attempt: 2, reason: null });
  });

  it("exhausts after BUMP_MAX_ATTEMPTS", () => {
    const v = bumpVerdict(texted({ followUpCount: BUMP_MAX_ATTEMPTS, lastOutboundAt: hoursAgo(240) }), NOW);
    expect(v.reason).toBe("bump_exhausted");
  });

  it("hard-skips non-Texted, non-v2, DNT, inbound-bearing, and phoneless records", () => {
    expect(bumpVerdict(texted({ outreachStatus: "Response Received" }), NOW).reason).toBe("not_texted");
    expect(bumpVerdict(texted({ outreachStatus: "" }), NOW).reason).toBe("not_texted");
    expect(bumpVerdict(texted({ sourceVersion: "v1_legacy" }), NOW).reason).toBe("not_v2");
    expect(bumpVerdict(texted({ sourceVersion: null }), NOW).reason).toBe("not_v2");
    expect(bumpVerdict(texted({ doNotText: true }), NOW).reason).toBe("do_not_text");
    expect(bumpVerdict(texted({ lastInboundAt: hoursAgo(1) }), NOW).reason).toBe("has_inbound");
    expect(bumpVerdict(texted({ agentPhone: "n/a" }), NOW).reason).toBe("no_valid_phone");
    expect(bumpVerdict(texted({ lastOutboundAt: null }), NOW).reason).toBe("no_outbound_stamp");
  });

  it("skips any inbound history even when it predates the last outbound", () => {
    const v = bumpVerdict(texted({ lastInboundAt: hoursAgo(500) }), NOW);
    expect(v.reason).toBe("has_inbound");
  });

  it("requires confirmed-fresh liveness (verify_stale blocks the bump)", () => {
    expect(bumpVerdict(texted({ lastVerified: hoursAgo(72) }), NOW).reason).toBe("verify_stale");
    expect(bumpVerdict(texted({ lastVerified: null }), NOW).reason).toBe("never_verified");
    expect(bumpVerdict(texted({ liveStatus: "Off Market" }), NOW).reason).toBe("live_status_off market");
  });

  it("blocks excluded/paused markets", () => {
    const v = bumpVerdict(texted({ state: "NC", zip: "27601", city: "Raleigh" }), NOW);
    expect(v.due).toBe(false);
  });
});

describe("selectBumpDue", () => {
  it("returns due records oldest silent thread first", () => {
    const older = texted({ id: "recOLDER00000001", lastOutboundAt: hoursAgo(120) });
    const newer = texted({ id: "recNEWER00000001", lastOutboundAt: hoursAgo(80) });
    const notDue = texted({ id: "recNOTDUE0000001", lastOutboundAt: hoursAgo(10) });
    const out = selectBumpDue([newer, notDue, older], NOW);
    expect(out.map((l) => l.id)).toEqual(["recOLDER00000001", "recNEWER00000001"]);
  });
});

describe("liveThreadPhoneIndex", () => {
  it("indexes normalized phones with reply-bearing statuses only", () => {
    const idx = liveThreadPhoneIndex([
      texted({ outreachStatus: "Negotiating", agentPhone: "313-555-0142" }),
      texted({ outreachStatus: "Texted", agentPhone: "313-555-0199" }),
    ]);
    expect(idx.has("+13135550142")).toBe(true);
    expect(idx.has("+13135550199")).toBe(false);
  });
});

describe("buildBumpMessage", () => {
  it("restates the sticky number and street only", () => {
    const m1 = buildBumpMessage("Sam Hantosh", "24806 Frisbee St, Detroit, MI 48219", 37_250, 1);
    expect(m1).toContain("$37,250");
    expect(m1).toContain("24806 Frisbee St");
    expect(m1).not.toContain("Detroit, MI");
    expect(m1).toContain("Hi Sam,");
  });

  it("uses the neutral greeting for org names and distinct copy for attempt 2", () => {
    const m2 = buildBumpMessage("The Graham Seeby Group", "474 Center Hill Ave, Atlanta, GA", 55_000, 2);
    expect(m2).toContain("Hi there,");
    expect(m2).toContain("last follow-up");
    expect(m2).toContain("$55,000");
  });
});

describe("buildBumpSentNote + extractStickyOffer roundtrip", () => {
  it("a bump stamp is re-parseable so stickiness survives repeated bumps", () => {
    const body = buildBumpMessage("Sam", "24806 Frisbee St, Detroit, MI", 37_250, 1);
    const notes = buildBumpSentNote(SENT_NOTE, "2026-07-11T16:05:00.000Z", 1, "MSGdef", body);
    const s = extractStickyOffer(notes);
    expect(s!.offer).toBe(37_250);
    expect(s!.iso).toBe("2026-07-11T16:05:00.000Z");
  });
});

describe("isBumpReverifyCandidate", () => {
  it("admits a silent v2 Texted record whose bump is due within the freshness window", () => {
    // Day-3 gap = 72h; due in 40h (< 48h window) → admit.
    expect(isBumpReverifyCandidate(texted({ lastOutboundAt: hoursAgo(32), lastVerified: null }), NOW)).toBe(true);
    // Already past due → admit.
    expect(isBumpReverifyCandidate(texted({ lastOutboundAt: hoursAgo(100), lastVerified: null }), NOW)).toBe(true);
  });

  it("refuses records whose bump is still far out (no keep-warm on not-yet-due air)", () => {
    // Due in 62h (> 48h window) → a verify stamp now would expire before the bump.
    expect(isBumpReverifyCandidate(texted({ lastOutboundAt: hoursAgo(10) }), NOW)).toBe(false);
  });

  it("refuses exhausted, inbound-bearing, DNT, and legacy records (dead air stays cold)", () => {
    expect(isBumpReverifyCandidate(texted({ followUpCount: 2, lastOutboundAt: hoursAgo(300) }), NOW)).toBe(false);
    expect(isBumpReverifyCandidate(texted({ lastInboundAt: hoursAgo(5), lastOutboundAt: hoursAgo(100) }), NOW)).toBe(false);
    expect(isBumpReverifyCandidate(texted({ doNotText: true, lastOutboundAt: hoursAgo(100) }), NOW)).toBe(false);
    expect(isBumpReverifyCandidate(texted({ sourceVersion: "v1_legacy", lastOutboundAt: hoursAgo(100) }), NOW)).toBe(false);
    expect(isBumpReverifyCandidate(texted({ outreachStatus: "Emailed", lastOutboundAt: hoursAgo(100) }), NOW)).toBe(false);
  });
});

describe("partitionReverifyBatch", () => {
  const core = Array.from({ length: 50 }, (_, i) => `core${i}`);
  const bump = Array.from({ length: 30 }, (_, i) => `bump${i}`);

  it("caps bump records at the minority share when core demand is high", () => {
    const { batch, coreTaken, bumpTaken } = partitionReverifyBatch(core, bump, 40);
    expect(coreTaken).toBe(24);
    expect(bumpTaken).toBe(16);
    expect(batch).toHaveLength(40);
    expect(batch[0]).toBe("core0");
  });

  it("gives unneeded reserve back to core when few bumps are waiting", () => {
    const { coreTaken, bumpTaken } = partitionReverifyBatch(core, bump.slice(0, 5), 40);
    expect(coreTaken).toBe(35);
    expect(bumpTaken).toBe(5);
  });

  it("lets bump records backfill spare capacity when core is thin", () => {
    const { coreTaken, bumpTaken } = partitionReverifyBatch(core.slice(0, 10), bump, 40);
    expect(coreTaken).toBe(10);
    expect(bumpTaken).toBe(30);
  });

  it("handles empty pools and zero limits", () => {
    expect(partitionReverifyBatch([], [], 40).batch).toHaveLength(0);
    expect(partitionReverifyBatch(core, bump, 0).batch).toHaveLength(0);
    const noBump = partitionReverifyBatch(core, [], 40);
    expect(noBump.coreTaken).toBe(40);
    expect(noBump.bumpTaken).toBe(0);
  });
});
