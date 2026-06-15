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
    // Stored ARV 50k < list 100k would be DISTRUSTED → 65% fallback. The seed
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
    // ceiling = 150000×0.6461 − 20000 − 5000 = 71,915; opener = 0.90× = 64,724
    expect(r.result.opener).toBe(64_724);
    expect(r.result.arvDistrusted).toBe(false);
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

  it("flat 65% fallback when neither seed nor stored ARV is usable", () => {
    const r = priceOpenerWithSeed({ listPrice: 80_000, seed: null });
    expect(r.arvSource).toBe("none");
    expect(r.result.opener).toBe(52_000);
    expect(r.basisLabel).toBe("list_fraction_65");
  });

  it("a seed with no subject sqft cannot produce an ARV → stored/fallback", () => {
    const r = priceOpenerWithSeed({ listPrice: 80_000, sqft: null, seed: seed() });
    expect(r.arvSource).toBe("none"); // no sqft → seed unusable, no stored ARV
    expect(r.result.basis).toBe("list_fraction_65");
  });

  it("a DONT_PRICE seed routes to 65%-of-list and NEVER to the stored ARV", () => {
    // The seed-quality gate marked this ZIP do-not-price. Even though a stored
    // ARV exists, the pricer must NOT use it — it goes to the flat 65% rail.
    const r = priceOpenerWithSeed({
      listPrice: 80_000,
      storedArv: 120_000, storedArvConfidence: "HIGH",
      sqft: 1_000, arvPctMax: DETROIT, anchorPct: 0.90,
      estRehabMid: 20_000, wholesaleFee: 5_000,
      seed: seed({ confidence: "DONT_PRICE", dontPrice: true, renovatedPerSqft: 0, arvLowPerSqft: null }),
    });
    expect(r.arvSource).toBe("none"); // NOT "stored"
    expect(r.arvUsed).toBeNull();
    expect(r.result.basis).toBe("list_fraction_65");
    expect(r.result.opener).toBe(52_000); // 0.65 × 80k
  });
});
