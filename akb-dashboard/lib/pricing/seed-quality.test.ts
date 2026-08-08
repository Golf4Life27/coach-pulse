import { describe, it, expect } from "vitest";
import {
  assessSeedPriceShape,
  isTransactionShapedPrice,
  SEED_QUALITY_MIN_COMPS,
  SEED_QUALITY_MIN_TRANSACTION_SHARE,
} from "./seed-quality";

const receipts = (prices: number[]) =>
  JSON.stringify({ comps: prices.map((price, i) => ({ addr: `c${i}`, price, sqft: 1500, psf: Math.round(price / 1500) })) });

// The REAL stored seeds this exists to tell apart, prices verbatim.
const DALLAS_75216 = [410_970, 323_203, 283_290, 297_265, 418_950, 179_975, 363_025, 342_940, 319_200, 246_933, 423_272, 475_589];
const MEMPHIS_38116 = [144_999, 149_900, 250_000, 137_000, 199_900, 185_000, 236_500, 189_900, 190_000, 209_000, 205_000, 135_000];

describe("assessSeedPriceShape — real transactions vs a model's guesses", () => {
  it("calls Dallas 75216 what it is: AVM estimates stored as comps", () => {
    const q = assessSeedPriceShape(receipts(DALLAS_75216));
    expect(q.verdict).toBe("avm_priced");
    expect(q.transactionShare!).toBeLessThan(SEED_QUALITY_MIN_TRANSACTION_SHARE);
    expect(q.detail).toMatch(/model ESTIMATES/);
  });

  it("passes Memphis 38116 — transaction-shaped throughout", () => {
    const q = assessSeedPriceShape(receipts(MEMPHIS_38116));
    expect(q.verdict).toBe("transaction_priced");
    expect(q.transactionShare).toBe(1);
  });

  it("passes the Cleveland 44102 seed that priced W 106th — real sale shapes", () => {
    const q = assessSeedPriceShape(
      receipts([149_900, 184_900, 150_000, 149_999, 129_900, 125_000, 124_900, 160_000, 149_900, 199_000]),
    );
    expect(q.verdict).toBe("transaction_priced");
  });

  it("knows the shapes humans actually price at", () => {
    for (const p of [149_900, 236_500, 144_999, 125_000, 89_995, 74_990]) {
      expect(isTransactionShapedPrice(p), String(p)).toBe(true);
    }
    for (const p of [423_272, 297_265, 246_933, 410_970]) {
      expect(isTransactionShapedPrice(p), String(p)).toBe(false);
    }
  });

  it("fails to 'insufficient' on thin or unreadable receipts — never to a verdict", () => {
    expect(assessSeedPriceShape(receipts([423_272, 297_265, 246_933])).verdict).toBe("insufficient");
    expect(assessSeedPriceShape(null).verdict).toBe("insufficient");
    expect(assessSeedPriceShape("not json").verdict).toBe("insufficient");
    expect(assessSeedPriceShape('{"comps":"nope"}').verdict).toBe("insufficient");
    expect(SEED_QUALITY_MIN_COMPS).toBe(4);
  });
});
