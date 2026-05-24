// INV-022 — property-intel-hydrate pure helper tests (Sprint 1).

import { describe, it, expect } from "vitest";
import {
  shouldHydrate,
  isFreshnessWindowExpired,
  computePayoffTotal,
  isSpecialFloodHazardZone,
  computePriceDrift,
  buildDiscrepancyFlags,
  maxSeverity,
  normalizeName,
  HYDRATION_ELIGIBLE_STATES,
  FRESHNESS_WINDOW_HOURS,
  PRICE_DRIFT_THRESHOLD_PCT,
  type HydrationCandidate,
} from "./property-intel-hydrate";
import type { DiscrepancyFlag } from "@/lib/property-intel";

function cand(over: Partial<HydrationCandidate> = {}): HydrationCandidate {
  return { outreachStatus: "Negotiating", lastHydratedAt: null, ...over };
}

describe("shouldHydrate — INV-022 eligibility predicate", () => {
  it("hydrates an eligible never-hydrated record", () => {
    const d = shouldHydrate(cand());
    expect(d.action).toBe("hydrate");
    expect(d.reason).toBe("should_hydrate");
  });

  it("hydrates Offer Accepted too", () => {
    expect(shouldHydrate(cand({ outreachStatus: "Offer Accepted" })).action).toBe("hydrate");
  });

  it("skips ineligible status (Texted)", () => {
    const d = shouldHydrate(cand({ outreachStatus: "Texted" }));
    expect(d.action).toBe("skip");
    expect(d.reason).toBe("status_not_eligible");
  });

  it("skips null status", () => {
    expect(shouldHydrate(cand({ outreachStatus: null })).reason).toBe("status_not_eligible");
  });

  it("skips a record hydrated within the freshness window", () => {
    const now = new Date("2026-05-25T15:00:00Z");
    const recent = new Date("2026-05-25T05:00:00Z").toISOString(); // 10h ago
    const d = shouldHydrate(cand({ lastHydratedAt: recent }), now);
    expect(d.action).toBe("skip");
    expect(d.reason).toBe("within_freshness_window");
  });

  it("hydrates a record hydrated longer than the window ago", () => {
    const now = new Date("2026-05-25T15:00:00Z");
    const old = new Date("2026-05-23T15:00:00Z").toISOString(); // 48h ago
    expect(shouldHydrate(cand({ lastHydratedAt: old }), now).action).toBe("hydrate");
  });

  it("force=true overrides the freshness window", () => {
    const now = new Date("2026-05-25T15:00:00Z");
    const recent = new Date("2026-05-25T14:00:00Z").toISOString(); // 1h ago
    expect(shouldHydrate(cand({ lastHydratedAt: recent }), now, true).action).toBe("hydrate");
  });

  it("force does NOT override status ineligibility", () => {
    expect(
      shouldHydrate(cand({ outreachStatus: "Dead" }), new Date(), true).reason,
    ).toBe("status_not_eligible");
  });
});

describe("isFreshnessWindowExpired", () => {
  it("null lastHydratedAt → expired (never hydrated)", () => {
    expect(isFreshnessWindowExpired(null)).toBe(true);
  });
  it("unparseable timestamp → expired (fail-open to re-hydrate)", () => {
    expect(isFreshnessWindowExpired("not-a-date")).toBe(true);
  });
  it("exactly at window boundary → expired", () => {
    const now = new Date("2026-05-25T15:00:00Z");
    const exactly = new Date(now.getTime() - FRESHNESS_WINDOW_HOURS * 3_600_000).toISOString();
    expect(isFreshnessWindowExpired(exactly, now)).toBe(true);
  });
  it("just inside window → not expired", () => {
    const now = new Date("2026-05-25T15:00:00Z");
    const justInside = new Date(now.getTime() - (FRESHNESS_WINDOW_HOURS - 1) * 3_600_000).toISOString();
    expect(isFreshnessWindowExpired(justInside, now)).toBe(false);
  });
});

describe("computePayoffTotal", () => {
  it("sums all lien components", () => {
    expect(
      computePayoffTotal({
        firstMortgageAmount: 55000,
        secondMortgageAmount: 10000,
        judgmentLiensTotal: 2000,
        mechanicLiensTotal: 1500,
        taxLiensTotal: 3000,
      }),
    ).toBe(71500);
  });
  it("treats null/undefined components as 0", () => {
    expect(computePayoffTotal({ firstMortgageAmount: 55000 })).toBe(55000);
  });
  it("clamps negative inputs to 0 (no deflation)", () => {
    expect(
      computePayoffTotal({ firstMortgageAmount: 55000, secondMortgageAmount: -9999 }),
    ).toBe(55000);
  });
  it("empty input → 0", () => {
    expect(computePayoffTotal({})).toBe(0);
  });
  it("23 Fields scenario: $55K revolving line", () => {
    expect(computePayoffTotal({ firstMortgageAmount: 55000 })).toBe(55000);
  });
});

describe("isSpecialFloodHazardZone", () => {
  it("A-prefixed zones are SFHA", () => {
    expect(isSpecialFloodHazardZone("A")).toBe(true);
    expect(isSpecialFloodHazardZone("AE")).toBe(true);
    expect(isSpecialFloodHazardZone("AO")).toBe(true);
  });
  it("V-prefixed zones are SFHA", () => {
    expect(isSpecialFloodHazardZone("VE")).toBe(true);
  });
  it("X / C / B / D are outside SFHA", () => {
    expect(isSpecialFloodHazardZone("X")).toBe(false);
    expect(isSpecialFloodHazardZone("C")).toBe(false);
    expect(isSpecialFloodHazardZone("B")).toBe(false);
    expect(isSpecialFloodHazardZone("D")).toBe(false);
  });
  it("null / empty → false", () => {
    expect(isSpecialFloodHazardZone(null)).toBe(false);
    expect(isSpecialFloodHazardZone("")).toBe(false);
    expect(isSpecialFloodHazardZone("  ")).toBe(false);
  });
  it("case-insensitive", () => {
    expect(isSpecialFloodHazardZone("ae")).toBe(true);
  });
});

describe("computePriceDrift", () => {
  it("flags AS-IS well above contract", () => {
    const d = computePriceDrift(150000, 100000); // 50% above
    expect(d.driftPct).toBeCloseTo(50, 1);
    expect(d.delta).toBe(50000);
    expect(d.exceedsThreshold).toBe(true);
  });
  it("flags AS-IS well below contract", () => {
    const d = computePriceDrift(70000, 100000); // 30% below
    expect(d.driftPct).toBeCloseTo(30, 1);
    expect(d.delta).toBe(-30000);
    expect(d.exceedsThreshold).toBe(true);
  });
  it("does not flag within threshold", () => {
    const d = computePriceDrift(110000, 100000); // 10%
    expect(d.exceedsThreshold).toBe(false);
  });
  it("exactly at threshold → not exceeding", () => {
    const d = computePriceDrift(120000, 100000); // exactly 20%
    expect(d.driftPct).toBeCloseTo(PRICE_DRIFT_THRESHOLD_PCT, 1);
    expect(d.exceedsThreshold).toBe(false);
  });
  it("missing inputs → no drift", () => {
    expect(computePriceDrift(null, 100000).exceedsThreshold).toBe(false);
    expect(computePriceDrift(100000, null).exceedsThreshold).toBe(false);
    expect(computePriceDrift(100000, 0).exceedsThreshold).toBe(false);
  });
});

describe("maxSeverity", () => {
  it("empty → none", () => {
    expect(maxSeverity([])).toBe("none");
  });
  it("picks the highest rank", () => {
    const flags: DiscrepancyFlag[] = [
      { type: "crime_grade_drop", severity: "info", detail: "", detected_at: "" },
      { type: "flood_zone", severity: "amber", detail: "", detected_at: "" },
      { type: "lien_presence", severity: "red", detail: "", detected_at: "" },
    ];
    expect(maxSeverity(flags)).toBe("red");
  });
});

describe("buildDiscrepancyFlags", () => {
  const now = new Date("2026-05-25T15:00:00Z");

  it("flags owner mismatch when names differ materially", () => {
    const r = buildDiscrepancyFlags(
      { ownerOfRecord: "Terrance Williams", statedSeller: "Genesis Prop Managers" },
      now,
    );
    expect(r.flags.some((f) => f.type === "owner_mismatch")).toBe(true);
    expect(r.severityMax).toBe("amber");
  });

  it("does NOT flag owner mismatch on trivial suffix/case diffs", () => {
    const r = buildDiscrepancyFlags(
      { ownerOfRecord: "Genesis Prop Managers LLC", statedSeller: "genesis prop managers" },
      now,
    );
    expect(r.flags.some((f) => f.type === "owner_mismatch")).toBe(false);
  });

  it("flags lien presence amber for a fixed mortgage", () => {
    const r = buildDiscrepancyFlags(
      { liens: { firstMortgageAmount: 55000 }, firstMortgageType: "fixed" },
      now,
    );
    const lien = r.flags.find((f) => f.type === "lien_presence");
    expect(lien?.severity).toBe("amber");
  });

  it("elevates lien presence to RED for a revolving mortgage (23 Fields)", () => {
    const r = buildDiscrepancyFlags(
      { liens: { firstMortgageAmount: 55000 }, firstMortgageType: "revolving" },
      now,
    );
    const lien = r.flags.find((f) => f.type === "lien_presence");
    expect(lien?.severity).toBe("red");
    expect(r.severityMax).toBe("red");
    expect(lien?.detail).toContain("REVOLVING");
  });

  it("does not flag lien presence when payoff is zero", () => {
    const r = buildDiscrepancyFlags({ liens: {} }, now);
    expect(r.flags.some((f) => f.type === "lien_presence")).toBe(false);
  });

  it("flags SFHA flood zone amber", () => {
    const r = buildDiscrepancyFlags({ femaFloodZone: "AE" }, now);
    expect(r.flags.some((f) => f.type === "flood_zone")).toBe(true);
  });

  it("does not flag zone X", () => {
    const r = buildDiscrepancyFlags({ femaFloodZone: "X" }, now);
    expect(r.flags.some((f) => f.type === "flood_zone")).toBe(false);
  });

  it("flags price drift beyond threshold", () => {
    const r = buildDiscrepancyFlags({ asIsValue: 70000, contractPrice: 100000 }, now);
    expect(r.flags.some((f) => f.type === "price_drift")).toBe(true);
  });

  it("flags Memphis assignment when applicable", () => {
    const r = buildDiscrepancyFlags({ memphisAssignmentApplies: true }, now);
    expect(r.flags.some((f) => f.type === "memphis_assignment")).toBe(true);
  });

  it("returns none severity + empty flags on clean inputs", () => {
    const r = buildDiscrepancyFlags(
      { femaFloodZone: "X", asIsValue: 100000, contractPrice: 100000, liens: {} },
      now,
    );
    expect(r.flags).toHaveLength(0);
    expect(r.severityMax).toBe("none");
  });

  it("compounds multiple flags and reports max severity", () => {
    const r = buildDiscrepancyFlags(
      {
        liens: { firstMortgageAmount: 55000 },
        firstMortgageType: "revolving",
        femaFloodZone: "AE",
        asIsValue: 70000,
        contractPrice: 100000,
      },
      now,
    );
    expect(r.flags.length).toBeGreaterThanOrEqual(3);
    expect(r.severityMax).toBe("red"); // revolving lien dominates
  });

  it("stamps detected_at with the provided clock", () => {
    const r = buildDiscrepancyFlags({ femaFloodZone: "AE" }, now);
    expect(r.flags[0].detected_at).toBe(now.toISOString());
  });
});

describe("normalizeName", () => {
  it("strips business suffixes, punctuation, case, whitespace", () => {
    expect(normalizeName("Genesis Prop Managers, LLC")).toBe("genesis prop managers");
    expect(normalizeName("ACME  Inc.")).toBe("acme");
  });
});

describe("constants", () => {
  it("eligible states are the DD-stage-and-later statuses", () => {
    expect(HYDRATION_ELIGIBLE_STATES.has("Negotiating")).toBe(true);
    expect(HYDRATION_ELIGIBLE_STATES.has("Offer Accepted")).toBe(true);
    expect(HYDRATION_ELIGIBLE_STATES.has("Contract Signed")).toBe(true);
    // Pre-DD stages excluded — too noisy, burns budget.
    expect(HYDRATION_ELIGIBLE_STATES.has("Texted")).toBe(false);
    expect(HYDRATION_ELIGIBLE_STATES.has("Response Received")).toBe(false);
    expect(HYDRATION_ELIGIBLE_STATES.has("Inbound Lead")).toBe(false);
  });
});
