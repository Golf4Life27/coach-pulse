// Unit tests for classifyCadence — covers every branch in the
// decision tree. Pure function, no Airtable, no clock dependency
// (now is injected). Validates pre-live-fire correctness per Alex
// 5/14 directive.
//
// Run: `npm test`
//
// Coverage matrix (17 branches):
//   T1  skip_restricted_state         → no_action_restricted
//   T2  skip_never_list               → no_action_never_list
//   T3  skip_pipeline_active          → no_action_pipeline_advanced
//   T4  skip_invalid_phone            → no_action_invalid_phone
//   T5  off_market_killed             → no_action_off_market
//   T6  Outreach_Status=Dead          → no_action_dead
//   T7  inbound > outbound (replied)  → no_action_already_replied
//   T8  Layer 1 depth-gate (cold rec→warm gate)         → hold_warm_contact_manual_draft
//   T9  active_eligible, no lastSendAt                  → wait_in_cadence
//   T10 active_eligible, schedule exhausted + timeout   → auto_dead_followup_timeout
//   T11 active_eligible, schedule exhausted, no timeout → wait_in_cadence
//   T12 active_eligible, within window                  → wait_in_cadence
//   T13 active_eligible, send time, drift up >10%       → hold_manual_review_drift_up
//   T14 active_eligible, send time, drift down >10%     → send_follow_up_drift_down
//   T15 active_eligible, send time, drift within ±10%   → send_follow_up_3
//   T16 pending_reverification, no prior probe          → send_status_check
//   T17 pending_reverification, prior probe + timeout   → auto_dead_status_check_timeout
//   T18 pending_reverification, prior probe, no timeout → wait_in_cadence

import { describe, it, expect } from "vitest";
import {
  classifyCadence,
  type AgentInteractionMap,
  type RecentlyTouchedAgentMap,
} from "./d3-cadence";
import type { Listing } from "./types";
import type { ScrubBucket } from "./d3-scrub";

// Reference clock for deterministic tests. Equates to 2026-05-14 18:00Z.
const NOW = new Date("2026-05-14T18:00:00Z");

function daysAgo(n: number): string {
  return new Date(NOW.getTime() - n * 24 * 60 * 60_000).toISOString();
}

// 5/15 widening tests need ISO YYYY-MM-DD (Last_Outreach_Date format,
// no time component).
function dateDaysAgo(n: number): string {
  const d = new Date(NOW.getTime() - n * 24 * 60 * 60_000);
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${d.getUTCFullYear()}-${m}-${day}`;
}

// Minimal Listing fixture. Tests override only what they exercise.
function listing(overrides: Partial<Listing> = {}): Listing {
  return {
    id: "recTEST00000000001",
    address: "123 Test St",
    city: "Houston",
    zip: "77001",
    listPrice: 100000,
    mao: null,
    dom: null,
    offerTier: null,
    liveStatus: "Active",
    executionPath: null,
    outreachStatus: "Texted",
    lastOutreachDate: null,
    agentName: "Test Agent",
    agentPhone: "713-555-0100",
    agentEmail: null,
    verificationUrl: null,
    notes: null,
    distressScore: null,
    distressBucket: null,
    bedrooms: null,
    bathrooms: null,
    buildingSqFt: null,
    stageCalc: null,
    approvedForOutreach: false,
    flipScore: null,
    offMarketOverride: false,
    restrictionText: null,
    ddChecklist: null,
    doNotText: false,
    state: "TX",
    actionHoldUntil: null,
    actionCardState: null,
    lastInboundAt: null,
    lastOutboundAt: null,
    listPriceAtSend: 100000,
    storedOfferPrice: 65000,
    lastStatusCheckSentAt: null,
    followUpCount: 0,
    ...overrides,
  };
}

describe("classifyCadence — terminal scrub buckets", () => {
  it("T1: skip_restricted_state → no_action_restricted", () => {
    const d = classifyCadence({
      listing: listing(),
      bucket: "skip_restricted_state",
      now: NOW,
    });
    expect(d.action).toBe("no_action_restricted");
    expect(d.template_id).toBeNull();
    expect(d.pending_writes).toBeNull();
  });

  it("T2: skip_never_list → no_action_never_list", () => {
    const d = classifyCadence({
      listing: listing(),
      bucket: "skip_never_list",
      now: NOW,
    });
    expect(d.action).toBe("no_action_never_list");
  });

  it("T3: skip_pipeline_active → no_action_pipeline_advanced", () => {
    const d = classifyCadence({
      listing: listing(),
      bucket: "skip_pipeline_active",
      now: NOW,
    });
    expect(d.action).toBe("no_action_pipeline_advanced");
  });

  it("T4: skip_invalid_phone → no_action_invalid_phone", () => {
    const d = classifyCadence({
      listing: listing(),
      bucket: "skip_invalid_phone",
      now: NOW,
    });
    expect(d.action).toBe("no_action_invalid_phone");
  });

  it("T5: off_market_killed → no_action_off_market", () => {
    const d = classifyCadence({
      listing: listing(),
      bucket: "off_market_killed",
      now: NOW,
    });
    expect(d.action).toBe("no_action_off_market");
  });
});

describe("classifyCadence — pre-bucket terminals", () => {
  it("T6: Outreach_Status=Dead → no_action_dead", () => {
    const d = classifyCadence({
      listing: listing({ outreachStatus: "Dead" }),
      bucket: "active_eligible",
      now: NOW,
    });
    expect(d.action).toBe("no_action_dead");
  });

  it("T7: inbound after last send → no_action_already_replied", () => {
    const d = classifyCadence({
      listing: listing({
        lastOutboundAt: daysAgo(5),
        lastInboundAt: daysAgo(1),
      }),
      bucket: "active_eligible",
      now: NOW,
    });
    expect(d.action).toBe("no_action_already_replied");
  });
});

describe("classifyCadence — Layer 1 depth-gate (Spine recmmidVrMyrLzjZp + recxxNF0U59MxYUqu)", () => {
  it("T8a: cold active_eligible record with warm agent → hold_warm_contact_manual_draft", () => {
    const phone = "713-555-0100"; // normalizes to +17135550100
    const map: AgentInteractionMap = new Map([
      [
        "+17135550100",
        { count: 3, listingIds: ["recTEST00000000001", "recOther1", "recOther2"] },
      ],
    ]);
    const d = classifyCadence({
      listing: listing({ agentPhone: phone, lastOutboundAt: daysAgo(5) }),
      bucket: "active_eligible",
      agentInteractionMap: map,
      now: NOW,
    });
    expect(d.action).toBe("hold_warm_contact_manual_draft");
    expect(d.banner).toContain("Warm contact");
    expect(d.reasoning).toContain("+17135550100");
  });

  it("T8b: cold pending_reverification record with warm agent → hold_warm_contact_manual_draft", () => {
    const map: AgentInteractionMap = new Map([
      ["+17135550100", { count: 2, listingIds: ["recTEST00000000001", "recOther1"] }],
    ]);
    const d = classifyCadence({
      listing: listing(),
      bucket: "pending_reverification",
      agentInteractionMap: map,
      now: NOW,
    });
    expect(d.action).toBe("hold_warm_contact_manual_draft");
  });

  it("T8c: phone variant normalizes to same key — gate still triggers", () => {
    // Listings_V1 has "(713) 555-0100" but map keyed by E.164 +17135550100.
    const map: AgentInteractionMap = new Map([
      ["+17135550100", { count: 2, listingIds: ["recTEST00000000001", "recOther1"] }],
    ]);
    const d = classifyCadence({
      listing: listing({ agentPhone: "(713) 555-0100" }),
      bucket: "pending_reverification",
      agentInteractionMap: map,
      now: NOW,
    });
    expect(d.action).toBe("hold_warm_contact_manual_draft");
  });

  it("T8d: count=1 (only this record) → gate does NOT fire", () => {
    const map: AgentInteractionMap = new Map([
      ["+17135550100", { count: 1, listingIds: ["recTEST00000000001"] }],
    ]);
    const d = classifyCadence({
      listing: listing(),
      bucket: "pending_reverification",
      agentInteractionMap: map,
      now: NOW,
    });
    expect(d.action).toBe("send_status_check");
  });

  it("T8e: invalid_phone terminal beats warm-gate (terminal precedence)", () => {
    const map: AgentInteractionMap = new Map([
      ["+17135550100", { count: 3, listingIds: ["recTEST00000000001", "recOther1", "recOther2"] }],
    ]);
    const d = classifyCadence({
      listing: listing(),
      bucket: "skip_invalid_phone",
      agentInteractionMap: map,
      now: NOW,
    });
    expect(d.action).toBe("no_action_invalid_phone");
  });

  it("T8f: already-replied beats warm-gate (terminal precedence)", () => {
    const map: AgentInteractionMap = new Map([
      ["+17135550100", { count: 3, listingIds: ["recTEST00000000001", "recOther1", "recOther2"] }],
    ]);
    const d = classifyCadence({
      listing: listing({
        lastOutboundAt: daysAgo(5),
        lastInboundAt: daysAgo(1),
      }),
      bucket: "active_eligible",
      agentInteractionMap: map,
      now: NOW,
    });
    expect(d.action).toBe("no_action_already_replied");
  });
});

describe("classifyCadence — active_eligible cadence positions", () => {
  it("T9: no lastSendAt → wait_in_cadence (data gap)", () => {
    const d = classifyCadence({
      listing: listing({ lastOutboundAt: null, lastOutreachDate: null }),
      bucket: "active_eligible",
      now: NOW,
    });
    expect(d.action).toBe("wait_in_cadence");
    expect(d.reasoning).toContain("can't compute cadence position");
  });

  it("T10: schedule exhausted, 15d since last send → auto_dead_followup_timeout", () => {
    const d = classifyCadence({
      listing: listing({
        lastOutboundAt: daysAgo(15),
        followUpCount: 3,
      }),
      bucket: "active_eligible",
      now: NOW,
    });
    expect(d.action).toBe("auto_dead_followup_timeout");
    expect(d.pending_writes).toEqual({
      Pipeline_Stage: "dead",
      Outreach_Status: "Dead",
    });
  });

  it("T11: schedule exhausted, 5d since last send → wait_in_cadence", () => {
    const d = classifyCadence({
      listing: listing({
        lastOutboundAt: daysAgo(5),
        followUpCount: 3,
      }),
      bucket: "active_eligible",
      now: NOW,
    });
    expect(d.action).toBe("wait_in_cadence");
  });

  it("T12: 2d since send, followUpCount=0 (next at day 3) → wait_in_cadence", () => {
    const d = classifyCadence({
      listing: listing({
        lastOutboundAt: daysAgo(2),
        followUpCount: 0,
      }),
      bucket: "active_eligible",
      now: NOW,
    });
    expect(d.action).toBe("wait_in_cadence");
    expect(d.reasoning).toContain("day 3");
  });

  it("T13: drift up >10% at send time → hold_manual_review_drift_up", () => {
    const d = classifyCadence({
      listing: listing({
        lastOutboundAt: daysAgo(3),
        followUpCount: 0,
        listPriceAtSend: 100000,
        listPrice: 115000, // +15%
      }),
      bucket: "active_eligible",
      now: NOW,
    });
    expect(d.action).toBe("hold_manual_review_drift_up");
    expect(d.banner).toContain("PRICE DRIFT UP");
  });

  it("T14: drift down >10% at send time → send_follow_up_drift_down", () => {
    const d = classifyCadence({
      listing: listing({
        lastOutboundAt: daysAgo(3),
        followUpCount: 0,
        listPriceAtSend: 100000,
        listPrice: 85000, // -15%
      }),
      bucket: "active_eligible",
      now: NOW,
    });
    expect(d.action).toBe("send_follow_up_drift_down");
    expect(d.template_id).toBe("follow_up_drift_down");
  });

  it("T15: drift within ±10% at send time, followUpCount=0 → send_follow_up_3", () => {
    const d = classifyCadence({
      listing: listing({
        lastOutboundAt: daysAgo(3),
        followUpCount: 0,
        listPriceAtSend: 100000,
        listPrice: 95000, // -5%
      }),
      bucket: "active_eligible",
      now: NOW,
    });
    expect(d.action).toBe("send_follow_up_3");
    expect(d.template_id).toBe("follow_up_3");
  });

  it("T15b: drift within window, followUpCount=1 → send_follow_up_7", () => {
    const d = classifyCadence({
      listing: listing({
        lastOutboundAt: daysAgo(7),
        followUpCount: 1,
        listPriceAtSend: 100000,
        listPrice: 100000,
      }),
      bucket: "active_eligible",
      now: NOW,
    });
    expect(d.action).toBe("send_follow_up_7");
  });

  it("T15c: drift within window, followUpCount=2 → send_follow_up_14", () => {
    const d = classifyCadence({
      listing: listing({
        lastOutboundAt: daysAgo(14),
        followUpCount: 2,
        listPriceAtSend: 100000,
        listPrice: 100000,
      }),
      bucket: "active_eligible",
      now: NOW,
    });
    expect(d.action).toBe("send_follow_up_14");
  });
});

describe("classifyCadence — pending_reverification status_check paths", () => {
  it("T16: no prior probe → send_status_check", () => {
    const d = classifyCadence({
      listing: listing({ lastStatusCheckSentAt: null }),
      bucket: "pending_reverification",
      now: NOW,
    });
    expect(d.action).toBe("send_status_check");
    expect(d.template_id).toBe("status_check");
  });

  it("T17: prior probe 4d ago, no reply → auto_dead_status_check_timeout", () => {
    const d = classifyCadence({
      listing: listing({ lastStatusCheckSentAt: daysAgo(4) }),
      bucket: "pending_reverification",
      now: NOW,
    });
    expect(d.action).toBe("auto_dead_status_check_timeout");
    expect(d.pending_writes).toEqual({
      Pipeline_Stage: "dead",
      Outreach_Status: "Dead",
    });
  });

  it("T18: prior probe 1d ago, no reply → wait_in_cadence", () => {
    const d = classifyCadence({
      listing: listing({ lastStatusCheckSentAt: daysAgo(1) }),
      bucket: "pending_reverification",
      now: NOW,
    });
    expect(d.action).toBe("wait_in_cadence");
  });
});

describe("classifyCadence — Layer 1 widening (5/15) recently-touched gate", () => {
  // The widening catches the Maribel-Frey case: agent texted within
  // the last 30 days on a now-Dead listing should still route to
  // hold_warm_contact_manual_draft because the human's memory of us
  // hasn't decayed.

  it("T19: agent texted 15d ago on now-Dead listing → hold_warm_contact_manual_draft on new Texted listing", () => {
    const phone = "713-555-9001"; // normalizes to +17135559001
    const recentMap: RecentlyTouchedAgentMap = new Map([
      [
        "+17135559001",
        {
          listingIds: ["recOLDdead"],
          statuses: ["Dead"],
          mostRecentTouchedDate: dateDaysAgo(15),
        },
      ],
    ]);
    const d = classifyCadence({
      listing: listing({ agentPhone: phone }),
      bucket: "pending_reverification",
      recentlyTouchedAgentMap: recentMap,
      now: NOW,
    });
    expect(d.action).toBe("hold_warm_contact_manual_draft");
    expect(d.banner).toContain("now Dead");
    expect(d.banner).toContain("within last 30 days");
    expect(d.reasoning).toContain("+17135559001");
  });

  it("T20: agent texted 45d ago on now-Dead listing → does NOT route to warm (outside 30d window)", () => {
    // Endpoint applies the window at map-build time. Outside-window
    // contacts simply don't appear in the map. Test the classifier's
    // behavior given an empty map for this phone.
    const recentMap: RecentlyTouchedAgentMap = new Map();
    const d = classifyCadence({
      listing: listing({ agentPhone: "713-555-9002" }),
      bucket: "pending_reverification",
      recentlyTouchedAgentMap: recentMap,
      now: NOW,
    });
    expect(d.action).toBe("send_status_check");
  });

  it("T21: agent texted 15d ago on still-Texted listing → routes via Layer 1 (precedence preserved)", () => {
    // Both gates would hit. Layer 1 runs first and wins with its
    // original banner ("agent has N other Listings_V1 record(s)").
    const phone = "713-555-9003"; // +17135559003
    const interactionMap: AgentInteractionMap = new Map([
      ["+17135559003", { count: 2, listingIds: ["recTEST00000000001", "recOther"] }],
    ]);
    const recentMap: RecentlyTouchedAgentMap = new Map([
      [
        "+17135559003",
        {
          listingIds: ["recTEST00000000001", "recOther"],
          statuses: ["Texted", "Texted"],
          mostRecentTouchedDate: dateDaysAgo(15),
        },
      ],
    ]);
    const d = classifyCadence({
      listing: listing({ agentPhone: phone }),
      bucket: "pending_reverification",
      agentInteractionMap: interactionMap,
      recentlyTouchedAgentMap: recentMap,
      now: NOW,
    });
    expect(d.action).toBe("hold_warm_contact_manual_draft");
    // Layer 1's banner wins — does NOT contain "within last N days".
    expect(d.banner).toContain("other Listings_V1 record(s)");
    expect(d.banner).not.toContain("within last 30 days");
  });

  it("T22: agent never previously touched → cold cadence (send_status_check)", () => {
    const recentMap: RecentlyTouchedAgentMap = new Map();
    const interactionMap: AgentInteractionMap = new Map();
    const d = classifyCadence({
      listing: listing({ agentPhone: "713-555-9004" }),
      bucket: "pending_reverification",
      agentInteractionMap: interactionMap,
      recentlyTouchedAgentMap: recentMap,
      now: NOW,
    });
    expect(d.action).toBe("send_status_check");
  });

  it("T23: self-reference — a listing's own Last_Outreach_Date doesn't trigger its own warm flag", () => {
    // Endpoint builds the map including the current record's own
    // touch; classifier must filter self out. If the entry contains
    // only the current record, no warm flag should fire.
    const phone = "713-555-9005";
    const recentMap: RecentlyTouchedAgentMap = new Map([
      [
        "+17135559005",
        {
          listingIds: ["recTEST00000000001"], // current record only
          statuses: ["Texted"],
          mostRecentTouchedDate: dateDaysAgo(10),
        },
      ],
    ]);
    const d = classifyCadence({
      listing: listing({ agentPhone: phone }),
      bucket: "pending_reverification",
      recentlyTouchedAgentMap: recentMap,
      now: NOW,
    });
    expect(d.action).toBe("send_status_check");
  });

  it("T23b: multiple OTHER recent touches with mixed statuses → banner lists unique statuses sorted", () => {
    const phone = "713-555-9006";
    const recentMap: RecentlyTouchedAgentMap = new Map([
      [
        "+17135559006",
        {
          listingIds: ["recOLD1", "recOLD2", "recOLD3"],
          statuses: ["Dead", "Emailed", "Dead"],
          mostRecentTouchedDate: dateDaysAgo(5),
        },
      ],
    ]);
    const d = classifyCadence({
      listing: listing({ agentPhone: phone }),
      bucket: "pending_reverification",
      recentlyTouchedAgentMap: recentMap,
      now: NOW,
    });
    expect(d.action).toBe("hold_warm_contact_manual_draft");
    // Unique sorted: "Dead, Emailed"
    expect(d.banner).toContain("(now Dead, Emailed)");
    expect(d.banner).toContain("on 3 other listing(s)");
  });
});
