// INV-022 Sprint 3 — federation cron orchestration pure helpers.
// @agent: data_federation
//
// The testable core of /api/cron/data-federation-pull: per-vendor outcome
// → Hydration_Status, and the Memphis assignment-clause detector. Network
// orchestration (the actual vendor calls + Airtable upsert) lives in the
// route; these pure functions carry the partial-failure-isolation tests.

import type { HydrationStatus } from "@/lib/property-intel";
import { buildDiscrepancyFlags } from "@/lib/maverick/property-intel-hydrate";
import {
  rentcastBudgetAllows,
  type RentcastHydrateInput,
  type RentcastHydrateResult,
} from "@/lib/federation/rentcast-hydrate";
import type {
  HydrationContribution,
  PhotoContribution,
} from "@/lib/federation/property-intel-store";
import { shouldPullFlood } from "@/lib/fema-flood";

/** Outcome of attempting one vendor for one record.
 *  - ok            : pull succeeded, data persisted
 *  - failed        : pull threw / errored
 *  - skipped_budget: intentionally not attempted (RentCast budget exhausted)
 *  - skipped_cache : intentionally not attempted (static data already present,
 *                    e.g. flood zone) — neutral, not a failure */
export type VendorOutcome = "ok" | "failed" | "skipped_budget" | "skipped_cache";

export interface VendorOutcomes {
  rentcast: VendorOutcome;
  photos: VendorOutcome;
  flood: VendorOutcome;
}

/** Pure: derive Hydration_Status from per-vendor outcomes. Partial-failure
 *  isolation means one vendor's failure never blocks another — the status
 *  reflects what actually succeeded.
 *
 *  - skipped_cache is neutral (the datum is already fresh; not an attempt).
 *  - "attempts" = vendors that were ok / failed / skipped_budget.
 *  - all attempts ok (or nothing attempted, everything cached) → complete
 *  - some ok + some failed/skipped_budget               → partial
 *  - all attempts failed/skipped_budget, zero ok        → failed */
export function summarizeHydrationStatus(o: VendorOutcomes): HydrationStatus {
  const outcomes = [o.rentcast, o.photos, o.flood];
  const attempts = outcomes.filter((x) => x !== "skipped_cache");
  if (attempts.length === 0) return "complete"; // everything already fresh
  const okCount = attempts.filter((x) => x === "ok").length;
  const notOkCount = attempts.length - okCount;
  if (okCount === 0) return "failed";
  if (notOkCount > 0) return "partial";
  return "complete";
}

/** Pure: does the Memphis assignment-clause hard precondition apply to this
 *  record? TN + a Memphis-area city. Conservative substring match on city. */
export function memphisAssignmentApplies(
  state: string | null | undefined,
  city: string | null | undefined,
): boolean {
  if (!state || !city) return false;
  return state.trim().toUpperCase() === "TN" && /memphis/i.test(city);
}

// ── Per-record orchestration (dependency-injected for testability) ──

export interface HydrateRecordInput {
  address: string;
  city: string | null;
  state: string | null;
  zip: string | null;
  bedrooms?: number | null;
  bathrooms?: number | null;
  buildingSqFt?: number | null;
  verificationUrl?: string | null;
  contractOfferPrice?: number | null;
  /** flood zone already on the Property_Intel row (cache); null if none. */
  existingFloodZone: string | null;
  /** RentCast credits available to this record's hydration. */
  rentcastBudgetRemaining: number;
}

/** Injected vendor callables — real impls in the route, mocks in tests. */
export interface HydrateRecordDeps {
  hydrateValuation: (input: RentcastHydrateInput) => Promise<RentcastHydrateResult>;
  hydratePhotos: (input: {
    verificationUrl: string | null;
    fullAddress: string;
  }) => Promise<PhotoContribution | null>;
  getFloodZoneByAddress: (address: string) => Promise<string | null>;
}

export interface HydrateRecordResult {
  contribution: HydrationContribution;
  outcomes: VendorOutcomes;
  status: HydrationStatus;
  creditsSpent: number;
}

/** Orchestrate one record's hydration across the three v1 vendors with
 *  partial-failure isolation: each vendor in its own try/catch; one
 *  vendor's failure never blocks another. Returns the assembled
 *  contribution + per-vendor outcomes + derived Hydration_Status. Does NO
 *  Airtable I/O — the caller persists via upsertPropertyIntel. Vendor calls
 *  are injected so tests can fail one deterministically. */
export async function hydrateRecord(
  input: HydrateRecordInput,
  deps: HydrateRecordDeps,
  now: Date = new Date(),
): Promise<HydrateRecordResult> {
  const contribution: HydrationContribution = {};
  const errors: string[] = [];
  let creditsSpent = 0;

  const hasAddressParts = Boolean(
    input.address && input.city && input.state && input.zip,
  );
  const fullAddress = [input.address, input.city, input.state, input.zip]
    .filter(Boolean)
    .join(", ");

  // RentCast (budget-gated)
  let rentcast: VendorOutcome;
  if (!hasAddressParts) {
    rentcast = "failed";
  } else if (rentcastBudgetAllows(input.rentcastBudgetRemaining).allowed) {
    try {
      const rc = await deps.hydrateValuation({
        address: input.address,
        city: input.city!,
        state: input.state!,
        zip: input.zip!,
        bedrooms: input.bedrooms,
        bathrooms: input.bathrooms,
        squareFootage: input.buildingSqFt,
      });
      creditsSpent += rc.creditsSpent;
      if (rc.valuation) contribution.valuation = rc.valuation;
      if (rc.rent) contribution.rent = rc.rent;
      if (rc.comps) contribution.comps = rc.comps;
      rentcast = rc.valuation || rc.rent || rc.comps ? "ok" : "failed";
    } catch (err) {
      rentcast = "failed";
      errors.push(`rentcast: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    rentcast = "skipped_budget";
  }

  // Photos (free; clean empty pull = ok, nothing written)
  let photos: VendorOutcome;
  if (!hasAddressParts) {
    photos = "failed";
  } else {
    try {
      const p = await deps.hydratePhotos({
        verificationUrl: input.verificationUrl ?? null,
        fullAddress,
      });
      if (p) contribution.photos = p;
      photos = "ok";
    } catch (err) {
      photos = "failed";
      errors.push(`photos: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // FEMA flood (free; static-per-parcel cache)
  let floodZone: string | null = input.existingFloodZone;
  let flood: VendorOutcome;
  if (!hasAddressParts) {
    flood = "failed";
  } else if (!shouldPullFlood(input.existingFloodZone)) {
    flood = "skipped_cache";
  } else {
    try {
      const zone = await deps.getFloodZoneByAddress(fullAddress);
      if (zone) {
        floodZone = zone;
        contribution.flood = {
          zone,
          source: "fema_nfhl",
          fetchedAt: now.toISOString(),
        };
        flood = "ok";
      } else {
        flood = "failed";
      }
    } catch (err) {
      flood = "failed";
      errors.push(`flood: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Discrepancy surface (Q5). Lien/owner inputs are v2 (PropStream) — omitted.
  contribution.discrepancy = buildDiscrepancyFlags(
    {
      asIsValue: contribution.valuation?.asIsValue ?? null,
      contractPrice: input.contractOfferPrice ?? null,
      femaFloodZone: floodZone,
      memphisAssignmentApplies: memphisAssignmentApplies(input.state, input.city),
    },
    now,
  );

  const outcomes: VendorOutcomes = { rentcast, photos, flood };
  const status = summarizeHydrationStatus(outcomes);
  contribution.hydrationStatus = status;
  contribution.lastHydratedAt = now.toISOString();

  return { contribution, outcomes, status, creditsSpent };
}
