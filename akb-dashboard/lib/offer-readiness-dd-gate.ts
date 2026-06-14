// DD-as-offer-readiness gate (spine recZ6tBZRmfFOLwqo, doctrine in
// SYSTEM_HANDOFF.md). @agent: orchestrator
//
// Two gates this method puts on offer-readiness:
//   1. No autonomous send on a record with zero DD answers parsed.
//      The first agent text is the door-opener (Tier A 65% of list,
//      conversational). A *committed* offer requires the DD-rehab
//      loop has been at least begun — text 2 sent, an answer parsed.
//   2. No contract-stage offer (above the door-opener) without a
//      rehab band narrowed by DD or a walkthrough. The vision
//      number alone does not authorize a contract price.

import type { DDRehabSignals } from "@/lib/dd-rehab-signals";
import type { RehabBand } from "@/lib/dd-rehab-band";

/** Stage of the offer being authorized. door_opener is the cold 65%-of-
 *  list first text; contract is a committed dollar number in a contract. */
export type OfferStage = "door_opener" | "contract";

export type GateVerdict =
  | { ok: true }
  | { ok: false; reason: string; missing: string[] };

/** Rehab band width at which "no rehab data" is the doctrinal verdict
 *  for contract stage, per SYSTEM_HANDOFF.md. */
export const CONTRACT_BAND_WIDTH_CEILING = 0.25;

export function evaluateDDOfferGate(
  stage: OfferStage,
  signals: DDRehabSignals,
  band: RehabBand,
): GateVerdict {
  if (stage === "door_opener") {
    // The door-opener is conversational. No DD requirement. The opener
    // texts ARE how we collect DD. Gate this only on whether the
    // record is priceable — that's enforced elsewhere (tierAOpenerGuard).
    return { ok: true };
  }

  // Contract stage.
  const missing: string[] = [];
  if (signals.answeredCount === 0 && band.source !== "walkthrough") {
    missing.push("dd_volley_started_no_answers");
  }
  if (band.source === "photos_only") {
    missing.push("rehab_band_unnarrowed_by_dd_or_walkthrough");
  }
  if (band.widthPct > CONTRACT_BAND_WIDTH_CEILING) {
    missing.push(`rehab_band_too_wide_for_contract_stage (±${Math.round(band.widthPct * 100)}% > ±${CONTRACT_BAND_WIDTH_CEILING * 100}%)`);
  }
  if (missing.length === 0) return { ok: true };
  return {
    ok: false,
    reason:
      `Contract-stage offer HOLD per SYSTEM_HANDOFF.md rehab doctrine: ` +
      missing.join("; ") +
      `. Send DD volley text 2 / parse mechanical-age answers / schedule a walkthrough before authorizing.`,
    missing,
  };
}
