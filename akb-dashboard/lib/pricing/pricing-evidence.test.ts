// CONVEYOR Milestone 1.5 — Pricing Evidence Run (READ-ONLY analysis).
//
// Question: across the COMPLETE with-ARV population (every Listings_V1 record
// that has a real Real_ARV_Median > 0, n=81 of 4,857 priceable on 2026-06-16),
// how often does the ARV / buy-box pricing path actually beat the flat
// 65%-of-list rail? M1 found it never did on 3 records; this measures it on
// the whole with-ARV set with REAL inputs (real market arv_pct_max, REAL ZIP
// renovated-comp seeds, each record's real ARV) so the ARV path is not
// starved — the explicit trap M1.5 warns against.
//
// REAL inputs fed (not mocked-empty):
//   - getMarketForListing  → committed markets.json (real arv_pct_max)
//   - ZIP_ARV_Seed         → real renovated-comp seeds pulled this session
//   - each record's real Real_ARV_Median / Est_Rehab_Mid / Building_SqFt
//   - anchor = 0.90 (Detroit launch default; KV unreachable this session).
//     0.90 is the HIGHEST anchor in play (calibration only moves it down), so
//     it is the most generous case for the ARV path — a loss here is not an
//     anchor-starvation artifact.
//
// Read-only: composes the live pricer; zero writes, zero sends, zero network
// (proveNoNetwork measures fetch during the synchronous run).

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { priceOpenerWithSeed } from "@/lib/opener-pricing";
import { computeRoughOpenerCeiling } from "@/lib/rough-opener-ceiling";
import { anchoredOpenerGate } from "@/lib/h2-outreach/your-mao-opener-gate";
import { arvForSubjectFromSeed, type ZipArvSeed } from "@/lib/zip-arv-seed-store";
import { getMarketForListing } from "@/lib/markets/registry";
import { proveNoNetwork } from "@/lib/orchestrator/dry-run-trace";

const DIR = dirname(fileURLToPath(import.meta.url));
const ANCHOR = 0.9; // launch default; KV unreachable. Most generous for ARV path.
const MATERIAL = 0.03; // >3% delta vs the 65% rail counts as "materially changed".

// Field-ID map (see arv-records JSON _meta).
const F = {
  list: "fld9J3Vi9fTq3zzMU",
  arv: "fldoNZxSZqQsCLIW6",
  conf: "fldDcIiUajkvi8Wz3",
  rehab: "fldmup8SvMky9eyag",
  rehabMid: "fldyDCVwvn9jfdiES",
  sqft: "fld5bKGJLlN7GmiE9",
  state: "fldSlDQvgCyr0J8tI",
  zip: "fld9PTaKkgBNtvWbB",
  mao: "flduPNI7iLK8Yj07E",
  status: "fldGIgqwyCJg4uFyv",
} as const;

type Rec = { id: string; f: Record<string, number | string> };

function loadRecords(): Rec[] {
  return JSON.parse(readFileSync(join(DIR, "__evidence__", "arv-records-2026-06-16.json"), "utf8")).records;
}
function loadSeeds(): Map<string, ZipArvSeed> {
  const raw = JSON.parse(readFileSync(join(DIR, "__evidence__", "zip-seeds-2026-06-16.json"), "utf8")).seeds;
  const m = new Map<string, ZipArvSeed>();
  for (const s of raw) {
    m.set(s.zip, {
      zip: s.zip,
      renovatedPerSqft: s.renovatedPerSqft,
      arvLowPerSqft: s.arvLowPerSqft,
      compCount: s.compCount,
      confidence: s.confidence,
      dontPrice: s.confidence === "DONT_PRICE",
      source: "rentcast_avm",
      market: "detroit_mi",
      state: "MI",
      fetchedAt: null,
      receiptsJson: null,
      recordId: "seed:" + s.zip,
    });
  }
  return m;
}

type Mechanism =
  | "buybox_won"
  | "buybox_won_capped"
  | "arv_distrusted"
  | "buybox_floored"
  | "seed_dont_price"
  | "no_buybox_market"
  | "fallback_other";

interface Row {
  id: string;
  state: string;
  zip: string;
  list: number;
  storedArv: number | null;
  arvUsed: number | null;
  arvDataSource: "seed" | "stored" | "suppressed_or_none";
  rehab: number | null;
  rawBuybox: number | null; // ARV-path opener BEFORE distrust/floor/cap guards
  final: number | null;
  basis: string;
  rail: number; // round(list * 0.65)
  mao_v1: number | null;
  mechanism: Mechanism;
  material: boolean; // |final - rail| / rail > 3%
  rawBeatRail: boolean; // the ARV path WOULD have beaten the rail pre-guards
  status: string;
}

function priceRow(rec: Rec, seeds: Map<string, ZipArvSeed>): Row {
  const f = rec.f;
  const num = (k: string): number | null => (typeof f[k] === "number" ? (f[k] as number) : null);
  const list = num(F.list) ?? 0;
  const storedArv = num(F.arv);
  const conf = (typeof f[F.conf] === "string" ? f[F.conf] : null) as "HIGH" | "MED" | "LOW" | null;
  const rehabMid = num(F.rehabMid);
  const rehab = num(F.rehab);
  const sqft = num(F.sqft);
  const state = String(f[F.state] ?? "");
  const zip = String(f[F.zip] ?? "");
  const mao = num(F.mao);
  const status = String(f[F.status] ?? "");

  const market = getMarketForListing({ state, zip });
  const arvPctMax = market?.buyer_params?.arv_pct_max ?? null;
  const seed = seeds.get(zip) ?? null;

  const priced = priceOpenerWithSeed({
    listPrice: list,
    storedArv,
    storedArvConfidence: conf,
    estRehabMid: rehabMid,
    estRehab: rehab,
    sqft,
    arvPctMax,
    wholesaleFee: null,
    anchorPct: ANCHOR,
    seed,
  });
  const r = priced.result;

  // The ARV the buy-box path WOULD use (source-swap: seed renovated $/sqft wins).
  const seedArv = seed ? arvForSubjectFromSeed(seed, sqft) : null;
  const arvForRaw = seedArv ?? (storedArv && storedArv > 0 ? storedArv : null);
  let rawBuybox: number | null = null;
  if (arvForRaw != null && arvPctMax != null) {
    const ceil = computeRoughOpenerCeiling({
      realArvMedian: arvForRaw,
      estRehabMid: rehabMid,
      estRehab: rehab,
      listPrice: list,
      arvPctMax,
    }).ceiling;
    rawBuybox = anchoredOpenerGate({ ceiling: ceil, anchorPct: ANCHOR, priceable: true }).opener;
  }

  const rail = Math.round(list * 0.65);
  const final = r.opener;

  let mechanism: Mechanism;
  if (r.basis === "arv_buybox") mechanism = r.cappedToList ? "buybox_won_capped" : "buybox_won";
  else if (r.arvDistrusted) mechanism = "arv_distrusted";
  else if (r.flooredToFallback) mechanism = "buybox_floored";
  else if (seed?.dontPrice) mechanism = "seed_dont_price";
  else if (arvPctMax == null) mechanism = "no_buybox_market";
  else mechanism = "fallback_other";

  const arvDataSource: Row["arvDataSource"] = seedArv != null ? "seed" : storedArv && storedArv > 0 ? "stored" : "suppressed_or_none";

  return {
    id: rec.id, state, zip, list, storedArv, arvUsed: priced.arvUsed, arvDataSource,
    rehab: rehabMid ?? rehab, rawBuybox, final, basis: priced.basisLabel, rail, mao_v1: mao,
    mechanism,
    material: final != null && Math.abs(final - rail) / rail > MATERIAL,
    rawBeatRail: rawBuybox != null && rawBuybox > rail * (1 + MATERIAL),
    status,
  };
}

describe("Pricing Evidence Run — ARV path vs 65% rail (CONVEYOR M1.5)", () => {
  const records = loadRecords();
  const seeds = loadSeeds();

  it("zero network / zero writes / zero sends during the read-only run", () => {
    const { fetchCalls } = proveNoNetwork(() => records.map((r) => priceRow(r, seeds)));
    expect(fetchCalls).toBe(0);
  });

  it("the complete with-ARV population is present (81)", () => {
    expect(records.length).toBe(81);
  });

  it("measures + prints the ARV-vs-rail distribution and headline", () => {
    const rows = records.map((r) => priceRow(r, seeds));

    const byMech: Record<string, number> = {};
    for (const r of rows) byMech[r.mechanism] = (byMech[r.mechanism] ?? 0) + 1;

    const M = rows.length; // all 81 have stored ARV → all "with real ARV data"
    const wonRows = rows.filter((r) => r.mechanism === "buybox_won" || r.mechanism === "buybox_won_capped");
    const materialRows = rows.filter((r) => r.material);
    const rawBeatButSuppressed = rows.filter((r) => r.rawBeatRail && r.mechanism !== "buybox_won" && r.mechanism !== "buybox_won_capped");
    const arvViaSeed = rows.filter((r) => r.arvDataSource === "seed").length;
    const arvViaStored = rows.filter((r) => r.arvDataSource === "stored").length;
    const arvSuppressed = rows.filter((r) => r.arvDataSource === "suppressed_or_none").length;

    const lines: string[] = [];
    lines.push("\n══════════ PRICING EVIDENCE — ARV path vs 65%-of-list rail ══════════");
    lines.push(`Population: ${M} records (the COMPLETE Real_ARV_Median>0 set, of 4,857 priceable).`);
    lines.push(`Inputs: REAL markets.json + REAL ZIP_ARV_Seed (18 Detroit ZIPs) + record ARV; anchor ${ANCHOR} (launch max).`);
    lines.push(`Effective ARV source: seed=${arvViaSeed} · stored=${arvViaStored} · suppressed/none=${arvSuppressed}`);
    lines.push("");
    lines.push("Route the FINAL opener took:");
    for (const k of ["buybox_won", "buybox_won_capped", "arv_distrusted", "buybox_floored", "seed_dont_price", "no_buybox_market", "fallback_other"]) {
      lines.push(`  ${k.padEnd(20)} ${byMech[k] ?? 0}`);
    }
    lines.push("");
    lines.push(`HEADLINE: of ${M} records with real ARV data, the ARV/buy-box path produced the FINAL opener (beat the rail) in ${wonRows.length} (${Math.round((100 * wonRows.length) / M)}%).`);
    lines.push(`          the final opener differed materially (>3%) from the 65% rail in ${materialRows.length} (${Math.round((100 * materialRows.length) / M)}%).`);
    lines.push(`          in ${rawBeatButSuppressed.length} records the ARV path WOULD have beaten the rail pre-guards, but a guard (distrust/floor) knocked it back to 65%.`);
    lines.push("");
    if (wonRows.length > 0) {
      lines.push("Records where the ARV path WON (final basis = arv_buybox):");
      lines.push("  id                | st zip   | list     | ARVused  | rehab   | rawBuybox| FINAL    | rail(65%)| basis");
      for (const r of wonRows) {
        lines.push(
          `  ${r.id} | ${r.state} ${r.zip} | ${String(r.list).padStart(8)} | ${String(r.arvUsed ?? "-").padStart(8)} | ${String(r.rehab ?? "-").padStart(7)} | ${String(r.rawBuybox ?? "-").padStart(8)} | ${String(r.final ?? "-").padStart(8)} | ${String(r.rail).padStart(8)} | ${r.basis}`,
        );
      }
    } else {
      lines.push("Records where the ARV path WON: NONE.");
    }
    lines.push("════════════════════════════════════════════════════════════════════\n");
    // eslint-disable-next-line no-console
    console.log(lines.join("\n"));

    // Assertions: the run completed over the whole population with a usable
    // opener on every record, and the headline counts are self-consistent.
    expect(rows.every((r) => typeof r.final === "number")).toBe(true);
    expect(wonRows.length + (byMech["arv_distrusted"] ?? 0) + (byMech["buybox_floored"] ?? 0) + (byMech["seed_dont_price"] ?? 0) + (byMech["no_buybox_market"] ?? 0) + (byMech["fallback_other"] ?? 0)).toBe(M);
  });
});
