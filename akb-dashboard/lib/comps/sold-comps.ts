// The ONE sold-comp faucet. @agent: appraiser
//
// Every ARV consumer drinks from here. Routing:
//   1. County deed ledger (open government data) where a registry source is
//      authoritative for the subject's city — freshest and free (Detroit:
//      deed transfers days old vs the vendor's ~9-12 month lag).
//   2. RentCast property records (deed data, stale but nationwide)
//      everywhere else, and as the fallback when county INFRASTRUCTURE
//      fails (geocoder down, ArcGIS error).
//
// An honest zero from the county source is FINAL for that pull — stale
// vendor data must never paper over a real "no recent arm's-length sales
// near this subject". Only thrown errors fall back.

import { getSaleComparables, type RentCastSaleComp, type CompPullWiden } from "@/lib/rentcast";
import { countyDeedSourceFor, getCountyDeedComps } from "@/lib/comps/county-deeds";
import { audit } from "@/lib/audit-log";

export interface SoldCompInput {
  address: string;
  city: string;
  state: string;
  zip: string;
  bedrooms?: number | null;
  bathrooms?: number | null;
  squareFootage?: number | null;
}

export async function getSoldComps(
  input: SoldCompInput,
  recordId?: string,
  widen?: CompPullWiden,
): Promise<RentCastSaleComp[]> {
  const source = countyDeedSourceFor(input.city, input.state);
  if (source) {
    try {
      const comps = await getCountyDeedComps(input, source, widen?.daysOld ?? 400);
      await audit({
        agent: "appraiser",
        event: "county_deed_comp_pull",
        status: "confirmed_success",
        recordId,
        inputSummary: { market: source.market, address: input.address },
        outputSummary: { comps: comps.length, source: "county_deeds", cost: 0 },
      });
      return comps;
    } catch (err) {
      // Infrastructure failure only — the vendor path is better than a dead
      // pull, and the audit row makes the degradation visible, never silent.
      await audit({
        agent: "appraiser",
        event: "county_deed_comp_pull",
        status: "confirmed_failure",
        recordId,
        inputSummary: { market: source.market, address: input.address },
        outputSummary: { fallback: "rentcast_property_records" },
        error: String(err).slice(0, 200),
      });
    }
  }
  return getSaleComparables(input, recordId, widen);
}
