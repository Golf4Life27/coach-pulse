// Three-way sold-comp benchmark — county ledger vs RentCast vs ATTOM.
// @agent: appraiser
//
// GET /api/admin/comp-benchmark            → run the known-truth gauntlet
// GET /api/admin/comp-benchmark?address=&city=&state=&zip=  → one subject
//
// READ-ONLY: no Airtable writes, no ARV stamps — pure evidence comparison.
// Per source and subject: comp count, newest sale date (the freshness
// question), qualifying count (≤0.5mi AND ≤365d), and the top rows so the
// operator can eyeball the receipts. Errors are surfaced verbatim —
// an ATTOM entitlement failure is an ANSWER, not a blank.
//
// Auth: dashboard session or the standard waterfall (paid calls behind it —
// RentCast + ATTOM bill per hit; the gauntlet is 5 subjects × ~3 calls).

import { NextResponse } from "next/server";
import { getSaleComparables, type RentCastSaleComp } from "@/lib/rentcast";
import { countyDeedSourceFor, getCountyDeedComps, censusGeocode } from "@/lib/comps/county-deeds";
import { getAttomSaleComps } from "@/lib/comps/attom-sales";
import {
  authenticate,
  hasDashboardSession,
  readAuthEnv,
  readAuthHeaders,
} from "@/lib/maverick/oauth/auth-waterfall";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";

export const runtime = "nodejs";
export const maxDuration = 120;

/** Known-truth gauntlet — addresses whose real evidence we have verified by
 *  hand this week. Fortress (via 1122 West's pull) is the canary: a source
 *  is honest only if it shows ~$214,900 sold 2020, never the $267,500 ask. */
const GAUNTLET = [
  { address: "1122 West Ave SW", city: "Atlanta", state: "GA", zip: "30315" },
  { address: "7714 E Canfield St", city: "Detroit", state: "MI", zip: "48214" },
  { address: "139 Puritan St", city: "Highland Park", state: "MI", zip: "48203" },
  { address: "3534 Boulder Park Dr SW", city: "Atlanta", state: "GA", zip: "30331" },
  { address: "2208 Mayfield Ave SW", city: "Birmingham", state: "AL", zip: "35211" },
];

interface SourceReport {
  comps: number;
  newest_sale: string | null;
  qualifying_05mi_365d: number;
  top: Array<{ addr: string | null; price: number | null; sold: string | null; mi: number | null; sqft: number | null }>;
  error: string | null;
}

function summarize(comps: RentCastSaleComp[]): Omit<SourceReport, "error"> {
  const cutoff = new Date(Date.now() - 365 * 86_400_000).toISOString();
  const sorted = [...comps].sort((a, b) => (b.saleDate ?? "").localeCompare(a.saleDate ?? ""));
  return {
    comps: comps.length,
    newest_sale: sorted[0]?.saleDate?.slice(0, 10) ?? null,
    qualifying_05mi_365d: comps.filter(
      (c) => (c.saleDate ?? "") >= cutoff && (c.distance == null || c.distance <= 0.5),
    ).length,
    top: sorted.slice(0, 5).map((c) => ({
      addr: c.formattedAddress ?? null,
      price: c.price,
      sold: c.saleDate?.slice(0, 10) ?? null,
      mi: c.distance,
      sqft: c.squareFootage,
    })),
  };
}

async function runSource(fn: () => Promise<RentCastSaleComp[]>): Promise<SourceReport> {
  try {
    return { ...summarize(await fn()), error: null };
  } catch (err) {
    return { comps: 0, newest_sale: null, qualifying_05mi_365d: 0, top: [], error: String(err).slice(0, 300) };
  }
}

export async function GET(req: Request) {
  const cookieHeader = req.headers.get("cookie");
  if (!hasDashboardSession(cookieHeader)) {
    const env = readAuthEnv();
    const headers = readAuthHeaders(req);
    const authRequired = kvConfigured() || env.cronSecret !== null || env.bearerDevToken !== null;
    if (authRequired) {
      const auth = await authenticate(headers, env, kvProd);
      if (!auth.ok) {
        return NextResponse.json({ error: "unauthorized", reason: auth.reason }, { status: 401 });
      }
    }
  }

  const url = new URL(req.url);
  const single =
    url.searchParams.get("address") && url.searchParams.get("city") && url.searchParams.get("state") && url.searchParams.get("zip")
      ? [{
          address: url.searchParams.get("address")!,
          city: url.searchParams.get("city")!,
          state: url.searchParams.get("state")!,
          zip: url.searchParams.get("zip")!,
        }]
      : null;
  const subjects = single ?? GAUNTLET;

  const results = [];
  for (const s of subjects) {
    // Benchmark exercises UNPROMOTED county sources too — that's how a
    // candidate (e.g. Cuyahoga) earns its receipts before the operator
    // rules on promotion. Production routing only sees promoted sources.
    const countySource = countyDeedSourceFor(s.city, s.state, { includeUnpromoted: true });
    let geo: { lat: number; lng: number } | null = null;
    let geoError: string | null = null;
    try {
      geo = await censusGeocode(s.address, s.city, s.state, s.zip);
    } catch (err) {
      geoError = String(err).slice(0, 200);
    }

    const [county, rentcast, attom] = await Promise.all([
      countySource
        ? runSource(() => getCountyDeedComps(s, countySource))
        : Promise.resolve(null),
      runSource(() => getSaleComparables(s)),
      geo
        ? runSource(() => getAttomSaleComps(geo!.lat, geo!.lng))
        : Promise.resolve({ comps: 0, newest_sale: null, qualifying_05mi_365d: 0, top: [], error: geoError ?? "subject not geocodable" } as SourceReport),
    ]);

    results.push({
      subject: `${s.address}, ${s.city}, ${s.state} ${s.zip}`,
      county_ledger: county,
      county_market: countySource?.market ?? null,
      county_promoted: countySource?.promoted ?? null,
      rentcast_deeds: rentcast,
      attom_sales: attom,
    });
  }

  return NextResponse.json({
    ran_at: new Date().toISOString(),
    note: "Benchmark only — no ARV writes. qualifying = sale ≤365d AND ≤0.5mi (unknown distance passes). Promotion per market is an operator ruling.",
    results,
  });
}
