// Pure tests for H2 first-touch outreach routing.

import { describe, it, expect } from "vitest";
import {
  isH2Eligible,
  ineligibleReasonForListing,
  selectH2Eligible,
  selectOutreachReady,
  outreachReadyReason,
  buildPriorContactIndex,
  buildH2Message,
  firstNameOnly,
  buildSentNote,
  buildStallNote,
  buildQuarantineNote,
  planQueue,
} from "./h2-outreach";
import type { Listing } from "@/lib/types";

function listing(over: Partial<Listing> = {}): Listing {
  return {
    id: "rec1",
    address: "123 Main St",
    city: "San Antonio",
    zip: "78201",
    listPrice: 150000,
    mao: 97500,
    dom: 40,
    offerTier: null,
    liveStatus: "Active",
    executionPath: "Auto Proceed",
    outreachStatus: "",
    lastOutreachDate: null,
    agentName: "Jane Agent",
    agentPhone: "(210) 555-1234",
    agentEmail: null,
    verificationUrl: null,
    notes: null,
    distressScore: null,
    distressBucket: null,
    bedrooms: 3,
    bathrooms: 2,
    buildingSqFt: null,
    stageCalc: null,
    approvedForOutreach: false,
    flipScore: null,
    offMarketOverride: false,
    restrictionText: null,
    ddChecklist: null,
    doNotText: false,
    state: "TX",
    sourceVersion: "v2_post_2026-05-26",
    actionHoldUntil: null,
    actionCardState: null,
    lastInboundAt: null,
    lastOutboundAt: null,
    ...over,
  } as Listing;
}

const NOW = "2026-05-26T19:00:00.000Z";

function plan(queue: Listing[], all: Listing[] = queue) {
  return planQueue(queue, buildPriorContactIndex(all));
}

describe("isH2Eligible", () => {
  it("matches the canonical first-touch candidate", () => {
    expect(isH2Eligible(listing())).toBe(true);
  });
  it("treats null/whitespace Outreach_Status as empty (eligible)", () => {
    expect(isH2Eligible(listing({ outreachStatus: null }))).toBe(true);
    expect(isH2Eligible(listing({ outreachStatus: "  " }))).toBe(true);
  });
  it("rejects already-contacted, wrong path/status, DNT, or missing phone", () => {
    expect(isH2Eligible(listing({ outreachStatus: "Texted" }))).toBe(false);
    expect(isH2Eligible(listing({ executionPath: "Manual Review" }))).toBe(false);
    expect(isH2Eligible(listing({ liveStatus: "Off Market" }))).toBe(false);
    expect(isH2Eligible(listing({ doNotText: true }))).toBe(false);
    expect(isH2Eligible(listing({ agentPhone: "" }))).toBe(false);
    expect(isH2Eligible(listing({ agentPhone: null }))).toBe(false);
  });
  it("excludes legacy / unversioned records (INV-LEGACY-BACKSTOP defense-in-depth)", () => {
    expect(isH2Eligible(listing({ sourceVersion: "v1_legacy" }))).toBe(false);
    expect(isH2Eligible(listing({ sourceVersion: null }))).toBe(false);
    expect(isH2Eligible(listing({ sourceVersion: "v2_post_2026-05-26" }))).toBe(true);
  });
  it("selectH2Eligible filters a mixed set", () => {
    const set = [
      listing({ id: "a" }),
      listing({ id: "b", outreachStatus: "Texted" }),
      listing({ id: "c", doNotText: true }),
      listing({ id: "d" }),
    ];
    expect(selectH2Eligible(set).map((l) => l.id)).toEqual(["a", "d"]);
  });
});

describe("planQueue — first_touch", () => {
  it("routes a clean candidate to first_touch with E.164 dest + composed message", () => {
    const [p] = plan([listing()]);
    expect(p.route).toBe("first_touch");
    expect(p.toE164).toBe("+12105551234");
    expect(p.message).toContain("Hi Jane, this is Alex with AKB Solutions");
    expect(p.message).not.toContain("Jane Agent"); // first name only — 5/8 rule
    expect(p.message).toContain("cash offer of $97,500 on 123 Main St.");
    expect(p.message).toContain("off their hands and done, we're ready to move fast.");
    expect(p.message).not.toContain("open to offers in that range"); // killed copy
    expect(p.message).toContain("$97,500");
  });
  it("falls back to 'there' when agent name is blank", () => {
    const [p] = plan([listing({ agentName: "" })]);
    expect(p.message).toContain("Hi there, this is Alex");
  });
  it("uses the STREET only — drops the redundant city/state/zip tail", () => {
    // Real RentCast addresses carry city/state/zip; the locked reframe
    // (2026-06-30) references the street only ("on 1138 Santa Anna"), never
    // the full line — so no redundant city clause is even possible.
    const [p] = plan([listing({ address: "1138 Santa Anna, San Antonio, TX 78201", city: "San Antonio" })]);
    expect(p.message).toContain("on 1138 Santa Anna. As-is");
    expect(p.message).not.toContain("San Antonio");
    expect(p.message).not.toContain("78201");
  });
});

describe("planQueue — bad_phone_quarantine", () => {
  it("quarantines an unnormalizable phone and never sets a destination", () => {
    const [p] = plan([listing({ agentPhone: "555-CALL-NOW" })]);
    expect(p.route).toBe("bad_phone_quarantine");
    expect(p.toE164).toBeNull();
    expect(p.message).toBeNull();
  });
  it("quarantines an email-in-phone-field value", () => {
    const [p] = plan([listing({ agentPhone: "jane@kw.com" })]);
    expect(p.route).toBe("bad_phone_quarantine");
  });
});

describe("planQueue — prior_contact_stall", () => {
  it("stalls when another record already has non-empty status for the same agent", () => {
    const trigger = listing({ id: "new", agentPhone: "(210) 555-1234" });
    const prior = listing({ id: "old", agentPhone: "210-555-1234", outreachStatus: "Negotiating" });
    const [p] = plan([trigger], [trigger, prior]);
    expect(p.route).toBe("prior_contact_stall");
    expect(p.prior?.recordId).toBe("old");
    expect(p.prior?.status).toBe("Negotiating");
  });
  it("matches across phone formats (normalized), not just exact strings", () => {
    // The whole point of the deviation: "(210) 555-1234" vs "+12105551234".
    const trigger = listing({ id: "new", agentPhone: "(210) 555-1234" });
    const prior = listing({ id: "old", agentPhone: "+12105551234", outreachStatus: "Texted" });
    const [p] = plan([trigger], [trigger, prior]);
    expect(p.route).toBe("prior_contact_stall");
  });
  it("stalls the second same-agent record within a single run (first one texts)", () => {
    const a = listing({ id: "a", address: "1 A St", agentPhone: "(210) 555-1234" });
    const b = listing({ id: "b", address: "2 B St", agentPhone: "210.555.1234" });
    const plans = plan([a, b]);
    expect(plans[0].route).toBe("first_touch");
    expect(plans[1].route).toBe("prior_contact_stall");
    expect(plans[1].prior?.recordId).toBe("a");
    expect(plans[1].prior?.status).toBe("Texted (this run)");
  });
});

describe("planQueue — prior-contact is CONTACTED-only (operator 2026-06-24)", () => {
  // The dedup index must count an agent as "prior contact" ONLY when a sibling
  // listing was actually touched — NOT merely sourced into Review/Parked/Dead.
  // The old "any non-empty status" rule stalled never-texted agents (the three
  // fresh Detroit leads were held behind Review/Parked siblings, throttling
  // volume). Do_Not_Text still enforces opt-outs independently of this index.
  const uncontacted = ["Review", "Parked", "Manual Review", "Multi-Listing Queued", "Dead"];
  for (const status of uncontacted) {
    it(`does NOT stall a first-touch behind a '${status}' (never-texted) sibling`, () => {
      const trigger = listing({ id: "new", agentPhone: "(210) 555-1234" });
      const sibling = listing({ id: "old", agentPhone: "210-555-1234", outreachStatus: status });
      const [p] = plan([trigger], [trigger, sibling]);
      expect(p.route).toBe("first_touch");
    });
  }

  const contacted = [
    "Texted",
    "Texted (Portfolio)",
    "Emailed",
    "Response Received",
    "Negotiating",
    "Offer Accepted",
    "Inbound Lead",
  ];
  for (const status of contacted) {
    it(`DOES stall a first-touch behind a '${status}' (real touch) sibling`, () => {
      const trigger = listing({ id: "new", agentPhone: "(210) 555-1234" });
      const sibling = listing({ id: "old", agentPhone: "210-555-1234", outreachStatus: status });
      const [p] = plan([trigger], [trigger, sibling]);
      expect(p.route).toBe("prior_contact_stall");
      expect(p.prior?.status).toBe(status);
    });
  }

  it("buildPriorContactIndex keys only contacted siblings", () => {
    const idx = buildPriorContactIndex([
      listing({ id: "t", agentPhone: "(210) 555-0001", outreachStatus: "Texted" }),
      listing({ id: "r", agentPhone: "(210) 555-0002", outreachStatus: "Review" }),
      listing({ id: "p", agentPhone: "(210) 555-0003", outreachStatus: "Parked" }),
    ]);
    expect(idx.size).toBe(1);
    expect([...idx.values()][0].recordId).toBe("t");
  });
});

describe("planQueue — skipped (MAO guard)", () => {
  it("skips null MAO rather than texting $0", () => {
    const [p] = plan([listing({ mao: null })]);
    expect(p.route).toBe("skipped");
    expect(p.skipReason).toBe("mao_null_or_zero");
  });
  it("skips zero / negative MAO", () => {
    expect(plan([listing({ mao: 0 })])[0].route).toBe("skipped");
    expect(plan([listing({ mao: -5 })])[0].route).toBe("skipped");
  });
});

describe("note builders", () => {
  it("appends sent / stall / quarantine notes, preserving existing notes", () => {
    expect(buildSentNote("prior", NOW, "msg_abc", "Hi there")).toBe(
      "prior\n\n[H2 sent 2026-05-26T19:00:00.000Z] Quo msg msg_abc: Hi there",
    );
    expect(
      buildStallNote(null, NOW, { recordId: "old", address: "1 A St", status: "Texted" }),
    ).toBe("[H2 stall 2026-05-26T19:00:00.000Z] Prior contact found at record old (1 A St, status: Texted)");
    expect(buildQuarantineNote(null, NOW, "555-CALL")).toBe(
      "[H2 quarantine 2026-05-26T19:00:00.000Z] Bad phone format: '555-CALL'",
    );
  });
  it("formats MAO with thousands separators and no decimals", () => {
    expect(buildH2Message("Sam", "9 Oak", 71250.4)).toContain("$71,250");
  });
});

describe("firstNameOnly — proven 5/8 outreach rule (greet on first name)", () => {
  it("takes only the leading token from a combined Agent_Name", () => {
    expect(firstNameOnly("Jane Smith")).toBe("Jane");
    expect(firstNameOnly("Mary Jo Alvarez")).toBe("Mary");
    expect(firstNameOnly("  Carlos   Reyes ")).toBe("Carlos");
  });
  it("passes through a name that is already first-only", () => {
    expect(firstNameOnly("Jane")).toBe("Jane");
  });
  it("falls back to 'there' on null / empty / whitespace", () => {
    expect(firstNameOnly(null)).toBe("there");
    expect(firstNameOnly("")).toBe("there");
    expect(firstNameOnly("   ")).toBe("there");
  });
});

describe("ineligibleReasonForListing", () => {
  const eligible = (): Partial<Listing> => ({
    outreachStatus: "",
    liveStatus: "Active",
    executionPath: "Auto Proceed",
    doNotText: false,
    agentPhone: "9015551234",
    sourceVersion: "v2_post_2026-05-26",
  });

  it("returns null for a fully eligible listing (mirrors isH2Eligible)", () => {
    const l = listing(eligible());
    expect(ineligibleReasonForListing(l)).toBeNull();
    expect(isH2Eligible(l)).toBe(true);
  });

  it("names each failing gate in isH2Eligible order", () => {
    expect(ineligibleReasonForListing(listing({ ...eligible(), outreachStatus: "Texted" }))).toContain("Outreach_Status already set");
    expect(ineligibleReasonForListing(listing({ ...eligible(), liveStatus: "Off Market" }))).toContain("not Active");
    expect(ineligibleReasonForListing(listing({ ...eligible(), executionPath: "Reject" }))).toContain("not Auto Proceed");
    expect(ineligibleReasonForListing(listing({ ...eligible(), doNotText: true }))).toContain("Do_Not_Text");
    expect(ineligibleReasonForListing(listing({ ...eligible(), agentPhone: "" }))).toContain("Agent_Phone is empty");
    expect(ineligibleReasonForListing(listing({ ...eligible(), sourceVersion: "v1_legacy" }))).toContain("not v2");
  });
});

describe("selectOutreachReady / outreachReadyReason — confirmed-live + actionable gate", () => {
  const NOW = new Date("2026-06-09T12:00:00Z");
  const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
  // A fully outreach-ready TX lead: H2-eligible + fresh + actionable.
  const ready = (): Partial<Listing> => ({
    outreachStatus: "", liveStatus: "Active", executionPath: "Auto Proceed",
    doNotText: false, agentPhone: "(210) 555-1234", sourceVersion: "v2_post_2026-05-26",
    state: "TX", city: "San Antonio", zip: "78201",
    lastVerified: hoursAgo(2),
  });

  it("ready when H2-eligible + fresh + actionable", () => {
    expect(outreachReadyReason(listing(ready()), NOW).ready).toBe(true);
  });
  it("NOT ready when verify is stale (>48h)", () => {
    const r = outreachReadyReason(listing({ ...ready(), lastVerified: hoursAgo(72) }), NOW);
    expect(r.ready).toBe(false);
    expect(r.reason).toBe("verify_stale");
  });
  it("NOT ready when never verified", () => {
    expect(outreachReadyReason(listing({ ...ready(), lastVerified: null }), NOW).reason).toBe("never_verified");
  });
  it("NOT ready in a PAUSED Memphis market even if fresh + H2-eligible", () => {
    const r = outreachReadyReason(listing({ ...ready(), state: "TN", city: "Memphis", zip: "38109" }), NOW);
    expect(r.ready).toBe(false);
    expect(r.reason).toContain("paused_memphis");
  });
  it("NOT ready when not H2-eligible (already texted)", () => {
    expect(outreachReadyReason(listing({ ...ready(), outreachStatus: "Texted" }), NOW).reason).toContain("Outreach_Status already set");
  });
  it("selectOutreachReady filters a mixed set down to the ready ones", () => {
    const set = [
      listing({ id: "ready", ...ready() }),
      listing({ id: "stale", ...ready(), lastVerified: hoursAgo(99) }),
      listing({ id: "memphis", ...ready(), state: "TN", city: "Memphis", zip: "38109" }),
    ];
    expect(selectOutreachReady(set, NOW).map((l) => l.id)).toEqual(["ready"]);
  });
});
