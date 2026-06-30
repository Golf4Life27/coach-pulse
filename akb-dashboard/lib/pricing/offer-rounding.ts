// Offer rounding (operator rule, re-implemented 2026-06-30 after it vaporized).
// @agent: crier / appraiser
//
// THE RULE (operator, months-old, lost between sessions, now durable + spined):
//   "Round offers up or down to the nearest $250."
//
// Every autonomous cash offer rounds to the nearest $250 so the number reads
// like a human wrote it ($16,500) instead of an algorithm ($16,535). Applied
// at EVERY place an opener dollar is finalized — the anchored send-path gate
// (your-mao-opener-gate) AND the seed/stored pricer (per-market-pricer) — so a
// single path can't silently skip it the way the original implementation did.
//
// Pure. No I/O, no env (the step is a fixed business rule; change it here).

/** The rounding increment for every cash offer, in dollars. */
export const OFFER_ROUND_STEP_USD = 250;

/**
 * Round a positive dollar offer to the nearest OFFER_ROUND_STEP_USD ($250).
 * Pure. Non-finite or ≤ 0 inputs pass through unchanged — callers gate those
 * separately (a ≤ 0 opener is a HOLD, not a roundable number), and rounding
 * must never turn a 0/negative sentinel into a positive offer.
 *
 *   16,535 → 16,500     16,700 → 16,750     1,714 → 1,750
 */
export function roundOfferToNearest(
  amount: number,
  step: number = OFFER_ROUND_STEP_USD,
): number {
  if (!Number.isFinite(amount) || amount <= 0 || step <= 0) return amount;
  return Math.round(amount / step) * step;
}
