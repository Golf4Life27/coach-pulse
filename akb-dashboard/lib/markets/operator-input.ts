// Operator/CMA input-integrity guard — pure, no I/O.
// @agent: orchestrator
//
// THE RULE (operator brief 2026-06-07, test-pinned at ingestion):
//   "CMA/operator inputs are operator-supplied figures verbatim or
//    rejected — prose never converts to numbers."
//
// THE INCIDENT it defends against: Dossier #002's cma_rehab_high=$22,000
// was "supplied by no one" — a figure that leaked in from prose (a prior
// dossier render said "rehab $16k mid / $22k high photo-informed") and was
// passed as if it were an operator-attested override. The bare
// parseInt()/parseFloat() ingestion happily coerced loose tokens into
// numbers ("22k" → 22, "$22,000 photo-informed" → 22), so prose became a
// number that then overrode the vision-derived bound.
//
// THE DEFENSE: a CMA numeric override is accepted ONLY when the raw token
// is a clean, verbatim operator figure — a bare integer/decimal, optionally
// with a leading "$" and well-formed thousands commas. ANYTHING else
// (embedded words, "k"/"m" shorthand, malformed grouping, ranges, prose) is
// REJECTED, not coerced. A rejected override is treated as NOT SUPPLIED and
// surfaced loudly — it never silently becomes a number in the verdict math.

export type OperatorFigureKind = "int" | "float";

export interface OperatorFigureResult {
  /** True when the field was either cleanly parsed or simply absent. False only on a REJECTED (prose-like) token. */
  ok: boolean;
  /** The parsed number, or null when absent/rejected. Never a coerced partial. */
  value: number | null;
  /** The verbatim raw token as supplied (trimmed), or null when absent. */
  raw: string | null;
  /** True when the caller actually supplied a (non-empty) token. */
  supplied: boolean;
  /** Human-readable rejection reason; null when ok. */
  reason: string | null;
}

const INT_RE = /^\d+$/;
const FLOAT_RE = /^\d+(\.\d+)?$/;
// Well-formed thousands grouping: 1; 12; 123; 1,234; 12,345; 123,456; 1,234,567 …
const GROUPED_RE = /^\d{1,3}(,\d{3})+(\.\d+)?$/;

/**
 * Strict verbatim-numeric parse for an operator/CMA override.
 *
 * Accepts: "22000", "$22,000", "22,000", " 132675 ", "$132,675",
 *          and (float kind) "87.5", "$93.25".
 * Rejects: "22k", "$22,000 photo-informed", "$16k mid / $22k high",
 *          "twenty-two thousand", "1,23,456" (bad grouping), "-5000",
 *          "1e5", "22000.5" (int kind).
 *
 * Absent input (null/undefined/""/whitespace) is NOT an error — it returns
 * ok:true, supplied:false, value:null (the field simply wasn't provided).
 */
export function parseOperatorFigure(
  rawIn: string | null | undefined,
  kind: OperatorFigureKind = "int",
): OperatorFigureResult {
  if (rawIn == null) return { ok: true, value: null, raw: null, supplied: false, reason: null };
  const raw = rawIn.trim();
  if (raw === "") return { ok: true, value: null, raw: null, supplied: false, reason: null };

  // Strip a single optional leading "$" — the only currency adornment we honor.
  let body = raw.startsWith("$") ? raw.slice(1).trim() : raw;

  // Resolve thousands commas: allowed ONLY in well-formed groups; otherwise reject.
  if (body.includes(",")) {
    if (!GROUPED_RE.test(body)) {
      return { ok: false, value: null, raw, supplied: true, reason: `not a verbatim number — malformed/ungrouped commas in "${raw}" (prose is never coerced)` };
    }
    body = body.replace(/,/g, "");
  }

  const re = kind === "int" ? INT_RE : FLOAT_RE;
  if (!re.test(body)) {
    return { ok: false, value: null, raw, supplied: true, reason: `not a verbatim ${kind} — "${raw}" contains non-numeric content (prose is never coerced)` };
  }

  const value = kind === "int" ? parseInt(body, 10) : parseFloat(body);
  if (!Number.isFinite(value)) {
    return { ok: false, value: null, raw, supplied: true, reason: `unparseable numeric "${raw}"` };
  }
  return { ok: true, value, raw, supplied: true, reason: null };
}
