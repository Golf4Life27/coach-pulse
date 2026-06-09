// Phase A γ-path — Buyer_Median manual-input validation (pure).
//
// HARD RULE (operator, 2026-06-08): Buyer_Median values come ONLY from
// InvestorBase exports, manually entered. The input MUST require the
// source stamp + the export date and MUST reject an unsourced number.
// This validator is the single chokepoint that enforces it — the write
// route refuses anything this rejects, so an unstamped value can never
// reach Property_Intel.Buyer_Median_Value.
//
// The α path (an automated InvestorBase scraper) is SPEC'd separately
// (docs/specs/InvestorBase_Scraper_Alpha_Spec.md) and is a separate go
// decision; when it ships it writes source="investorbase" (auto). This
// manual path is source="investorbase_manual" — distinct provenance so
// the two are never conflated in the audit trail.

/** The ONLY accepted source for a manually-entered Buyer_Median. Not
 *  "manual_operator" (that's an unsourced guess) and not "investorbase"
 *  (that's the auto-scraper). A value with any other source is refused. */
export const BUYER_MEDIAN_ALLOWED_SOURCE = "investorbase_manual" as const;

/** Sanity bound — a cash-buyer median above this is almost certainly a
 *  fat-finger (e.g. cents entered as dollars, or a total-portfolio figure). */
export const BUYER_MEDIAN_MAX = 5_000_000;

/** Which buyer track a median represents. The pool is BIMODAL (operator
 *  2026-06-09, Detroit 48227: flippers median ~$150k, landlords ~$55k), so a
 *  Buyer_Median is meaningless without its track — a blended number averages
 *  two different buyer economics and is REFUSED. */
export type BuyerTrack = "flipper" | "landlord";
export const BUYER_TRACKS: readonly BuyerTrack[] = ["flipper", "landlord"] as const;

/** Tokens that signal a blended / mixed number — explicitly refused so a
 *  two-population average can never be stored as a single median. */
const BLENDED_TRACK_TOKENS = new Set(["blended", "blend", "both", "mixed", "combined", "all", "average", "avg", "overall"]);

export interface BuyerMedianValidated {
  value: number;
  source: typeof BUYER_MEDIAN_ALLOWED_SOURCE;
  /** Which buyer track this value represents — never blended. */
  track: BuyerTrack;
  /** ISO date of the InvestorBase export the value was read from. */
  exportDate: string;
  sampleSize: number | null;
}

export type BuyerMedianValidation =
  | { ok: true; data: BuyerMedianValidated }
  | { ok: false; error: string };

function coerceNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v.replace(/[$,\s]/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Validate a raw manual Buyer_Median submission. Pure; no I/O.
 *  Rejects (never throws) on any rule violation with a specific message. */
export function validateBuyerMedianInput(
  raw: { value?: unknown; source?: unknown; track?: unknown; exportDate?: unknown; sampleSize?: unknown },
  now: Date = new Date(),
): BuyerMedianValidation {
  // 1. Source stamp — THE hard rule. Must be present and exactly the
  //    InvestorBase-manual source. Empty / wrong source → refuse.
  if (raw.source == null || raw.source === "") {
    return { ok: false, error: "source_required: Buyer_Median must be stamped — unsourced numbers are refused" };
  }
  if (raw.source !== BUYER_MEDIAN_ALLOWED_SOURCE) {
    return {
      ok: false,
      error: `source_invalid: only "${BUYER_MEDIAN_ALLOWED_SOURCE}" is accepted (got "${String(raw.source)}") — values come only from InvestorBase exports`,
    };
  }

  // 1b. Track — THE bimodal-pool hard rule. Must be exactly "flipper" or
  //     "landlord". A blended / mixed / averaged number is REFUSED: the
  //     flipper and landlord pools have different economics and a single
  //     median across both is meaningless.
  if (raw.track == null || raw.track === "") {
    return { ok: false, error: "track_required: Buyer_Median must declare its buyer track (\"flipper\" or \"landlord\") — the pool is bimodal" };
  }
  const trackStr = String(raw.track).trim().toLowerCase();
  if (BLENDED_TRACK_TOKENS.has(trackStr)) {
    return { ok: false, error: `track_blended: a blended/averaged Buyer_Median is refused (got "${String(raw.track)}") — enter the flipper and landlord medians separately` };
  }
  if (trackStr !== "flipper" && trackStr !== "landlord") {
    return { ok: false, error: `track_invalid: track must be "flipper" or "landlord" (got "${String(raw.track)}")` };
  }
  const track = trackStr as BuyerTrack;

  // 2. Export date — required, parseable, not in the future.
  if (raw.exportDate == null || raw.exportDate === "") {
    return { ok: false, error: "export_date_required: the InvestorBase export date must accompany the value" };
  }
  const t = Date.parse(String(raw.exportDate));
  if (!Number.isFinite(t)) {
    return { ok: false, error: `export_date_invalid: "${String(raw.exportDate)}" is not a parseable date` };
  }
  if (t > now.getTime()) {
    return { ok: false, error: "export_date_future: the export date cannot be in the future" };
  }

  // 3. Value — required, positive, within sanity bound.
  const value = coerceNumber(raw.value);
  if (value == null) {
    return { ok: false, error: "value_required: a numeric Buyer_Median is required" };
  }
  if (value <= 0) {
    return { ok: false, error: "value_nonpositive: Buyer_Median must be greater than 0" };
  }
  if (value > BUYER_MEDIAN_MAX) {
    return { ok: false, error: `value_out_of_range: ${value} exceeds the $${BUYER_MEDIAN_MAX.toLocaleString()} sanity bound` };
  }

  // 4. Sample size — optional; if present must be a positive integer.
  let sampleSize: number | null = null;
  if (raw.sampleSize != null && raw.sampleSize !== "") {
    const ss = coerceNumber(raw.sampleSize);
    if (ss == null || ss < 1 || !Number.isInteger(ss)) {
      return { ok: false, error: "sample_size_invalid: when provided, sample size must be a positive integer" };
    }
    sampleSize = ss;
  }

  return {
    ok: true,
    data: {
      value,
      source: BUYER_MEDIAN_ALLOWED_SOURCE,
      track,
      exportDate: new Date(t).toISOString(),
      sampleSize,
    },
  };
}

// ── Track defaulting + track-aware MAO ────────────────────────────────

/** Pure: the default buyer track for a listing's cohort. The DISTRESSED
 *  AS-IS cohort defaults to LANDLORD (operator 2026-06-09) — those houses
 *  trade to buy-and-hold investors at the as-is landlord median, not the
 *  renovated-resale flipper median. Everything else defaults to flipper. */
export function defaultBuyerTrack(input: {
  /** Rehab scope tier (lib/markets/pessimistic-mao.classifyRehabTier). */
  arvTier?: "as_is" | "light_retail" | "full_retail" | "unknown" | null;
  /** Vision condition label, if no tier. */
  condition?: string | null;
  /** Any explicit distress signal (keyword/score). */
  distressed?: boolean | null;
}): BuyerTrack {
  const cond = (input.condition ?? "").toLowerCase();
  const asIs =
    input.arvTier === "as_is" ||
    /poor|disrepair|water[_ ]?damage|fire|gut|tear[- ]?down|shell/.test(cond);
  if (asIs || input.distressed === true) return "landlord";
  return "flipper";
}

export interface TrackAwareMao {
  track: BuyerTrack;
  /** Investor_MAO — the cash buyer's max. Flipper: median is a RENOVATED-
   *  resale basis, so rehab is subtracted. Landlord: the as-is median is
   *  ALREADY a purchase price for the as-is condition, so the flip rehab is
   *  NOT subtracted again (that would double-count). */
  investorMao: number | null;
  /** Your_MAO = Investor_MAO − Wholesale_Fee. */
  yourMao: number | null;
  wholesaleFeeUsed: number;
  formula: string;
}

/** Pure: track-aware Buyer_Median → MAO. The track decides whether the flip
 *  rehab is subtracted (flipper: yes; landlord as-is: no). Never blends. */
export function computeTrackAwareMao(input: {
  track: BuyerTrack;
  buyerMedian: number | null | undefined;
  estRehab: number | null | undefined;
  wholesaleFee?: number | null | undefined;
}): TrackAwareMao {
  const DEFAULT_FEE = 5_000;
  const fee =
    typeof input.wholesaleFee === "number" && Number.isFinite(input.wholesaleFee) && input.wholesaleFee >= 0
      ? input.wholesaleFee
      : DEFAULT_FEE;
  const bm =
    typeof input.buyerMedian === "number" && Number.isFinite(input.buyerMedian) && input.buyerMedian > 0
      ? input.buyerMedian
      : null;
  if (bm == null) {
    return { track: input.track, investorMao: null, yourMao: null, wholesaleFeeUsed: fee, formula: "HOLD — Buyer_Median missing" };
  }

  if (input.track === "flipper") {
    const rehab =
      typeof input.estRehab === "number" && Number.isFinite(input.estRehab) && input.estRehab >= 0
        ? input.estRehab
        : null;
    if (rehab == null) {
      return { track: input.track, investorMao: null, yourMao: null, wholesaleFeeUsed: fee, formula: "HOLD — flipper track needs Est_Rehab (renovated-resale basis)" };
    }
    const investorMao = Math.round(bm - rehab);
    const yourMao = Math.round(investorMao - fee);
    return {
      track: input.track,
      investorMao,
      yourMao,
      wholesaleFeeUsed: fee,
      formula: `flipper: Investor_MAO = Buyer_Median $${bm.toLocaleString()} − Est_Rehab $${rehab.toLocaleString()} = $${investorMao.toLocaleString()}; Your_MAO = − fee $${fee.toLocaleString()} = $${yourMao.toLocaleString()}`,
    };
  }

  // landlord (as-is): the median IS the buyer's as-is purchase price, so the
  // flip rehab is NOT subtracted. Your_MAO = median − wholesale fee.
  const investorMao = Math.round(bm);
  const yourMao = Math.round(bm - fee);
  return {
    track: input.track,
    investorMao,
    yourMao,
    wholesaleFeeUsed: fee,
    formula: `landlord (as-is): Investor_MAO = Buyer_Median $${bm.toLocaleString()} (as-is purchase price, flip rehab NOT subtracted); Your_MAO = − fee $${fee.toLocaleString()} = $${yourMao.toLocaleString()}`,
  };
}
