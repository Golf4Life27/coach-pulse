import { describe, it, expect } from "vitest";
import { zipMedianKey, validateZipMedianWrite } from "./buyer-median-store";

describe("zipMedianKey", () => {
  it("composes <zip>:<track>, lowercasing the track", () => {
    expect(zipMedianKey("48227", "Landlord")).toBe("48227:landlord");
    expect(zipMedianKey("48227", "flipper")).toBe("48227:flipper");
  });
});

describe("validateZipMedianWrite", () => {
  const good = { zip: "48227", track: "landlord" as const, value: 55000, source: "investorbase_manual" as const };

  it("accepts a sourced, track-tagged write", () => {
    const r = validateZipMedianWrite({ ...good, compCount: 9, fetchedAt: "2026-06-09" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.key).toBe("48227:landlord");
      expect(r.data.value).toBe(55000);
      expect(r.data.compCount).toBe(9);
      expect(r.data.fetchedAt).toBe("2026-06-09");
    }
  });

  it("rejects a non-5-digit ZIP", () => {
    expect(validateZipMedianWrite({ ...good, zip: "482" }).ok).toBe(false);
  });

  it("REFUSES a blended / averaged track", () => {
    for (const t of ["blended", "both", "mixed", "average"]) {
      const r = validateZipMedianWrite({ ...good, track: t as never });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("track_invalid");
    }
  });

  it("rejects an un-sourced value (only investorbase_* accepted)", () => {
    expect(validateZipMedianWrite({ ...good, source: "manual_operator" as never }).ok).toBe(false);
    expect(validateZipMedianWrite({ ...good, source: "guess" as never }).ok).toBe(false);
  });

  it("accepts the auto source (scheduled pull)", () => {
    expect(validateZipMedianWrite({ ...good, source: "investorbase_auto" }).ok).toBe(true);
  });

  it("rejects non-positive / out-of-range value", () => {
    expect(validateZipMedianWrite({ ...good, value: 0 }).ok).toBe(false);
    expect(validateZipMedianWrite({ ...good, value: 9_000_000 }).ok).toBe(false);
  });

  it("strips $ and commas from a string value", () => {
    const r = validateZipMedianWrite({ ...good, value: "$55,000" as never });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.value).toBe(55000);
  });

  it("rejects a non-integer comp count", () => {
    expect(validateZipMedianWrite({ ...good, compCount: 4.5 }).ok).toBe(false);
  });
});
