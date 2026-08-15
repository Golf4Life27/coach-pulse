// OPENER RECEIPT PARITY (2026-08-14, the 1708 Cardinal reverse-engineering).
//
// lib/pricing/opener-derivation.ts was built by the 2026-08-06 audit so that a
// priced record carries the ARITHMETIC, not just the answer — the operator had
// asked what the MAO was on 8235 Prest St and no record could tell him.
//
// The module shipped. Its only CALLER was the intake cron.
//
// So every record priced anywhere else — which is most of the live pipeline,
// because the send path re-prices at send time — kept storing the answer alone.
// 1708 Cardinal Dr texted $63,000 against a $229,900 list, the seller countered
// "165k no more ridiculous offers please", and answering "where did $63,000
// come from?" took four queries and still ended in reverse-engineering: the
// exact failure the receipt field exists to prevent. Pricing doctrine standard
// 1 (recompute-and-match before queueing) is likewise unenforceable against a
// record that kept only the number.
//
// The bug was not the arithmetic. It was that a WRITE SITE could be added
// without the receipt and nothing objected. This test is the objection: any
// file that persists Rough_Opener_Amount must persist Opener_Derivation_JSON
// in the same file. It is deliberately structural rather than behavioral —
// the failure mode is a new call site, not a wrong branch.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { priceOpenerWithSeed } from "./opener-pricing";
import { verifyDerivation } from "./pricing/opener-derivation";
import type { ZipArvSeed } from "./zip-arv-seed-store";

const API_ROOT = join(__dirname, "..", "app", "api");

/** Every route.ts under app/api, recursively. */
function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...routeFiles(full));
    else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

/** A WRITE of the field, not a read.
 *  Matches `Rough_Opener_Amount: x` and `sentFields.Rough_Opener_Amount = x`.
 *  Does NOT match `r.fields["Rough_Opener_Amount"]` or a `"Rough_Opener_Amount",`
 *  entry in a field-name array — both are reads. */
const writesField = (src: string, field: string) =>
  new RegExp(`${field}\\s*[:=]`).test(src);

describe("opener receipt parity — a number is never persisted without its arithmetic", () => {
  const files = routeFiles(API_ROOT);

  it("finds the API routes at all (guards against a silently-empty sweep)", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it("every route that writes Rough_Opener_Amount also writes Opener_Derivation_JSON", () => {
    const offenders = files
      .map((f) => ({ f, src: readFileSync(f, "utf8") }))
      .filter(({ src }) => writesField(src, "Rough_Opener_Amount"))
      .filter(({ src }) => !writesField(src, "Opener_Derivation_JSON"))
      .map(({ f }) => f.slice(f.indexOf("app/api")));

    expect(
      offenders,
      `These routes persist an opener with no derivation receipt, so the number ` +
        `cannot be recomputed cold — the 1708 Cardinal failure. Serialize the ` +
        `pricer's derivation (serializeDerivation(pw.derivation)) into ` +
        `Opener_Derivation_JSON in the same write.`,
    ).toEqual([]);
  });

  it("the intake path — the original and formerly ONLY caller — still writes it", () => {
    // Guards the regression in the other direction: this test would pass
    // vacuously if every write site disappeared.
    const intake = files.find((f) => f.includes(join("cron", "listings-intake")));
    expect(intake, "listings-intake route not found").toBeTruthy();
    expect(readFileSync(intake!, "utf8")).toContain("serializeDerivation");
  });

  it("at least three distinct routes now carry the receipt (intake was alone before this fix)", () => {
    const carriers = files.filter((f) =>
      readFileSync(f, "utf8").includes("serializeDerivation"),
    );
    expect(carriers.length).toBeGreaterThanOrEqual(3);
  });
});

// A receipt that cannot reproduce its own opener is worse than no receipt: it
// looks like an audit trail and answers nothing. The 1708 Cardinal rerun caught
// exactly that — the pricer's detail line read "fee $5,000" while the receipt
// recorded fee:null, because the receipt stored the fee PASSED IN rather than
// the one the arithmetic used. Every record with a blank Wholesale_Fee_Target
// (most of them) would have written an unverifiable receipt.
describe("receipt self-verification — the arithmetic must reproduce from the record alone", () => {
  const seed = (o: Partial<ZipArvSeed>): ZipArvSeed => ({
    zip: "00000", renovatedPerSqft: 0, arvLowPerSqft: null, compCount: 0,
    confidence: "STRONG", dontPrice: false, source: "rentcast_avm",
    market: null, state: null, fetchedAt: null, receiptsJson: null,
    recordId: "recTEST", ...o,
  } as ZipArvSeed);

  // The REAL 46227 seed receipts behind 1708 Cardinal, so the fixture is the
  // actual bitten record rather than a synthetic one — a hand-built comp set
  // lands a lower ARV and trips infeasible_ask, which would test the sanity
  // gate instead of the receipt.
  const receiptsJson = JSON.stringify({
    method: "comp_cluster_unimodal",
    filter_quality: "clean",
    comps: [
      { addr: "3149 Carson Ave", price: 160_000, sqft: 1_586, psf: 101 },
      { addr: "1228 E Perry St", price: 214_900, sqft: 1_720, psf: 125 },
      { addr: "3050 St Paul St", price: 230_000, sqft: 1_617, psf: 142 },
      { addr: "949 E Yoke St", price: 275_000, sqft: 1_536, psf: 179 },
      { addr: "844 E Berwyn St", price: 239_900, sqft: 1_663, psf: 144 },
      { addr: "1501 Nelson Ave", price: 184_900, sqft: 1_473, psf: 126 },
      { addr: "948 Albany St", price: 230_000, sqft: 1_464, psf: 157 },
      { addr: "1015 Cameron St", price: 275_000, sqft: 1_750, psf: 157 },
      { addr: "3319 S Tacoma Ave", price: 160_000, sqft: 1_488, psf: 108 },
      { addr: "2307 Werges Ave E", price: 264_900, sqft: 1_446, psf: 183 },
      { addr: "2874 S State Ave", price: 214_900, sqft: 1_832, psf: 117 },
      { addr: "951 E Southern Ave", price: 189_900, sqft: 1_810, psf: 105 },
    ],
  });

  const cases: Array<{ label: string; wholesaleFee: number | null }> = [
    { label: "blank Wholesale_Fee_Target (the bitten case)", wholesaleFee: null },
    { label: "explicit fee", wholesaleFee: 7_500 },
  ];

  for (const { label, wholesaleFee } of cases) {
    it(`produced opener reproduces from its own receipt — ${label}`, () => {
      const pw = priceOpenerWithSeed({
        listPrice: 229_900, storedArv: 245_589, storedArvConfidence: "HIGH",
        estRehabMid: 32_331, estRehab: 32_331, sqft: 1_336,
        arvPctMax: 0.70, wholesaleFee, anchorPct: 0.9,
        seed: seed({ zip: "46227", renovatedPerSqft: 154, arvLowPerSqft: 94.2, compCount: 23, receiptsJson }),
      });
      expect(pw.result.opener, "fixture should produce a number, not a HOLD").not.toBeNull();
      expect(pw.derivation.fee, "the fee USED must be on the receipt").toBeGreaterThan(0);

      const v = verifyDerivation(pw.derivation);
      expect(v.status, `receipt did not reproduce: ${v.detail}`).toBe("reproduced");
    });
  }
});
