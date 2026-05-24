// Phase 16.x / M.2 — Appraiser backfill helper tests.
//
// Locks the pure helpers that gate the destructive apply path:
//   - classifyBackfillEligibility — what gets touched vs skipped.
//   - readBackfillPaceMs — env-driven throttle clamp.
//   - aggregateBackfillStatus — per-record status roll-up across the
//     three Appraiser endpoint calls.

import { describe, it, expect } from "vitest";
import {
  aggregateBackfillStatus,
  classifyBackfillEligibility,
  estimateBackfillCost,
  readBackfillPaceMs,
  totalBackfillCost,
} from "./appraiser-backfill";
import type { Listing } from "@/lib/types";

type EligibilityListing = Parameters<typeof classifyBackfillEligibility>[0];

function makeListing(overrides: Partial<EligibilityListing> = {}): EligibilityListing {
  return {
    id: "recTEST",
    zip: "78210",
    arvValidatedAt: null,
    rehabEstimatedAt: null,
    estimatedMonthlyRent: null,
    arvConfidence: null,
    realArvMedian: null,
    ...overrides,
  };
}

describe("classifyBackfillEligibility", () => {
  it("eligible when ARV / rehab / rent all null and zip present", () => {
    const r = classifyBackfillEligibility(makeListing());
    expect(r.eligible).toBe(true);
    expect(r.skipReason).toBeNull();
  });

  it("skip missing_zip when zip is empty / null / whitespace", () => {
    expect(classifyBackfillEligibility(makeListing({ zip: "" }))).toMatchObject({
      eligible: false,
      skipReason: "missing_zip",
    });
    expect(
      classifyBackfillEligibility(makeListing({ zip: "   " })),
    ).toMatchObject({ eligible: false, skipReason: "missing_zip" });
  });

  it("skip manual_review_low_arv when arvConfidence is LOW (Phase 4A.1 gate)", () => {
    const r = classifyBackfillEligibility(makeListing({ arvConfidence: "LOW" }));
    expect(r.eligible).toBe(false);
    expect(r.skipReason).toBe("manual_review_low_arv");
  });

  it("override LOW-ARV skip with includeManualReview=true", () => {
    const r = classifyBackfillEligibility(
      makeListing({ arvConfidence: "LOW" }),
      { includeManualReview: true },
    );
    expect(r.eligible).toBe(true);
  });

  it("HIGH / MED arvConfidence does NOT skip (only LOW is the gate)", () => {
    expect(
      classifyBackfillEligibility(makeListing({ arvConfidence: "HIGH" })).eligible,
    ).toBe(true);
    expect(
      classifyBackfillEligibility(makeListing({ arvConfidence: "MED" })).eligible,
    ).toBe(true);
  });

  it("skip already_complete when all three completion fields populated", () => {
    const r = classifyBackfillEligibility(
      makeListing({
        arvValidatedAt: "2026-05-18T00:00:00Z",
        rehabEstimatedAt: "2026-05-18T00:00:00Z",
        estimatedMonthlyRent: 1400,
      }),
    );
    expect(r.eligible).toBe(false);
    expect(r.skipReason).toBe("already_complete");
  });

  it("partial completion is eligible (only all-three skips)", () => {
    // ARV + Rehab populated but rent null → still eligible.
    const r = classifyBackfillEligibility(
      makeListing({
        arvValidatedAt: "2026-05-18T00:00:00Z",
        rehabEstimatedAt: "2026-05-18T00:00:00Z",
        estimatedMonthlyRent: null,
      }),
    );
    expect(r.eligible).toBe(true);
  });

  it("override already_complete with force=true", () => {
    const r = classifyBackfillEligibility(
      makeListing({
        arvValidatedAt: "2026-05-18T00:00:00Z",
        rehabEstimatedAt: "2026-05-18T00:00:00Z",
        estimatedMonthlyRent: 1400,
      }),
      { force: true },
    );
    expect(r.eligible).toBe(true);
  });

  it("missing_zip wins over LOW-ARV and already_complete (gate ordering)", () => {
    // First gate is zip; even fully-complete + LOW-ARV records get
    // missing_zip if zip is missing.
    const r = classifyBackfillEligibility(
      makeListing({
        zip: "",
        arvConfidence: "LOW",
        arvValidatedAt: "2026-05-18T00:00:00Z",
        rehabEstimatedAt: "2026-05-18T00:00:00Z",
        estimatedMonthlyRent: 1400,
      }),
    );
    expect(r.skipReason).toBe("missing_zip");
  });

  it("populates current snapshot regardless of eligibility", () => {
    const r = classifyBackfillEligibility(
      makeListing({
        arvValidatedAt: "2026-01-01T00:00:00Z",
        rehabEstimatedAt: null,
        estimatedMonthlyRent: 1500,
        arvConfidence: "MED",
      }),
    );
    expect(r.current).toEqual({
      arv_validated_at: "2026-01-01T00:00:00Z",
      rehab_estimated_at: null,
      estimated_monthly_rent: 1500,
      arv_confidence: "MED",
    });
  });
});

describe("estimateBackfillCost + totalBackfillCost", () => {
  it("per-record cost: 1 scraperapi + 1 anthropic + 1 rentcast when rent missing", () => {
    expect(estimateBackfillCost({ estimatedMonthlyRent: null })).toEqual({
      scraperapi_calls: 1,
      anthropic_calls: 1,
      rentcast_calls: 1,
    });
  });

  it("rentcast skipped when rent already populated (BuyerIntel caches across runs)", () => {
    expect(estimateBackfillCost({ estimatedMonthlyRent: 1400 })).toEqual({
      scraperapi_calls: 1,
      anthropic_calls: 1,
      rentcast_calls: 0,
    });
  });

  it("zero / negative rent treated as missing (defensive)", () => {
    expect(estimateBackfillCost({ estimatedMonthlyRent: 0 }).rentcast_calls).toBe(1);
  });

  it("totalBackfillCost sums correctly across records", () => {
    const totals = totalBackfillCost([
      { scraperapi_calls: 1, anthropic_calls: 1, rentcast_calls: 1 },
      { scraperapi_calls: 1, anthropic_calls: 1, rentcast_calls: 0 },
      { scraperapi_calls: 1, anthropic_calls: 1, rentcast_calls: 1 },
    ]);
    expect(totals).toEqual({
      scraperapi_calls: 3,
      anthropic_calls: 3,
      rentcast_calls: 2,
    });
  });

  it("totalBackfillCost empty list → zeros", () => {
    expect(totalBackfillCost([])).toEqual({
      scraperapi_calls: 0,
      anthropic_calls: 0,
      rentcast_calls: 0,
    });
  });
});

describe("readBackfillPaceMs", () => {
  it("default 2000ms when env var unset", () => {
    expect(readBackfillPaceMs({})).toBe(2000);
  });

  it("respects valid env value", () => {
    expect(readBackfillPaceMs({ BACKFILL_PACE_MS: "3500" })).toBe(3500);
  });

  it("clamps to 30000ms ceiling", () => {
    expect(readBackfillPaceMs({ BACKFILL_PACE_MS: "999999" })).toBe(30_000);
  });

  it("zero allowed (back-to-back firing for isolated reruns)", () => {
    expect(readBackfillPaceMs({ BACKFILL_PACE_MS: "0" })).toBe(0);
  });

  it("invalid values fall through to default", () => {
    expect(readBackfillPaceMs({ BACKFILL_PACE_MS: "not-a-number" })).toBe(2000);
    expect(readBackfillPaceMs({ BACKFILL_PACE_MS: "-100" })).toBe(2000);
    expect(readBackfillPaceMs({ BACKFILL_PACE_MS: "" })).toBe(2000);
  });
});

describe("aggregateBackfillStatus", () => {
  it("ok when all three endpoints succeeded", () => {
    expect(aggregateBackfillStatus("ok", "ok", "ok")).toBe("ok");
  });

  it("error when all three endpoints failed", () => {
    expect(aggregateBackfillStatus("error", "error", "error")).toBe("error");
  });

  it("partial when at least one ok and at least one error", () => {
    expect(aggregateBackfillStatus("ok", "error", "ok")).toBe("partial");
    expect(aggregateBackfillStatus("error", "ok", "error")).toBe("partial");
    expect(aggregateBackfillStatus("ok", "ok", "error")).toBe("partial");
    expect(aggregateBackfillStatus("error", "error", "ok")).toBe("partial");
  });
});

describe("classifyBackfillEligibility — anchor: 37 active deals state", () => {
  it("typical pre-backfill record (no Appraiser data yet) → eligible", () => {
    // This is the canonical state of the 37 active deals per the
    // 5/18 session-open briefing: all three Appraiser outputs null,
    // zip present, no manual-review flag.
    const r = classifyBackfillEligibility(
      makeListing({
        zip: "78210",
        arvValidatedAt: null,
        rehabEstimatedAt: null,
        estimatedMonthlyRent: null,
        arvConfidence: null,
      }),
    );
    expect(r.eligible).toBe(true);
    expect(r.skipReason).toBeNull();
  });
});
