// Bexar CAD tax re-source — REPORT ONLY (2026-06-05).
// @agent: appraiser
//
// GET /api/admin/resource-bexar-taxes?recordId=rec...
//   ...or ?address=...&city=...&zip=...
//
// Pulls the annual property tax total from Bexar CAD via Firecrawl and
// reports it alongside the existing RentCast value + a derived sanity
// estimate. Writes NOTHING — the operator confirms the number against
// bcad.org before it drives any offer math. Pass the confirmed number
// to /api/admin/landlord-mao via ?taxes_override=<n>.
//
// Auth: /api/admin/* convention (Vercel deployment layer).

import { NextResponse } from "next/server";
import { getListing } from "@/lib/airtable";
import { getAnnualPropertyTaxes } from "@/lib/rentcast";
import { fetchBexarCadTaxes, BEXAR_EFFECTIVE_TAX_RATE } from "@/lib/county-cad/bexar";
import { audit } from "@/lib/audit-log";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(req: Request) {
  const t0 = Date.now();
  const url = new URL(req.url);
  const recordId = url.searchParams.get("recordId");

  let address = url.searchParams.get("address") ?? "";
  let city = url.searchParams.get("city") ?? "";
  let state = url.searchParams.get("state") ?? "";
  let zip = url.searchParams.get("zip") ?? "";

  if (recordId) {
    const listing = await getListing(recordId);
    if (!listing) return NextResponse.json({ error: "listing_not_found", recordId }, { status: 404 });
    address = listing.address ?? "";
    city = listing.city ?? "";
    state = listing.state ?? "";
    zip = listing.zip ?? "";
  }
  if (!address || !zip) {
    return NextResponse.json({ error: "missing_address_or_zip" }, { status: 400 });
  }

  const [rentCast, bexar] = await Promise.all([
    getAnnualPropertyTaxes({ address, city, state, zip }).catch(() => null),
    fetchBexarCadTaxes({ address, city, zip }).catch((err) => ({
      directAnnualTaxes: null, assessedValue: null, derivedAnnualTaxes: null,
      recommendedAnnualTaxes: null, source: null,
      provenance: `bexar fetch threw: ${String(err).slice(0, 200)}`,
      rawExcerpt: null, url: null, firecrawlStatus: null,
      error: String(err).slice(0, 200),
    })),
  ]);

  console.log(
    `BEXAR_TAXES ${recordId ?? "(adhoc)"} ${address} zip=${zip} rc=${rentCast ?? "-"} ` +
    `bex_direct=${bexar.directAnnualTaxes ?? "-"} bex_assessed=${bexar.assessedValue ?? "-"} ` +
    `bex_derived=${bexar.derivedAnnualTaxes ?? "-"} src=${bexar.source ?? "-"}`,
  );

  await audit({
    agent: "appraiser",
    event: "bexar_cad_tax_resource",
    status: "confirmed_success",
    recordId: recordId ?? undefined,
    inputSummary: { address, city, zip },
    outputSummary: {
      rentcast_taxes: rentCast,
      bexar_direct: bexar.directAnnualTaxes,
      bexar_derived: bexar.derivedAnnualTaxes,
      bexar_source: bexar.source,
    },
    ms: Date.now() - t0,
  });

  return NextResponse.json({
    ok: true,
    note: "REPORT ONLY — no Airtable writes. Confirm against bcad.org, then pass to /api/admin/landlord-mao via ?taxes_override=<n>.",
    recordId,
    address, city, state, zip,
    rentcast: {
      annualTaxes: rentCast,
      note: "RentCast /properties.propertyTaxes — county-only on many Bexar records; understates the true combined load.",
    },
    bexar_cad: bexar,
    bexar_effective_rate_used_for_derivation: BEXAR_EFFECTIVE_TAX_RATE,
    elapsed_ms: Date.now() - t0,
  });
}
