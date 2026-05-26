// Pure tests for the stale Auto-Proceed outreach cleanup selector.

import { describe, it, expect } from "vitest";
import {
  selectStaleOutreach,
  matchesCleanupCriteria,
  buildCleanupNote,
  CLEANUP_SENTINEL,
} from "./cleanup-stale-outreach";
import type { Listing } from "@/lib/types";

function listing(over: Partial<Listing> = {}): Listing {
  return {
    id: "rec1",
    address: "123 Main St",
    city: "San Antonio",
    zip: "78201",
    listPrice: 150000,
    mao: null,
    dom: 40,
    offerTier: null,
    liveStatus: "Active",
    executionPath: "Auto Proceed",
    outreachStatus: "",
    lastOutreachDate: null,
    agentName: "Jane Agent",
    agentPhone: "+12105551234",
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
    actionHoldUntil: null,
    actionCardState: null,
    lastInboundAt: null,
    lastOutboundAt: null,
    ...over,
  } as Listing;
}

describe("matchesCleanupCriteria", () => {
  it("matches the canonical Auto-Proceed stale record", () => {
    expect(matchesCleanupCriteria(listing())).toBe(true);
  });
  it("treats null/whitespace Outreach_Status as empty (match)", () => {
    expect(matchesCleanupCriteria(listing({ outreachStatus: null }))).toBe(true);
    expect(matchesCleanupCriteria(listing({ outreachStatus: "   " }))).toBe(true);
  });
  it("rejects when Outreach_Status is set (already in a cadence)", () => {
    expect(matchesCleanupCriteria(listing({ outreachStatus: "Texted" }))).toBe(false);
  });
  it("rejects non-Auto-Proceed execution paths", () => {
    expect(matchesCleanupCriteria(listing({ executionPath: "Manual Review" }))).toBe(false);
    expect(matchesCleanupCriteria(listing({ executionPath: "Reject" }))).toBe(false);
  });
  it("rejects non-Active live status", () => {
    expect(matchesCleanupCriteria(listing({ liveStatus: "Off Market" }))).toBe(false);
  });
  it("rejects missing agent phone", () => {
    expect(matchesCleanupCriteria(listing({ agentPhone: null }))).toBe(false);
    expect(matchesCleanupCriteria(listing({ agentPhone: "  " }))).toBe(false);
  });
  it("rejects records already Do_Not_Text (no re-touch)", () => {
    expect(matchesCleanupCriteria(listing({ doNotText: true }))).toBe(false);
  });
});

describe("selectStaleOutreach", () => {
  it("partitions eligible vs the two integrity buckets", () => {
    const set = [
      listing({ id: "ok1" }),
      listing({ id: "ok2", dom: 90 }),
      listing({ id: "skip_status", outreachStatus: "Texted" }),
      listing({ id: "skip_dnt", doNotText: true }),
      listing({ id: "restricted", state: "IL" }),
      listing({ id: "never", address: "2715 Monterey St" }),
    ];
    const r = selectStaleOutreach(set);
    expect(r.eligible.map((l) => l.id).sort()).toEqual(["ok1", "ok2", "restricted"]);
    expect(r.restrictedStateViolations.map((l) => l.id)).toEqual(["restricted"]);
    expect(r.excludedNeverResurface.map((l) => l.id)).toEqual(["never"]);
  });

  it("excludes never-resurface addresses from the write set (case-insensitive)", () => {
    const r = selectStaleOutreach([listing({ id: "n", address: "714 HALLIE AVE" })]);
    expect(r.eligible).toHaveLength(0);
    expect(r.excludedNeverResurface.map((l) => l.id)).toEqual(["n"]);
  });

  it("flags restricted-state matches but still keeps them eligible (Do_Not_Text is correct for them too)", () => {
    const r = selectStaleOutreach([listing({ id: "mo", state: "MO" })]);
    expect(r.eligible.map((l) => l.id)).toEqual(["mo"]);
    expect(r.restrictedStateViolations.map((l) => l.id)).toEqual(["mo"]);
  });

  it("expected restricted-state count is 0 for a clean TX/TN cohort", () => {
    const r = selectStaleOutreach([listing({ state: "TX" }), listing({ id: "tn", state: "TN" })]);
    expect(r.restrictedStateViolations).toHaveLength(0);
  });
});

describe("buildCleanupNote", () => {
  it("appends the provenance line to existing notes", () => {
    const note = buildCleanupNote("Prior note.", "2026-05-26");
    expect(note).toContain("Prior note.");
    expect(note).toContain("2026-05-26 — Pre-H2-live mass cleanup.");
    expect(note).toContain("re-enter pipeline via Crawler");
  });
  it("writes the line standalone when there are no prior notes", () => {
    expect(buildCleanupNote(null, "2026-05-26").startsWith("2026-05-26 — ")).toBe(true);
  });
  it("is idempotent — no re-append when the sentinel is already present", () => {
    const once = buildCleanupNote(null, "2026-05-26");
    const twice = buildCleanupNote(once, "2026-05-26");
    expect(twice).toBe(once);
    expect(once.includes(CLEANUP_SENTINEL)).toBe(true);
  });
});
