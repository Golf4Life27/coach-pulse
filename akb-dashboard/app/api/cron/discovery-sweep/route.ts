// THE HUNTER — GET /api/cron/discovery-sweep
// @agent: scout
//
// Finds properties that fit the target, on Firecrawl, without spending a
// single RentCast call. This is the lane that was missing: every choke point
// diagnosed this week sat downstream of a top-of-funnel capped at ~30 ZIP
// scans/day because the crawl budget IS the RentCast plan divided by days.
//
// Per ZIP on the circuit leg:
//   1. ONE /v2/search for listing URLs (~1 credit).
//   2. Drop URLs already in Listings_V1 — dedup BEFORE spending a scrape.
//   3. Scrape each NEW url via verifyListingByUrl, which already extracts
//      price + sqft and runs every hard veto (~1 credit each).
//   4. Screen against lib/buy-box.
//   5. Report qualifiers. Enrichment (the RentCast agent-phone call) is a
//      SEPARATE step and deliberately not done here.
//
// DRY RUN BY DEFAULT. `?apply=1` is accepted but currently changes nothing
// except the audit label — this lane reports what it FOUND before it is
// trusted to write records, because whether the portals return usable listing
// rows for a ZIP-level query is unproven. The first live run is the probe.

import { NextResponse } from "next/server";
import { audit } from "@/lib/audit-log";
import { getListings } from "@/lib/airtable";
import { kvProd, kvConfigured } from "@/lib/maverick/oauth/kv";
import { readAuthEnv, readAuthHeaders, authenticate, hasDashboardSession } from "@/lib/maverick/oauth/auth-waterfall";
import { verifyListingByUrl } from "@/lib/crawler/sources/firecrawl";
import { selectNextLeg, type MetroCircuitRow } from "@/lib/crawler/metro-circuit";
import {
  buildZipSearchQuery,
  isListingUrl,
  screenCandidate,
  summarizeScreens,
  type SweepCandidate,
  type SweepScreen,
} from "@/lib/crawler/discovery-sweep";
import { METRO_ZIPS } from "@/lib/crawler/metro-zips";
import {
  parseAddressFromListingUrl,
  isTextable,
  summarizeEnrichment,
  findMatchingListing,
  type EnrichOutcome,
} from "@/lib/crawler/sweep-enrich";
import { fetchListingsByZip } from "@/lib/crawler/sources/rentcast";
import { buildIntakeListingFields } from "@/lib/crawler/intake-fields";

const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID || "appp8inLAGTg4qpEZ";
const AIRTABLE_LISTINGS_TABLE = process.env.AIRTABLE_LISTINGS_TABLE || "tbldMjKBgPiq45Jjs";

export const runtime = "nodejs";
export const maxDuration = 300;

const FIRECRAWL_SEARCH_URL = "https://api.firecrawl.dev/v2/search";
/** URLs pulled per ZIP search. */
const SEARCH_LIMIT = 20;
/** Scrapes per RUN — the hard credit bound. Each is ~1 credit. */
const MAX_SCRAPES_PER_RUN = 40;
/** Leave the lambda room to write its audit row. */
const WALL_CLOCK_BUDGET_MS = 240_000;
/** RentCast lookups per run — the scarce-call bound. ONE per qualifier, and a
 *  qualifier has already cleared the buy box and every hard veto. At ~10/run
 *  and 8 runs/day this is bounded well under the daily plan share. */
const MAX_ENRICH_PER_RUN = Math.max(0, Number(process.env.SWEEP_MAX_ENRICH_PER_RUN) || 10);

const sweepKey = (zip: string) => `sweep:zip:${zip}`;
const SWEEP_TTL_S = 60 * 86_400;

export async function GET(req: Request) {
  const t0 = Date.now();
  const url = new URL(req.url);
  const dryRun = url.searchParams.get("apply") !== "1";
  const zipCap = Math.max(1, Number(url.searchParams.get("zips") ?? 8) || 8);

  // ── Auth: same waterfall as every other cron route ──
  let authKind = "session";
  if (!hasDashboardSession(req.headers.get("cookie"))) {
    const env = readAuthEnv();
    const auth = await authenticate(readAuthHeaders(req), env, kvProd);
    if (!auth.ok) return NextResponse.json({ error: "unauthorized", reason: auth.reason }, { status: 401 });
    authKind = auth.kind;
  }
  if (authKind === "cron" && process.env.MAVERICK_CRON_ENABLED !== "true") {
    return NextResponse.json({ error: "cron_disabled" }, { status: 503 });
  }
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "firecrawl_not_configured" }, { status: 503 });
  }

  // ── Pick the next stop on the circuit ──
  const rows: MetroCircuitRow[] = [];
  for (const { metro, zips } of METRO_ZIPS) {
    for (const zip of zips) {
      let lastSweptAt: string | null = null;
      if (kvConfigured()) {
        lastSweptAt = await kvProd.get(sweepKey(zip)).catch(() => null);
      }
      rows.push({ metro, zip, lastSweptAt });
    }
  }
  const leg = selectNextLeg(rows, new Date(), zipCap);
  if (!leg) {
    return NextResponse.json({ ok: true, skipped: true, reason: "no_metros_configured" });
  }

  // ── Known URLs — never pay to re-scrape what we already hold ──
  const known = new Set<string>();
  try {
    for (const l of await getListings()) {
      const u = (l.verificationUrl ?? "").trim().toLowerCase();
      if (u) known.add(u);
    }
  } catch {
    /* an unreadable table just means we re-scrape; never blocks the hunt */
  }

  const perZip: Array<{ zip: string; urls: number; new_urls: number; examined: number; qualified: number }> = [];
  const qualified: Array<{ url: string; zip: string; price: number | null; distress: string[] }> = [];
  const screens: SweepScreen[] = [];
  let searchCredits = 0;
  let scrapeCredits = 0;
  let scrapes = 0;
  const errors: Array<{ zip: string; error: string }> = [];

  for (const zip of leg.zips) {
    if (Date.now() - t0 > WALL_CLOCK_BUDGET_MS) break;
    const city = METRO_ZIPS.find((m) => m.zips.includes(zip));
    let urls: string[] = [];
    try {
      const res = await fetch(FIRECRAWL_SEARCH_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          query: buildZipSearchQuery(zip, city?.metro ?? null, city?.state ?? null),
          limit: SEARCH_LIMIT,
        }),
        cache: "no-store",
      });
      if (!res.ok) {
        errors.push({ zip, error: `search ${res.status}` });
        continue;
      }
      const body = (await res.json()) as { data?: { web?: Array<{ url?: string }> }; creditsUsed?: number };
      searchCredits += typeof body.creditsUsed === "number" ? body.creditsUsed : 0;
      urls = (body.data?.web ?? []).map((w) => (w.url ?? "").trim()).filter((u) => isListingUrl(u));
    } catch (e) {
      errors.push({ zip, error: e instanceof Error ? e.message.slice(0, 150) : String(e).slice(0, 150) });
      continue;
    }

    const fresh = urls.filter((u) => !known.has(u.toLowerCase()));
    let examinedHere = 0;
    let qualifiedHere = 0;

    for (const u of fresh) {
      if (scrapes >= MAX_SCRAPES_PER_RUN || Date.now() - t0 > WALL_CLOCK_BUDGET_MS) break;
      scrapes++;
      known.add(u.toLowerCase()); // never scrape the same url twice in a run
      // No known address — this IS the discovery step. A null address skips
      // the street-number confirmation, which only exists to prove a scraped
      // page matches a subject we already had.
      const fc = await verifyListingByUrl(u, null, { debug: true }).catch(() => null);
      if (!fc) continue;
      scrapeCredits += fc.creditsUsed ?? 0;
      if (!fc.resolved) continue;
      const candidate: SweepCandidate = {
        url: u,
        zip,
        city: city?.metro ?? null,
        price: fc.scrapedPrice ?? null,
        sqft: fc.scrapedSqft ?? null,
        text: fc.pageExcerpt ?? null,
        // Decided over the FULL page text by the shared classifier, not the
        // capped excerpt.
        hasDistressLanguage: fc.hasConditionSignal || (fc.matchedDistressKeywords?.length ?? 0) > 0,
        renovated: fc.hasRenovatedLanguage,
        newConstruction: fc.isNewConstruction,
        wholesalerExcluded: fc.wholesalerExcluded,
        stillActive: fc.stillActive,
      };
      const screen = screenCandidate(candidate);
      screens.push(screen);
      examinedHere++;
      if (screen.accept) {
        qualifiedHere++;
        qualified.push({ url: u, zip, price: candidate.price ?? null, distress: screen.distress });
      }
    }

    perZip.push({ zip, urls: urls.length, new_urls: fresh.length, examined: examinedHere, qualified: qualifiedHere });
    if (!dryRun && kvConfigured()) {
      await kvProd.setEx(sweepKey(zip), new Date().toISOString(), SWEEP_TTL_S).catch(() => {});
    }
  }

  // ── ENRICHMENT — the ONLY place a RentCast call is spent ────────────────
  // One lookup per QUALIFIER, never per scanned property. A qualifier has
  // already passed the buy box, the distress test and every hard veto, so this
  // is the call the old intake belt was spending blind on whole ZIPs.
  const enrichOutcomes: EnrichOutcome[] = [];
  // Verbatim Airtable failures — the sweep reported "record_write_failed" with
  // no detail for two days while the write URL was malformed.
  const writeErrors: string[] = [];
  if (!dryRun) {
    // ONE ZIP fetch per ZIP-with-qualifiers, then match locally. Strictly
    // cheaper than per-property (5 qualifiers in a ZIP cost 1 call, not 5) and
    // robust to the formatting variance that made the exact-address lookup
    // return no_rentcast_match on 4 of 5 qualifiers.
    const byZip = new Map<string, typeof qualified>();
    for (const q of qualified) {
      const list = byZip.get(q.zip) ?? [];
      list.push(q);
      byZip.set(q.zip, list);
    }

    for (const [zip, group] of byZip) {
      if (Date.now() - t0 > WALL_CLOCK_BUDGET_MS) break;
      let feed: Awaited<ReturnType<typeof fetchListingsByZip>> | null = null;
      try {
        feed = await fetchListingsByZip(zip);
      } catch {
        /* a vendor blip is a skip for this ZIP, never a failed run */
      }
      const feedCandidates = feed?.candidates ?? [];

      for (const q of group) {
        if (enrichOutcomes.filter((o) => o.recordId).length >= MAX_ENRICH_PER_RUN) {
          enrichOutcomes.push({ url: q.url, address: null, recordId: null, skipped: "enrich_budget_reached" });
          continue;
        }

        const parsed = parseAddressFromListingUrl(q.url);
        if (!parsed) {
          enrichOutcomes.push({ url: q.url, address: null, recordId: null, skipped: "url_unparseable" });
          continue;
        }

        const candidate = findMatchingListing(parsed.formatted, feedCandidates);
        if (!candidate) {
          // Address recorded so a repeat failure is diagnosable from the audit
          // row alone — the first run only said "no match" and could not say
          // what we asked for.
          enrichOutcomes.push({ url: q.url, address: parsed.formatted, recordId: null, skipped: "no_rentcast_match" });
          continue;
        }

        if (!isTextable(candidate.agentPhone)) {
        enrichOutcomes.push({ url: q.url, address: parsed.formatted, recordId: null, skipped: "no_agent_phone" });
        continue;
      }

      // Born H2-ready: same field builder intake uses, so a swept lead and an
      // intake lead are the SAME THING downstream and no gate has to learn
      // about two kinds. Verification_URL carries the page we already scraped,
      // so freshness and the off-market re-check work on it immediately.
      try {
        const fields = buildIntakeListingFields(candidate, {
          iso: new Date().toISOString(),
          promote: true,
          firecrawlUrl: q.url,
          portfolioDetected: false,
          matchedPortfolioKeywords: [],
          underwrittenMao: null,
          underwrittenMaoTrack: null,
          opener: null,
          renovatedLanguage: false,
          matchedRenovationKeywords: [],
        });
        // TABLE/BASE IDs (2026-08-07): this route was the ONLY file in the repo
        // reading AIRTABLE_LISTINGS_TABLE — every other writer hardcodes
        // tbldMjKBgPiq45Jjs. With that env var unset the URL resolved to
        // ".../undefined", so EVERY write 404'd and the sweep had never
        // persisted a record. Fall back to the known ids so this works whether
        // or not the vars exist.
        const res = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_LISTINGS_TABLE}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${process.env.AIRTABLE_PAT}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ records: [{ fields }], typecast: true }),
        });
        const raw = await res.text().catch(() => "");
        let body: { records?: Array<{ id: string }> } | null = null;
        try { body = JSON.parse(raw) as { records?: Array<{ id: string }> }; } catch { /* non-JSON error body */ }
        const recordId = body?.records?.[0]?.id ?? null;
        if (!recordId) {
          // SAY WHY. The previous version swallowed the response with
          // .catch(() => null), so a 404 from a malformed URL and a 422 from a
          // bad field looked identical — "record_write_failed" and nothing
          // else. A system that knows the reason must not report confusion.
          writeErrors.push(`${res.status} ${raw.slice(0, 300)}`);
        }
        enrichOutcomes.push({ url: q.url, address: parsed.formatted, recordId, skipped: recordId ? null : "record_write_failed" });
        } catch (err) {
          writeErrors.push(err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300));
          enrichOutcomes.push({ url: q.url, address: parsed.formatted, recordId: null, skipped: "record_write_failed" });
        }
      }
    }
  }

  const summary = {
    metro: leg.metro,
    zips_swept: perZip.length,
    enrichment: summarizeEnrichment(enrichOutcomes),
    write_errors: writeErrors.slice(0, 5),
    ...summarizeScreens(screens),
    qualified_urls: qualified.length,
    credits: { search: searchCredits, scrape: scrapeCredits, total: searchCredits + scrapeCredits },
    scrapes,
    errors: errors.length,
  };

  await audit({
    agent: "scout",
    event: dryRun ? "discovery_sweep_dry_run" : "discovery_sweep_live",
    status: errors.length > 0 && perZip.length === 0 ? "confirmed_failure" : "confirmed_success",
    inputSummary: { auth_kind: authKind, dry_run: dryRun, metro: leg.metro, zips: leg.zips.length },
    outputSummary: summary,
    ms: Date.now() - t0,
  });

  return NextResponse.json({
    ok: true,
    mode: dryRun ? "dry_run" : "apply",
    leg: { metro: leg.metro, zips: leg.zips, reason: leg.reason, age_days: leg.ageDays },
    summary,
    per_zip: perZip,
    qualified,
    errors,
    elapsed_ms: Date.now() - t0,
  });
}
