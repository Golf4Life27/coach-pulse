// Decision-math persistence — the single writer of the decision fields.
// @agent: appraiser
//
// Wraps lib/decision-math (pure) with the record read→compute→write cycle
// every hook shares: the engaged-underwrite cron, the counter-ingestion hook
// (quo-sync / gmail-sync), the opener paths, and the decision-backfill cron.
// One writer = the fields can't drift by call site.
//
// IDEMPOTENT: Decision_Inputs_Hash is a ±$5-bucketed hash of every input —
// when it matches the stored hash the write is skipped entirely (no record
// churn, no Spine noise; pricing-doctrine recompute-tolerance standard 1).
//
// NEVER touches operator-confirmed fields (Contract_Offer_Price,
// Annual_Taxes_Confirmed, EMD signoffs…) — it only writes its own
// Decision_* / Buyer_Ceiling / Deal_Spread / AllIn / confidence set, plus
// Latest_Counter_Usd when the caller passes a freshly classified counter.
//
// Type 1: computes and stores numbers. Never sends, never flips
// counterparty-facing status. (The post-vision park below mints an OPERATOR
// review card — internal surfacing, not a counterparty-facing action.)

import { updateListingRecord } from "@/lib/airtable";
import { audit } from "@/lib/audit-log";
import {
  computeDecisionMath,
  decisionInputsFromListing,
  type DecisionMathResult,
} from "@/lib/decision-math";
import { parkDeal } from "@/lib/conveyor/park";
import { NEGOTIATION_STATUSES } from "@/lib/maverick/heartbeat";
import type { Listing } from "@/lib/types";

/** POST-VISION PARK crossing detector (operator 2026-07-16, the Mayfield/
 *  Cheyenne class): fire exactly when this compute takes a deal's spread
 *  NEGATIVE for the first time (prior stored spread was null/≥0) on a record
 *  whose opener already went out. Pure — the caller decides what to do with it.
 *  Fires once at the crossing, not on every underwater recompute. */
export function crossedUnderwater(
  priorSpread: number | null | undefined,
  newSpread: number | null | undefined,
  openerSent: boolean,
): boolean {
  if (!openerSent) return false;
  if (newSpread == null || !Number.isFinite(newSpread) || newSpread >= 0) return false;
  return !(typeof priorSpread === "number" && Number.isFinite(priorSpread) && priorSpread < 0);
}

export interface PersistDecisionOutcome {
  recordId: string;
  result: DecisionMathResult;
  /** false when the inputs hash matched (tolerance no-op) or write failed. */
  written: boolean;
  skippedUnchanged: boolean;
  writeError: string | null;
}

/**
 * Compute the decision set for one listing and persist it (hash-gated).
 * `trigger` labels the audit trail (engaged_cron / counter_ingest /
 * opener_pass / backfill / manual). Pass `latestCounterUsd` when a fresh
 * counter was just classified — it is persisted alongside the decision so
 * the live price survives to the next compute.
 */
export async function persistDecisionMath(
  listing: Listing,
  opts: {
    trigger: string;
    latestCounterUsd?: number | null;
    nowIso?: string;
  },
): Promise<PersistDecisionOutcome> {
  const nowIso = opts.nowIso ?? new Date().toISOString();
  const inputs = decisionInputsFromListing(listing, {
    latestCounterUsd: opts.latestCounterUsd ?? undefined,
  });
  const result = computeDecisionMath(inputs);

  // Tolerance no-op: same ±$5-bucketed inputs → nothing to say.
  if (listing.decisionInputsHash && listing.decisionInputsHash === result.inputsHash) {
    return {
      recordId: listing.id,
      result,
      written: false,
      skippedUnchanged: true,
      writeError: null,
    };
  }

  const fields: Record<string, unknown> = {
    Buyer_Ceiling: result.buyerCeiling,
    Deal_Spread: result.dealSpread,
    AllIn_Pct_ARV: result.allInPctArv,
    Decision_Verdict: result.verdict,
    Decision_Reason: result.reason,
    Decision_Computed_At: nowIso,
    Decision_Inputs_Hash: result.inputsHash,
    Underwrite_Confidence: result.confidence,
  };
  if (opts.latestCounterUsd != null && Number.isFinite(opts.latestCounterUsd) && opts.latestCounterUsd > 0) {
    fields["Latest_Counter_Usd"] = Math.round(opts.latestCounterUsd);
  }

  let written = false;
  let writeError: string | null = null;
  try {
    await updateListingRecord(listing.id, fields);
    written = true;
  } catch (err) {
    writeError = err instanceof Error ? err.message.slice(0, 240) : String(err).slice(0, 240);
  }

  // ── POST-VISION PARK (operator 2026-07-16) ────────────────────────────────
  // This compute just took the deal underwater for the first time and an
  // opener is already out. Pre-engagement records are handled by the bump
  // lane's parked_underwater skip (it reads the stored Deal_Spread we just
  // wrote). ENGAGED records need the operator: a live negotiation is riding a
  // number no buyer pays — mint ONE underwater_review card (2C: pass /
  // re-verify condition / route creative). Best-effort: a park failure never
  // fails the persist.
  const openerSent = listing.roughOpenerAmount != null || listing.outreachOfferPrice != null;
  if (
    written &&
    crossedUnderwater(listing.dealSpread, result.dealSpread, openerSent) &&
    NEGOTIATION_STATUSES.has(listing.outreachStatus ?? "")
  ) {
    try {
      await parkDeal({
        recordId: listing.id,
        address: listing.address ?? listing.id,
        reason: "underwater_post_vision",
        priority: "HIGH",
        reasoning:
          `Deal went underwater when the math got real: spread ${result.dealSpread!.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })} ` +
          `(buyer ceiling ${result.buyerCeiling != null ? `$${result.buyerCeiling.toLocaleString()}` : "—"} vs current price ${result.currentPrice != null ? `$${result.currentPrice.toLocaleString()}` : "—"}). ` +
          `An offer is already out — rule it: pass, re-verify condition, or route creative. Do not advance the number.`,
        payload: {
          deal_spread: result.dealSpread,
          buyer_ceiling: result.buyerCeiling,
          current_price: result.currentPrice,
          verdict: result.verdict,
          trigger: opts.trigger,
        },
      });
    } catch (err) {
      console.error("[decision-persist] underwater park failed:", err);
    }
  }

  await audit({
    agent: "appraiser",
    event: "decision_math_computed",
    status: written ? "confirmed_success" : "confirmed_failure",
    recordId: listing.id,
    inputSummary: {
      address: listing.address,
      trigger: opts.trigger,
      price: result.currentPrice,
      price_source: result.priceSource,
      counter: opts.latestCounterUsd ?? null,
    },
    outputSummary: {
      verdict: result.verdict,
      buyer_ceiling: result.buyerCeiling,
      deal_spread: result.dealSpread,
      all_in_pct: result.allInPctArv,
      confidence: result.confidence,
      lane: result.ceilingLane,
      reason: result.reason.slice(0, 200),
    },
    decision: result.verdict,
    error: writeError ?? undefined,
  });

  return { recordId: listing.id, result, written, skippedUnchanged: false, writeError };
}
