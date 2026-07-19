// INV-022 Sprint 2 — RentCast valuation + rent hydration for Property_Intel.
// @agent: data_federation
//
// Wraps the existing lib/rentcast.ts helpers (getAvmValue, getRentEstimate,
// getSaleComparables) and shapes their output into Property_Intel
// contributions. Does NOT touch /api/verify-listing — federation pulls
// /avm/value + /avm/rent/long-term independently from verify-listing's
// /v1/listings/sale (different endpoints, no shared cadence).
//
// Budget discipline: RENTCAST_MONTHLY_CAP (default 1000) gates these calls.
// Each hydration burns up to 2 quota credits (/avm/value once — comps come
// embedded — + /avm/rent/long-term once). The cron passes the remaining
// budget; rentcastBudgetAllows decides whether to spend or defer.

import {
  getAvmValue,
  getRentEstimate,
} from "@/lib/rentcast";
import { getSoldComps } from "@/lib/comps/sold-comps";
import type {
  ValuationContribution,
  RentContribution,
  CompsContribution,
} from "@/lib/federation/property-intel-store";

export const RENTCAST_MONTHLY_CAP = Number(process.env.RENTCAST_MONTHLY_CAP ?? "1000");

/** Quota credits a single federation hydration consumes: one /avm/value
 *  (comps embedded) + one /avm/rent/long-term. */
export const RENTCAST_CREDITS_PER_HYDRATION = 2;

export interface RentcastBudgetDecision {
  allowed: boolean;
  reason: "ok" | "insufficient_budget";
  /** credits this hydration would spend */
  requested: number;
  remaining: number;
}

/** Pure: can we afford a federation RentCast hydration with `remaining`
 *  credits left this cycle? Refuses when the hydration would exceed the
 *  remaining budget — defer rather than overspend (respects the cap the
 *  burn-rate monitor reports). */
export function rentcastBudgetAllows(
  remaining: number,
  requested: number = RENTCAST_CREDITS_PER_HYDRATION,
): RentcastBudgetDecision {
  const ok = Number.isFinite(remaining) && remaining >= requested;
  return {
    allowed: ok,
    reason: ok ? "ok" : "insufficient_budget",
    requested,
    remaining,
  };
}

export interface RentcastHydrateInput {
  address: string;
  city: string;
  state: string;
  zip: string;
  bedrooms?: number | null;
  bathrooms?: number | null;
  squareFootage?: number | null;
}

export interface RentcastHydrateResult {
  valuation?: ValuationContribution;
  rent?: RentContribution;
  comps?: CompsContribution;
  /** populated when a sub-call threw; partial results still returned. */
  errors: string[];
  /** credits actually spent (for the cron to decrement its budget). */
  creditsSpent: number;
}

/** Hydrate AS-IS value + rent + comps from RentCast. Each sub-call is
 *  isolated: a throw on one does not abort the others (partial hydration is
 *  valid — the Property_Intel row gets Hydration_Status=partial). Caller
 *  must check rentcastBudgetAllows BEFORE invoking. */
export async function hydrateValuation(
  input: RentcastHydrateInput,
): Promise<RentcastHydrateResult> {
  const fetchedAt = new Date().toISOString();
  const errors: string[] = [];
  let creditsSpent = 0;
  const result: RentcastHydrateResult = { errors, creditsSpent: 0 };

  // /avm/value (+ embedded comps). One credit covers both value + comps.
  try {
    const avm = await getAvmValue(input);
    creditsSpent += 1;
    if (avm) {
      result.valuation = {
        asIsValue: avm.price,
        asIsValueLow: avm.priceLow,
        asIsValueHigh: avm.priceHigh,
        source: "rentcast",
        fetchedAt,
      };
    }
    // Comps embedded in the same response — parse without a second credit.
    if (Array.isArray(avm?.comparables)) {
      result.comps = { comps: avm!.comparables as unknown[], source: "rentcast" };
    } else {
      // Fall back to the dedicated parser (same /avm/value endpoint, but it
      // re-fetches; only do so if the embedded array was absent).
      try {
        const comps = await getSoldComps(input);
        creditsSpent += 1;
        result.comps = { comps, source: "rentcast" };
      } catch (err) {
        errors.push(`comps: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch (err) {
    errors.push(`avm_value: ${err instanceof Error ? err.message : String(err)}`);
  }

  // /avm/rent/long-term.
  try {
    const rent = await getRentEstimate(input);
    creditsSpent += 1;
    result.rent = { rent: rent.rent, source: "rentcast", fetchedAt };
  } catch (err) {
    errors.push(`rent: ${err instanceof Error ? err.message : String(err)}`);
  }

  result.creditsSpent = creditsSpent;
  return result;
}
