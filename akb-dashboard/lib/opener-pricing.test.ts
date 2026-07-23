import { describe, it, expect } from "vitest";
import { priceOpenerWithSeed } from "./opener-pricing";
import type { ZipArvSeed } from "./zip-arv-seed-store";

const DETROIT = 0.6461;

function seed(over: Partial<ZipArvSeed> = {}): ZipArvSeed {
  return {
    zip: "48227", renovatedPerSqft: 150, arvLowPerSqft: 110, compCount: 7,
    confidence: "STRONG", dontPrice: false, source: "rentcast_avm", market: "Detroit", state: "MI",
    fetchedAt: null, receiptsJson: null, recordId: "rec1", ...over,
  };
}

describe("priceOpenerWithSeed — source-swap", () => {
  it("prefers the renovated-comp seed ARV over a contaminated stored ARV", () => {
    // Stored ARV 50k < list 100k would be DISTRUSTED → HOLD. The seed
    // (150/sqft × 1000 = 150k renovated) repairs it → real buy-box opener.
    const r = priceOpenerWithSeed({
      listPrice: 100_000,
      storedArv: 50_000,
      estRehabMid: 20_000,
      wholesaleFee: 5_000,
      sqft: 1_000,
      arvPctMax: DETROIT,
      anchorPct: 0.90,
      seed: seed(),
    });
    expect(r.arvSource).toBe("seed_renovated");
    expect(r.result.basis).toBe("arv_buybox");
    expect(r.basisLabel).toBe("arv_buybox_seed");
    expect(r.arvUsed).toBe(150_000);
    // ceiling = 150000×0.6461 − 20000 − 5000 = 71,915; opener = 0.90× = 64,724 → nearest $250 = 64,750
    expect(r.result.opener).toBe(64_750);
    expect(r.result.arvDistrusted).toBe(false);
  });

  // Comp receipts whose sqft band is ~1,000 sqft — the 44310 Avon St shape.
  const smallCompReceipts = JSON.stringify({
    method: "comp_cluster_unimodal",
    filter_quality: "noisy",
    comps: [
      { addr: "a", sqft: 978, psf: 184 },
      { addr: "b", sqft: 1236, psf: 132 },
      { addr: "c", sqft: 991, psf: 116 },
      { addr: "d", sqft: 1040, psf: 100 },
    ],
  });

  it("HOLDS a subject far outside the comp size band (927 Avon St repro — 2,605 sqft vs ~1,000 sqft comps)", () => {
    // Before the gate this texted $121,250: 134/sqft × 2605 = 349k ARV, ×0.90
    // anchor after a placeholder rehab. The subject is 2.1× the largest comp.
    const r = priceOpenerWithSeed({
      listPrice: 150_000,
      sqft: 2_605,
      arvPctMax: 0.70,
      anchorPct: 0.90,
      wholesaleFee: 5_000,
      seed: seed({ zip: "44310", renovatedPerSqft: 134, arvLowPerSqft: 100, confidence: "STRONG", receiptsJson: smallCompReceipts }),
    });
    expect(r.result.opener).toBeNull();
    expect(r.result.basis).toBe("hold_no_value_basis");
    expect(r.basisLabel).toBe("hold_failed_corroboration");
    expect(r.corroborationFlags).toContain("size_extrapolation");
  });

  it("does NOT fall back to stored ARV when the seed is size-extrapolated — it HOLDS", () => {
    const r = priceOpenerWithSeed({
      listPrice: 150_000, sqft: 2_605, storedArv: 180_000, storedArvConfidence: "HIGH",
      arvPctMax: 0.70, anchorPct: 0.90, wholesaleFee: 5_000,
      seed: seed({ zip: "44310", renovatedPerSqft: 134, confidence: "STRONG", receiptsJson: smallCompReceipts }),
    });
    expect(r.result.opener).toBeNull();
    expect(r.basisLabel).toBe("hold_failed_corroboration");
  });

  it("HOLDS an opener that only survived by clamping to list on a non-STRONG ARV (868 N Main / capped class)", () => {
    // A stored (contaminated) ARV so high the opener hits the 85%-of-list cap.
    // capped_untrusted_arv → not a trusted deep discount → HOLD.
    const r = priceOpenerWithSeed({
      listPrice: 99_000, sqft: 1_200, storedArv: 400_000, storedArvConfidence: "MED",
      arvPctMax: 0.70, anchorPct: 0.90, wholesaleFee: 5_000, seed: null,
    });
    expect(r.result.opener).toBeNull();
    expect(r.basisLabel).toBe("hold_failed_corroboration");
    expect(r.corroborationFlags).toContain("capped_untrusted_arv");
    expect(r.corroborationFlags).toContain("arv_implausible_vs_list");
  });

  it("still prices a subject INSIDE the comp size band off the same seed", () => {
    const r = priceOpenerWithSeed({
      listPrice: 150_000, sqft: 1_100, arvPctMax: 0.70, anchorPct: 0.90,
      estRehabMid: 20_000, wholesaleFee: 5_000,
      seed: seed({ zip: "44310", renovatedPerSqft: 134, confidence: "STRONG", receiptsJson: smallCompReceipts }),
    });
    expect(r.arvSource).toBe("seed_renovated");
    expect(r.result.opener).not.toBeNull();
  });

  it("does NOT guard when the seed carries no receipts (older seeds price as before)", () => {
    const r = priceOpenerWithSeed({
      listPrice: 150_000, sqft: 2_605, arvPctMax: 0.70, anchorPct: 0.90,
      estRehabMid: 20_000, wholesaleFee: 5_000,
      seed: seed({ zip: "44310", renovatedPerSqft: 134, confidence: "STRONG", receiptsJson: null }),
    });
    expect(r.arvSource).toBe("seed_renovated");
  });

  it("THIN seed biases ARV to the low end", () => {
    const r = priceOpenerWithSeed({
      listPrice: 100_000, sqft: 1_000, arvPctMax: DETROIT, anchorPct: 0.90,
      estRehabMid: 20_000, wholesaleFee: 5_000,
      seed: seed({ confidence: "THIN" }),
    });
    expect(r.arvUsed).toBe(110_000); // low-end $/sqft × sqft, not 150k
  });

  it("falls back to the contaminated stored ARV only when no seed exists", () => {
    const r = priceOpenerWithSeed({
      listPrice: 60_000, storedArv: 120_000, storedArvConfidence: "MED",
      estRehabMid: 20_000, wholesaleFee: 5_000, arvPctMax: DETROIT, anchorPct: 0.90,
      sqft: 1_000, seed: null,
    });
    expect(r.arvSource).toBe("stored");
    expect(r.basisLabel).toBe("arv_buybox_stored");
  });

  it("HOLDS when neither seed nor stored ARV is usable (never list-anchors)", () => {
    const r = priceOpenerWithSeed({ listPrice: 80_000, seed: null });
    expect(r.arvSource).toBe("none");
    expect(r.result.opener).toBeNull();          // was 0.65 × 80k = 52,000
    expect(r.result.basis).toBe("hold_no_value_basis");
    expect(r.basisLabel).toBe("hold");
  });

  it("a seed with no subject sqft cannot produce an ARV → HOLD (never list-anchors)", () => {
    const r = priceOpenerWithSeed({ listPrice: 80_000, sqft: null, seed: seed() });
    expect(r.arvSource).toBe("none"); // no sqft → seed unusable, no stored ARV
    expect(r.result.basis).toBe("hold_no_value_basis");
    expect(r.result.opener).toBeNull();
  });

  it("a DONT_PRICE seed HOLDS and NEVER falls back to the stored ARV", () => {
    // The seed-quality gate marked this ZIP do-not-price. Even though a stored
    // ARV exists, the pricer must NOT use it — with no trusted ARV it HOLDS for
    // review (the flat 65%-of-list rail is retired, 2026-06-28).
    const r = priceOpenerWithSeed({
      listPrice: 80_000,
      storedArv: 120_000, storedArvConfidence: "HIGH",
      sqft: 1_000, arvPctMax: DETROIT, anchorPct: 0.90,
      estRehabMid: 20_000, wholesaleFee: 5_000,
      seed: seed({ confidence: "DONT_PRICE", dontPrice: true, renovatedPerSqft: 0, arvLowPerSqft: null }),
    });
    expect(r.arvSource).toBe("none"); // NOT "stored"
    expect(r.arvUsed).toBeNull();
    expect(r.result.basis).toBe("hold_no_value_basis");
    expect(r.result.opener).toBeNull();          // was 0.65 × 80k = 52,000
  });
});
