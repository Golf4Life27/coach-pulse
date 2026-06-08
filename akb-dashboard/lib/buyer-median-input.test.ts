import { describe, it, expect } from "vitest";
import { validateBuyerMedianInput, BUYER_MEDIAN_ALLOWED_SOURCE } from "./buyer-median-input";

const NOW = new Date("2026-06-08T12:00:00Z");
const good = {
  value: 120000,
  source: BUYER_MEDIAN_ALLOWED_SOURCE,
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
