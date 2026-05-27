import { describe, it, expect } from "vitest";
import { detectZipSaturation } from "./zip-saturation";
import type { PulseDetectorInput } from "../detector-input";
import type { ZipRegistryRow, MarketTier } from "@/lib/zip-registry";

function regRow(zip: string, tier: MarketTier, streak: number | null): ZipRegistryRow {
  return {
    recordId: `rec_${zip}`,
    zip,
    state: "TX",
    market: "San Antonio TX",
    marketTier: tier,
    wholesaleRestricted: false,
    memphisRequired: false,
    lastIngestedAt: null,
    acceptRate30d: null,
    avgDom: null,
    avgListPrice: null,
    recordsIngested30d: null,
    saturationThreshold: 0.01,
    belowThresholdStreakDays: streak,
    approvalRequestedAt: null,
    approvalNotifiedChannels: [],
    approvedBy: null,
    approvalMethod: null,
    notes: null,
  };
}

function input(rows: ZipRegistryRow[], env: Record<string, string | undefined> = {}): PulseDetectorInput {
  return {
    audit_log: [],
    listings: [],
    test_count: null,
    previous_test_count: null,
    zip_registry: rows,
    env,
    now: () => new Date("2026-05-27T00:00:00Z"),
  };
}

describe("detectZipSaturation", () => {
  it("is silent when there are no rows", () => {
    expect(detectZipSaturation(input([]))).toEqual([]);
    expect(detectZipSaturation({ ...input([]), zip_registry: undefined })).toEqual([]);
  });

  it("is silent for healthy active ZIPs", () => {
    const fires = detectZipSaturation(input([regRow("78201", "active", 0), regRow("78202", "active", 2)]));
    expect(fires).toEqual([]);
  });

  it("fires an expansion warning when a ZIP is saturated", () => {
    const fires = detectZipSaturation(input([regRow("78201", "saturated", 14), regRow("78202", "active", 1)]));
    const expansion = fires.find((f) => f.id === "zip_saturation_expansion");
    expect(expansion).toBeDefined();
    expect(expansion?.severity).toBe("warning");
    expect(expansion?.detector_id).toBe("zip_saturation");
    expect(expansion?.source_data?.saturated_zips).toEqual(["78201"]);
  });

  it("fires an approaching-info when an active ZIP is in the warning band", () => {
    const fires = detectZipSaturation(input([regRow("78207", "active", 11)]));
    const approaching = fires.find((f) => f.id === "zip_saturation_approaching");
    expect(approaching).toBeDefined();
    expect(approaching?.severity).toBe("info");
  });

  it("does not fire approaching once a ZIP has already flipped", () => {
    const fires = detectZipSaturation(input([regRow("78207", "saturated", 20)]));
    expect(fires.find((f) => f.id === "zip_saturation_approaching")).toBeUndefined();
    expect(fires.find((f) => f.id === "zip_saturation_expansion")).toBeDefined();
  });

  it("respects env-tuned warning + flip streaks", () => {
    const rows = [regRow("78210", "active", 6)];
    expect(detectZipSaturation(input(rows)).length).toBe(0); // default warn 10
    const fires = detectZipSaturation(input(rows, { PULSE_ZIP_SATURATION_WARN_STREAK: "5", SATURATION_STREAK_DAYS: "14" }));
    expect(fires.find((f) => f.id === "zip_saturation_approaching")).toBeDefined();
  });
});
