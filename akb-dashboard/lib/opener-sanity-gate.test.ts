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

describe("avm_priced_seed — comps that are model guesses, not sales (Dallas 75216)", () => {
  const mk = (prices: number[]) =>
    JSON.stringify({ comps: prices.map((price, i) => ({ addr: `c${i}`, price, sqft: 1_500 + i * 100, psf: Math.round(price / 1_500) })) });
  const base = {
    opener: 40_000, listPrice: 120_000, arvUsed: 180_000, sqft: 1_600, cappedToList: false,
    arvConfidence: "STRONG" as const, renovatedPerSqft: 110, bestCaseOpener: 90_000,
  };

  it("flags the real Dallas price shapes", () => {
    const r = corroborateOpener({
      ...base,
      seed: { receiptsJson: mk([410_970, 323_203, 283_290, 297_265, 418_950, 179_975, 363_025, 342_940, 319_200, 246_933, 423_272, 475_589]) },
    });
    expect(r.flags).toContain("avm_priced_seed");
    expect(r.corroborated).toBe(false);
  });

  it("passes the real Memphis price shapes", () => {
    const r = corroborateOpener({
      ...base,
      seed: { receiptsJson: mk([144_999, 149_900, 250_000, 137_000, 199_900, 185_000, 236_500, 189_900, 190_000, 209_000, 205_000, 135_000]) },
    });
    expect(r.flags).not.toContain("avm_priced_seed");
  });

  it("thin receipts never draw this flag — thin data has its own guards", () => {
    const r = corroborateOpener({ ...base, seed: { receiptsJson: mk([423_272, 297_265, 246_933]) } });
    expect(r.flags).not.toContain("avm_priced_seed");
  });
});

// ── UNVERIFIED VALUE BASIS (2026-08-20, the 2849 Mcguffey incident) ─────────
// The record's own sold comps are the only block-level evidence we get. Zero
// usable comps ⇒ the ARV is a ZIP average, and a ZIP is not a block.
describe("unverified_value_basis", () => {
  const base = {
    opener: 45250,
    listPrice: 66000,
    arvUsed: 120000,
    sqft: 1378,
    cappedToList: false,
    arvConfidence: "THIN" as const,
  };

  it("HOLDS the Mcguffey shape: a confident cash number on ZERO usable own comps", () => {
    const r = corroborateOpener({ ...base, ownComps: { parsed: 44, usable: 0 } });
    expect(r.corroborated).toBe(false);
    expect(r.flags).toContain("unverified_value_basis");
    expect(r.reasons.join(" ")).toMatch(/ZIP-level average/);
  });

  it("does NOT fire when the record has real own-comp evidence", () => {
    const r = corroborateOpener({ ...base, ownComps: { parsed: 5, usable: 3 } });
    expect(r.flags).not.toContain("unverified_value_basis");
  });

  it("fails toward SENDING when the record has NO comp data — unknown is not disproven", () => {
    expect(corroborateOpener({ ...base, ownComps: { parsed: 0, usable: 0 } }).flags).not.toContain("unverified_value_basis");
  });

  it("fails toward SENDING when evidence is absent entirely", () => {
    expect(corroborateOpener({ ...base, ownComps: null }).flags).not.toContain("unverified_value_basis");
    expect(corroborateOpener({ ...base }).flags).not.toContain("unverified_value_basis");
  });

  it("stays silent when there is no opener to send (already a HOLD)", () => {
    const r = corroborateOpener({ ...base, opener: null, ownComps: { parsed: 44, usable: 0 } });
    expect(r.corroborated).toBe(true);
    expect(r.flags).toHaveLength(0);
  });
});

// ── OPENER EXCEEDS ARV (2026-08-20, the Chalmers/Euclid/Wilbeth subset) ─────
// A cash opener at or above the finished value is logically upside-down: no
// room for the end buyer's rehab, our fee, or their profit.
describe("opener_exceeds_arv", () => {
  const base = {
    listPrice: 346000, sqft: 1500, cappedToList: false,
    arvConfidence: "THIN" as const, ownComps: { parsed: 5, usable: 3 },
  };

  it("HOLDS the 257 Chalmers shape: $248,500 opener on a $190,446 ARV", () => {
    const r = corroborateOpener({ ...base, opener: 248500, arvUsed: 190446 });
    expect(r.corroborated).toBe(false);
    expect(r.flags).toContain("opener_exceeds_arv");
    expect(r.reasons.join(" ")).toMatch(/upside-down/);
  });

  it("HOLDS a marginal over-ARV (818 Euclid: $47,750 on $39,723)", () => {
    expect(corroborateOpener({ ...base, opener: 47750, arvUsed: 39723 }).flags).toContain("opener_exceeds_arv");
  });

  it("does NOT fire on a healthy value-anchored opener well under ARV", () => {
    expect(corroborateOpener({ ...base, opener: 45250, arvUsed: 120000 }).flags).not.toContain("opener_exceeds_arv");
  });

  it("does NOT fire at exactly ARV or when ARV is absent", () => {
    expect(corroborateOpener({ ...base, opener: 100000, arvUsed: 100000 }).flags).not.toContain("opener_exceeds_arv");
    expect(corroborateOpener({ ...base, opener: 50000, arvUsed: null }).flags).not.toContain("opener_exceeds_arv");
  });

  it("stays silent when there is no opener to send", () => {
    expect(corroborateOpener({ ...base, opener: null, arvUsed: 190446 }).flags).toHaveLength(0);
  });
});
