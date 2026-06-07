// Pessimistic-bound rehab MAO + rehab-scope → ARV-tier guard.
// @agent: orchestrator
//
// THE PROBLEM: median rehab is the central estimate; underwriting from
// the median ignores rehab upside risk (the band's HIGH end). On
// Strathmoor that's $48,664 vs $37,434 — an $11k swing on $/sqft inputs
// that themselves have ±15% noise. Compounding optimistic ARV + optimistic
// rehab is exactly how a marginal deal flips to a losing deal.
//
// THIS LIB (pure, no I/O):
//
//   computePessimisticMao — MAO computed from the CONSERVATIVE ARV anchor
//     AND the HIGH end of the rehab band. The "what if everything goes
//     bad" floor. If THIS clears the sticky floor → deal is robust. If
//     it doesn't → escalate, never auto-pass.
//
//   classifyRehabTier — maps a rehab scope (vision conf + band width +
//     condition narrative) into an ARV tier: as_is | light_retail |
//     full_retail. Heavy scope (gut/incomplete bath/wiring exposed)
//     prevents pricing against full retail ARV; the deal can only
//     underwrite to a discounted tier. Surfaced for the dossier.

import { getWholesaleFeeDefault } from "./registry";

export interface PessimisticMaoInputs {
  /** Conservative ARV anchor (nearest-weighted P25, or operator CMA). */
  conservativeArv: number | null | undefined;
  /** HIGH end of the rehab band (vision median × upper multiplier). */
  rehabHigh: number | null | undefined;
  /** Market ARV%Max (e.g. 0.6461 for Detroit). */
  arvPctMax: number;
  /** Wholesale fee override; defaults to registry wholesale_fee_default. */
  wholesaleFee?: number;
  /** Sticky floor the operator set for the deal (e.g. $52,000 for 12724
   *  Strathmoor). Pessimistic MAO must clear this. */
  stickyFloor?: number | null;
}

export type PessimisticVerdict = "robust" | "marginal" | "fails_floor" | "hold";

export interface PessimisticMaoResult {
  pessimisticMao: number | null;
  verdict: PessimisticVerdict;
  /** Excess over stickyFloor (negative when below). null when stickyFloor
   *  not provided. */
  marginOverFloor: number | null;
  reason: string;
}

/** Pure: pessimistic MAO = conservativeARV × ARV%Max − rehabHIGH − fee. */
export function computePessimisticMao(input: PessimisticMaoInputs): PessimisticMaoResult {
  const arv = typeof input.conservativeArv === "number" && Number.isFinite(input.conservativeArv) && input.conservativeArv > 0
    ? input.conservativeArv : null;
  const rehab = typeof input.rehabHigh === "number" && Number.isFinite(input.rehabHigh) && input.rehabHigh >= 0
    ? input.rehabHigh : null;
  const fee = typeof input.wholesaleFee === "number" && Number.isFinite(input.wholesaleFee) && input.wholesaleFee >= 0
    ? input.wholesaleFee : getWholesaleFeeDefault();
  const floor = typeof input.stickyFloor === "number" && Number.isFinite(input.stickyFloor) ? input.stickyFloor : null;

  if (arv == null || rehab == null) {
    return {
      pessimisticMao: null,
      verdict: "hold",
      marginOverFloor: null,
      reason: `HOLD — missing input(s): ${[arv == null && "conservativeArv", rehab == null && "rehabHigh"].filter(Boolean).join(", ")}`,
    };
  }

  const mao = Math.round(arv * input.arvPctMax - rehab - fee);
  let verdict: PessimisticVerdict;
  let margin: number | null = null;
  if (floor != null) {
    margin = mao - floor;
    if (margin >= 0.10 * floor) verdict = "robust";
    else if (margin >= 0) verdict = "marginal";
    else verdict = "fails_floor";
  } else {
    verdict = mao > 0 ? "robust" : "fails_floor";
  }
  return {
    pessimisticMao: mao,
    verdict,
    marginOverFloor: margin,
    reason: `pessimistic MAO $${mao.toLocaleString()} = ARV $${arv.toLocaleString()} × ${(input.arvPctMax * 100).toFixed(2)}% − rehab $${rehab.toLocaleString()} (HIGH band) − fee $${fee.toLocaleString()}${floor != null ? `; margin over sticky floor $${floor.toLocaleString()} = $${(margin as number).toLocaleString()}` : ""}`,
  };
}

// ── Rehab scope → ARV tier classifier ─────────────────────────────────
// Vision returns Condition + line items + confidence. Some scopes lock
// the deal out of full-retail ARV pricing:
//   • exposed wiring, unfinished bathroom, gut conditions → AS-IS pricing
//     (because a renovated comp's renovated state is unreachable without
//     significant uncertainty / overruns)
//   • Average/Fair without structural issues → LIGHT_RETAIL
//   • Good/Renovated → FULL_RETAIL

export type ArvTier = "as_is" | "light_retail" | "full_retail" | "unknown";

export interface ScopeClassifierInputs {
  /** Vision condition label (Good | Average | Fair | Poor | Disrepair). */
  visionCondition?: string | null;
  /** Confidence percent (0-100). */
  visionConfidence?: number | null;
  /** Free-text scope notes (line-item summary). The classifier scans for
   *  hard-stop phrases (exposed wiring / incomplete bathroom / gut). */
  scopeText?: string | null;
}

export interface ScopeClassifierResult {
  tier: ArvTier;
  hardStops: string[];
  reason: string;
}

const HARD_STOP_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /exposed\s+wiring/i, label: "exposed wiring" },
  { re: /incomplete\s+(bath|kitchen)|unfinished\s+(bath|kitchen)|mid[- ]renovation/i, label: "incomplete bath/kitchen / mid-renovation" },
  { re: /gut\s+rehab|stripped\s+to\s+studs/i, label: "gut/strip-to-studs" },
  { re: /knob[- ]and[- ]tube|knob\s+and\s+tube/i, label: "knob-and-tube wiring" },
  { re: /collapsed|severely\s+deteriorat|foundation\s+(crack|issue)/i, label: "structural deterioration" },
];

export function classifyRehabTier(input: ScopeClassifierInputs): ScopeClassifierResult {
  const cond = (input.visionCondition ?? "").toLowerCase().trim();
  const text = input.scopeText ?? "";
  const conf = typeof input.visionConfidence === "number" ? input.visionConfidence : null;

  const hardStops: string[] = [];
  for (const { re, label } of HARD_STOP_PATTERNS) {
    if (re.test(text)) hardStops.push(label);
  }

  // Any hard-stop OR Poor/Disrepair → as-is pricing.
  if (hardStops.length > 0 || cond === "poor" || cond === "disrepair") {
    return {
      tier: "as_is",
      hardStops,
      reason: hardStops.length > 0
        ? `as-is tier — hard-stop scope: ${hardStops.join("; ")}`
        : `as-is tier — vision condition: ${cond}`,
    };
  }
  if (cond === "fair" || cond === "average" || (conf != null && conf < 70)) {
    return {
      tier: "light_retail",
      hardStops: [],
      reason: `light_retail tier — vision condition: ${cond || "n/a"}${conf != null ? ` (conf ${conf})` : ""}`,
    };
  }
  if (cond === "good" || cond === "renovated") {
    return {
      tier: "full_retail",
      hardStops: [],
      reason: `full_retail tier — vision condition: ${cond}`,
    };
  }
  return {
    tier: "unknown",
    hardStops: [],
    reason: `tier unknown — vision condition: ${cond || "missing"}`,
  };
}
