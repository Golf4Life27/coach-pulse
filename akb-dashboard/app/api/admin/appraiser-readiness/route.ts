// Appraiser readiness diagnostic + Building_SqFt backfill.
// @agent: appraiser
//
// GET /api/admin/appraiser-readiness
//   ?apply_sqft=1   write Building_SqFt from RentCast for active records
//                   that are missing it (default: report only)
//   ?probe_url=...  Redfin URL to run the photo-scrape diagnostic against
//                   (default: probes up to 3 active records that have a
//                   Verification_URL)
//   ?limit=N        cap sqft-backfill writes per invocation (default 10)
//
// Two jobs in one read-mostly route:
//   1. PHOTO PROBE — runs `probeListingPhotos` so we can tell whether
//      the rehab pipeline's no_photos_available failures are systemic
//      (ScraperAPI key/quota, Redfin HTML change) or per-record.
//   2. Building_SqFt scale + backfill — counts active records missing
//      Building_SqFt / Verification_URL and (with ?apply_sqft=1) writes
//      Building_SqFt from RentCast's subject-facts endpoint.
//
// Auth: standard waterfall (dashboard cookie / CRON_SECRET / OAuth).
// Console-logs a flat PROBE.* / SQFT.* summary so a cron-fired
// invocation is fully observable in Vercel runtime logs (the log table
// truncates long lines, so each fact is its own short line).

import { NextResponse } from "next/server";
import { getActiveListingsForBrief, updateListingRecord } from "@/lib/airtable";
import { audit } from "@/lib/audit-log";
import {
  authenticate,
  hasDashboardSession,
  readAuthEnv,
  readAuthHeaders,
} from "@/lib/maverick/oauth/auth-waterfall";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";
import {
  probeListingPhotos,
  probeFirecrawlPhotos,
  probeRentCastPhotos,
} from "@/lib/photo-sources";
import { getSubjectFacts } from "@/lib/rentcast";
import type { Listing } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300;

const DEFAULT_SQFT_LIMIT = 10;
const DEFAULT_PROBE_RECORDS = 3;
// 924 Sunnyside — the record that 422'd with photos despite valid
// Building_SqFt + Verification_URL. Default probe target.
const DEFAULT_PROBE_URL =
  "https://www.redfin.com/TX/Dallas/924-Sunnyside-Ave-75211/home/32118136";

function hasSqft(l: Listing): boolean {
  return l.buildingSqFt != null && l.buildingSqFt > 0;
}
function hasUrl(l: Listing): boolean {
  return Boolean(l.verificationUrl && l.verificationUrl.trim() !== "");
}

export async function GET(req: Request) {
  const t0 = Date.now();

  // ── Auth waterfall ───────────────────────────────────────────────
  const cookieHeader = req.headers.get("cookie");
  let authKind = "none";
  if (hasDashboardSession(cookieHeader)) {
    authKind = "dashboard_session";
  } else {
    const env = readAuthEnv();
    const headers = readAuthHeaders(req);
    const authRequired = kvConfigured() || env.cronSecret !== null || env.bearerDevToken !== null;
    if (authRequired) {
      const auth = await authenticate(headers, env, kvProd);
      if (!auth.ok) {
        return NextResponse.json({ error: "unauthorized", reason: auth.reason }, { status: 401 });
      }
      authKind = auth.kind;
    }
  }

  const url = new URL(req.url);
  const applySqft = url.searchParams.get("apply_sqft") === "1";
  const probeUrl = url.searchParams.get("probe_url");
  const limitRaw = Number(url.searchParams.get("limit"));
  const sqftLimit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : DEFAULT_SQFT_LIMIT;

  let active: Listing[];
  try {
    active = await getActiveListingsForBrief();
  } catch (err) {
    return NextResponse.json(
      { error: "active_fetch_failed", message: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }

  // ── Building_SqFt / Verification_URL scale ───────────────────────
  const missingSqft = active.filter((l) => !hasSqft(l));
  const missingUrl = active.filter((l) => !hasUrl(l));
  const missingBoth = active.filter((l) => !hasSqft(l) && !hasUrl(l));

  // ── Photo probe ──────────────────────────────────────────────────
  // If a URL is given, probe just that. Otherwise probe the first N
  // active records that HAVE a Verification_URL (to gauge the scrape
  // path generally), plus the known 924 Sunnyside default.
  const probeTargets: Array<{ recordId: string | null; address: string | null; url: string }> = [];
  if (probeUrl) {
    probeTargets.push({ recordId: null, address: null, url: probeUrl });
  } else {
    probeTargets.push({ recordId: null, address: "924 Sunnyside (default)", url: DEFAULT_PROBE_URL });
    for (const l of active.filter(hasUrl).slice(0, DEFAULT_PROBE_RECORDS)) {
      probeTargets.push({ recordId: l.id, address: l.address, url: l.verificationUrl! });
    }
  }
  const probes = [];
  for (const t of probeTargets) {
    const p = await probeListingPhotos(t.url);
    const fc = await probeFirecrawlPhotos(t.url);
    probes.push({ ...t, probe: p, firecrawl: fc });
  }

  // ── RentCast photo probe (priority 1) ────────────────────────────
  // Probes per-record (uses the listing's address). For the default
  // probe (924 Sunnyside) we hard-code the address. The probe reports
  // whether RentCast's listings/sale or properties payload carries
  // photo URLs at all — if yes, we skip scraping entirely for those
  // records.
  const rentcastProbes = [];
  // Default probe: 924 Sunnyside Ave, Dallas, TX 75211.
  rentcastProbes.push({
    recordId: null as string | null,
    address: "924 Sunnyside Ave (default)",
    rentcast: await probeRentCastPhotos({
      address: "924 Sunnyside Ave",
      city: "Dallas",
      state: "TX",
      zip: "75211",
    }),
  });
  // Plus the first N active records with URL (gauge breadth).
  for (const l of active.filter(hasUrl).slice(0, DEFAULT_PROBE_RECORDS)) {
    if (!l.city || !l.state || !l.zip) continue;
    rentcastProbes.push({
      recordId: l.id,
      address: l.address,
      rentcast: await probeRentCastPhotos({
        address: l.address,
        city: l.city,
        state: l.state,
        zip: l.zip,
      }),
    });
  }
  // SUMMARY FIRST — Vercel's runtime-log indexer surfaces ONLY the first
  // console.log per request and truncates the message column to ~30
  // chars. Tight encoding so the verdict fits the visible window:
  //   P924 R{src}+{ls}/{prop} F{http}+{matches} S{http}+{matches}
  // R src codes: 0=none/null, L=listings_sale, P=properties.
  // 0=null/no-result, dashes mean errored.
  const firstProbe = probes[0];
  const firstRc = rentcastProbes[0]?.rentcast;
  const rcSrcCode =
    firstRc?.source === "listings_sale"
      ? "L"
      : firstRc?.source === "properties"
        ? "P"
        : "0";
  const tight =
    `P924 R${rcSrcCode}+${firstRc?.listings_sale_photo_count ?? "-"}/${firstRc?.properties_photo_count ?? "-"}` +
    ` F${firstProbe?.firecrawl.scrape_status ?? "-"}+${firstProbe?.firecrawl.img_match_count ?? "-"}/${firstProbe?.firecrawl.filtered_count ?? "-"}` +
    ` S${firstProbe?.probe.scraperapi_http_status ?? "-"}+${firstProbe?.probe.regex_match_count ?? "-"}`;
  console.log(tight);

  // Longer-form summary AFTER — used by the response body + audit row.
  // Not surfaced by the runtime-log MCP (tool only returns first log per
  // request), but the operator can read it from the JSON response when
  // hitting the endpoint with dashboard auth.
  const summary = {
    fc_url: probes.map((p) => ({
      key: p.firecrawl.firecrawl_key_present,
      http: p.firecrawl.scrape_status,
      html: p.firecrawl.html_length,
      md: p.firecrawl.markdown_length,
      matches: p.firecrawl.img_match_count,
      sample: p.firecrawl.sample_match?.slice(0, 100) ?? null,
      err: p.firecrawl.error,
    })),
    sa_url: probes.map((p) => ({
      key: p.probe.scraper_key_present,
      http: p.probe.scraperapi_http_status,
      matches: p.probe.regex_match_count,
      err: p.probe.error,
    })),
    rc: rentcastProbes.map((rp) => ({
      addr: rp.address,
      key: rp.rentcast.rentcast_key_present,
      ls_status: rp.rentcast.listings_sale_status,
      ls_photos: rp.rentcast.listings_sale_photo_count,
      props_status: rp.rentcast.properties_status,
      props_photos: rp.rentcast.properties_photo_count,
      source: rp.rentcast.source,
      sample: rp.rentcast.sample_photo?.slice(0, 100) ?? null,
      fields: rp.rentcast.photo_field_keys,
      err: rp.rentcast.error,
    })),
  };
  console.log(`SUMMARY ${JSON.stringify(summary)}`);

  // ── Building_SqFt backfill (apply mode) ──────────────────────────
  const sqftWrites: Array<{ recordId: string; address: string; written: number | null; source: string | null; error: string | null }> = [];
  if (applySqft) {
    for (const l of missingSqft.slice(0, sqftLimit)) {
      // Budget guard.
      if (Date.now() - t0 > 240_000) break;
      try {
        const facts = await getSubjectFacts({
          address: l.address,
          city: l.city ?? "",
          state: l.state ?? "",
          zip: l.zip ?? "",
        });
        if (facts.squareFootage != null) {
          await updateListingRecord(l.id, { Building_SqFt: facts.squareFootage });
          sqftWrites.push({ recordId: l.id, address: l.address, written: facts.squareFootage, source: facts.source, error: null });
        } else {
          sqftWrites.push({ recordId: l.id, address: l.address, written: null, source: facts.source, error: "rentcast_no_sqft" });
        }
      } catch (err) {
        sqftWrites.push({ recordId: l.id, address: l.address, written: null, source: null, error: String(err).slice(0, 200) });
      }
    }
  }
  const sqftWritten = sqftWrites.filter((w) => w.written != null).length;
  console.log(`SQFT.active_total=${active.length}`);
  console.log(`SQFT.missing_sqft=${missingSqft.length}`);
  console.log(`SQFT.missing_url=${missingUrl.length}`);
  console.log(`SQFT.missing_both=${missingBoth.length}`);
  console.log(`SQFT.applied=${applySqft}`);
  console.log(`SQFT.written=${sqftWritten}`);

  await audit({
    agent: "appraiser",
    event: "appraiser_readiness",
    status: "confirmed_success",
    inputSummary: { auth_kind: authKind, apply_sqft: applySqft, sqft_limit: sqftLimit },
    outputSummary: {
      active_total: active.length,
      missing_sqft: missingSqft.length,
      missing_url: missingUrl.length,
      missing_both: missingBoth.length,
      sqft_written: sqftWritten,
      probe_count: probes.length,
      // Full photo-probe verdict (truncated samples) so the audit row
      // carries the readiness signal — runtime-log indexer collapses
      // multi-line console.log to one row, so this is how we surface
      // RentCast/Firecrawl/ScraperAPI breakdowns off-cron.
      photo_verdict: summary,
    },
    ms: Date.now() - t0,
  });

  return NextResponse.json({
    ok: true,
    auth_kind: authKind,
    active_total: active.length,
    sqft_scale: {
      missing_sqft: missingSqft.length,
      missing_sqft_records: missingSqft.map((l) => ({ recordId: l.id, address: l.address })),
      missing_url: missingUrl.length,
      missing_both: missingBoth.length,
    },
    sqft_backfill: { applied: applySqft, written: sqftWritten, results: sqftWrites },
    photo_probes: probes,
    rentcast_photo_probes: rentcastProbes,
    duration_ms: Date.now() - t0,
  });
}
