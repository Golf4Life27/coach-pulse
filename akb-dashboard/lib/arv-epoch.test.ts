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

  it("pre-epoch stamps are contaminated-engine output → untrusted", () => {
    // The 1122 West Ave stamp: 14:45Z on fix day, before the deploy.
    expect(arvStampTrusted("2026-07-17T14:45:32.911Z")).toBe(false);
    expect(arvStampTrusted("2026-06-01T00:00:00Z")).toBe(false);
  });

  it("stamps at or after the epoch come from the fixed engine → trusted", () => {
    expect(arvStampTrusted(ARV_SOLD_COMPS_EPOCH_ISO)).toBe(true);
    expect(arvStampTrusted("2026-07-17T16:00:00Z")).toBe(true);
    expect(arvStampTrusted("2027-01-01T00:00:00Z")).toBe(true);
  });

  it("ARV_ENGINE_EPOCH env advances the boundary without a code change", () => {
    process.env.ARV_ENGINE_EPOCH = "2027-03-01T00:00:00Z";
    expect(arvStampTrusted("2026-07-17T16:00:00Z")).toBe(false);
    expect(arvStampTrusted("2027-03-02T00:00:00Z")).toBe(true);
  });

  it("an unparseable env override falls back to the built-in epoch", () => {
    process.env.ARV_ENGINE_EPOCH = "yesterday-ish";
    expect(arvStampTrusted("2026-07-17T16:00:00Z")).toBe(true);
    expect(arvStampTrusted("2026-07-17T14:45:32Z")).toBe(false);
  });
});
