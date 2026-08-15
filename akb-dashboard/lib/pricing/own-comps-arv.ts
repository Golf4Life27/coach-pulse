// OWN-COMPS ARV — the record's own sold comps become the PRIMARY value basis.
// @agent: appraiser
//
// OPERATOR RULING (2026-08-14, verbatim): "I am wondering why in the hell a
// properties, OWN COMPS, wouldn't have been used in the first place."
//
// THE HISTORY THAT MADE THIS BUG (git archaeology, 2026-08-14 workflow).
// ARV_Comp_Details_JSON was created 2026-05-18 as a PROVENANCE receipt for the
// deal-room UI — "operator must be able to verify any comp in one click" —
// never as a pricer input. When the stored Real_ARV_Median went bad on part of
// the cohort (as-is values in a renovated-ARV field; a fifth of the full-437
// dry-run showed ARV < list), the 2026-06-14 source-swap demoted the stored
// FIELD globally in favor of ZIP seeds. Correct doctrine — "fields are
// history, not authority" — wrong scope: it threw out the EVIDENCE with the
// field. No commit between 5/18 and 8/14 ever read the comps as valuation
// input; the first consumer of any kind was the read-only audit (04661a3).
//
// Both August failures are one lesson from opposite directions:
//   1708 Cardinal — ZIP seed built 10/12 from NEIGHBOR ZIPs priced $63k, then
//     $100k; the record's own 30 comps (all 46227, ≤0.88mi, median $183.47)
//     support ~$121k. Seller: "your numbers are wrong in that area." He was
//     right — the comps were literally not from his area.
//   9360 Cheyenne — stored field $107.81/sqft on top of 44 own comps whose
//     median is ~$55; the displayed $34,840 spread was fiction.
//
// THE RULE. Hierarchy: own_comps → seed → stored → HOLD. The record's own
// comps are the closest evidence the system owns; the ZIP seed is the fallback
// for records without usable ones; the stored field stays last. We recompute
// from evidence, never trust a stored claim. Zero vendor calls — these comps
// are already bought and stored.
//
// ADVERSARIAL REVIEW (2026-08-14 workflow, verdict "unsafe" on the naive
// draft) — every rail below exists because the review found the hole:
//   · EXCLUDED-COMPS POISONING: on an honest-empty compute, arv-write.ts
//     persists comps_excluded into this SAME field (so the deal room shows why
//     there is no number). Entries carrying excluded_reason are documented
//     junk — subject's own listing, no recorded sale, wrong beds — and are
//     dropped before anything is counted.
//   · SUBJECT SELF-SALE: RentCast pulls include the subject's own print at
//     distance ≈ 0 (1122 West Ave priced itself off its own ask; Cheyenne's
//     array carries the subject's impeached $64k print at 0.021mi). Comps
//     within SELF_DISTANCE_MI are dropped.
//   · DOUBLE-RECORDED DEEDS + PORTFOLIO DEEDS: stale arrays predate the
//     compute-time dedupes (2431 Parker double deed; 2106 Parkdale $840k
//     portfolio deed as 3 "comps" pushing a ~$102k house toward $740k). Both
//     dedupe rules re-run here at READ time.
//   · AVM-PRICED ARRAYS: model estimates stored as comps (Dallas 75216
//     $423,272-class) fail the transaction-shape test and the record falls
//     back to the seed. Same quarantine the ZIP seeds get, applied per record.
//   · AS-IS vs RENOVATED BIAS: a mixed-condition median UNDERSTATES renovated
//     value, which fails conservative — except through the over-ARV-list
//     amendment, where a wrong-basis "STRONG" would send lowballs
//     autonomously. So the pricer treats this basis as THIN (holds on
//     ARV < list) until a shadow cohort earns STRONG. See opener-pricing.
//
// KNOWN LIMITS (accepted, documented): array age is bounded only via sale
// recency (no fetch-timestamp gate yet); bimodal sets are not cluster-split —
// the pessimistic median plus THIN posture makes that fail conservative.

import { sizeAdjustedPsf } from "@/lib/pricing/size-adjusted-psf";
import { assessSeedPriceShape } from "@/lib/pricing/seed-quality";
import { normalizeStreetLine } from "@/lib/arv-intelligence";

/** Minimum usable comps before the record can self-price. Below this a single
 *  odd print owns the median; the ZIP seed (more data, less local) is the
 *  safer basis. Matches MIN_COMPS_FOR_CHECK in arv-vs-own-comps. */
export const OWN_COMPS_MIN = 5;

/** ≥ this many usable comps → the RESULT is labeled STRONG (data-quality
 *  signal for reports). The pricer still treats the basis as THIN — see the
 *  as-is/renovated note above. */
export const OWN_COMPS_STRONG_COUNT = 8;

/** Comps farther than this are a different pocket, not this block. */
export const OWN_COMPS_MAX_DISTANCE_MI = 1.25;

/** Sales older than this are a different market. 18 months. */
export const OWN_COMPS_MAX_AGE_DAYS = 548;

/** A "comp" this close is the subject itself (RentCast includes the subject's
 *  own print at distance ≈ 0; nearest legit neighbor observed at 0.041mi). */
export const SELF_DISTANCE_MI = 0.03;

/** Two entries with the same dedupe signature inside this window are one
 *  conveyance, not two sales (mirrors DEED_DUP_WINDOW_DAYS). */
const DUP_WINDOW_DAYS = 30;

interface RawComp {
  price?: unknown;
  sqft?: unknown;
  squareFootage?: unknown;
  per_sqft?: unknown;
  distance?: unknown;
  sale_date?: unknown;
  saleDate?: unknown;
  formatted_address?: unknown;
  formattedAddress?: unknown;
  excluded_reason?: unknown;
  comp?: unknown;
}

export interface OwnComp {
  price: number;
  sqft: number;
  psf: number;
  distance: number | null;
  saleDate: string | null;
  address: string | null;
}

export interface OwnCompsArvResult {
  ok: boolean;
  arv: number | null;
  /** $/sqft actually applied (size-fit when the comps support one, else median). */
  psf: number | null;
  psfSource: "size_fit" | "median" | null;
  compCount: number;
  /** Data-quality label for reports; the PRICER treats own_comps as THIN
   *  regardless until the renovated-cluster upgrade lands. */
  confidence: "STRONG" | "THIN" | null;
  reason: string | null;
  /** The usable comps in seed-receipts shape ({comps:[…]}), so the
   *  corroboration gate's size-band / price-shape rails parse and audit the
   *  SAME evidence that produced the ARV. */
  receiptsJson: string | null;
  usable: OwnComp[];
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function withinDays(a: string | null, b: string | null, days: number): boolean {
  if (!a || !b) return true; // undatable pair → treat as the same conveyance (conservative)
  const ta = Date.parse(a), tb = Date.parse(b);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return true;
  return Math.abs(ta - tb) / 86_400_000 <= days;
}

/** Pure: parse + filter a record's ARV_Comp_Details_JSON down to comps worth
 *  pricing from. Accepts both the bare-array shape the appraiser writes and a
 *  {comps:[…]} wrapper; drops exclusion receipts, the subject's own print,
 *  double-recorded deeds, and portfolio-deed signatures. */
export function parseOwnComps(
  raw: string | null | undefined,
  now: Date = new Date(),
): OwnComp[] {
  if (!raw || typeof raw !== "string") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const arr: unknown[] = Array.isArray(parsed)
    ? parsed
    : typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { comps?: unknown }).comps)
      ? ((parsed as { comps: unknown[] }).comps)
      : [];

  const candidates: OwnComp[] = [];
  for (const entry of arr) {
    if (typeof entry !== "object" || entry === null) continue;
    let c = entry as RawComp;
    // EXCLUSION RECEIPTS are documented junk, not comps — the honest-empty
    // write stores them in this same field. Both observed wrapper shapes.
    if (c.excluded_reason != null) continue;
    if (typeof c.comp === "object" && c.comp !== null) {
      if ((c as { excluded_reason?: unknown }).excluded_reason != null) continue;
      c = c.comp as RawComp;
      if (c.excluded_reason != null) continue;
    }

    const price = num(c.price);
    const sqft = num(c.sqft) ?? num(c.squareFootage);
    if (price == null || sqft == null) continue;

    const distance = typeof c.distance === "number" && Number.isFinite(c.distance) ? c.distance : null;
    if (distance != null && distance > OWN_COMPS_MAX_DISTANCE_MI) continue;
    // The subject is never its own comp.
    if (distance != null && distance <= SELF_DISTANCE_MI) continue;

    const saleDate = str(c.sale_date) ?? str(c.saleDate);
    if (saleDate) {
      const t = Date.parse(saleDate);
      if (Number.isFinite(t) && (now.getTime() - t) / 86_400_000 > OWN_COMPS_MAX_AGE_DAYS) continue;
    }

    const address = str(c.formatted_address) ?? str(c.formattedAddress);
    candidates.push({ price, sqft, psf: price / sqft, distance, saleDate, address });
  }

  // Newest first so both dedupe passes keep the latest recording, mirroring
  // the compute-time versions in lib/arv-intelligence.
  candidates.sort((a, b) => (b.saleDate ?? "").localeCompare(a.saleDate ?? ""));

  // DOUBLE-RECORDED DEED: same street line + same price, dates within the
  // window → one sale (2431 Parker class).
  const byStreetPrice = new Map<string, OwnComp>();
  // PORTFOLIO DEED: same price + same sqft-to-the-foot, dates within the
  // window, across DIFFERENT addresses → one conveyance stamped on multiple
  // parcels (2106 Parkdale class).
  const bySignature = new Map<string, OwnComp>();

  const out: OwnComp[] = [];
  for (const c of candidates) {
    const streetKey = c.address != null ? `${normalizeStreetLine(c.address)}|${c.price}` : null;
    if (streetKey) {
      const prior = byStreetPrice.get(streetKey);
      if (prior && withinDays(prior.saleDate, c.saleDate, DUP_WINDOW_DAYS)) continue;
    }
    const sigKey = `${c.price}|${c.sqft}`;
    const priorSig = bySignature.get(sigKey);
    if (priorSig && withinDays(priorSig.saleDate, c.saleDate, DUP_WINDOW_DAYS)) continue;

    if (streetKey) byStreetPrice.set(streetKey, c);
    bySignature.set(sigKey, c);
    out.push(c);
  }
  return out;
}

/** Pure: the ARV this record's own comps support, or the reason they can't.
 *  Same size ladder the seed path uses (measured slope, clamped to the
 *  observed psf range, median fallback). */
export function ownCompsArv(input: {
  compsJson?: string | null;
  sqft?: number | null;
  now?: Date;
}): OwnCompsArvResult {
  const fail = (reason: string, compCount = 0): OwnCompsArvResult => ({
    ok: false, arv: null, psf: null, psfSource: null, compCount,
    confidence: null, reason, receiptsJson: null, usable: [],
  });

  const sqft = num(input.sqft);
  if (sqft == null) return fail("no_subject_sqft");

  const usable = parseOwnComps(input.compsJson, input.now ?? new Date());
  if (usable.length < OWN_COMPS_MIN) {
    return fail(`too_few_own_comps (${usable.length} < ${OWN_COMPS_MIN})`, usable.length);
  }

  const receiptsJson = JSON.stringify({
    method: "own_comps",
    comps: usable.map((c) => ({
      addr: c.address ?? undefined,
      price: c.price,
      sqft: c.sqft,
      psf: Math.round(c.psf * 100) / 100,
    })),
  });

  // AVM-PRICED ARRAY → not evidence. Same transaction-shape quarantine the
  // ZIP seeds get (Dallas 75216 class), applied to this record's array.
  const shape = assessSeedPriceShape(receiptsJson);
  if (shape.verdict === "avm_priced") {
    return fail(`avm_priced_own_comps (${shape.detail})`, usable.length);
  }

  const psfs = usable.map((c) => c.psf).sort((a, b) => a - b);
  const med = median(psfs);

  const fit = sizeAdjustedPsf({
    comps: usable.map((c) => ({ sqft: c.sqft, psf: c.psf })),
    subjectSqft: sqft,
    seedMedianPsf: med,
  });
  const psf = fit.source === "size_fit" && fit.psf != null ? fit.psf : med;
  const psfSource: "size_fit" | "median" = fit.source === "size_fit" && fit.psf != null ? "size_fit" : "median";

  return {
    ok: true,
    arv: Math.round(psf * sqft),
    psf,
    psfSource,
    compCount: usable.length,
    confidence: usable.length >= OWN_COMPS_STRONG_COUNT ? "STRONG" : "THIN",
    reason: null,
    receiptsJson,
    usable,
  };
}
