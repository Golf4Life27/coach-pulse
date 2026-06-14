// Per-record V2.1 landlord underwrite — single source of truth.
// @agent: appraiser
//
// Extracted (2026-06-14, Maverick "rebuild stale-deal handling") so the
// SAME landlord-MAO compute serves two callers without a parallel build:
//
//   1. INITIAL UNDERWRITE — /api/cron/underwrite-v21-fresh fires this ONCE
//      per cold priceable record (allowReprice=false → idempotency holds).
//      UNCHANGED in behavior; the cron just delegates the loop body here.
//
//   2. REPLY-TRIGGERED RE-PRICE — lib/appraiser/auto-run-on-engaged fires
//      this on a seller reply for an ALREADY-underwritten record
//      (allowReprice=true → recompute off fresh inputs). "Fresh paid pulls
//      on an already-underwritten record, fires ONLY on a seller reply"
//      (Maverick). Never on a clock, never on a non-responsive record.
//
// The landlord MAO (computeV21LandlordMao) keys off rent + county taxes +
// sourced cap + Est_Rehab — NOT ARV. The reply trigger refreshes the
// flipper lane (ARV comps) via the ARV route; THIS refreshes the landlord
// lane. Together they re-price both lanes on a reply.
//
// Paid pulls per call: taxes are always fetched fresh (RentCast
// /properties ×2 — the within-RentCast redundancy is pre-existing, flagged
// in the spend audit, untouched here). Rent is stored-preferred (free)
// unless forceFreshRent — the re-price path sets it so the recompute is
// genuinely fresh.

import { getRentEstimate, getAnnualPropertyTaxes, getRentCastAssessedValue } from "@/lib/rentcast";
import { updateListingRecord } from "@/lib/airtable";
import {
  resolveAnnualTaxes,
  defaultInvestorCapFor,
  computeV21LandlordMao,
  buildMaoV21Marker,
  upsertMaoV21Marker,
  type V21MaoResult,
  type TaxResolution,
} from "@/lib/landlord-hydrate";
import { decideV21Write, type V21Lane, type V21WriteDecision } from "@/lib/v21-writer-decision";
import { getMarketForListing } from "@/lib/markets/registry";
import { listSeededZips } from "@/lib/buyer-median-store";
import type { Listing } from "@/lib/types";

export interface UnderwriteV21Options {
  /** Write Your_MAO_V21 / Investor_MAO_V21 / marker when the compute is ok.
   *  false = compute only (dry-run / report). */
  apply: boolean;
  /** Bypass the already_has_v21 idempotency guard — the reply-triggered
   *  re-price path deliberately recomputes an existing number. */
  allowReprice?: boolean;
  /** Force a fresh RentCast rent pull instead of preferring stored rent.
   *  The re-price path sets this; the initial-underwrite cron leaves it
   *  off (don't pay for a number we already have on a cold record). */
  forceFreshRent?: boolean;
  /** Seeded-ZIP set for the priceability gate. Fetched if omitted (the
   *  cron passes its already-loaded set to avoid a per-record refetch). */
  seededZips?: Set<string>;
}

export interface UnderwriteV21Outcome {
  recordId: string;
  /** The fire-decision (write/skip + lane/reason). */
  decision: V21WriteDecision;
  lane: V21Lane | null;
  result: V21MaoResult | null;
  monthlyRent: number | null;
  taxes: number | null;
  taxSource: string | null;
  /** Whether a write actually landed (apply && ok && yourMao). */
  written: boolean;
  writeError: string | null;
  /** True when the existing number was overwritten (reprice), false on a
   *  first-time write. null when nothing was written. */
  reprice: boolean | null;
}

/**
 * Underwrite (or re-price) ONE record's landlord V2.1 MAO. Pure-ish: does
 * paid RentCast pulls and (when apply) one Airtable write. No scheduling,
 * no batching — the caller owns the loop/budget.
 */
export async function underwriteV21Record(
  listing: Listing,
  opts: UnderwriteV21Options,
): Promise<UnderwriteV21Outcome> {
  const skip = (decision: V21WriteDecision): UnderwriteV21Outcome => ({
    recordId: listing.id,
    decision,
    lane: null,
    result: null,
    monthlyRent: null,
    taxes: null,
    taxSource: null,
    written: false,
    writeError: null,
    reprice: null,
  });

  // ── Priceability gate (mirrors the cron's candidate selection) ──────
  const zip = (listing.zip ?? "").trim();
  const seededZips = opts.seededZips ?? (await listSeededZips().catch(() => new Set<string>()));
  const market = getMarketForListing({ state: listing.state, zip: listing.zip });
  const priceable = market?.buyer_params?.arv_pct_max != null && seededZips.has(zip);

  const decision = decideV21Write(
    {
      liveStatus: listing.liveStatus,
      yourMao: listing.yourMao,
      state: listing.state,
      zip: listing.zip,
      redFlags: listing.redFlags,
      distressBucket: listing.distressBucket,
      distressScore: listing.distressScore,
    },
    { priceable, allowReprice: opts.allowReprice },
  );
  if (!decision.write) return skip(decision);
  const lane = decision.lane;

  // ── Sourced inputs ──────────────────────────────────────────────────
  const addr = {
    address: listing.address ?? "",
    city: listing.city ?? "",
    state: listing.state ?? "",
    zip: listing.zip ?? "",
  };

  // Rent: stored preferred (free) unless re-price forces fresh.
  let monthlyRent: number | null = opts.forceFreshRent ? null : (listing.estimatedMonthlyRent ?? null);
  if (monthlyRent == null) {
    const rentEst = await getRentEstimate(addr, listing.id).catch(() => null);
    monthlyRent = rentEst?.rent ?? null;
  }

  // Taxes: same resolver precedence the cron uses (RentCast lane; ATTOM
  // null here — the fresh/reply paths don't pay for the ATTOM assessor).
  const rcTaxes = await getAnnualPropertyTaxes(addr, listing.id).catch(() => null);
  const rcAssessed = await getRentCastAssessedValue(addr, listing.id).catch(() => null);
  const taxResolution: TaxResolution = resolveAnnualTaxes({
    state: listing.state,
    confirmedTaxes: listing.confirmedTaxes,
    confirmedLabel: listing.confirmedTaxesSource,
    attomTaxes: null,
    attomAssessedValue: null,
    rentcastTaxes: rcTaxes,
    assessedValue: rcAssessed,
  });

  const cap = defaultInvestorCapFor(listing.state, listing.zip);
  const estRehab = (listing.estRehabMid ?? listing.estRehab ?? null) as number | null;
  const result: V21MaoResult = computeV21LandlordMao({
    monthlyRent,
    annualTaxes: taxResolution.annualTaxes,
    estRehab,
    capRate: cap,
  });

  let written = false;
  let writeError: string | null = null;
  let reprice: boolean | null = null;

  if (opts.apply && result.status === "ok" && result.yourMao != null) {
    // reprice flag: were we overwriting an existing number?
    reprice =
      typeof listing.yourMao === "number" && Number.isFinite(listing.yourMao) && listing.yourMao > 0;
    const marker = buildMaoV21Marker(
      {
        status: result.status,
        lane,
        yourMao: result.yourMao,
        investorMao: result.investorMao,
        cap: result.cap,
        rent: monthlyRent,
        taxes: taxResolution.annualTaxes,
      },
      new Date(),
    );
    try {
      await updateListingRecord(listing.id, {
        Your_MAO_V21: result.yourMao,
        Investor_MAO_V21: result.investorMao,
        Underwritten_MAO_Track: "landlord",
        Estimated_Monthly_Rent: monthlyRent,
        Verification_Notes: upsertMaoV21Marker(listing.notes ?? null, marker),
      });
      written = true;
    } catch (err) {
      writeError = err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200);
    }
  }

  return {
    recordId: listing.id,
    decision,
    lane,
    result,
    monthlyRent,
    taxes: taxResolution.annualTaxes,
    taxSource: taxResolution.source,
    written,
    writeError,
    reprice,
  };
}
