// The ONE sold-comp faucet. @agent: appraiser
//
// Every ARV consumer drinks from here. Routing (ATTOM promoted 2026-07-19
// by operator ruling on benchmark receipts — 37/8/19/45 qualifying comps
// across the gauntlet vs RentCast's 1/0/1/0):
//   1. County deed ledger (open government data) where a registry source is
//      authoritative for the subject's city — freshest and free (Detroit:
//      deed transfers days old vs any vendor's lag).
//   2. ATTOM /sale/snapshot — PRIMARY everywhere without a county source,
//      and the infra-failure fallback for registry markets (still fresher
//      than RentCast's ~9-12 month deed lag).
//   3. RentCast property records — LAST RESORT only, entered on a thrown
//      ATTOM error (entitlement, network, subject not geocodable), and the
//      degradation is audited, never silent.
//
// An honest zero is FINAL at every step: a clean county or ATTOM pull with
// zero qualifying sales must never be papered over by a staler source's
// "no recent arm's-length sales near this subject". Only thrown errors
// fall through.

import { getSaleComparables, type RentCastSaleComp, type CompPullWiden } from "@/lib/rentcast";
import { countyDeedSourceFor, getCountyDeedComps, censusGeocode } from "@/lib/comps/county-deeds";
import { getAttomSaleComps } from "@/lib/comps/attom-sales";
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

/** ATTOM leg: /sale/snapshot queries by point, so the subject is geocoded
 *  first (same free Census geocoder as the county path). Throws on any
 *  failure — the caller audits the degradation and falls back. */
async function getAttomComps(
  input: SoldCompInput,
  recordId?: string,
  widen?: CompPullWiden,
): Promise<RentCastSaleComp[]> {
  const geo = await censusGeocode(input.address, input.city, input.state, input.zip);
  if (!geo) throw new Error("attom: subject not geocodable — vendor fallback");
  const days = widen?.daysOld ?? 400;
  return getAttomSaleComps(geo.lat, geo.lng, {
    radiusMiles: widen?.maxRadius,
    sinceIsoDate: new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10),
    recordId,
  });
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
      // Infrastructure failure only — ATTOM is next in line, and the audit
      // row makes the degradation visible, never silent.
      await audit({
        agent: "appraiser",
        event: "county_deed_comp_pull",
        status: "confirmed_failure",
        recordId,
        inputSummary: { market: source.market, address: input.address },
        outputSummary: { fallback: "attom_sale_snapshot" },
        error: String(err).slice(0, 200),
      });
    }
  }

  try {
    const comps = await getAttomComps(input, recordId, widen);
    await audit({
      agent: "appraiser",
      event: "attom_comp_pull",
      status: "confirmed_success",
      recordId,
      inputSummary: { address: input.address, city: input.city, state: input.state },
      outputSummary: { comps: comps.length, source: "attom_sale_snapshot", registryFallback: Boolean(source) },
    });
    return comps;
  } catch (err) {
    // Thrown ATTOM errors ONLY (auth/entitlement, network, geocode) reach
    // the vendor path — an ATTOM honest zero returned above is final.
    await audit({
      agent: "appraiser",
      event: "attom_comp_pull",
      status: "confirmed_failure",
      recordId,
      inputSummary: { address: input.address, city: input.city, state: input.state },
      outputSummary: { fallback: "rentcast_property_records" },
      error: String(err).slice(0, 200),
    });
  }
  return getSaleComparables(input, recordId, widen);
}
