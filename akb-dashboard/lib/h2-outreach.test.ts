// Pure tests for H2 first-touch outreach routing.

import { describe, it, expect } from "vitest";
import {
  isH2Eligible,
  selectH2Eligible,
  buildPriorContactIndex,
  buildH2Message,
  firstNameOnly,
  buildSentNote,
  buildStallNote,
  buildQuarantineNote,
  planQueue,
  addressKey,
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
    expect(p.message).toContain("listing at 123 Main St. I would like");
    expect(p.message).toContain("$97,500");
  });
  it("falls back to 'there' when agent name is blank", () => {
    const [p] = plan([listing({ agentName: "" })]);
    expect(p.message).toContain("Hi there, this is Alex");
  });
  it("uses the address verbatim — no redundant city clause appended", () => {
    // Real RentCast addresses already carry city/state/zip; the old code
    // appended " in {city}" → "…, San Antonio, TX 78201 in San Antonio".
    const [p] = plan([listing({ address: "1138 Santa Anna, San Antonio, TX 78201", city: "San Antonio" })]);
    expect(p.message).toContain("listing at 1138 Santa Anna, San Antonio, TX 78201. I would like");
    expect(p.message).not.toContain("78201 in San Antonio");
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

describe("addressKey — normalized same-property key (Spine recwkHvBMTjeMLECp)", () => {
  it("matches the truncated vs directional+suffix forms (the 1610 dup)", () => {
    expect(addressKey("1610 22nd, San Antonio, TX 78201"))
      .toBe(addressKey("1610 Nw 22nd St, San Antonio, TX 78201"));
  });
  it("matches suffix-present vs suffix-absent (the 1803 Mardell dup)", () => {
    expect(addressKey("1803 Mardell St, San Antonio, TX 78201"))
      .toBe(addressKey("1803 Mardell, San Antonio, TX 78201"));
  });
  it("does NOT merge different house numbers on the same street", () => {
    expect(addressKey("1610 22nd")).not.toBe(addressKey("1612 22nd"));
  });
  it("returns null when there's not enough to match safely", () => {
    expect(addressKey(null)).toBeNull();
    expect(addressKey("")).toBeNull();
    expect(addressKey("1610")).toBeNull();        // number only
    expect(addressKey("1610 NW")).toBeNull();     // number + directional only
  });
});

describe("planQueue — normalized-address dedupe (same property, different phones)", () => {
  it("stalls the 2nd same-address record within a run even when phones differ (1610/1803 class)", () => {
    // The exact gap that double-texted: one agent, two phone numbers, one
    // property. Phone-keyed dedupe alone let both first-touch.
    const a = listing({ id: "a", address: "1610 22nd, San Antonio, TX 78201", agentPhone: "(210) 387-1336" });
    const b = listing({ id: "b", address: "1610 Nw 22nd St, San Antonio, TX 78201", agentPhone: "(210) 434-5974" });
    const plans = plan([a, b]);
    expect(plans[0].route).toBe("first_touch");
    expect(plans[1].route).toBe("prior_contact_stall");
    expect(plans[1].prior?.recordId).toBe("a");
    expect(plans[1].prior?.status).toBe("Texted (this run)");
  });

  it("stalls an eligible record whose address was already contacted under a different phone", () => {
    const trigger = listing({ id: "new", address: "1803 Mardell, San Antonio, TX 78201", agentPhone: "(210) 286-7264" });
    const prior = listing({ id: "old", address: "1803 Mardell St, San Antonio, TX 78201", agentPhone: "+12103259807", outreachStatus: "Texted" });
    const [p] = plan([trigger], [trigger, prior]);
    expect(p.route).toBe("prior_contact_stall");
    expect(p.prior?.recordId).toBe("old");
    expect(p.prior?.status).toBe("Texted");
  });

  it("still first-touches genuinely distinct properties (no false merge)", () => {
    const a = listing({ id: "a", address: "1610 22nd, San Antonio, TX 78201", agentPhone: "(210) 111-1111" });
    const b = listing({ id: "b", address: "1612 22nd, San Antonio, TX 78201", agentPhone: "(210) 222-2222" });
    const plans = plan([a, b]);
    expect(plans[0].route).toBe("first_touch");
    expect(plans[1].route).toBe("first_touch");
  });
});
