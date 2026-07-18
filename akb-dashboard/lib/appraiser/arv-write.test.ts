import { describe, it, expect } from "vitest";
import { arvPersistFields } from "./arv-write";
import type { ArvCompUsed } from "@/lib/arv-intelligence";

const NOW = "2026-07-17T16:00:00.000Z";

function comp(over: Partial<ArvCompUsed> = {}): ArvCompUsed {
  return {
    price: 214_900,
    sqft: 1_400,
    per_sqft: 153.5,
    distance: 0.3,
    sale_date: "2026-07-01T00:00:00Z",
    beds: 2,
    bathrooms: 1,
    days_on_market: 20,
    formatted_address: "1097 Fortress Ave SW, Atlanta, GA 30315",
    ...over,
  };
}

describe("arvPersistFields", () => {
  it("a real band writes the band + used-comp receipts + stamp (unchanged behavior)", () => {
    const f = arvPersistFields(
      {
        arv_low: 200_000,
        arv_mid: 218_584,
        arv_high: 230_000,
        avg_per_sqft: 154,
        comp_count_used: 3,
        comps_used: [comp(), comp(), comp()],
        comps_excluded: [],
      },
      "MED",
      NOW,
    );
    expect(f.Real_ARV_Median).toBe(218_584);
    expect(f.ARV_Comp_Count).toBe(3);
    expect(f.ARV_Validated_At).toBe(NOW);
    expect(JSON.parse(f.ARV_Comp_Details_JSON as string)).toHaveLength(3);
  });

  it("HONEST EMPTINESS: zero surviving comps writes nulls, count 0, the exclusion receipts, and STILL stamps", () => {
    // The 1122 West Ave shape post-fix: all three comps excluded by name.
    const excluded = [
      comp({ price: 129_999, sale_date: null, formatted_address: "1122 West Ave SW, Atlanta, GA 30315", excluded_reason: "subject_property" }),
      comp({ price: 319_900, sale_date: null, formatted_address: "1048 Garibaldi St SW, Atlanta, GA 30310", excluded_reason: "no_recorded_sale" }),
      comp({ price: 267_500, sale_date: null, formatted_address: "1097 Fortress Ave SW, Atlanta, GA 30315", excluded_reason: "no_recorded_sale" }),
    ];
    const f = arvPersistFields(
      {
        arv_low: null,
        arv_mid: null,
        arv_high: null,
        avg_per_sqft: null,
        comp_count_used: 0,
        comps_used: [],
        comps_excluded: excluded,
      },
      "LOW",
      NOW,
    );
    // The fabricated number is REPLACED with honest nulls — not left standing.
    expect(f.Real_ARV_Median).toBeNull();
    expect(f.Real_ARV_Low).toBeNull();
    expect(f.Real_ARV_High).toBeNull();
    expect(f.ARV_Confidence).toBe("LOW");
    expect(f.ARV_Comp_Count).toBe(0);
    // The stamp is what stops the */5-min cron from re-burning the call.
    expect(f.ARV_Validated_At).toBe(NOW);
    // The operator sees WHY there is no number, per-comp, in the panel.
    const receipts = JSON.parse(f.ARV_Comp_Details_JSON as string) as ArvCompUsed[];
    expect(receipts.map((r) => r.excluded_reason)).toEqual([
      "subject_property",
      "no_recorded_sale",
      "no_recorded_sale",
    ]);
  });

  it("comps survived but no band projectable (missing sqft) — writes emptiness with the used comps as receipts", () => {
    const f = arvPersistFields(
      {
        arv_low: null,
        arv_mid: null,
        arv_high: null,
        avg_per_sqft: 154,
        comp_count_used: 2,
        comps_used: [comp(), comp()],
        comps_excluded: [],
      },
      "LOW",
      NOW,
    );
    expect(f.Real_ARV_Median).toBeNull();
    expect(f.ARV_Comp_Count).toBe(2);
    expect(JSON.parse(f.ARV_Comp_Details_JSON as string)).toHaveLength(2);
    expect(f.ARV_Validated_At).toBe(NOW);
  });
});
