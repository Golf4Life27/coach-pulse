// SCOPE INTEL — turn an agent's own words about condition into a re-priced
// ceiling for the OPERATOR ALERT. @agent: appraiser/crier
//
// THE CASE (2175 W 106th St, 2026-08-08). Vision filed $41,514 of rehab
// ($33/sqft, upper-Medium) on a house the operator reads as light/medium
// (~$22.5/sqft). One tier of disagreement moved the offer by ~$13k — at
// cheap-market MAOs that is the whole negotiating room, and the $25,750
// opener drew "the seller would not consider an offer anywhere near that
// range." The rework math was then done BY HAND in chat. This module is that
// hand math, automated.
//
// THE DOCTRINE SEAM IT LIVES IN. recommended-reply guardrail G1 is absolute:
// an outbound draft carries the delivery-stamped sticky number or NO number —
// so a recomputed ceiling may NEVER ride an outbound draft. It rides the
// OPERATOR ALERT instead ("the system proposes, operator disposes"): when an
// inbound carries condition language, the alert shows what that scope does to
// the ceiling, and the operator picks the number.
//
// ONE TIER VOCABULARY. Tiers and $/sqft come from lib/appraiser/
// rehab-calibration (Bible v3 §4.2 anchors × market multiplier) — the SAME
// table vision calibrates against. This module deliberately adds no third
// tier list (rehab-scope.ts duplicating BBC anchors is a known cleanup).
//
// CONSERVATIVE BY CONSTRUCTION (INVARIANTS §2):
//   - Ambiguous spans two tiers ("light/medium") → the HEAVIER tier.
//   - Multiple signals → the HEAVIEST matched tier wins.
//   - Negated or past-tense good-news phrasing ("brand new roof") is a
//     LIGHTER signal; "needs a roof" is a HEAVIER one. Direction matters.
//   - No signal → null. Never guess a tier out of silence.

import {
  computeRehabRange,
  type BbcTier,
} from "@/lib/appraiser/rehab-calibration";

export interface ScopeSignal {
  tier: BbcTier;
  /** The phrase that fired, verbatim-ish, for the audit trail. */
  phrase: string;
}

const TIER_RANK: Record<BbcTier, number> = { Cosmetic: 0, Light: 1, Medium: 2, Heavy: 3, Gut: 4 };

/** Ordered pattern table. Each entry names the tier its phrase EVIDENCES.
 *  Good-news phrases (work already done) map LIGHTER; needs-work phrases map
 *  HEAVIER. Compound spans resolve to their heavier end. */
const PATTERNS: Array<{ tier: BbcTier; re: RegExp }> = [
  // ── Gut ──
  { tier: "Gut", re: /\bgut(?:ted|\s+job|\s+rehab)?\b/i },
  { tier: "Gut", re: /\bdown to the studs\b/i },
  { tier: "Gut", re: /\bfire damage|\bcondemn|\bnot habitable|\btear.?down\b/i },
  // ── Heavy ──
  { tier: "Heavy", re: /\bheavy\s+(?:rehab|work|scope)\b/i },
  { tier: "Heavy", re: /\bfull\s+(?:rehab|renovation)\b/i },
  { tier: "Heavy", re: /\bneeds?\s+(?:a\s+)?(?:new\s+)?roof\b/i },
  { tier: "Heavy", re: /\bfoundation\s+(?:issues?|problems?|work)\b/i },
  { tier: "Heavy", re: /\bneeds?\s+(?:everything|a lot of work|major work)\b/i },
  // ── Medium (incl. the heavier end of compound spans) ──
  { tier: "Medium", re: /\blight[\s/-]+(?:to[\s/-]+)?med(?:ium)?\b/i }, // "light/medium" → Medium
  { tier: "Medium", re: /\bmed(?:ium)?\s+(?:rehab|scope|work)\b/i },
  { tier: "Medium", re: /\bkitchen(?:s)?\s+and\s+bath/i },
  { tier: "Medium", re: /\bneeds?\s+(?:updating|updates|work)\b/i },
  { tier: "Medium", re: /\bdated\b/i },
  // ── Light ──
  { tier: "Light", re: /\blight\s+(?:rehab|work|scope|cosmetics?)\b/i },
  { tier: "Light", re: /\bcosmetic(?:s|\s+only|\s+work)?\b/i },
  { tier: "Light", re: /\bpaint\s+and\s+carpet|\bcarpet\s+and\s+paint\b/i },
  // ── Cosmetic (good news — work already done) ──
  { tier: "Cosmetic", re: /\bturn.?key\b/i },
  { tier: "Cosmetic", re: /\bmove.?in\s+ready\b/i },
  { tier: "Cosmetic", re: /\b(?:fully|recently|newly)\s+(?:renovated|remodeled|updated)\b/i },
  { tier: "Cosmetic", re: /\b(?:brand\s+)?new\s+roof\b/i },
  { tier: "Cosmetic", re: /\bupdated?\s+mechanicals\b/i },
  { tier: "Cosmetic", re: /\bnothing\s+(?:needs?|needed|to do)\b/i },
];

/** Pure: the heaviest scope tier the text evidences, or null on silence.
 *
 *  HEAVIEST-WINS is the pessimistic read (INVARIANTS §2) with one carve-out:
 *  a needs-phrase can be NEGATED ("no major work needed", "doesn't need a
 *  roof") — a negated heavy signal is discarded, not flipped, because "no
 *  major work" bounds the scope from above without naming a tier. */
export function extractScopeTier(text: string | null | undefined): ScopeSignal | null {
  if (!text || typeof text !== "string") return null;
  let best: ScopeSignal | null = null;
  for (const p of PATTERNS) {
    const m = p.re.exec(text);
    if (!m) continue;
    // Negation guard: "no / not / doesn't / without" within the 20 chars
    // before the match discards a needs-work signal.
    if (TIER_RANK[p.tier] >= TIER_RANK.Medium) {
      const before = text.slice(Math.max(0, m.index - 20), m.index);
      if (/\b(?:no|not|n't|never|without)\s*[\w\s]*$/i.test(before)) continue;
    }
    if (!best || TIER_RANK[p.tier] > TIER_RANK[best.tier]) {
      best = { tier: p.tier, phrase: m[0] };
    }
  }
  return best;
}

export interface ScopeRepriceInput {
  signal: ScopeSignal;
  sqft: number | null | undefined;
  state: string | null | undefined;
  /** Rehab currently on the record (Est_Rehab_Mid / Est_Rehab). */
  storedRehab: number | null | undefined;
  /** Underwritten MAO on the record — the doctrine ceiling at the STORED
   *  rehab. The re-priced ceiling is mao + storedRehab − scopeRehab: only the
   *  rehab TERM moves, so no ARV re-read is needed and the arithmetic cannot
   *  drift from whatever produced the MAO. */
  mao: number | null | undefined;
}

export interface ScopeReprice {
  tier: BbcTier;
  phrase: string;
  /** Bible-anchored rehab at the agent's stated scope (× market multiplier). */
  scopeRehab: number | null;
  storedRehab: number | null;
  /** Re-priced ceiling; null when mao or either rehab is missing. */
  ceiling: number | null;
  /** ceiling − mao. Positive = the agent's scope buys room. */
  delta: number | null;
}

const pos = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

/** Pure: what the agent's stated scope does to the ceiling. Fails to nulls —
 *  the alert simply omits the line when the record can't support the math. */
export function scopeReprice(input: ScopeRepriceInput): ScopeReprice {
  const { signal } = input;
  const range = computeRehabRange({
    sqft: pos(input.sqft) ? input.sqft : null,
    bbcTier: signal.tier,
    state: input.state ?? null,
  });
  const scopeRehab = range.rehab_mid;
  const storedRehab = pos(input.storedRehab) ? input.storedRehab : null;
  const ceiling =
    pos(input.mao) && scopeRehab != null && storedRehab != null
      ? Math.round(input.mao + storedRehab - scopeRehab)
      : null;
  return {
    tier: signal.tier,
    phrase: signal.phrase,
    scopeRehab,
    storedRehab,
    ceiling,
    delta: ceiling != null && pos(input.mao) ? ceiling - Math.round(input.mao) : null,
  };
}
