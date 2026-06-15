import { describe, it, expect } from "vitest";
import { isReviewBacklogInScope, routeBacklogStatus, BACKLOG_DEFAULT_STATE } from "./backlog-reprice";
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

describe("routeBacklogStatus — Review vs Manual Review", () => {
  it("clean buy-box opener ≤75% of list, list ≤$250k → stays Review (sendable)", () => {
    const v = routeBacklogStatus({ opener: 33_247, listPrice: 70_000 }); // 47%
    expect(v.route).toBe("review");
    expect(v.manualReview).toBe(false);
  });

  it("opener at exactly 75% stays Review; above 75% → Manual Review (hot-seed)", () => {
    expect(routeBacklogStatus({ opener: 75_000, listPrice: 100_000 }).manualReview).toBe(false);
    expect(routeBacklogStatus({ opener: 75_001, listPrice: 100_000 }).manualReview).toBe(true);
  });

  it("74% stays Review, 80% routes to Manual Review (the slice boundary cases)", () => {
    expect(routeBacklogStatus({ opener: 74_000, listPrice: 100_000 }).route).toBe("review");   // 19120 Orleans
    expect(routeBacklogStatus({ opener: 80_000, listPrice: 100_000 }).route).toBe("manual_review"); // 151 Mclean
  });

  it("capped_to_list (90% of list) always trips hot-seed → Manual Review", () => {
    const v = routeBacklogStatus({ opener: 45_000, listPrice: 50_000 }); // 90%
    expect(v.manualReview).toBe(true);
    expect(v.reasons.some((r) => r.includes("hot-seed"))).toBe(true);
  });

  it("list > $250k → Manual Review regardless of basis (luxury 65%-fallback)", () => {
    const v = routeBacklogStatus({ opener: 260_000, listPrice: 400_000 }); // 65% but luxury
    expect(v.manualReview).toBe(true);
    expect(v.reasons.some((r) => r.includes("ceiling"))).toBe(true);
  });

  it("an arv_buybox opener on a >$250k list still routes to Manual Review (human look, not auto-reject)", () => {
    const v = routeBacklogStatus({ opener: 90_000, listPrice: 280_000 }); // 32%, but list>ceiling
    expect(v.route).toBe("manual_review");
  });
});
