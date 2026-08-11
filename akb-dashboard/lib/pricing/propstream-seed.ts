// PropStream MLS-sold → ZIP ARV seed. @agent: appraiser
//
// THE FINDING THIS MODULE EXISTS FOR (2026-08-11, San Antonio export).
// A PropStream property export carries TWO price columns and only one of
// them is a transaction:
//
//   "Last Sale Amount"  — 23.0% transaction-shaped across 2,472 rows, and
//     it contained a $546,310,000 portfolio transfer repeated five times.
//     Texas is a NON-DISCLOSURE state: deed prices are not public, so this
//     column is modelled. Seeding from it rebuilds exactly the fiction that
//     put TX on DONT_PRICE in the first place (78211 was seeded at
//     $3,459/sqft).
//   "MLS Amount" where "MLS Status" = SOLD — 94.8% transaction-shaped
//     across 5,282 rows. Agents report closings to the MLS even where the
//     county does not publish them. THIS is the real receipt.
//
// So the seed-quality gate has to run PER COLUMN, not per file. A vendor
// file is not "clean" or "dirty" — its individual fields are.
//
// THE SECOND DECISION: condition bands. ARV is an AFTER-REPAIR number, so
// only renovated comps may set it. The same export splits cleanly and
// monotonically, which is the evidence that the condition field is real:
//   Excellent $232/sqft (n=62) · Good $167 (n=3,112) · Average $140 (n=1,893)
//   · Poor $85 (n=155) · Disrepair $71 (n=8)
// Seeding ARV off "average or worse" would understate every San Antonio ARV
// and reproduce the W 106th miss (an opener built on an ARV ~$24k light).
// Good+Excellent set renovatedPerSqft; the as-is bands are carried in the
// receipts as context and never price anything.
//
// VALIDATION on the operator's own hand-underwriting: the measured
// Good+Excellent median is $168/sqft. He underwrote 3022 El Paso St — the
// contract whose math was sound — at $185,000 on 1,100 sqft = $168/sqft.
// The measured seed reproduces his best manual comp set to the dollar.

import {
  isTransactionShapedPrice,
  SEED_QUALITY_MIN_COMPS,
  SEED_QUALITY_MIN_TRANSACTION_SHARE,
} from "./seed-quality";
import type { ZipArvSeedWrite } from "@/lib/zip-arv-seed-store";

/** Only the columns this module reads. Deliberately NOT the full 76-column
 *  PropStream shape — the route maps the CSV down to this so a vendor
 *  column rename cannot reach the pricing logic. */
export interface PropstreamRow {
  zip: string | null;
  city: string | null;
  state: string | null;
  mlsStatus: string | null;
  /** The agent-reported sold price. The ONLY price this module will use. */
  mlsAmount: number | null;
  buildingSqft: number | null;
  totalCondition: string | null;
}

/** Condition values that mean "renovated" — these and only these set ARV. */
export const ARV_CONDITIONS = new Set(["good", "excellent"]);
/** Condition values that mean "as-is" — carried as context, never priced. */
export const AS_IS_CONDITIONS = new Set(["average", "fair", "poor", "disrepair"]);

/** Junk rails, NOT market opinions. These exist to strip portfolio transfers
 *  and unit-of-measure errors, and are deliberately far wider than any real
 *  residential market so they never quietly impose a price view. The
 *  $3,459/sqft San Antonio fiction and the $546M transfer both fall outside;
 *  a genuinely expensive infill teardown does not. */
export const MIN_SQFT = 200;
export const MAX_SQFT = 20_000;
export const MIN_PSF = 5;
export const MAX_PSF = 1_500;

export interface ZipSeedReport {
  zip: string;
  arvCompCount: number;
  asIsCompCount: number;
  renovatedPerSqft: number | null;
  arvLowPerSqft: number | null;
  asIsPerSqft: number | null;
  transactionShare: number | null;
  dontPrice: boolean;
  reason: string;
}

export interface BuildSeedsResult {
  seeds: ZipArvSeedWrite[];
  reports: ZipSeedReport[];
  totals: {
    rowsIn: number;
    soldRows: number;
    usableRows: number;
    droppedNotSold: number;
    droppedNoPrice: number;
    droppedNoSqft: number;
    droppedOutOfRails: number;
    zipsPriceable: number;
    zipsDontPrice: number;
  };
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Conservative low end for arvLowPerSqft — the seed store prices ARV off
 *  this, never off the median (see arv-comp-engine's cardinal principle:
 *  never overestimate the resale). */
function percentile(xs: number[], p: number): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.floor((s.length - 1) * p)));
  return s[i];
}

interface Comp {
  price: number;
  sqft: number;
  psf: number;
}

export interface BuildSeedsOpts {
  rows: PropstreamRow[];
  /** Stamped onto every seed. */
  market?: string | null;
  fetchedAt?: string;
}

export function buildSeedsFromPropstream(opts: BuildSeedsOpts): BuildSeedsResult {
  const { rows } = opts;
  const totals = {
    rowsIn: rows.length,
    soldRows: 0,
    usableRows: 0,
    droppedNotSold: 0,
    droppedNoPrice: 0,
    droppedNoSqft: 0,
    droppedOutOfRails: 0,
    zipsPriceable: 0,
    zipsDontPrice: 0,
  };

  const arvByZip = new Map<string, Comp[]>();
  const asIsByZip = new Map<string, Comp[]>();
  const stateByZip = new Map<string, string>();
  // Every ZIP with at least one usable SOLD row, even if none of them carried
  // a condition. A re-seed must emit an explicit DONT_PRICE for those rather
  // than staying silent: silence leaves whatever fiction is already stored on
  // the ZIP in place, which is the failure this whole exercise is undoing.
  const seenZips = new Set<string>();

  for (const r of rows) {
    // ONLY closed transactions. Pending/Active/Expired are asking prices —
    // an ask is not a receipt, and mixing them is how a seed starts
    // describing the seller's hopes instead of the market.
    if ((r.mlsStatus ?? "").trim().toUpperCase() !== "SOLD") {
      totals.droppedNotSold++;
      continue;
    }
    totals.soldRows++;
    const zip = (r.zip ?? "").trim().slice(0, 5);
    if (!/^\d{5}$/.test(zip)) continue;
    const price = r.mlsAmount;
    if (!price || !Number.isFinite(price) || price <= 0) {
      totals.droppedNoPrice++;
      continue;
    }
    const sqft = r.buildingSqft;
    if (!sqft || !Number.isFinite(sqft) || sqft < MIN_SQFT || sqft > MAX_SQFT) {
      totals.droppedNoSqft++;
      continue;
    }
    const psf = price / sqft;
    if (psf < MIN_PSF || psf > MAX_PSF) {
      totals.droppedOutOfRails++;
      continue;
    }
    totals.usableRows++;
    seenZips.add(zip);
    if (r.state) stateByZip.set(zip, r.state.trim().toUpperCase().slice(0, 2));

    const cond = (r.totalCondition ?? "").trim().toLowerCase();
    const comp: Comp = { price, sqft, psf };
    if (ARV_CONDITIONS.has(cond)) {
      (arvByZip.get(zip) ?? arvByZip.set(zip, []).get(zip)!).push(comp);
    } else if (AS_IS_CONDITIONS.has(cond)) {
      (asIsByZip.get(zip) ?? asIsByZip.set(zip, []).get(zip)!).push(comp);
    }
    // Unknown/blank condition is counted as usable but priced into neither
    // band — we will not guess whether a house was renovated.
  }

  const seeds: ZipArvSeedWrite[] = [];
  const reports: ZipSeedReport[] = [];
  const zips = new Set<string>([...seenZips, ...arvByZip.keys(), ...asIsByZip.keys()]);

  for (const zip of [...zips].sort()) {
    const arv = arvByZip.get(zip) ?? [];
    const asIs = asIsByZip.get(zip) ?? [];
    const asIsPsf = median(asIs.map((c) => c.psf));

    // Per-column fiction gate, on the ARV band's own prices.
    const shaped = arv.filter((c) => isTransactionShapedPrice(c.price)).length;
    const share = arv.length > 0 ? shaped / arv.length : null;
    const testable = arv.length >= SEED_QUALITY_MIN_COMPS;
    const failsShape = testable && (share as number) < SEED_QUALITY_MIN_TRANSACTION_SHARE;

    const renovated = median(arv.map((c) => c.psf));
    const low = percentile(arv.map((c) => c.psf), 0.25);

    let dontPrice = false;
    let reason = "";
    if (arv.length === 0) {
      dontPrice = true;
      reason = "no renovated (Good/Excellent) comps in this ZIP — cannot set an after-repair value";
    } else if (failsShape) {
      dontPrice = true;
      reason = `renovated comps are model-shaped (${((share as number) * 100).toFixed(0)}% transaction-shaped over ${arv.length} comps, floor ${(SEED_QUALITY_MIN_TRANSACTION_SHARE * 100).toFixed(0)}%)`;
    } else if (!renovated || renovated <= 0) {
      dontPrice = true;
      reason = "renovated psf did not compute";
    } else {
      reason = testable
        ? `${arv.length} renovated comps, ${((share as number) * 100).toFixed(0)}% transaction-shaped`
        : `${arv.length} renovated comps (below the ${SEED_QUALITY_MIN_COMPS}-comp shape-test floor — priced, not shape-tested)`;
    }

    reports.push({
      zip,
      arvCompCount: arv.length,
      asIsCompCount: asIs.length,
      renovatedPerSqft: dontPrice ? null : renovated,
      arvLowPerSqft: dontPrice ? null : low,
      asIsPerSqft: asIsPsf,
      transactionShare: share,
      dontPrice,
      reason,
    });

    if (dontPrice) {
      totals.zipsDontPrice++;
      seeds.push({
        zip,
        compCount: arv.length,
        source: "propstream_mls_sold",
        market: opts.market ?? null,
        state: stateByZip.get(zip) ?? null,
        fetchedAt: opts.fetchedAt,
        dontPrice: true,
        receiptsJson: JSON.stringify({
          comps: [],
          filter_quality: "dont_price",
          reason,
          as_is_psf_median: asIsPsf,
          as_is_comp_count: asIs.length,
        }),
      });
      continue;
    }

    totals.zipsPriceable++;
    seeds.push({
      zip,
      renovatedPerSqft: renovated as number,
      arvLowPerSqft: low,
      compCount: arv.length,
      source: "propstream_mls_sold",
      market: opts.market ?? null,
      state: stateByZip.get(zip) ?? null,
      fetchedAt: opts.fetchedAt,
      // Receipts carry the raw comps so the #194 measured-slope ladder can
      // fit this ZIP's own psf-vs-sqft curve instead of falling to flat psf.
      receiptsJson: JSON.stringify({
        comps: arv.map((c) => ({ price: c.price, sqft: c.sqft })),
        filter_quality: "clean",
        transaction_share: share,
        as_is_psf_median: asIsPsf,
        as_is_comp_count: asIs.length,
        price_column: "mls_amount_sold",
      }),
    });
  }

  return { seeds, reports, totals };
}
