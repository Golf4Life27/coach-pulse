// Stale-deal self-triage — 2026-06-05.
// @agent: orchestrator
//
// Active records with no inbound/outbound movement for >14 days are
// pipeline rot. This worker classifies each into one of three states.
// Disposal moves a record to the terminal `dead` stage, so the bar is
// HIGH: dispose fires ONLY on a hard terminal signal. Anything
// ambiguous → HOLD (with the blocking reason written to the record).
// Never dispose on a guess.
//
//   dispose_dead   — a terminal signal: declined reply, delisted /
//                    off-market, or an uneconomic (negative-spread) MAO.
//   reengage_queue — still-active listing with NO prior response →
//                    flag re-engage-eligible ONLY. Queuing is NOT
//                    sending; outreach stays hard-disabled.
//   hold           — ambiguous (responded-but-stale, MAO uncomputable,
//                    no clear signal) → reason written, left for review.
//
// Pure. No I/O. The cron route extracts the signals + acts.

/** Reply phrasings that mean the agent/seller declined / the property
 *  is gone. Substring, case-insensitive, scanned against the most-recent
 *  inbound text. Kept narrow + unambiguous — a false dispose is worse
 *  than a false hold. */
export const DECLINE_KEYWORDS: readonly string[] = [
  "not interested",
  "no thank",
  "no thanks",
  "we'll pass",
  "we will pass",
  "going to pass",
  "gonna pass",
  "probably not",
  "not selling",
  "no longer for sale",
  "off the market",
  "under contract",
  "already sold",
  "it sold",
  "we sold",
  "is sold",
  "do not contact",
  "stop contacting",
  "remove me",
  "lose my number",
];

export interface DeclineMatch {
  declined: boolean;
  matched: string | null;
}

/** Pure: does the inbound text express a decline / gone-listing? */
export function detectDecline(text: string | null | undefined): DeclineMatch {
  if (!text) return { declined: false, matched: null };
  const lc = text.toLowerCase();
  for (const k of DECLINE_KEYWORDS) {
    if (lc.includes(k)) return { declined: true, matched: k };
  }
  return { declined: false, matched: null };
}

export const STALE_DAYS_DEFAULT = 14;

/** Pure: most-recent movement timestamp (ms) across all activity
 *  fields. null when none present. */
export function lastMovementMs(input: {
  lastInboundAt?: string | null;
  lastOutboundAt?: string | null;
  lastOutreachDate?: string | null;
  lastEmailOutreachDate?: string | null;
}): number | null {
  const ts = [input.lastInboundAt, input.lastOutboundAt, input.lastOutreachDate, input.lastEmailOutreachDate]
    .map((v) => (v ? Date.parse(v) : NaN))
    .filter((n) => Number.isFinite(n)) as number[];
  return ts.length ? Math.max(...ts) : null;
}

/** Pure: is this record stale (no movement in `days`)? A record with NO
 *  movement timestamp at all is treated as stale (it has never moved). */
export function isStale(
  input: Parameters<typeof lastMovementMs>[0],
  now: Date,
  days: number = STALE_DAYS_DEFAULT,
): { stale: boolean; daysSinceMovement: number | null } {
  const last = lastMovementMs(input);
  if (last == null) return { stale: true, daysSinceMovement: null };
  const daysSince = (now.getTime() - last) / 86_400_000;
  return { stale: daysSince > days, daysSinceMovement: Math.floor(daysSince) };
}

export type StaleVerdict = "dispose_dead" | "reengage_queue" | "hold";

export type DisposeCategory =
  | "delisted"
  | "declined_reply"
  | "uneconomic_negative_spread"
  | "blacklist";

export interface StaleClassifyInput {
  /** Live_Status === "Active". */
  isActive: boolean;
  /** MLS_Status indicates still-for-sale (active / for sale / coming soon). */
  mlsActive: boolean;
  /** A decline/gone-listing reply was detected. */
  declined: boolean;
  declineMatch?: string | null;
  /** The agent has responded at all (Response Received / Counter / Negotiating / Offer Accepted). */
  hasResponded: boolean;
  /** Landlord-lane Your_MAO when fully computable; null when it isn't
   *  (missing rehab / rent / taxes). Only a NEGATIVE (≤0) value disposes;
   *  null never disposes (it's a HOLD input, not a terminal one). */
  landlordYourMao: number | null;
  /** Address matches the never-resurface blocklist (Canon §9 / Sentinel).
   *  HARDEST terminal signal — sourced fact, not inference. Beats everything. */
  onBlacklist?: boolean;
}

export interface StaleClassifyResult {
  verdict: StaleVerdict;
  disposeCategory: DisposeCategory | null;
  reason: string;
}

/**
 * Pure: classify one stale record. Precedence is deliberate —
 * terminal signals first (most certain → least), then the re-engage
 * lane, then HOLD as the conservative default.
 */
export function classifyStaleDeal(input: StaleClassifyInput): StaleClassifyResult {
  // ── Terminal signals → dispose dead ───────────────────────────────
  // 0. Blacklist — Canon §9 sourced fact (operator-curated, explicit list).
  //    Zero false-positive risk (the inference we avoided was free-text
  //    seller-type guessing). Beats every other signal: a blacklisted
  //    address never gets pursued regardless of economics, response state,
  //    or listing status.
  if (input.onBlacklist) {
    return {
      verdict: "dispose_dead",
      disposeCategory: "blacklist",
      reason: "address on never-resurface blocklist (Canon §9 sourced fact) — permanent disposal",
    };
  }
  // 1. Delisted / off-market — the property is gone; nothing to pursue.
  if (!input.isActive || !input.mlsActive) {
    return {
      verdict: "dispose_dead",
      disposeCategory: "delisted",
      reason: `delisted/off-market (Live_Status active=${input.isActive}, MLS active=${input.mlsActive}) — property no longer for sale`,
    };
  }
  // 2. Declined reply — the agent/seller said no.
  if (input.declined) {
    return {
      verdict: "dispose_dead",
      disposeCategory: "declined_reply",
      reason: `declined reply detected ("${input.declineMatch ?? "decline phrase"}") — seller/agent passed`,
    };
  }
  // 3. Uneconomic — a fully-computed landlord MAO with a non-positive
  //    spread. ONLY a real negative number disposes; null (uncomputable)
  //    falls through to HOLD, never disposes.
  if (input.landlordYourMao != null && input.landlordYourMao <= 0) {
    return {
      verdict: "dispose_dead",
      disposeCategory: "uneconomic_negative_spread",
      reason: `uneconomic — landlord Your_MAO $${input.landlordYourMao.toLocaleString()} ≤ 0 (income math does not support a wholesale spread)`,
    };
  }

  // ── Re-engage lane — active, no prior response ────────────────────
  // Queuing only; nothing transmits (outreach is hard-disabled).
  if (input.isActive && input.mlsActive && !input.hasResponded) {
    return {
      verdict: "reengage_queue",
      disposeCategory: null,
      reason: "active listing, no prior response, stale >14d → re-engage-eligible (flag only; outreach stays OFF)",
    };
  }

  // ── HOLD — anything ambiguous ─────────────────────────────────────
  // e.g. the agent responded but the thread went cold, or the MAO can't
  // be computed yet. Don't dispose on a guess; surface the reason.
  return {
    verdict: "hold",
    disposeCategory: null,
    reason: input.hasResponded
      ? "responded then went cold — ambiguous; not a clean dispose. Operator review or fresh classification needed"
      : "no terminal signal and not cleanly re-engageable — held for review",
  };
}

// ── Record annotation (idempotent) ───────────────────────────────────
//
// Every classified record carries a provenance line in Verification_Notes
// so the decision is auditable on the record itself (the audit log is the
// other half). A single stable sentinel makes the worker DURABLE: a record
// already annotated is skipped on the next sweep, so re-running the cron
// produces zero duplicate writes. Disposed records leave the active
// population (Outreach_Status → Dead) so they never recur; held / re-engage
// records keep the sentinel and are skipped.

/** Stable substring stamped into every triage annotation. Idempotency
 *  key — presence means "already classified by this worker". */
export const STALE_TRIAGE_SENTINEL = "STALE-TRIAGE";

const VERDICT_TAG: Record<StaleVerdict, string> = {
  dispose_dead: "DISPOSE→DEAD",
  reengage_queue: "RE-ENGAGE-ELIGIBLE (flag only; outreach OFF)",
  hold: "HOLD",
};

/** Pure: does this record's verification notes already contain the blacklist
 *  triage line? Re-runs are skipped via the existing STALE_TRIAGE_SENTINEL
 *  check, but blacklist disposals carry a more specific tag so they're
 *  visible in the audit trail. */
export const BLACKLIST_DISPOSE_TAG = "blacklist";

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Pure: has this record already been classified by the stale-triage
 *  worker? (Idempotency guard for the durable cron.) */
export function alreadyTriaged(notes: string | null | undefined): boolean {
  return (notes ?? "").includes(STALE_TRIAGE_SENTINEL);
}

/** Pure: the single provenance line for a classification. */
export function buildTriageNote(
  result: StaleClassifyResult,
  daysSinceMovement: number | null,
  now: Date,
): string {
  const stamp = `${now.getUTCFullYear()}-${pad2(now.getUTCMonth() + 1)}-${pad2(now.getUTCDate())}`;
  const age = daysSinceMovement == null ? "no recorded movement" : `${daysSinceMovement}d stale`;
  return `${stamp} — ${STALE_TRIAGE_SENTINEL} ${VERDICT_TAG[result.verdict]}: ${result.reason} (${age}).`;
}

/** Pure: append the triage line to existing notes (blank-line separated,
 *  trailing whitespace trimmed). Mirrors the bulk-dead-annotation append. */
export function appendTriageNote(currentNotes: string | null | undefined, line: string): string {
  const trimmed = (currentNotes ?? "").replace(/\s+$/u, "");
  return trimmed.length > 0 ? `${trimmed}\n\n${line}` : line;
}
