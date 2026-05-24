// INV-022 Sprint 2 — buildHydrationFields pure assembler tests.

import { describe, it, expect } from "vitest";
import { buildHydrationFields } from "./property-intel-store";

describe("buildHydrationFields", () => {
  it("emits valuation fields + provenance when present", () => {
    const f = buildHydrationFields({
      valuation: {
        asIsValue: 120000,
        asIsValueLow: 110000,
        asIsValueHigh: 130000,
        source: "rentcast",
        fetchedAt: "2026-05-25T15:00:00.000Z",
      },
    });
    expect(f["AS_IS_Value"]).toBe(120000);
    expect(f["AS_IS_Value_Low"]).toBe(110000);
    expect(f["AS_IS_Value_High"]).toBe(130000);
    expect(f["AS_IS_Value_Source"]).toBe("rentcast");
    expect(f["AS_IS_Value_FetchedAt"]).toBe("2026-05-25T15:00:00.000Z");
  });

  it("omits entirely-absent contributions (no null pollution)", () => {
    const f = buildHydrationFields({});
    expect(Object.keys(f)).toHaveLength(0);
  });

  it("writes source + fetchedAt even when the value itself is null (pull happened, came back empty)", () => {
    const f = buildHydrationFields({
      valuation: {
        asIsValue: null,
        asIsValueLow: null,
        asIsValueHigh: null,
        source: "rentcast",
        fetchedAt: "2026-05-25T15:00:00.000Z",
      },
    });
    expect("AS_IS_Value" in f).toBe(false); // null value not written
    expect(f["AS_IS_Value_Source"]).toBe("rentcast"); // but provenance is
    expect(f["AS_IS_Value_FetchedAt"]).toBe("2026-05-25T15:00:00.000Z");
  });

  it("stringifies + counts comps", () => {
    const f = buildHydrationFields({
      comps: { comps: [{ price: 1 }, { price: 2 }, { price: 3 }], source: "rentcast" },
    });
    expect(f["Sold_Comps_Count"]).toBe(3);
    expect(JSON.parse(f["Sold_Comps_JSON"] as string)).toHaveLength(3);
  });

  it("stringifies + counts + provenances photos", () => {
    const f = buildHydrationFields({
      photos: {
        photos: [
          { url: "a", source: "listing" },
          { url: "b", source: "streetview" },
        ],
        source: "mixed",
        fetchedAt: "2026-05-25T15:00:00.000Z",
      },
    });
    expect(f["Photo_Count"]).toBe(2);
    expect(f["Photos_Source"]).toBe("mixed");
    expect(JSON.parse(f["Photo_Urls_JSON"] as string)[0].url).toBe("a");
  });

  it("emits flood fields", () => {
    const f = buildHydrationFields({
      flood: { zone: "AE", source: "fema_nfhl", fetchedAt: "2026-05-25T15:00:00.000Z" },
    });
    expect(f["FEMA_Flood_Zone"]).toBe("AE");
    expect(f["FEMA_Flood_Source"]).toBe("fema_nfhl");
  });

  it("emits discrepancy flags JSON + max severity", () => {
    const f = buildHydrationFields({
      discrepancy: {
        flags: [
          { type: "flood_zone", severity: "amber", detail: "x", detected_at: "t" },
        ],
        severityMax: "amber",
      },
    });
    expect(f["Discrepancy_Severity_Max"]).toBe("amber");
    expect(JSON.parse(f["Discrepancy_Flags_JSON"] as string)).toHaveLength(1);
  });

  it("passes through hydrationStatus + lastHydratedAt", () => {
    const f = buildHydrationFields({
      hydrationStatus: "complete",
      lastHydratedAt: "2026-05-25T15:00:00.000Z",
    });
    expect(f["Hydration_Status"]).toBe("complete");
    expect(f["Last_Hydrated_At"]).toBe("2026-05-25T15:00:00.000Z");
  });

  it("caps oversized JSON fields at 95k", () => {
    const big = Array.from({ length: 20000 }, (_, i) => ({ url: `photo-${i}` }));
    const f = buildHydrationFields({
      photos: { photos: big as Array<{ url: string; source: string }>, source: "scraperapi", fetchedAt: "t" },
    });
    expect((f["Photo_Urls_JSON"] as string).length).toBeLessThanOrEqual(95_000);
  });
});
