// Phase 1.4 + 1.5 + 1.7 / Q.5 — Scenario B intake quality gates.
//
// Pure helpers that detect intake-time anomalies in listing bodies +
// agent contact data. Replaces the spec'd Make-side Scenario B fixes
// that were never implemented. Sentry / process-intake routes can
// gate on these classifications.
//
// Three gates:
//   1.4 — off-market body text: listing body contains language
//         suggesting the property is already off the market
//         (under contract, pending, sold). Route to Manual Review.
//   1.5 — flip/renovation keyword score: counts indicator keywords;
//         4+ → Manual Review, 7+ → Reject (likely competing flipper).
//   1.7 — Agent_Phone numeric validation: phone matches expected
//         pattern; non-matches route to Manual Review.

export type IntakeGateAction = "pass" | "manual_review" | "reject";

export interface IntakeGateResult {
  action: IntakeGateAction;
  /** Stable reason code for downstream audit / Pulse counting. */
  reason: string;
  /** Specific matches that triggered the action (when applicable). */
  matches?: string[];
}

// ── 1.4 — Off-market body text detection ────────────────────────────────

const OFF_MARKET_PATTERNS: ReadonlyArray<{ pattern: RegExp; code: string }> = [
  { pattern: /\bunder contract\b/i, code: "under_contract" },
  { pattern: /\bpending sale\b/i, code: "pending_sale" },
  { pattern: /\bpending\b/i, code: "pending" },
  { pattern: /\boff the market\b/i, code: "off_the_market" },
  { pattern: /\boff market\b/i, code: "off_market" },
  { pattern: /\bsold on\b/i, code: "sold_on" },
  { pattern: /\bjust sold\b/i, code: "just_sold" },
  { pattern: /\bclosed escrow\b/i, code: "closed_escrow" },
  { pattern: /\bwithdrawn\b/i, code: "withdrawn" },
];

/** Pure: detect off-market signals in listing body text. */
export function detectOffMarketLanguage(body: string | null | undefined): IntakeGateResult {
  if (!body || body.trim().length === 0) {
    return { action: "pass", reason: "empty_body" };
  }
  const matched: string[] = [];
  for (const { pattern, code } of OFF_MARKET_PATTERNS) {
    if (pattern.test(body)) matched.push(code);
  }
  if (matched.length === 0) return { action: "pass", reason: "no_off_market_signal" };
  return {
    action: "manual_review",
    reason: "off_market_language_detected",
    matches: matched,
  };
}

// ── 1.5 — Flip/renovation keyword scoring ───────────────────────────────

const FLIP_KEYWORDS: ReadonlyArray<RegExp> = [
  /\brecently renovated\b/i,
  /\bbrand new\b/i,
  /\bcompletely remodeled\b/i,
  /\bjust flipped\b/i,
  /\bturnkey\b/i,
  /\bmove[-\s]?in ready\b/i,
  /\bnew everything\b/i,
  /\bnew (?:roof|hvac|kitchen|bathroom|flooring|plumbing|electrical|windows)\b/i,
  /\bgranite\b/i,
  /\bquartz\b/i,
  /\bstainless\b/i,
  /\bupgraded\b/i,
  /\bgut[-\s]?renovat/i,
  /\bcustom\b/i,
];

export interface FlipScoreResult extends IntakeGateResult {
  score: number;
  /** Each matched keyword (canonical source pattern). */
  matched_keywords: string[];
}

const FLIP_MANUAL_REVIEW_THRESHOLD = 4;
const FLIP_REJECT_THRESHOLD = 7;

/** Pure: count flip/renovation keyword matches in listing text and
 *  classify per the 4+/7+ thresholds. */
export function scoreFlipKeywords(body: string | null | undefined): FlipScoreResult {
  if (!body || body.trim().length === 0) {
    return {
      action: "pass",
      reason: "empty_body",
      score: 0,
      matched_keywords: [],
    };
  }
  const matched: string[] = [];
  for (const pattern of FLIP_KEYWORDS) {
    if (pattern.test(body)) matched.push(pattern.source);
  }
  const score = matched.length;
  let action: IntakeGateAction = "pass";
  let reason = "below_flip_threshold";
  if (score >= FLIP_REJECT_THRESHOLD) {
    action = "reject";
    reason = "flip_keyword_reject";
  } else if (score >= FLIP_MANUAL_REVIEW_THRESHOLD) {
    action = "manual_review";
    reason = "flip_keyword_manual_review";
  }
  return { action, reason, score, matched_keywords: matched };
}

// ── 1.7 — Agent_Phone numeric validation ────────────────────────────────

// Allow common phone-format characters; require ≥7 digits total.
const PHONE_FORMAT_RE = /^[+\d\s\-().]+$/;

/** Pure: validate agent_phone format. Empty / null phones pass
 *  (handled separately as "no phone on file"); malformed strings
 *  route to manual review. */
export function validateAgentPhone(phone: string | null | undefined): IntakeGateResult {
  if (!phone || phone.trim().length === 0) {
    return { action: "pass", reason: "empty_phone" };
  }
  const trimmed = phone.trim();
  if (!PHONE_FORMAT_RE.test(trimmed)) {
    return {
      action: "manual_review",
      reason: "phone_invalid_chars",
      matches: [trimmed.slice(0, 50)],
    };
  }
  const digitCount = trimmed.replace(/\D/g, "").length;
  if (digitCount < 7) {
    return {
      action: "manual_review",
      reason: "phone_too_few_digits",
      matches: [String(digitCount)],
    };
  }
  if (digitCount > 15) {
    return {
      action: "manual_review",
      reason: "phone_too_many_digits",
      matches: [String(digitCount)],
    };
  }
  return { action: "pass", reason: "phone_valid" };
}

// ── Combined gate run ────────────────────────────────────────────────────

export interface CombinedIntakeGate {
  /** Worst action across all gates. */
  action: IntakeGateAction;
  off_market: IntakeGateResult;
  flip_score: FlipScoreResult;
  phone: IntakeGateResult;
}

const ACTION_SEVERITY: Record<IntakeGateAction, number> = {
  pass: 0,
  manual_review: 1,
  reject: 2,
};

/** Pure: run all three gates and return the worst-action aggregate. */
export function runIntakeGates(input: {
  body: string | null | undefined;
  agent_phone: string | null | undefined;
}): CombinedIntakeGate {
  const off_market = detectOffMarketLanguage(input.body);
  const flip_score = scoreFlipKeywords(input.body);
  const phone = validateAgentPhone(input.agent_phone);
  const action: IntakeGateAction =
    ACTION_SEVERITY[off_market.action] >= ACTION_SEVERITY[flip_score.action] &&
    ACTION_SEVERITY[off_market.action] >= ACTION_SEVERITY[phone.action]
      ? off_market.action
      : ACTION_SEVERITY[flip_score.action] >= ACTION_SEVERITY[phone.action]
        ? flip_score.action
        : phone.action;
  return { action, off_market, flip_score, phone };
}
