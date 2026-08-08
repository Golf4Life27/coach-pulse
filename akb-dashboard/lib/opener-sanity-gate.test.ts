import { describe, it, expect } from "vitest";
import { corroborateOpener } from "./opener-sanity-gate";

const smallComps = JSON.stringify({
  filter_quality: "noisy",
  comps: [{ sqft: 978 }, { sqft: 1236 }, { sqft: 991 }, { sqft: 1040 }],
});

describe("corroborateOpener — allowlist pre-send gate", () => {
  it("PASSES a clean, corroborated opener", () => {
    const r = corroborateOpener({
      opener: 62_000, listPrice: 100_000, arvUsed: 150_000, sqft: 1_100,
      cappedToList: false, arvConfidence: "STRONG",
      seed: { receiptsJson: smallComps }, renovatedPerSqft: 134,
    });
    expect(r.corroborated).toBe(true);
    expect(r.flags).toEqual([]);
  });

  it("a null opener (already a HOLD) is trivially corroborated", () => {
    expect(corroborateOpener({
      opener: null, listPrice: 100_000, arvUsed: null, sqft: 1_000,
      cappedToList: false, arvConfidence: null,
    }).corroborated).toBe(true);
  });

  it("FLAGS size extrapolation (927 Avon: 2,605 sqft vs ~1,000 sqft comps)", () => {
    const r = corroborateOpener({
      opener: 121_250, listPrice: 150_000, arvUsed: 349_070, sqft: 2_605,
      cappedToList: false, arvConfidence: "STRONG",
      seed: { receiptsJson: smallComps }, renovatedPerSqft: 134,
    });
    expect(r.corroborated).toBe(false);
    expect(r.flags).toContain("size_extrapolation");
  });

  it("FLAGS an ARV implausibly high vs list", () => {
    const r = corroborateOpener({
      opener: 120_000, listPrice: 100_000, arvUsed: 300_000, sqft: 1_500,
      cappedToList: false, arvConfidence: "STRONG", seed: null, renovatedPerSqft: 200,
    });
    expect(r.corroborated).toBe(false);
    expect(r.flags).toContain("arv_implausible_vs_list");
  });

  it("does NOT flag a normal ARV-above-list deal (a real discount)", () => {
    // ARV 170k on a 100k list = 1.7×, under the 2.5× ceiling → sends.
    const r = corroborateOpener({
      opener: 60_000, listPrice: 100_000, arvUsed: 170_000, sqft: 1_400,
      cappedToList: false, arvConfidence: "STRONG", seed: null, renovatedPerSqft: 121,
    });
    expect(r.corroborated).toBe(true);
  });

  it("FLAGS a $/sqft outside sane bounds", () => {
    expect(corroborateOpener({
      opener: 50_000, listPrice: 90_000, arvUsed: 90_000, sqft: 1_000,
      cappedToList: false, arvConfidence: "THIN", seed: null, renovatedPerSqft: 900,
    }).flags).toContain("psf_out_of_range");
  });

  it("FLAGS an opener clamped to list on a non-STRONG ARV (868 N Main / capped class)", () => {
    const r = corroborateOpener({
      opener: 84_150, listPrice: 99_000, arvUsed: 250_000, sqft: 1_200,
      cappedToList: true, arvConfidence: "STORED", seed: null, renovatedPerSqft: 208,
    });
    expect(r.corroborated).toBe(false);
    expect(r.flags).toContain("capped_untrusted_arv");
  });

  it("FLAGS an infeasible ask — even the zero-rehab best case is hopeless (2048 Joffre class)", () => {
    // Joffre: $45k texted on a $147.5k ask; best case ~$71k = 48% of list.
    const r = corroborateOpener({
      opener: 45_000, listPrice: 147_500, arvUsed: 120_000, sqft: 1_736,
      cappedToList: false, arvConfidence: "STRONG", seed: null, renovatedPerSqft: 69,
      bestCaseOpener: 71_000,
    });
    expect(r.corroborated).toBe(false);
    expect(r.flags).toContain("infeasible_ask");
  });

  it("does NOT flag a genuine discount — distressed stock keeps its pessimistic opener (test, not text)", () => {
    // Deep-discount shell: list $40k, ARV $120k. Real opener is the pessimistic
    // number; best case is far above list (capped) so feasibility clears.
    const r = corroborateOpener({
      opener: 22_500, listPrice: 40_000, arvUsed: 96_000, sqft: 1_764,
      cappedToList: false, arvConfidence: "STRONG", seed: null, renovatedPerSqft: 54,
      bestCaseOpener: 34_000, // capped at 85% of list
    });
    expect(r.corroborated).toBe(true);
  });

  it("529 Bina class passes feasibility (best case 70% of ask) — its fix is condition, not this gate", () => {
    const r = corroborateOpener({
      opener: 31_000, listPrice: 89_000, arvUsed: 98_600, sqft: 671,
      cappedToList: false, arvConfidence: "STRONG", seed: null, renovatedPerSqft: 129,
      bestCaseOpener: 62_500,
    });
    expect(r.flags).not.toContain("infeasible_ask");
  });

  it("does NOT flag a capped opener when the ARV is STRONG (a trusted deep discount)", () => {
    const r = corroborateOpener({
      opener: 84_150, listPrice: 99_000, arvUsed: 200_000, sqft: 1_400,
      cappedToList: true, arvConfidence: "STRONG", seed: null, renovatedPerSqft: 143,
    });
    // arv/list = 2.02× (under ceiling), STRONG, in-size → sends.
    expect(r.corroborated).toBe(true);
  });
});

describe("size rail tightened (2026-08-08): outside the RAW band needs a measured fit", () => {
  // Ten sloped comps, 1,658–2,710 sqft — the real 44102 seed shape.
  const slopedComps = JSON.stringify({
    comps: [
      { price: 149_900, sqft: 2_710 }, { price: 184_900, sqft: 2_337 }, { price: 150_000, sqft: 2_128 },
      { price: 149_999, sqft: 1_658 }, { price: 129_900, sqft: 2_040 }, { price: 125_000, sqft: 1_889 },
      { price: 124_900, sqft: 1_896 }, { price: 160_000, sqft: 2_091 }, { price: 149_900, sqft: 1_848 },
      { price: 199_000, sqft: 1_964 },
    ],
  });
  const base = {
    opener: 30_000, listPrice: 89_000, arvUsed: 118_554, cappedToList: false,
    arvConfidence: "STRONG" as const, renovatedPerSqft: 94, bestCaseOpener: 78_000,
  };

  it("2175 W 106th shape: below every comp but the slope fit covers it → PASSES", () => {
    const r = corroborateOpener({ ...base, sqft: 1_258, seed: { receiptsJson: slopedComps } });
    expect(r.flags).not.toContain("size_extrapolation");
  });

  it("same subject, but the seed has too few comps for a fit → FLAGS", () => {
    const thin = JSON.stringify({
      comps: [
        { price: 149_900, sqft: 2_710 }, { price: 184_900, sqft: 2_337 },
        { price: 150_000, sqft: 2_128 }, { price: 149_999, sqft: 1_658 },
      ],
    });
    const r = corroborateOpener({ ...base, sqft: 1_258, seed: { receiptsJson: thin } });
    expect(r.flags).toContain("size_extrapolation");
    expect(r.reasons.join(" ")).toMatch(/cannot support a measured size fit/);
  });

  it("same subject, comps FLAT (no size signal) → FLAGS rather than trusting a curve past the data", () => {
    const flat = JSON.stringify({
      comps: [1_658, 1_848, 1_889, 1_964, 2_091, 2_337].map((sqft) => ({ price: 100 * sqft, sqft })),
    });
    const r = corroborateOpener({ ...base, sqft: 1_258, seed: { receiptsJson: flat } });
    expect(r.flags).toContain("size_extrapolation");
  });

  it("a subject INSIDE the comp band never touches the new rail", () => {
    const r = corroborateOpener({ ...base, sqft: 1_900, seed: { receiptsJson: slopedComps } });
    expect(r.flags).not.toContain("size_extrapolation");
  });

  it("the 1.5× Avon rail is unchanged: 2.1× the largest comp flags regardless of fit", () => {
    const r = corroborateOpener({ ...base, sqft: 5_700, seed: { receiptsJson: slopedComps } });
    expect(r.flags).toContain("size_extrapolation");
  });
});
