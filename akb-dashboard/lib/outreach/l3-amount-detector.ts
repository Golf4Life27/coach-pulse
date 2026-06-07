// L3 dollar-amount reply detector — escalation surface.
// @agent: outreach / orchestrator
//
// Any L3 reply that contains a dollar amount is a NEGOTIATION POINT and
// must escalate immediately. Examples that proved this rule in live data:
//
//   12724 Strathmoor (Ali Fawaz, 5/6): "...I can make $70k work for you..."
//   1518 Waverly (Alan King): "...won't take less than $100k..."
//
// Both must skip auto-triage and route to operator review. The detector
// is PURE — caller decides the escalation channel.
//
// Posture: a dollar-amount reply is ALWAYS escalation-eligible. We do NOT
// try to classify counter / floor / ceiling — that's an operator judgment.
// We just surface the amount and the verbatim sentence it appeared in.

export interface DollarAmount {
  /** Numeric value in dollars (parsed from "$70k" or "100000" etc). */
  amountUsd: number;
  /** The verbatim token as it appeared in the source. */
  token: string;
  /** The sentence (rough) the amount appeared in, for context. */
  context: string;
}

export interface L3AmountDetection {
  /** All dollar amounts found in the reply, in source order. */
  amounts: DollarAmount[];
  /** Escalation status — true when at least one amount was found. */
  shouldEscalate: boolean;
  /** Short reason for the audit log / Spine entry. */
  reason: string;
}

// "$70k" / "$70,000" / "$70.5k" / "70k" / "70K" — order matters: longer
// patterns first to avoid the "70" inside "70k" being captured.
const AMOUNT_PATTERNS: Array<{ re: RegExp; scale: number }> = [
  { re: /\$\s?(\d{1,3}(?:,\d{3})+(?:\.\d+)?)/g, scale: 1 },     // $70,000
  { re: /\$\s?(\d+(?:\.\d+)?)\s?[kK]\b/g, scale: 1_000 },        // $70k
  { re: /\$\s?(\d+(?:\.\d+)?)\s?[mM]\b/g, scale: 1_000_000 },    // $1.2M
  { re: /\$\s?(\d{4,})(?:\.\d+)?\b/g, scale: 1 },                // $70000
  { re: /\b(\d+(?:\.\d+)?)\s?[kK]\b/g, scale: 1_000 },           // 70k (no $)
];

function splitIntoSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Pure: detect dollar amounts in an L3 reply body and decide whether to
 *  escalate. Idempotent; same input → same output. */
export function detectL3DollarAmounts(reply: string | null | undefined): L3AmountDetection {
  if (!reply || !reply.trim()) {
    return { amounts: [], shouldEscalate: false, reason: "empty reply" };
  }
  const found = new Map<number, DollarAmount>();
  const sentences = splitIntoSentences(reply);
  for (const sent of sentences) {
    for (const { re, scale } of AMOUNT_PATTERNS) {
      const localRe = new RegExp(re.source, re.flags);
      let m: RegExpExecArray | null;
      while ((m = localRe.exec(sent)) != null) {
        const numStr = m[1].replace(/,/g, "");
        const n = parseFloat(numStr) * scale;
        if (!Number.isFinite(n) || n <= 0) continue;
        // Discard implausibly-small numerals that almost certainly aren't
        // dollar amounts (e.g. "I called 5 times" → 5).
        if (scale === 1 && n < 1000) continue;
        if (!found.has(n)) {
          found.set(n, {
            amountUsd: n,
            token: m[0].trim(),
            context: sent,
          });
        }
      }
    }
  }
  const amounts = Array.from(found.values()).sort((a, b) => a.amountUsd - b.amountUsd);
  return {
    amounts,
    shouldEscalate: amounts.length > 0,
    reason: amounts.length > 0
      ? `L3 dollar amount(s) detected: ${amounts.map((a) => `$${a.amountUsd.toLocaleString()}`).join(", ")} — escalate to operator`
      : "no dollar amount in reply",
  };
}
