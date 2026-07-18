import { describe, it, expect, afterEach } from "vitest";
import { arvStampTrusted, ARV_SOLD_COMPS_EPOCH_ISO } from "./arv-epoch";

afterEach(() => {
  delete process.env.ARV_ENGINE_EPOCH;
});

describe("arvStampTrusted", () => {
  it("null / undefined / garbage → never trusted", () => {
    expect(arvStampTrusted(null)).toBe(false);
    expect(arvStampTrusted(undefined)).toBe(false);
    expect(arvStampTrusted("")).toBe(false);
    expect(arvStampTrusted("not a date")).toBe(false);
  });

  it("pre-epoch stamps are superseded-engine output → untrusted", () => {
    // The 1122 West Ave stamp lineage: 14:45Z 7/17 (lastSeenDate engine),
    // 10:25Z 7/18 (removedDate engine — the $294,602 Fortress delisted-ask),
    // and 14-17Z 7/18 (AVM listing-feed engine — 25/25 honest-empty because
    // the feed carries no recorded sales at all).
    expect(arvStampTrusted("2026-07-17T14:45:32.911Z")).toBe(false);
    expect(arvStampTrusted("2026-07-18T10:25:00Z")).toBe(false);
    expect(arvStampTrusted("2026-07-18T14:00:00Z")).toBe(false);
    expect(arvStampTrusted("2026-06-01T00:00:00Z")).toBe(false);
  });

  it("stamps at or after the epoch come from the current engine → trusted", () => {
    expect(arvStampTrusted(ARV_SOLD_COMPS_EPOCH_ISO)).toBe(true);
    expect(arvStampTrusted("2026-07-18T19:00:00Z")).toBe(true);
    expect(arvStampTrusted("2027-01-01T00:00:00Z")).toBe(true);
  });

  it("ARV_ENGINE_EPOCH env advances the boundary without a code change", () => {
    process.env.ARV_ENGINE_EPOCH = "2027-03-01T00:00:00Z";
    expect(arvStampTrusted("2026-07-18T19:00:00Z")).toBe(false);
    expect(arvStampTrusted("2027-03-02T00:00:00Z")).toBe(true);
  });

  it("an unparseable env override falls back to the built-in epoch", () => {
    process.env.ARV_ENGINE_EPOCH = "yesterday-ish";
    expect(arvStampTrusted("2026-07-18T19:00:00Z")).toBe(true);
    expect(arvStampTrusted("2026-07-18T10:25:00Z")).toBe(false);
  });
});
