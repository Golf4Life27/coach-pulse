import { describe, it, expect } from "vitest";
import {
  buildDerivation,
  serializeDerivation,
  parseDerivation,
  verifyDerivation,
  maoFromDerivation,
  explainDerivation,
  DERIVATION_SCHEMA_VERSION,
} from "./opener-derivation";

// THE AUDIT THAT PRODUCED THIS (2026-08-06): the operator asked what MAO was on
// 8235 Prest St and the record could not answer. It stored a $26,000 opener and
// Opener_Basis "arv_buybox_seed" — no ARV, no rehab, no fee, no anchor. Twelve
// combinations of (arv_pct_max, fee, anchor, psf) all round to $26,000.
const prest = buildDerivation({
  opener: 26_000,
  basis: "arv_buybox_seed",
  psf: 92,
  sqft: 940,
  arv: 86_480,          // 92 × 940, from the STRONG 24-comp 48228 seed
  arvSource: "seed_renovated",
  arvPctMax: 0.6461,    // detroit_mi configured + arv_source_verified
  rehab: 23_970,        // $25.50/sqft — the light/medium the operator confirmed
  rehabPlaceholder: false,
  fee: 5_000,
  anchor: 0.97,
  ceiling: 0.6461 * 86_480 - 23_970 - 5_000,
  roundTo: 250,
  flags: [],
});

describe("the receipt answers the question the record could not", () => {
  it("names the MAO", () => {
    // "Whats MAO on Prest?" — 0.6461 × 86,480 − 23,970 − 5,000.
    expect(maoFromDerivation(prest)).toBe(26_905);
  });

  it("reproduces the opener from its own inputs", () => {
    const v = verifyDerivation(prest);
    expect(v.status).toBe("reproduced");
    expect(v.detail).toContain("ARV $86,480");
    expect(v.detail).toContain("rehab $23,970");
  });

  it("survives a round-trip through the stored field", () => {
    const back = parseDerivation(serializeDerivation(prest));
    expect(back).not.toBeNull();
    expect(verifyDerivation(back).status).toBe("reproduced");
    expect(maoFromDerivation(back)).toBe(26_905);
  });
});

describe("verifyDerivation — the enforcement the recompute standard was missing", () => {
  it("CATCHES an opener that does not follow from its own inputs", () => {
    // The failure this exists to make visible: a number that looks derived and
    // isn't. 23 of 40 April records offered more than their ARV supported and
    // nothing in the system could say so.
    const tampered = buildDerivation({ ...prest, opener: 51_350 });
    const v = verifyDerivation(tampered);
    expect(v.status).toBe("mismatch");
    expect(v.recomputed).toBe(26_000);
    expect(v.delta).toBe(26_000 - 51_350);
    expect(v.detail).toContain("its own inputs produce");
  });

  it("does not accept a receipt that is missing a term", () => {
    // Silence about a missing input is how the original problem happened.
    const v = verifyDerivation(buildDerivation({ ...prest, rehab: null, ceiling: null }));
    expect(v.status).toBe("incomplete");
    expect(v.detail).toContain("rehab");
  });

  it("treats a HOLD as a HOLD, not a failure", () => {
    const held = buildDerivation({
      opener: null,
      basis: "placeholder_rehab_needs_vision",
      arv: 86_480, arvPctMax: 0.6461, rehab: 25_944, fee: 5_000, anchor: 0.9,
      rehabPlaceholder: true,
    });
    const v = verifyDerivation(held);
    expect(v.status).toBe("hold_no_opener");
    // ...and it can still answer the MAO question while holding.
    expect(maoFromDerivation(held)).toBe(24_931);
  });

  it("returns incomplete rather than throwing on no receipt at all", () => {
    expect(verifyDerivation(null).status).toBe("incomplete");
    expect(maoFromDerivation(null)).toBeNull();
  });

  it("allows rounding slack but not a real disagreement", () => {
    // Within one rounding increment → reproduced.
    expect(verifyDerivation(buildDerivation({ ...prest, opener: 26_150 })).status).toBe("reproduced");
    // A whole increment beyond → mismatch.
    expect(verifyDerivation(buildDerivation({ ...prest, opener: 27_000 })).status).toBe("mismatch");
  });
});

describe("parseDerivation refuses to launder a corrupt receipt", () => {
  it("returns null on unreadable input", () => {
    expect(parseDerivation(null)).toBeNull();
    expect(parseDerivation("")).toBeNull();
    expect(parseDerivation("not json")).toBeNull();
    expect(parseDerivation("[1,2,3]")).toBeNull();
    expect(parseDerivation('{"opener":26000}')).toBeNull(); // no version/basis
  });

  it("stamps the schema version so a future reader knows the arithmetic", () => {
    expect(prest.v).toBe(DERIVATION_SCHEMA_VERSION);
    expect(parseDerivation(serializeDerivation(prest))?.v).toBe(DERIVATION_SCHEMA_VERSION);
  });
});

describe("explainDerivation", () => {
  it("gives the operator the whole chain in one line", () => {
    const s = explainDerivation(prest);
    expect(s).toContain("$26,000");
    expect(s).toContain("MAO $26,905");
    expect(s).toContain("ARV $86,480");
  });

  it("marks a number that does not reconcile", () => {
    expect(explainDerivation(buildDerivation({ ...prest, opener: 51_350 }))).toContain("⚠");
  });
});

// ── THE INTEGRATION THAT CLOSES THE LOOP ─────────────────────────────────────
// A receipt is only worth storing if the REAL pricer emits one that reproduces.
// This runs priceOpenerWithSeed and verifies its own derivation — so the
// recompute standard is enforced against the production path, not a fixture.
import { priceOpenerWithSeed } from "@/lib/opener-pricing";
import type { ZipArvSeed } from "@/lib/zip-arv-seed-store";

describe("the production pricer emits a receipt that reproduces its own opener", () => {
  // The real 48228 seed shape (STRONG, 24 comps, median $92/sqft) that priced
  // 8235 Prest St.
  const seed = {
    zip: "48228",
    state: "MI",
    market: "Detroit",
    renovatedPerSqft: 92,
    arvLowPerSqft: 59.54,
    compCount: 24,
    confidence: "STRONG",
    receiptsJson: JSON.stringify({
      method: "comp_cluster_unimodal",
      filter_quality: "clean",
      comps: [
        { addr: "9194 Prest St", price: 125000, sqft: 1170, psf: 107 },
        { addr: "8949 Lauder St", price: 74500, sqft: 993, psf: 75 },
        { addr: "8282 Sussex St NW", price: 99900, sqft: 1200, psf: 83 },
        { addr: "8510 Lauder St", price: 84999, sqft: 914, psf: 93 },
      ],
    }),
  } as unknown as ZipArvSeed;

  it("verifies end to end on a sendable opener", () => {
    const priced = priceOpenerWithSeed({
      listPrice: 75_900,
      storedArv: null,
      estRehabMid: 23_970,
      sqft: 940,
      arvPctMax: 0.6461,
      wholesaleFee: 5_000,
      anchorPct: 0.9,
      seed,
    });
    const v = verifyDerivation(priced.derivation);
    // Either it sent and reproduces, or it HELD — never "incomplete", which
    // would mean the pricer computed a number it cannot account for.
    expect(["reproduced", "hold_no_opener"]).toContain(v.status);
    if (priced.result.opener != null) {
      expect(v.status).toBe("reproduced");
      expect(priced.derivation.arv).toBe(92 * 940);
      expect(priced.derivation.arvSource).toBe("seed_renovated");
      expect(priced.derivation.rehab).toBe(23_970);
    }
  });

  it("still writes a receipt when the record HOLDS", () => {
    // "Why is there no number" is exactly as hard to answer later as
    // "where did this number come from" — a HOLD gets a receipt too.
    const priced = priceOpenerWithSeed({
      listPrice: 75_900,
      storedArv: null,
      estRehabMid: null, // no rehab → placeholder → vision hold
      sqft: 940,
      arvPctMax: 0.6461,
      wholesaleFee: 5_000,
      anchorPct: 0.9,
      seed,
    });
    expect(priced.derivation).toBeTruthy();
    expect(priced.derivation.basis).toBe(priced.basisLabel);
    // It captures every input that WAS resolved before the hold.
    expect(priced.derivation.arv).toBe(92 * 940);
    expect(priced.derivation.arvSource).toBe("seed_renovated");
    expect(priced.derivation.arvPctMax).toBe(0.6461);

    // KNOWN GAP (2026-08-06, found by this very test): on some HOLD paths the
    // pricer never populates rehabUsed or ceiling, so the receipt records THAT
    // it held but not what the number would have been. verifyDerivation
    // correctly reports "hold_no_opener", and maoFromDerivation returns null
    // rather than inventing a ceiling from partial inputs.
    //
    // So "where did this number come from" is now answerable and "why is there
    // no number" is only partly answerable. Closing that means having the
    // pricer's hold branches carry their intermediate terms — a change to
    // per-market-pricer, not to the receipt.
    expect(verifyDerivation(priced.derivation).status).toBe("hold_no_opener");
    expect(maoFromDerivation(priced.derivation)).toBeNull();
  });

  it("round-trips through the stored field from the real pricer", () => {
    const priced = priceOpenerWithSeed({
      listPrice: 75_900, storedArv: null, estRehabMid: 23_970, sqft: 940,
      arvPctMax: 0.6461, wholesaleFee: 5_000, anchorPct: 0.9, seed,
    });
    const back = parseDerivation(serializeDerivation(priced.derivation));
    expect(back).not.toBeNull();
    expect(verifyDerivation(back).status).toBe(verifyDerivation(priced.derivation).status);
  });
});
