import { describe, it, expect } from "vitest";
import { isReviewBacklogInScope, BACKLOG_DEFAULT_STATE } from "./backlog-reprice";
import type { Listing } from "@/lib/types";

const SINCE = Date.parse("2026-06-09T00:00:00Z");

function rec(over: Partial<Listing> = {}): Listing {
  return {
    id: "rec1", address: "1 A St", city: "Detroit", zip: "48205",
    state: "MI", outreachStatus: "Review", createdTime: "2026-06-12T10:00:00Z",
    roughOpenerAmount: null,
    listPrice: 50_000, mao: null, dom: null, offerTier: null, liveStatus: null,
    executionPath: null, lastOutreachDate: null, agentName: null, agentPhone: null,
    agentEmail: null, verificationUrl: null, notes: null, distressScore: null, distressBucket: null,
    ...over,
  } as Listing;
}

const opts = { sinceMs: SINCE, state: BACKLOG_DEFAULT_STATE };

describe("isReviewBacklogInScope", () => {
  it("accepts a fresh MI Review record with no opener yet", () => {
    expect(isReviewBacklogInScope(rec(), opts)).toBe(true);
  });

  it("accepts Manual Review too", () => {
    expect(isReviewBacklogInScope(rec({ outreachStatus: "Manual Review" }), opts)).toBe(true);
  });

  it("rejects non-Review status (already promoted / dead / empty)", () => {
    expect(isReviewBacklogInScope(rec({ outreachStatus: "" }), opts)).toBe(false);
    expect(isReviewBacklogInScope(rec({ outreachStatus: "Dead" }), opts)).toBe(false);
    expect(isReviewBacklogInScope(rec({ outreachStatus: "Texted" }), opts)).toBe(false);
  });

  it("rejects non-MI (skips the stale TX/Memphis backlog)", () => {
    expect(isReviewBacklogInScope(rec({ state: "TX" }), opts)).toBe(false);
    expect(isReviewBacklogInScope(rec({ state: "TN" }), opts)).toBe(false);
  });

  it("rejects records created before the cohort cutoff", () => {
    expect(isReviewBacklogInScope(rec({ createdTime: "2026-06-08T23:59:00Z" }), opts)).toBe(false);
    expect(isReviewBacklogInScope(rec({ createdTime: null }), opts)).toBe(false);
  });

  it("rejects already-priced records (idempotent cursor — no re-spend)", () => {
    expect(isReviewBacklogInScope(rec({ roughOpenerAmount: 33_000 }), opts)).toBe(false);
  });

  it("honors a ZIP narrowing when provided", () => {
    const z = { ...opts, zips: new Set(["48205"]) };
    expect(isReviewBacklogInScope(rec({ zip: "48205" }), z)).toBe(true);
    expect(isReviewBacklogInScope(rec({ zip: "48206" }), z)).toBe(false);
  });
});
