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
// counterparty-facing status.

import { updateListingRecord } from "@/lib/airtable";
import { audit } from "@/lib/audit-log";
import {
  computeDecisionMath,
  decisionInputsFromListing,
  type DecisionMathResult,
} from "@/lib/decision-math";
import type { Listing } from "@/lib/types";

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
