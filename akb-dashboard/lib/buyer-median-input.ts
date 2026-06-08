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

export interface BuyerMedianValidated {
  value: number;
  source: typeof BUYER_MEDIAN_ALLOWED_SOURCE;
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
  raw: { value?: unknown; source?: unknown; exportDate?: unknown; sampleSize?: unknown },
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
      exportDate: new Date(t).toISOString(),
      sampleSize,
    },
  };
}
