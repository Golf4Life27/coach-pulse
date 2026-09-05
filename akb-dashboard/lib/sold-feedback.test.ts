import { describe, it, expect } from "vitest";
import {
  detectReportedSale,
  reportedSaleFields,
  computeSoldFeedback,
  suggestedAnchorPct,
  anchorPctForZip,
  priceBand,
  scanNotesForReportedSale,
} from "./sold-feedback";

describe("detectReportedSale", () => {
  it("reads the operator's anchor case: sold for $163,250 against a $102,250 opener", () => {
    const r = detectReportedSale("Thanks but it sold for $163,250. Your $102,250 was not close.");
    expect(r?.kind).toBe("sold");
    expect(r?.price).toBe(163_250);
  });
  it("takes the amount AFTER the sale verb, not our own number quoted first", () => {
    const r = detectReportedSale("You offered $102,250 — we sold for 163k last week.");
    expect(r?.price).toBe(163_000);
  });
  it("reads closed / went-for / got-for shapes", () => {
    expect(detectReportedSale("Closed at $150,000 in June.")?.price).toBe(150_000);
    expect(detectReportedSale("It went for 145k.")?.price).toBe(145_000);
    expect(detectReportedSale("We got $170k for it, sorry.")?.price).toBe(170_000);
    expect(detectReportedSale("Sale price was $210,000")?.price).toBe(210_000);
  });
  it("reads under-contract-at as a contract price, not a sale", () => {
    const r = detectReportedSale("Already under contract at $155k, thanks though.");
    expect(r?.kind).toBe("under_contract");
    expect(r?.price).toBe(155_000);
    expect(detectReportedSale("Seller accepted an offer of $160,000 yesterday")?.kind).toBe("under_contract");
  });
  it("returns null for a bare gone-deal, a counter, or a tiny number", () => {
    expect(detectReportedSale("sold")).toBeNull();
    expect(detectReportedSale("It sold last week.")).toBeNull();
    expect(detectReportedSale("Seller needs $120k to make it work")).toBeNull();
    expect(detectReportedSale("we sold for 5 years at that address")).toBeNull();
    expect(detectReportedSale("")).toBeNull();
    expect(detectReportedSale(null)).toBeNull();
  });
});

describe("reportedSaleFields", () => {
  it("stamps price and the inbound's own day", () => {
    const f = reportedSaleFields({ price: 163_250, kind: "sold", matchedPattern: "x" }, "2026-09-04T22:53:19.145Z");
    expect(f).toEqual({ Reported_Sale_Price: 163_250, Reported_Sale_Date: "2026-09-04" });
  });
});

describe("suggestedAnchorPct — advisory, always inside the 60-65% band", () => {
  it("thin samples fall back to the default", () => {
    expect(suggestedAnchorPct(0.99, 2)).toBe(0.62);
    expect(suggestedAnchorPct(null, 10)).toBe(0.62);
  });
  it("saturated buckets get the top of the band, soft buckets the bottom", () => {
    expect(suggestedAnchorPct(0.99, 3)).toBe(0.65);
    expect(suggestedAnchorPct(0.90, 3)).toBe(0.6);
    expect(suggestedAnchorPct(0.95, 3)).toBe(0.62);
  });
});

describe("computeSoldFeedback", () => {
  const rows = [
    { id: "a", zip: "78202", listPrice: 165_000, openerUsd: 102_250, reportedSalePrice: 163_250, buildingSqFt: 1_100, lastOutreachDate: "2026-08-01", reportedSaleDate: "2026-09-01", address: "1 A St" },
    { id: "b", zip: "78202", listPrice: 200_000, openerUsd: 124_000, reportedSalePrice: 198_000, buildingSqFt: 1_200 },
    { id: "c", zip: "78202", listPrice: 100_000, openerUsd: 62_000, reportedSalePrice: 99_000 },
    { id: "d", zip: "44307", listPrice: 93_000, openerUsd: 57_750, reportedSalePrice: 75_000, buildingSqFt: 1_114 },
    { id: "e", zip: "44307", listPrice: 90_000, reportedSalePrice: null },
  ];
  it("buckets by zip and price band, medians the ratios, flags saturation", () => {
    const r = computeSoldFeedback(rows, () => new Date("2026-09-05T00:00:00Z"));
    expect(r.sampleSize).toBe(4);
    const sa = r.byZip["78202"];
    expect(sa.n).toBe(3);
    expect(sa.listToSaleMedian).toBeCloseTo(0.99, 2);
    expect(sa.saturated).toBe(true);
    expect(sa.suggestedAnchorPct).toBe(0.65);
    expect(sa.openerToSaleMedian).toBeCloseTo(0.626, 2);
    expect(sa.daysOpenerToSaleMedian).toBe(31);
    const ak = r.byZip["44307"];
    expect(ak.n).toBe(1);
    expect(ak.saturated).toBe(false);
    expect(ak.suggestedAnchorPct).toBe(0.62);
    expect(r.byPriceBand["150-250k"].n).toBe(2);
    expect(r.reportedSales.find((s) => s.id === "a")?.perSqft).toBe(148);
    expect(r.reportedSales.some((s) => s.id === "e")).toBe(false);
  });
  it("priceBand edges", () => {
    expect(priceBand(74_999)).toBe("<75k");
    expect(priceBand(75_000)).toBe("75-150k");
    expect(priceBand(400_000)).toBe("400k+");
    expect(priceBand(null)).toBe("unknown");
  });
});

describe("anchorPctForZip — flag-gated opener hook", () => {
  const report = computeSoldFeedback([
    { id: "a", zip: "78202", listPrice: 100_000, reportedSalePrice: 99_000 },
    { id: "b", zip: "78202", listPrice: 100_000, reportedSalePrice: 98_000 },
    { id: "c", zip: "78202", listPrice: 100_000, reportedSalePrice: 99_500 },
  ]);
  it("flag off → default, no bucket", () => {
    expect(anchorPctForZip("78202", report, {} as unknown as NodeJS.ProcessEnv)).toEqual({ pct: 0.62, source: "default", bucket: null });
  });
  it("flag on + saturated zip → 0.65 from the map; unknown zip → default", () => {
    const env = { H2_SOLD_FEEDBACK_MAP: "1" } as unknown as NodeJS.ProcessEnv;
    expect(anchorPctForZip("78202", report, env).pct).toBe(0.65);
    expect(anchorPctForZip("78202", report, env).source).toBe("sold_feedback_map");
    expect(anchorPctForZip("99999", report, env).source).toBe("default");
    expect(anchorPctForZip("78202", null, env).source).toBe("default");
  });
  it("never leaves the band even if the stored JSON is corrupt", () => {
    const bad = { ...report, byZip: { "78202": { ...report.byZip["78202"], suggestedAnchorPct: 0.9 } } };
    expect(anchorPctForZip("78202", bad, { H2_SOLD_FEEDBACK_MAP: "1" } as unknown as NodeJS.ProcessEnv).pct).toBe(0.65);
  });
});

describe("scanNotesForReportedSale — backfill reader", () => {
  it("reads the latest sold-for reply out of a notes blob and its receipt timestamp", () => {
    const notes = [
      "[H2 sent 2026-08-01T12:00:00Z] Quo msg AC1111111111111111111111111111aaaa: Hi ... around $102,250",
      "",
      "8/20 — L3 INBOUND: REJECTION. Body: Thanks but it sold for $163,250.",
      "[Quo inbound msg AC2222222222222222222222222222bbbb ts=2026-08-20T15:00:00.000Z src=quo_webhook ingested_at=2026-08-20T15:00:02.000Z]",
    ].join("\n");
    const hit = scanNotesForReportedSale(notes);
    expect(hit).toEqual({ price: 163_250, kind: "sold", ts: "2026-08-20T15:00:00.000Z" });
    expect(scanNotesForReportedSale("no inbound here")).toBeNull();
  });
});
