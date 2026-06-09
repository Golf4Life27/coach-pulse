import { describe, it, expect } from "vitest";
import {
  validateBuyerMedianInput,
  BUYER_MEDIAN_ALLOWED_SOURCE,
  defaultBuyerTrack,
  computeTrackAwareMao,
} from "./buyer-median-input";

const NOW = new Date("2026-06-08T12:00:00Z");
const good = {
  value: 120000,
  source: BUYER_MEDIAN_ALLOWED_SOURCE,
  track: "landlord",
  exportDate: "2026-06-07",
  sampleSize: 8,
};

describe("validateBuyerMedianInput — the hard source rule", () => {
  it("accepts a fully-stamped InvestorBase value", () => {
    const r = validateBuyerMedianInput(good, NOW);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.value).toBe(120000);
      expect(r.data.source).toBe("investorbase_manual");
      expect(r.data.track).toBe("landlord");
      expect(r.data.exportDate).toBe("2026-06-07T00:00:00.000Z");
      expect(r.data.sampleSize).toBe(8);
    }
  });

  it("REFUSES an unsourced number (no source)", () => {
    const r = validateBuyerMedianInput({ ...good, source: undefined }, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("source_required");
  });

  it("REFUSES empty-string source", () => {
    const r = validateBuyerMedianInput({ ...good, source: "" }, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("source_required");
  });

  it("REFUSES a manual_operator guess (wrong source)", () => {
    const r = validateBuyerMedianInput({ ...good, source: "manual_operator" }, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("source_invalid");
  });

  it("REFUSES the auto-scraper source on the manual path", () => {
    const r = validateBuyerMedianInput({ ...good, source: "investorbase" }, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("source_invalid");
  });
});

describe("validateBuyerMedianInput — export date", () => {
  it("requires an export date", () => {
    const r = validateBuyerMedianInput({ ...good, exportDate: "" }, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("export_date_required");
  });

  it("rejects an unparseable date", () => {
    const r = validateBuyerMedianInput({ ...good, exportDate: "last tuesday" }, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("export_date_invalid");
  });

  it("rejects a future export date", () => {
    const r = validateBuyerMedianInput({ ...good, exportDate: "2026-06-09" }, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("export_date_future");
  });
});

describe("validateBuyerMedianInput — value", () => {
  it("requires a numeric value", () => {
    const r = validateBuyerMedianInput({ ...good, value: "abc" }, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("value_required");
  });

  it("strips $ and commas", () => {
    const r = validateBuyerMedianInput({ ...good, value: "$120,000" }, NOW);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.value).toBe(120000);
  });

  it("rejects non-positive", () => {
    const r = validateBuyerMedianInput({ ...good, value: 0 }, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("value_nonpositive");
  });

  it("rejects above the sanity bound", () => {
    const r = validateBuyerMedianInput({ ...good, value: 9_000_000 }, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("value_out_of_range");
  });
});

describe("validateBuyerMedianInput — the bimodal track rule", () => {
  it("requires a track", () => {
    const r = validateBuyerMedianInput({ ...good, track: undefined }, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("track_required");
  });

  it("accepts flipper and landlord (case-insensitive)", () => {
    expect(validateBuyerMedianInput({ ...good, track: "flipper" }, NOW).ok).toBe(true);
    expect(validateBuyerMedianInput({ ...good, track: "LANDLORD" }, NOW).ok).toBe(true);
  });

  it("REFUSES a blended / averaged number", () => {
    for (const t of ["blended", "both", "mixed", "average", "combined"]) {
      const r = validateBuyerMedianInput({ ...good, track: t }, NOW);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("track_blended");
    }
  });

  it("REFUSES an unknown track", () => {
    const r = validateBuyerMedianInput({ ...good, track: "wholesaler" }, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("track_invalid");
  });
});

describe("defaultBuyerTrack — distressed as-is → landlord", () => {
  it("as-is tier → landlord", () => {
    expect(defaultBuyerTrack({ arvTier: "as_is" })).toBe("landlord");
  });
  it("water-damage / poor condition → landlord", () => {
    expect(defaultBuyerTrack({ condition: "water_damage Moderate" })).toBe("landlord");
    expect(defaultBuyerTrack({ condition: "Poor" })).toBe("landlord");
  });
  it("explicit distress flag → landlord", () => {
    expect(defaultBuyerTrack({ distressed: true })).toBe("landlord");
  });
  it("clean / renovated full-retail → flipper", () => {
    expect(defaultBuyerTrack({ arvTier: "full_retail", condition: "Good" })).toBe("flipper");
    expect(defaultBuyerTrack({})).toBe("flipper");
  });
});

describe("computeTrackAwareMao — track decides rehab subtraction", () => {
  it("flipper: subtracts rehab (renovated-resale basis)", () => {
    const r = computeTrackAwareMao({ track: "flipper", buyerMedian: 150_000, estRehab: 28_518, wholesaleFee: 5_000 });
    expect(r.investorMao).toBe(121_482); // 150,000 − 28,518
    expect(r.yourMao).toBe(116_482); // − 5,000
  });

  it("landlord (as-is): does NOT subtract the flip rehab — Strathmoor $55k ceiling", () => {
    // 12724 Strathmoor: $55k landlord median, $28,518 flip rehab present but
    // NOT subtracted (the as-is median already prices the as-is condition).
    const r = computeTrackAwareMao({ track: "landlord", buyerMedian: 55_000, estRehab: 28_518, wholesaleFee: 5_000 });
    expect(r.investorMao).toBe(55_000); // as-is purchase price, no rehab double-count
    expect(r.yourMao).toBe(50_000); // − 5,000 wholesale fee
  });

  it("never blends: landlord ignores rehab entirely even when large", () => {
    const r = computeTrackAwareMao({ track: "landlord", buyerMedian: 55_000, estRehab: 99_999, wholesaleFee: 5_000 });
    expect(r.yourMao).toBe(50_000);
  });

  it("flipper HOLDs when rehab missing (needs it for the renovated basis)", () => {
    const r = computeTrackAwareMao({ track: "flipper", buyerMedian: 150_000, estRehab: null });
    expect(r.yourMao).toBeNull();
  });

  it("HOLDs when buyer median missing", () => {
    expect(computeTrackAwareMao({ track: "landlord", buyerMedian: null, estRehab: 10_000 }).yourMao).toBeNull();
  });
});

describe("validateBuyerMedianInput — sample size", () => {
  it("is optional (null when omitted)", () => {
    const r = validateBuyerMedianInput({ ...good, sampleSize: undefined }, NOW);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.sampleSize).toBeNull();
  });

  it("rejects a non-integer / non-positive sample size", () => {
    expect(validateBuyerMedianInput({ ...good, sampleSize: 0 }, NOW).ok).toBe(false);
    expect(validateBuyerMedianInput({ ...good, sampleSize: 2.5 }, NOW).ok).toBe(false);
  });
});
