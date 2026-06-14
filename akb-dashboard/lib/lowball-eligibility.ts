// Lowball-eligibility front gate (spine recMmNxLqT7z44p1M). @agent: crier
//
// Decides WHO receives the aggressive 65%-style opener — runs BEFORE any
// opener is priced or sent. This is the target-selection doctrine, kept
// pure and separate from the pricing math (lib/per-market-pricer).
//
// THE DOCTRINE (Maverick 2026-06-14, national-crawler build):
//   TIME-ON-MARKET DECIDES. Cumulative, relist-aware DOM ≥ 60 days is hard,
//   reliable data — it makes a record eligible ALONE, no vision needed.
//   VISION ONLY ADDS. A condition read can promote an UNDER-60 record to
//   eligible, but ONLY when the listing LANGUAGE and the VISUAL read AGREE
//   (both signals, strongly corroborated). Vision NEVER subtracts, NEVER
//   creates a target on a lone flag. Uncertainty errs toward NOT sending.
//   (Vision hallucinated water_damage on a renovated house 2026-06-13 — it
//   cannot be the decider; corroboration is the floor.)
//
// Pure. No I/O. The caller maps the two distress signals from the Firecrawl
// verify (listing-language keywords) and the rehab-vision condition read,
// and the DOM from lib/attom/cumulative-dom.resolveCumulativeDom.

/** Cumulative DOM at/above this is eligible on its own — the reliable,
 *  relist-aware time-on-market signal. Env-tunable (never below 30). */
export const LOWBALL_DOM_THRESHOLD_DAYS = (() => {
  const raw = Number(process.env.LOWBALL_DOM_THRESHOLD_DAYS);
  return Number.isFinite(raw) && raw >= 30 ? Math.floor(raw) : 60;
})();

export type LowballTier =
  | "dom_ge_threshold"        // ≥60d cumulative — decides alone
  | "distress_corroborated"   // <60d but language + vision AGREE
  | "not_eligible_clean"      // <60d, no corroborated distress
  | "not_eligible_unsure";    // <60d, partial/uncorroborated signal only

export interface LowballEligibilityInput {
  /** Cumulative, relist-aware DOM (lib/attom/cumulative-dom). null when no
   *  source produced one — treated as "unknown", never as ≥ threshold. */
  cumulativeDom: number | null;
  /** True when the DOM figure is a gameable lower bound (mls_dom_v2 +
   *  relist suspicion). We NEVER promote a sub-threshold figure over the
   *  line on suspicion — doctrine errs toward not sending — but we surface
   *  it so the caller can route to operator review if desired. */
  relistSuspected?: boolean;
  /** Listing-LANGUAGE distress: the Firecrawl page affirmatively used
   *  cash-only / investor-special / needs-work / TLC / as-is language.
   *  (firecrawl.matchedDistressKeywords non-empty.) */
  listingLanguageDistress: boolean;
  /** VISUAL read distress: the rehab-vision condition read independently
   *  judged the property distressed/as-is (NOT a lone redflag — the
   *  caller should pass the vision's affirmative condition verdict). */
  visionDistress: boolean;
  /** Optional echoes for the receipt. */
  matchedLanguagePhrases?: string[];
  visionConditionLabel?: string | null;
}

export interface LowballEligibilityResult {
  /** Eligible for the AGGRESSIVE (65%-style) opener. */
  eligible: boolean;
  tier: LowballTier;
  /** Plain-English why, for the audit receipt + operator review. */
  detail: string;
  /** The decisive signal, for telemetry grouping. */
  decidedBy: "time_on_market" | "distress_corroboration" | "none";
  cumulativeDom: number | null;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Pure: decide aggressive-opener eligibility. Time-on-market decides;
 *  vision only adds via corroboration; uncertainty → not eligible. */
export function evaluateLowballEligibility(
  input: LowballEligibilityInput,
): LowballEligibilityResult {
  const dom = isNum(input.cumulativeDom) ? input.cumulativeDom : null;

  // (1) TIME-ON-MARKET DECIDES. ≥ threshold cumulative DOM → eligible alone.
  if (dom != null && dom >= LOWBALL_DOM_THRESHOLD_DAYS) {
    return {
      eligible: true,
      tier: "dom_ge_threshold",
      detail: `cumulative DOM ${dom}d ≥ ${LOWBALL_DOM_THRESHOLD_DAYS}d — eligible on time-on-market alone (no vision needed)`,
      decidedBy: "time_on_market",
      cumulativeDom: dom,
    };
  }

  // (2) VISION ONLY ADDS, and ONLY when strongly corroborated: the listing
  // LANGUAGE and the VISUAL read must AGREE. Either signal alone is refused
  // (a lone vision flag cannot create a target; a lone keyword is not the
  // corroboration the doctrine requires).
  const corroborated = input.listingLanguageDistress && input.visionDistress;
  if (corroborated) {
    const phrases = (input.matchedLanguagePhrases ?? []).slice(0, 4).join(", ");
    return {
      eligible: true,
      tier: "distress_corroborated",
      detail:
        `under ${LOWBALL_DOM_THRESHOLD_DAYS}d (DOM ${dom ?? "unknown"}) but distress STRONGLY corroborated — ` +
        `listing language${phrases ? ` (${phrases})` : ""} AGREES with vision condition read` +
        `${input.visionConditionLabel ? ` (${input.visionConditionLabel})` : ""}`,
      decidedBy: "distress_corroboration",
      cumulativeDom: dom,
    };
  }

  // (3) NOT eligible for the aggressive opener. Distinguish a clean record
  // from one carrying a single uncorroborated flag (so the caller can route
  // an "unsure" record to a gentler opener / operator review if defined,
  // while a clean record is simply skipped). Either way: do NOT send the
  // lowball by default.
  const anyLoneSignal =
    input.listingLanguageDistress || input.visionDistress || input.relistSuspected === true;
  if (anyLoneSignal) {
    const which = [
      input.listingLanguageDistress ? "listing-language distress" : null,
      input.visionDistress ? "vision condition flag" : null,
      input.relistSuspected ? "relist-suspected DOM (lower bound)" : null,
    ]
      .filter(Boolean)
      .join(" + ");
    return {
      eligible: false,
      tier: "not_eligible_unsure",
      detail:
        `under ${LOWBALL_DOM_THRESHOLD_DAYS}d (DOM ${dom ?? "unknown"}) with only an UNCORROBORATED signal (${which}) — ` +
        `not enough for the aggressive opener; doctrine errs toward not sending`,
      decidedBy: "none",
      cumulativeDom: dom,
    };
  }

  return {
    eligible: false,
    tier: "not_eligible_clean",
    detail: `under ${LOWBALL_DOM_THRESHOLD_DAYS}d (DOM ${dom ?? "unknown"}) and clean — no aggressive opener`,
    decidedBy: "none",
    cumulativeDom: dom,
  };
}
