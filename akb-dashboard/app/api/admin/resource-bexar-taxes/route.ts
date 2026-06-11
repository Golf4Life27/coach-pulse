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
import { getAnnualPropertyTaxes, getRentCastAssessedValue } from "@/lib/rentcast";
import { fetchBexarCadTaxes, BEXAR_EFFECTIVE_TAX_RATE } from "@/lib/county-cad/bexar";
import { fetchRedfinPublicTaxes } from "@/lib/county-cad/redfin-public-facts";
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
  let verificationUrl: string | null = null;

  if (recordId) {
    const listing = await getListing(recordId);
    if (!listing) return NextResponse.json({ error: "listing_not_found", recordId }, { status: 404 });
    address = listing.address ?? "";
    city = listing.city ?? "";
    state = listing.state ?? "";
    zip = listing.zip ?? "";
    verificationUrl = listing.verificationUrl ?? null;
  }
  if (!address || !zip) {
    return NextResponse.json({ error: "missing_address_or_zip" }, { status: 400 });
  }

  const [rentCast, rentcastAssessed, bexar, redfin] = await Promise.all([
    getAnnualPropertyTaxes({ address, city, state, zip }, recordId ?? undefined).catch(() => null),
    getRentCastAssessedValue({ address, city, state, zip }, recordId ?? undefined).catch(() => null),
    fetchBexarCadTaxes({ address, city, zip }).catch((err) => ({
      directAnnualTaxes: null, assessedValue: null, derivedAnnualTaxes: null,
      recommendedAnnualTaxes: null, source: null,
      provenance: `bexar fetch threw: ${String(err).slice(0, 200)}`,
      rawExcerpt: null, url: null, firecrawlStatus: null,
      error: String(err).slice(0, 200),
    })),
    verificationUrl
      ? fetchRedfinPublicTaxes(verificationUrl).catch((err) => ({
          annualTaxes: null, year: null, assessedValue: null, source: null,
          provenance: `redfin fetch threw: ${String(err).slice(0, 200)}`,
          rawExcerpt: null, url: verificationUrl, firecrawlStatus: null,
          error: String(err).slice(0, 200),
        }))
      : Promise.resolve(null),
  ]);

  // RentCast-assessed-value-derived tax estimate as a CAD-grounded
  // fallback when the bcad.org scrape can't pin a direct number.
  // RentCast pulls `taxAssessments.<year>.value` from the county CAD,
  // and Bexar's combined effective rate is published. The derivation is
  // labeled clearly as derived (not direct), surfaced for operator
  // confirmation, NEVER auto-substituted into offer math.
  const rentcastDerivedTaxes =
    rentcastAssessed != null ? Math.round(rentcastAssessed * BEXAR_EFFECTIVE_TAX_RATE) : null;

  // Recommendation precedence (highest → lowest fidelity):
  //   1. Redfin Public Facts (CAD-sourced via Redfin's listing-detail
  //      tax history table — most reliable when verificationUrl is set).
  //   2. Direct Bexar CAD scrape (when search.bcad.org renders the
  //      detail page; today returns "Domain not found").
  //   3. RentCast assessedValue × Bexar effective rate (CAD-grounded
  //      derivation; explicit operator confirmation still required).
  //   4. Bexar scraped-assessed × rate.
  //   5. null → HOLD.
  const recommendedAnnualTaxes =
    redfin?.annualTaxes ??
    bexar.directAnnualTaxes ??
    rentcastDerivedTaxes ??
    bexar.derivedAnnualTaxes ??
    null;
  const recommendedSource =
    redfin?.annualTaxes != null
      ? "redfin_public_facts_cad_sourced"
      : bexar.directAnnualTaxes != null
        ? "bexar_cad_direct"
        : rentcastDerivedTaxes != null
          ? "rentcast_assessed_x_bexar_effective_rate"
          : bexar.derivedAnnualTaxes != null
            ? "bexar_scraped_assessed_x_rate"
            : null;

  console.log(
    `BEXAR_TAXES ${recordId ?? "(adhoc)"} ${address} zip=${zip} rc_pt=${rentCast ?? "-"} ` +
    `rc_assessed=${rentcastAssessed ?? "-"} rc_derived=${rentcastDerivedTaxes ?? "-"} ` +
    `bex_direct=${bexar.directAnnualTaxes ?? "-"} bex_assessed=${bexar.assessedValue ?? "-"} ` +
    `recommended=${recommendedAnnualTaxes ?? "-"} src=${recommendedSource ?? "-"}`,
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
    note: "REPORT ONLY — no Airtable writes. Confirm against bcad.org, then pass to /api/admin/landlord-mao via ?taxes_override=recId:N.",
    recordId,
    address, city, state, zip,
    rentcast: {
      annualTaxes: rentCast,
      assessedValue: rentcastAssessed,
      derivedAnnualTaxes: rentcastDerivedTaxes,
      derivation_provenance: rentcastAssessed != null
        ? `RentCast assessedValue $${rentcastAssessed.toLocaleString()} × Bexar combined effective rate ${(BEXAR_EFFECTIVE_TAX_RATE * 100).toFixed(2)}% = $${rentcastDerivedTaxes?.toLocaleString()}/yr (CAD-grounded estimate, NOT a direct CAD tax total — confirm against bcad.org).`
        : "RentCast taxAssessments not available; no derivation possible.",
      note: "RentCast /properties.propertyTaxes is county-only on many Bexar records; understates the true combined load. The assessedValue (above) IS CAD-sourced and is a more reliable derivation basis.",
    },
    redfin_public_facts: redfin,
    bexar_cad_scrape: bexar,
    recommended: {
      annualTaxes: recommendedAnnualTaxes,
      source: recommendedSource,
      note:
        "Precedence: Redfin Public Facts (CAD-sourced) > direct Bexar scrape > RentCast assessedValue × Bexar effective rate > Bexar scraped assessed × rate. All PENDING operator confirmation against bcad.org.",
    },
    bexar_effective_rate_used_for_derivation: BEXAR_EFFECTIVE_TAX_RATE,
    elapsed_ms: Date.now() - t0,
  });
}
