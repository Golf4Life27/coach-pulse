// Opener dry-run — the national-pricer EYEBALL surface (Maverick
// 2026-06-14). @agent: crier/appraiser
//
// Runs the per-market rough-opener pricer (lib/per-market-pricer) + the
// lowball-eligibility front gate (lib/lowball-eligibility) over the cohort
// and reports, per record, the opener number it WOULD send and whether the
// aggressive lowball gate lets it through — WITHOUT sending anything and
// WITHOUT a paid call (reads only already-stored ARV/list/rehab fields).
//
// This is the watched-first eyeball: Alex reads what the system would send
// across the cohort before any text fires. Sends stay behind
// H2_OUTREACH_HARD_DISABLE regardless — this route never sends and never
// writes; it only computes + reports.
//
// GET /api/admin/opener-dry-run
//   ?limit=N      cap records (default all)
//   ?zips=a,b     scope to ZIPs
//   ?eligible=1   only return per-record rows the lowball gate passed
//   ?sample=N     cap the per-record rows in the response (default 50;
//                 aggregates always cover the full scanned set)

import { NextResponse } from "next/server";
import { getListings } from "@/lib/airtable";
import { audit } from "@/lib/audit-log";
import { priceOpenerWithSeed } from "@/lib/opener-pricing";
import { evaluateLowballEligibility } from "@/lib/lowball-eligibility";
import { classifyHold } from "@/lib/pricing/hold-reason";
import { resolveCumulativeDom } from "@/lib/attom/cumulative-dom";
import { getMarketForListing, openerArvPctMax } from "@/lib/markets/registry";
import { resolveAnchorPct } from "@/lib/markets/anchor";
import { getZipArvSeed, type ZipArvSeed } from "@/lib/zip-arv-seed-store";
import {
  authenticate,
  hasDashboardSession,
  readAuthEnv,
  readAuthHeaders,
} from "@/lib/maverick/oauth/auth-waterfall";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";
import type { Listing } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300;

/** Approximate the live distress signals from stored cohort fields. The live
 *  crawler computes these fresh from Firecrawl (listing language) + rehab
 *  vision; over the existing cohort we proxy: intake distressScore stands in
 *  for listing-language distress, parsed redFlags for the vision read. DOM is
 *  exact. Labeled in the response so the proxy is never mistaken for live. */
function listingLanguageDistress(l: Listing): boolean {
  if (typeof l.distressScore === "number" && l.distressScore > 0) return true;
  const b = (l.distressBucket ?? "").toLowerCase();
  return b.includes("distress") || b.includes("motivated") || b.includes("high");
}
function visionDistress(l: Listing): boolean {
  const rf = l.redFlags ?? l.rehabRedFlags ?? null;
  if (Array.isArray(rf)) return rf.length > 0;
  if (typeof rf === "string") return rf.trim().length > 0 && rf.trim() !== "[]";
  return false;
}

export async function GET(req: Request) {
  const t0 = Date.now();
  const url = new URL(req.url);

  // ── Auth waterfall (mirror of the guarded crons) ──
  const cookieHeader = req.headers.get("cookie");
  let authKind = "none";
  if (hasDashboardSession(cookieHeader)) authKind = "dashboard_session";
  else {
    const env = readAuthEnv();
    const headers = readAuthHeaders(req);
    const authRequired = kvConfigured() || env.cronSecret !== null || env.bearerDevToken !== null;
    if (authRequired) {
      const auth = await authenticate(headers, env, kvProd);
      if (!auth.ok) return NextResponse.json({ error: "unauthorized", reason: auth.reason }, { status: 401 });
      authKind = auth.kind;
    }
  }

  const limitRaw = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : Infinity;
  const sampleRaw = Number(url.searchParams.get("sample"));
  const sampleCap = Number.isFinite(sampleRaw) && sampleRaw >= 0 ? Math.floor(sampleRaw) : 50;
  const eligibleOnly = url.searchParams.get("eligible") === "1";
  const zipScope = new Set(
    (url.searchParams.get("zips") ?? "").split(",").map((z) => z.trim()).filter((z) => /^\d{5}$/.test(z)),
  );

  let listings: Listing[];
  try {
    listings = await getListings();
  } catch (err) {
    return NextResponse.json(
      { error: "listings_fetch_failed", message: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }

  // Scope to records that have something to price (a list price) + optional
  // ZIP scope. We price the whole cohort, not just the send-ready slice, so
  // Alex sees the full picture of what national pricing produces.
  const scoped = listings.filter((l) => {
    if (zipScope.size > 0 && !(l.zip && zipScope.has(l.zip))) return false;
    return typeof l.listPrice === "number" && l.listPrice > 0;
  });

  const agg = {
    scanned: 0,
    priced: 0,
    held_no_inputs: 0,
    by_basis: { arv_buybox: 0, hold_no_value_basis: 0 } as Record<string, number>,
    by_confidence: {} as Record<string, number>,
    lowball_eligible: 0,
    lowball_not_eligible: 0,
    by_tier: {} as Record<string, number>,
    would_send_aggressive: 0, // eligible AND has an opener
    by_arv_source: { seed_renovated: 0, stored: 0, none: 0 } as Record<string, number>,
    seed_dont_price: 0,
    // reseed_flagged = "seed is BAD, re-pull could fix it" (low-confidence ARV
    // that tripped a guard). capped / arv_below_list = "guard fired" telemetry
    // (a STRONG seed correctly handling a deep-discount or over-ARV listing) —
    // NOT a re-seed signal. Kept distinct so the metric means what it says.
    reseed_flagged: 0,
    capped: 0,
    arv_below_list: 0,
    opener_sum: 0,
    opener_n: 0,
    // ── HOLD-reason instrument (operator volume-worry, 2026-06-28) ──
    // Of the records that HOLD, WHY and WHO owns the next step. The headline
    // (held_* below) answers "how much of the hold pile ever reaches my desk?"
    by_hold_reason: { needs_seed: 0, no_market_buybox: 0, seed_dont_price: 0, cash_no_pencil: 0, operator_review: 0 } as Record<string, number>,
    by_hold_owner: { auto_seed: 0, configure_market: 0, data_limited: 0, creative_lane: 0, operator: 0 } as Record<string, number>,
    // System-owned = auto-seed / cached-skip (no human reaches the desk).
    held_system_owned: 0,
    // Needs attention = creative-lane pipeline / one-time market config / operator.
    held_needs_attention: 0,
    // ── PRE-SEND CORROBORATION GATE instrument (reliability build, 2026-07-23) ──
    // How many computed openers the allowlist gate HELD, and on which signal.
    // A computed opener that the gate holds = a number that would have sent under
    // the old blocklist model. Watch this to calibrate the gate thresholds.
    failed_corroboration: 0,
    by_corroboration_flag: {} as Record<string, number>,
  };
  const rows: Array<Record<string, unknown>> = [];
  const anchorCache = new Map<string, number>();
  // Per-ZIP renovated-comp seed cache (source-swap away from contaminated
  // stored ARV). Loaded once per ZIP; null when the ZIP isn't seeded yet.
  const seedCache = new Map<string, ZipArvSeed | null>();

  for (const l of scoped.slice(0, limit === Infinity ? scoped.length : limit)) {
    agg.scanned++;
    const market = getMarketForListing({ state: l.state, zip: l.zip });
    const marketId = market?.id ?? "";
    let anchorPct = anchorCache.get(marketId);
    if (anchorPct == null) {
      anchorPct = await resolveAnchorPct(marketId || null);
      anchorCache.set(marketId, anchorPct);
    }

    if (l.zip && !seedCache.has(l.zip)) {
      seedCache.set(l.zip, await getZipArvSeed(l.zip).catch(() => null));
    }
    const seed = l.zip ? seedCache.get(l.zip) ?? null : null;
    if (seed?.dontPrice) agg.seed_dont_price++;
    const pricedW = priceOpenerWithSeed({
      listPrice: l.listPrice ?? null,
      storedArv: l.realArvMedian ?? null,
      storedArvConfidence: l.arvConfidence ?? null,
      estRehabMid: l.estRehabMid ?? null,
      estRehab: l.estRehab ?? null,
      sqft: l.buildingSqFt ?? null,
      arvPctMax: openerArvPctMax(market, l.state),
      wholesaleFee: l.wholesaleFeeTarget ?? null,
      anchorPct,
      seed,
    });
    const priced = pricedW.result;

    const dom = resolveCumulativeDom({ mlsDomV2: l.dom });
    const lowball = evaluateLowballEligibility({
      cumulativeDom: dom.cumulativeDom,
      relistSuspected: dom.relistSuspected,
      listingLanguageDistress: listingLanguageDistress(l),
      visionDistress: visionDistress(l),
      visionConditionLabel: l.distressBucket ?? null,
    });

    agg.by_basis[priced.basis] = (agg.by_basis[priced.basis] ?? 0) + 1;
    agg.by_confidence[priced.confidence] = (agg.by_confidence[priced.confidence] ?? 0) + 1;
    agg.by_tier[lowball.tier] = (agg.by_tier[lowball.tier] ?? 0) + 1;
    agg.by_arv_source[pricedW.arvSource] = (agg.by_arv_source[pricedW.arvSource] ?? 0) + 1;
    if (priced.flagReseed) agg.reseed_flagged++;
    if (priced.cappedToList) agg.capped++;
    if (priced.arvDistrusted) agg.arv_below_list++;
    if (pricedW.basisLabel === "hold_failed_corroboration") {
      agg.failed_corroboration++;
      for (const f of pricedW.corroborationFlags) {
        agg.by_corroboration_flag[f] = (agg.by_corroboration_flag[f] ?? 0) + 1;
      }
    }
    if (priced.opener != null) {
      agg.priced++;
      agg.opener_sum += priced.opener;
      agg.opener_n++;
    } else {
      agg.held_no_inputs++;
    }
    if (lowball.eligible) agg.lowball_eligible++;
    else agg.lowball_not_eligible++;
    const wouldSend = lowball.eligible && priced.opener != null;
    if (wouldSend) agg.would_send_aggressive++;

    // HOLD-reason classification — only for actual holds (opener null).
    const hold = classifyHold({
      opener: priced.opener,
      arvDistrusted: priced.arvDistrusted,
      flooredToFallback: priced.flooredToFallback,
      flagReseed: priced.flagReseed,
      arvSource: pricedW.arvSource,
      seedDontPrice: !!seed?.dontPrice,
      marketHasBuybox: openerArvPctMax(market, l.state) != null,
    });
    if (hold.category !== "value_send") {
      agg.by_hold_reason[hold.category] = (agg.by_hold_reason[hold.category] ?? 0) + 1;
      agg.by_hold_owner[hold.owner] = (agg.by_hold_owner[hold.owner] ?? 0) + 1;
      if (hold.automatable) agg.held_system_owned++;
      else agg.held_needs_attention++;
    }

    if (eligibleOnly && !lowball.eligible) continue;
    if (rows.length < sampleCap) {
      rows.push({
        id: l.id,
        address: l.address ?? null,
        zip: l.zip ?? null,
        market: marketId || null,
        list_price: l.listPrice ?? null,
        arv: l.realArvMedian ?? null,
        opener: priced.opener,
        opener_basis: pricedW.basisLabel,
        arv_source: pricedW.arvSource,
        arv_used: pricedW.arvUsed,
        stored_arv: l.realArvMedian ?? null,
        seed_per_sqft: seed?.renovatedPerSqft ?? null,
        opener_confidence: priced.confidence,
        reseed_flagged: priced.flagReseed,
        opener_vs_list_pct: l.listPrice ? Math.round((100 * (priced.opener ?? 0)) / l.listPrice) : null,
        ceiling: priced.ceiling,
        anchor_pct: priced.anchorPct,
        cumulative_dom: dom.cumulativeDom,
        dom_source: dom.source,
        lowball_eligible: lowball.eligible,
        lowball_tier: lowball.tier,
        would_send_aggressive: wouldSend,
        hold_reason: hold.category === "value_send" ? null : hold.category,
        hold_owner: hold.category === "value_send" ? null : hold.owner,
        hold_detail: hold.category === "value_send" ? null : hold.detail,
        pricer_detail: priced.detail,
        lowball_detail: lowball.detail,
      });
    }
  }

  const avgOpener = agg.opener_n > 0 ? Math.round(agg.opener_sum / agg.opener_n) : null;

  // ── HOLD headline — "how much of the hold pile ever reaches my desk?" ──
  const heldTotal = agg.held_system_owned + agg.held_needs_attention;
  const holdHeadline = {
    sent: agg.priced,
    held_total: heldTotal,
    // No human reaches the desk: the crawler seeds it (→ becomes a send) or it's a cached skip.
    system_owned: agg.held_system_owned,
    pct_holds_system_owned: heldTotal > 0 ? Math.round((100 * agg.held_system_owned) / heldTotal) : null,
    // Owned elsewhere: creative/subject-to pipeline, a one-time market config, or genuine operator review.
    needs_attention: agg.held_needs_attention,
    by_owner: agg.by_hold_owner,
    by_reason: agg.by_hold_reason,
  };

  await audit({
    agent: "crier",
    event: "opener_dry_run",
    status: "confirmed_success",
    inputSummary: { auth_kind: authKind, scanned: agg.scanned, zips: [...zipScope] },
    outputSummary: {
      priced: agg.priced,
      would_send_aggressive: agg.would_send_aggressive,
      by_basis: agg.by_basis,
      hold_headline: holdHeadline,
      avg_opener: avgOpener,
      duration_ms: Date.now() - t0,
    },
  });

  return NextResponse.json({
    ok: true,
    note:
      "DRY-RUN report only. No texts sent, no records written, no paid calls. Opener numbers computed " +
      "from stored ARV/list/rehab via lib/per-market-pricer; lowball gate via lib/lowball-eligibility. " +
      "Distress signals over the existing cohort are PROXIED from stored distressScore/redFlags (the live " +
      "crawler computes them fresh from Firecrawl + vision); DOM is exact (mls_dom_v2, relist-aware).",
    auth_kind: authKind,
    duration_ms: Date.now() - t0,
    hold_headline: holdHeadline,
    aggregates: { ...agg, avg_opener: avgOpener },
    sample_rows: rows,
  });
}
