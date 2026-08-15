// OWN-COMPS ARV — tests are the two real failures this exists to end.
//
// 1708 Cardinal:  ZIP seed (10 of 12 comps from neighbor ZIPs) priced $63k,
//                 then $100k; the record's own 30 comps — all 46227, ≤0.88mi —
//                 support ~$121k+. Seller Kirk: "your numbers are wrong in
//                 that area." He was right; the comps were not from his area.
// 9360 Cheyenne:  stored field $154,177 (=$107.81/sqft) on top of 44 own comps
//                 whose median is ~$55 — the sent $42,499 could never pencil.
import { describe, it, expect } from "vitest";
import { parseOwnComps, ownCompsArv, OWN_COMPS_MIN } from "./own-comps-arv";
import { priceOpenerWithSeed } from "../opener-pricing";
import { verifyDerivation } from "./opener-derivation";
import type { ZipArvSeed } from "../zip-arv-seed-store";

const NOW = new Date("2026-08-14T20:00:00Z");

/** The real 1708 Cardinal ARV_Comp_Details_JSON (trimmed to consumed fields). */
const CARDINAL = JSON.stringify([
  { price: 181800, sqft: 1190, distance: 0.466, sale_date: "2026-07-07", formatted_address: "1352 SOUTHVIEW DR, INDIANAPOLIS, IN, 46227" },
  { price: 372400, sqft: 1344, distance: 0.383, sale_date: "2026-06-26", formatted_address: "1649 SOUTHVIEW DR, INDIANAPOLIS, IN, 46227" },
  { price: 238668, sqft: 1514, distance: 0.5443, sale_date: "2026-06-17", formatted_address: "6350 SHELBY ST, INDIANAPOLIS, IN, 46227" },
  { price: 253737, sqft: 1336, distance: 0.3164, sale_date: "2026-05-01", formatted_address: "6653 HOMESTEAD DR, INDIANAPOLIS, IN, 46227" },
  { price: 196000, sqft: 1506, distance: 0.783, sale_date: "2026-04-14", formatted_address: "1540 WEBER DR, INDIANAPOLIS, IN, 46227" },
  { price: 290272, sqft: 1124, distance: 0.1139, sale_date: "2026-04-03", formatted_address: "6324 HOMESTEAD DR, INDIANAPOLIS, IN, 46227" },
  { price: 250000, sqft: 1328, distance: 0.8494, sale_date: "2026-03-11", formatted_address: "5524 S WALCOTT ST, INDIANAPOLIS, IN, 46227" },
  { price: 320000, sqft: 1484, distance: 0.4742, sale_date: "2026-03-09", formatted_address: "1119 E CRAGMONT DR, INDIANAPOLIS, IN, 46227" },
  { price: 290000, sqft: 1483, distance: 0.2542, sale_date: "2026-02-23", formatted_address: "1408 E BANTA RD, INDIANAPOLIS, IN, 46227" },
  { price: 243000, sqft: 1326, distance: 0.7426, sale_date: "2026-02-02", formatted_address: "931 MAYNARD DR, INDIANAPOLIS, IN, 46227" },
  { price: 331083, sqft: 1446, distance: 0.6328, sale_date: "2026-01-21", formatted_address: "1101 SOUTHVIEW DR, INDIANAPOLIS, IN, 46227" },
  { price: 272500, sqft: 1385, distance: 0.2901, sale_date: "2026-01-06", formatted_address: "2224 FAIRHOPE DR, INDIANAPOLIS, IN, 46227" },
  { price: 280000, sqft: 1542, distance: 0.4732, sale_date: "2025-12-31", formatted_address: "6335 S KEYSTONE AVE, INDIANAPOLIS, IN, 46227" },
  { price: 250000, sqft: 1588, distance: 0.4203, sale_date: "2025-12-30", formatted_address: "6546 DERBYSHIRE RD, INDIANAPOLIS, IN, 46227" },
  { price: 210500, sqft: 1280, distance: 0.3572, sale_date: "2025-12-23", formatted_address: "1734 SOUTHVIEW DR, INDIANAPOLIS, IN, 46227" },
  { price: 250000, sqft: 1327, distance: 0.5468, sale_date: "2025-12-22", formatted_address: "6336 S TACOMA AVE, INDIANAPOLIS, IN, 46227" },
  { price: 173000, sqft: 1166, distance: 0.8801, sale_date: "2025-12-19", formatted_address: "1729 E EPLER AVE, INDIANAPOLIS, IN, 46227" },
  { price: 155000, sqft: 1309, distance: 0.7993, sale_date: "2025-11-04", formatted_address: "1134 GILBERT AVE, INDIANAPOLIS, IN, 46227" },
  { price: 260000, sqft: 1398, distance: 0.7269, sale_date: "2025-10-31", formatted_address: "2535 MAYNARD DR, INDIANAPOLIS, IN, 46227" },
  { price: 210000, sqft: 1520, distance: 0.431, sale_date: "2025-10-30", formatted_address: "1147 WOOD CT, INDIANAPOLIS, IN, 46227" },
  { price: 252500, sqft: 1276, distance: 0.7621, sale_date: "2025-10-21", formatted_address: "2620 MAYNARD DR, INDIANAPOLIS, IN, 46227" },
  { price: 218000, sqft: 1238, distance: 0.8674, sale_date: "2025-10-21", formatted_address: "5516 S STATE AVE, INDIANAPOLIS, IN, 46227" },
  { price: 284900, sqft: 1551, distance: 0.3698, sale_date: "2025-10-14", formatted_address: "6802 MADISON AVE, INDIANAPOLIS, IN, 46227" },
  { price: 259000, sqft: 1176, distance: 0.2107, sale_date: "2025-10-06", formatted_address: "6471 HOMESTEAD DR, INDIANAPOLIS, IN, 46227" },
  { price: 273000, sqft: 1554, distance: 0.6459, sale_date: "2025-10-03", formatted_address: "6805 TWIN BROOKS DR, INDIANAPOLIS, IN, 46227" },
  { price: 195000, sqft: 1215, distance: 0.7062, sale_date: "2025-09-30", formatted_address: "1535 WHALEN AVE, INDIANAPOLIS, IN, 46227" },
  { price: 285000, sqft: 1130, distance: 0.1701, sale_date: "2025-09-16", formatted_address: "1739 FOREST DR, INDIANAPOLIS, IN, 46227" },
  { price: 195000, sqft: 1233, distance: 0.3431, sale_date: "2025-09-12", formatted_address: "6604 FABLE ST, INDIANAPOLIS, IN, 46227" },
  { price: 285000, sqft: 1455, distance: 0.2541, sale_date: "2025-08-15", formatted_address: "6141 MADISON AVE, INDIANAPOLIS, IN, 46227" },
  { price: 220000, sqft: 1601, distance: 0.8639, sale_date: "2025-08-15", formatted_address: "114 SOUTH ST, SOUTHPORT, IN, 46227" },
]);

/** 9360 Cheyenne comps — representative half of the real 44 (median ≈ $52/sqft;
 *  full-set median ≈ $55). Includes the subject's own 2025-09 sale. */
const CHEYENNE = JSON.stringify([
  { price: 95000, sqft: 1276, distance: 0.4212, sale_date: "2026-06-29", formatted_address: "10030 HARTWELL, Detroit, MI, 48227" },
  { price: 100000, sqft: 1218, distance: 0.4813, sale_date: "2026-05-21", formatted_address: "8590 LITTLEFIELD, Detroit, MI, 48228" },
  { price: 55000, sqft: 1307, distance: 0.3206, sale_date: "2026-05-13", formatted_address: "8871 CHEYENNE, Detroit, MI, 48228" },
  { price: 115000, sqft: 1210, distance: 0.6541, sale_date: "2026-05-04", formatted_address: "9630 STRATHMOOR, Detroit, MI, 48227" },
  { price: 82863, sqft: 1417, distance: 0.8796, sale_date: "2026-04-30", formatted_address: "8250 ESPER, Detroit, MI, 48204" },
  { price: 70000, sqft: 1351, distance: 0.4998, sale_date: "2026-04-21", formatted_address: "8560 WARD, Detroit, MI, 48228" },
  { price: 50000, sqft: 1486, distance: 0.6133, sale_date: "2026-04-15", formatted_address: "9581 MARK TWAIN, Detroit, MI, 48227" },
  { price: 60000, sqft: 1298, distance: 0.2341, sale_date: "2026-04-13", formatted_address: "9119 LITTLEFIELD, Detroit, MI, 48228" },
  { price: 71000, sqft: 1552, distance: 0.978, sale_date: "2026-02-11", formatted_address: "8319 MARLOWE, Detroit, MI, 48228" },
  { price: 65000, sqft: 1518, distance: 0.497, sale_date: "2026-02-02", formatted_address: "8561 WARD, Detroit, MI, 48228" },
  { price: 62000, sqft: 1174, distance: 0.1938, sale_date: "2026-01-27", formatted_address: "9180 HARTWELL, Detroit, MI, 48228" },
  { price: 90000, sqft: 1305, distance: 0.1076, sale_date: "2026-01-22", formatted_address: "9279 LITTLEFIELD, Detroit, MI, 48228" },
  { price: 70000, sqft: 1171, distance: 0.1628, sale_date: "2026-01-14", formatted_address: "9222 HARTWELL, Detroit, MI, 48228" },
  { price: 85000, sqft: 1568, distance: 0.8072, sale_date: "2026-01-12", formatted_address: "11300 HUBBELL, Detroit, MI, 48227" },
  { price: 48000, sqft: 1172, distance: 0.9509, sale_date: "2025-12-31", formatted_address: "11431 MARLOWE, Detroit, MI, 48227" },
  { price: 90000, sqft: 1188, distance: 0.2423, sale_date: "2025-12-30", formatted_address: "9141 HARTWELL, Detroit, MI, 48228" },
  { price: 72200, sqft: 1487, distance: 0.0411, sale_date: "2025-10-31", formatted_address: "9300 CHEYENNE, Detroit, MI, 48228" },
  { price: 67000, sqft: 1475, distance: 0.1091, sale_date: "2025-10-30", formatted_address: "9244 LITTLEFIELD, Detroit, MI, 48228" },
  { price: 64000, sqft: 1430, distance: 0.021, sale_date: "2025-09-11", formatted_address: "9360 CHEYENNE, Detroit, MI, 48228" },
  { price: 74000, sqft: 1169, distance: 0.6521, sale_date: "2025-09-11", formatted_address: "11395 MANOR, Detroit, MI, 48204" },
]);

const seed = (o: Partial<ZipArvSeed>): ZipArvSeed => ({
  zip: "00000", renovatedPerSqft: 0, arvLowPerSqft: null, compCount: 0,
  confidence: "STRONG", dontPrice: false, source: "rentcast_avm",
  market: null, state: null, fetchedAt: null, receiptsJson: null,
  recordId: "recTEST", ...o,
} as ZipArvSeed);

describe("parseOwnComps — filters and dedup", () => {
  it("drops junk, keeps real comps", () => {
    const j = JSON.stringify([
      null, 7, { price: 0, sqft: 1000 }, { price: 100000 },
      { price: 100000, sqft: 1000, formatted_address: "A ST" },
    ]);
    expect(parseOwnComps(j, NOW)).toHaveLength(1);
  });

  it("dedupes the same closing reported twice (MLS + public record)", () => {
    const j = JSON.stringify([
      { price: 253000, sqft: 1525, formatted_address: "816 W Philadelphia St" },
      { price: 253000, sqft: 1525, formatted_address: "816 W PHILADELPHIA ST" },
      { price: 255000, sqft: 1636, formatted_address: "708 W Euclid St" },
    ]);
    expect(parseOwnComps(j, NOW)).toHaveLength(2);
  });

  it("drops stale sales (>18mo) and far comps (>1.25mi)", () => {
    const j = JSON.stringify([
      { price: 100000, sqft: 1000, sale_date: "2024-06-01", formatted_address: "OLD" },
      { price: 100000, sqft: 1000, distance: 2.4, formatted_address: "FAR" },
      { price: 100000, sqft: 1000, sale_date: "2026-06-01", distance: 0.3, formatted_address: "GOOD" },
    ]);
    const out = parseOwnComps(j, NOW);
    expect(out).toHaveLength(1);
    expect(out[0].address).toBe("GOOD");
  });
});

describe("ownCompsArv — refuses before it guesses", () => {
  it("below the floor → not ok, never a silent basis", () => {
    const four = JSON.stringify(
      Array.from({ length: OWN_COMPS_MIN - 1 }, (_, i) => ({ price: 100000, sqft: 1000, formatted_address: `C${i}` })),
    );
    const r = ownCompsArv({ compsJson: four, sqft: 1200, now: NOW });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/too_few_own_comps/);
  });

  it("no sqft → not ok", () => {
    expect(ownCompsArv({ compsJson: CARDINAL, sqft: null, now: NOW }).ok).toBe(false);
  });
});

describe("1708 Cardinal — the record's own comps produce the number Kirk recognizes", () => {
  it("own comps: ~$183+/sqft, ARV ≈ $245k+ (seed said $158.76 → $212k)", () => {
    const r = ownCompsArv({ compsJson: CARDINAL, sqft: 1336, now: NOW });
    expect(r.ok).toBe(true);
    expect(r.compCount).toBe(30);
    expect(r.confidence).toBe("STRONG");
    expect(r.psf!).toBeGreaterThan(175);
    expect(r.arv!).toBeGreaterThan(235_000);
    expect(r.arv!).toBeLessThan(280_000);
  });

  it("INTEGRATION: own comps outrank the wrong-area seed — opener lands ~$121k, receipt reproduces", () => {
    const pw = priceOpenerWithSeed({
      listPrice: 229_900,
      storedArv: 245_589, storedArvConfidence: "HIGH",
      estRehabMid: 32_331, estRehab: 32_331, sqft: 1_336,
      arvPctMax: 0.70, wholesaleFee: null, anchorPct: 0.9,
      // The REAL 46227 seed — the one that produced $100k. It must LOSE.
      seed: seed({ zip: "46227", renovatedPerSqft: 154, arvLowPerSqft: 94.2, compCount: 23 }),
      ownCompsJson: CARDINAL,
    });
    expect(pw.arvSource).toBe("own_comps");
    expect(pw.basisLabel).toMatch(/^arv_buybox_own_comps/);
    expect(pw.result.opener).not.toBeNull();
    // $63k was sent; seed math said $100k; own comps put it $115k–$140k.
    expect(pw.result.opener!).toBeGreaterThanOrEqual(112_000);
    expect(pw.result.opener!).toBeLessThanOrEqual(140_000);
    expect(pw.corroborationFlags).toEqual([]);
    const v = verifyDerivation(pw.derivation);
    expect(v.status, v.detail).toBe("reproduced");
  });
});

describe("9360 Cheyenne — own comps stop the offer the stored field allowed", () => {
  it("own comps say ~$52-58/sqft, not the stored $107.81", () => {
    const r = ownCompsArv({ compsJson: CHEYENNE, sqft: 1_430, now: NOW });
    expect(r.ok).toBe(true);
    expect(r.psf!).toBeGreaterThan(40);
    expect(r.psf!).toBeLessThan(65);
  });

  it("INTEGRATION: the $42,499 that was actually texted can no longer be produced", () => {
    const pw = priceOpenerWithSeed({
      listPrice: 44_999,
      storedArv: 154_177, storedArvConfidence: "HIGH", // the lying field
      estRehabMid: 36_465, estRehab: 36_465, sqft: 1_430,
      arvPctMax: 0.6461, wholesaleFee: null, anchorPct: 0.9,
      seed: null,
      ownCompsJson: CHEYENNE,
    });
    expect(pw.arvSource).toBe("own_comps");
    // ARV ~$75-83k → ceiling ≈ $7-12k → below the micro-opener floor → HOLD.
    expect(pw.result.opener).toBeNull();
  });

  it("counterfactual: without own comps the lying stored field still prices — the bug this retires", () => {
    // At Cheyenne's real $44,999 list the stored path happens to be caught by
    // the coarse 2.5× ARV-vs-list rail (154,177 / 44,999 = 3.43×) — an
    // ACCIDENT of this record's numbers, not protection. Same lying field at
    // a $89,900 list is 1.7× and sails straight through:
    const pw = priceOpenerWithSeed({
      listPrice: 89_900,
      storedArv: 154_177, storedArvConfidence: "HIGH",
      estRehabMid: 36_465, estRehab: 36_465, sqft: 1_430,
      arvPctMax: 0.6461, wholesaleFee: null, anchorPct: 0.9,
      seed: null, ownCompsJson: null,
    });
    expect(pw.arvSource).toBe("stored");
    expect(pw.result.opener).not.toBeNull();

    // …while the SAME record with its own comps present refuses regardless of
    // what the list price happens to be:
    const withComps = priceOpenerWithSeed({
      listPrice: 89_900,
      storedArv: 154_177, storedArvConfidence: "HIGH",
      estRehabMid: 36_465, estRehab: 36_465, sqft: 1_430,
      arvPctMax: 0.6461, wholesaleFee: null, anchorPct: 0.9,
      seed: null, ownCompsJson: CHEYENNE,
    });
    expect(withComps.arvSource).toBe("own_comps");
    expect(withComps.result.opener).toBeNull();
  });
});

describe("adversarial-review rails (2026-08-14 workflow, verdict 'unsafe' on the naive draft)", () => {
  const mk = (n: number, extra: object[] = []) =>
    JSON.stringify([
      ...Array.from({ length: n }, (_, i) => ({
        price: 100_000 + i * 10_000, sqft: 1_000 + i * 10, distance: 0.2 + i / 100,
        sale_date: "2026-06-01", formatted_address: `${i} REAL ST, DETROIT, MI, 48228`,
      })),
      ...extra,
    ]);

  it("EXCLUSION RECEIPTS never count — the honest-empty write stores documented junk in this field", () => {
    const j = JSON.stringify(
      Array.from({ length: 6 }, (_, i) => ({
        price: 100_000, sqft: 1_000, distance: 0.2,
        formatted_address: `${i} JUNK ST`, excluded_reason: "subject_property",
      })),
    );
    const r = ownCompsArv({ compsJson: j, sqft: 1_200, now: NOW });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/too_few_own_comps \(0/);
  });

  it("the subject's own print (distance ≈ 0) is never its own comp", () => {
    const withSelf = mk(5, [{ price: 64_000, sqft: 1_430, distance: 0.021, sale_date: "2025-09-11", formatted_address: "9360 CHEYENNE, Detroit, MI, 48228" }]);
    const out = parseOwnComps(withSelf, NOW);
    expect(out).toHaveLength(5);
    expect(out.some((c) => c.address?.includes("9360 CHEYENNE"))).toBe(false);
  });

  it("PORTFOLIO DEED: same price + sqft-to-the-foot + date across different addresses = one conveyance (2106 Parkdale class)", () => {
    const j = mk(5, [
      { price: 840_000, sqft: 1_296, distance: 0.4, sale_date: "2026-04-27", formatted_address: "1515 OAKWOOD AVE" },
      { price: 840_000, sqft: 1_296, distance: 0.5, sale_date: "2026-04-27", formatted_address: "1526 NORWOOD AVE" },
      { price: 840_000, sqft: 1_296, distance: 0.6, sale_date: "2026-04-27", formatted_address: "1509 OAKWOOD AVE" },
    ]);
    const out = parseOwnComps(j, NOW);
    expect(out.filter((c) => c.price === 840_000)).toHaveLength(1);
  });

  it("AVM-PRICED ARRAY: model estimates stored as comps fail the shape test (Dallas 75216 class)", () => {
    const avm = JSON.stringify(
      [423_272, 297_265, 283_290, 410_970, 246_933, 475_589].map((price, i) => ({
        price, sqft: 1_400 + i * 20, distance: 0.3, sale_date: "2026-05-01", formatted_address: `${i} MODEL DR`,
      })),
    );
    const r = ownCompsArv({ compsJson: avm, sqft: 1_400, now: NOW });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/avm_priced_own_comps/);
  });

  it("accepts the {comps:[…]} wrapper shape as well as the bare array", () => {
    const wrapped = JSON.stringify({ comps: JSON.parse(mk(6)) });
    expect(parseOwnComps(wrapped, NOW)).toHaveLength(6);
  });

  it("DIVERGENCE RAIL: own psf far ABOVE a STRONG seed → the curated seed prices, not the suspect array", () => {
    // Own comps imply ~$300/sqft; the STRONG seed says $100 — upward
    // divergence means stale dupes/portfolio junk, so the seed wins.
    const inflated = JSON.stringify(
      Array.from({ length: 8 }, (_, i) => ({
        price: 300_000 + i * 5_000, sqft: 1_000, distance: 0.2 + i / 50,
        sale_date: "2026-06-01", formatted_address: `${i} INFLATED AVE`,
      })),
    );
    const pw = priceOpenerWithSeed({
      listPrice: 150_000, storedArv: null, estRehabMid: 30_000, sqft: 1_300,
      arvPctMax: 0.70, anchorPct: 0.9,
      seed: seed({ zip: "48228", renovatedPerSqft: 100, arvLowPerSqft: 60, compCount: 20 }),
      ownCompsJson: inflated,
    });
    expect(pw.arvSource).toBe("seed_renovated");
  });

  it("SHADOW POSTURE: own_comps basis is THIN in the pricer — ARV below list HOLDS instead of auto-sending the over-ARV-list lowball", () => {
    // Own comps say ~$110/sqft × 1,000 = $110k ARV against a $160k list →
    // ARV < list. On a STRONG seed that sends per the 2026-07-22 amendment;
    // on the unproven own-comps basis it must HOLD.
    const pw = priceOpenerWithSeed({
      listPrice: 160_000, storedArv: null, estRehabMid: 20_000, sqft: 1_000,
      arvPctMax: 0.70, anchorPct: 0.9, seed: null,
      ownCompsJson: mk(8),
    });
    expect(pw.arvSource).toBe("own_comps");
    expect(pw.result.opener).toBeNull();
  });
});

describe("hierarchy — fallbacks unchanged when own comps are absent or thin", () => {
  it("no comps JSON → seed path exactly as before", () => {
    const pw = priceOpenerWithSeed({
      listPrice: 229_900, storedArv: null, estRehabMid: 32_331, sqft: 1_336,
      arvPctMax: 0.70, anchorPct: 0.9,
      seed: seed({ zip: "46227", renovatedPerSqft: 154, arvLowPerSqft: 94.2, compCount: 23 }),
    });
    expect(pw.arvSource).toBe("seed_renovated");
  });

  it("own comps OUTRANK a DONT_PRICE ZIP — hyperlocal sales beat an aggregate's absence", () => {
    const pw = priceOpenerWithSeed({
      listPrice: 150_000, storedArv: null, estRehabMid: 30_000, sqft: 1_336,
      arvPctMax: 0.70, anchorPct: 0.9,
      seed: seed({ zip: "48206", renovatedPerSqft: 0, confidence: "DONT_PRICE", dontPrice: true }),
      ownCompsJson: CARDINAL,
    });
    expect(pw.arvSource).toBe("own_comps");
    expect(pw.result.opener).not.toBeNull();
  });
});
