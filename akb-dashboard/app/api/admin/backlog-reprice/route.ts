// Review-backlog re-verify + re-price pass (Maverick 2026-06-15).
// @agent: scout/crier
//
// GET /api/admin/backlog-reprice
//   default          DRY-RUN: report the in-scope count + batch preview +
//                    estimated Firecrawl credits. No spend, no writes.
//   ?apply=1         re-verify liveness FIRST, then price the live ones.
//   ?limit=N         cap the batch (default 25 — the watched first slice;
//                    max 300).
//   ?state=MI        target state (default MI — Detroit metro only).
//   ?since=2026-06-09 created-on/after cutoff (default 2026-06-09).
//   ?zips=a,b        narrow to specific ZIPs.
//
// WHY: intake skips existing records as duplicates, so the ~hundreds already
// in the table never got an opener — blank Rough_Opener_Amount, can't send.
// This operates IN PLACE on existing record IDs.
//
// PER RECORD (apply): (1) Firecrawl liveness re-verify FIRST — known-URL
// re-scrape (1 credit) when a Verification_URL exists, else address discovery
// (2 credits). If no longer active → mark Dead (Live_Status=Off Market +
// Outreach_Status=Dead), NEVER priced or texted. (2) Only if live → price off
// the seed table via priceOpenerWithSeed (DONT_PRICE / unseeded ZIPs fall to
// flat 65%-of-list) and write Rough_Opener_Amount + Opener_Basis. Status stays
// Review — NO auto-promote; Alex reviews the priced batch before release.
//
// COST GUARD: the verify phase is gated by shouldHaltVerify (balance/breaker) —
// a drained wallet halts before any spend. Idempotent: already-priced records
// drop out of scope, so repeated runs never re-spend.

import { NextResponse } from "next/server";
import { getListings, updateListingRecord } from "@/lib/airtable";
import { audit } from "@/lib/audit-log";
import {
  authenticate,
  hasDashboardSession,
  readAuthEnv,
  readAuthHeaders,
} from "@/lib/maverick/oauth/auth-waterfall";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";
import { verifyListing, verifyListingByUrl, probeFirecrawlBalance } from "@/lib/crawler/sources/firecrawl";
import { checkFirecrawlBreaker, recordFirecrawlSpend, shouldHaltVerify } from "@/lib/crawler/firecrawl-circuit-breaker";
import { priceOpenerWithSeed } from "@/lib/opener-pricing";
import { getMarketForListing } from "@/lib/markets/registry";
import { resolveAnchorPct } from "@/lib/markets/anchor";
import { getZipArvSeed, type ZipArvSeed } from "@/lib/zip-arv-seed-store";
import {
  isReviewBacklogInScope,
  BACKLOG_DEFAULT_SINCE,
  BACKLOG_DEFAULT_STATE,
} from "@/lib/admin/backlog-reprice";
import type { Listing } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300;

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 300;
const BUDGET_MS = 180_000;

export async function GET(req: Request) {
  const t0 = Date.now();
  const url = new URL(req.url);

  // ── Auth waterfall (mirror of the guarded admin routes) ──
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

  const apply = url.searchParams.get("apply") === "1";
  const limitRaw = Number(url.searchParams.get("limit"));
  const limit = Math.min(MAX_LIMIT, Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : DEFAULT_LIMIT);
  const state = ((url.searchParams.get("state") ?? BACKLOG_DEFAULT_STATE).trim() || BACKLOG_DEFAULT_STATE).toUpperCase();
  const sinceRaw = (url.searchParams.get("since") ?? BACKLOG_DEFAULT_SINCE).trim();
  const sinceParsed = Date.parse(sinceRaw);
  const sinceMs = Number.isFinite(sinceParsed) ? sinceParsed : Date.parse(BACKLOG_DEFAULT_SINCE);
  const zips = new Set(
    (url.searchParams.get("zips") ?? "").split(",").map((z) => z.trim()).filter((z) => /^\d{5}$/.test(z)),
  );

  let all: Listing[];
  try {
    all = await getListings();
  } catch (err) {
    return NextResponse.json({ error: "listings_fetch_failed", message: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }

  const inScope = all.filter((l) => isReviewBacklogInScope(l, { sinceMs, state, zips }));
  // Oldest-first so a capped slice drains the stalest records first.
  inScope.sort((a, b) => (Date.parse(a.createdTime ?? "") || 0) - (Date.parse(b.createdTime ?? "") || 0));
  const batch = inScope.slice(0, limit);
  const withUrl = batch.filter((l) => !!(l.verificationUrl && l.verificationUrl.trim())).length;
  // Estimated credits: 1 per known-URL re-scrape, 2 per address discovery.
  const estCredits = withUrl * 1 + (batch.length - withUrl) * 2;

  const scope = { state, since: new Date(sinceMs).toISOString(), zips: [...zips] };

  if (!apply) {
    return NextResponse.json({
      ok: true,
      mode: "dry_run",
      note: "No spend, no writes. ?apply=1 to run. Liveness re-verify FIRST (dead → marked Dead, never priced); live → priced off the seed table; status stays Review (no auto-promote).",
      auth_kind: authKind,
      scope,
      in_scope_total: inScope.length,
      batch_size: batch.length,
      batch_with_url: withUrl,
      estimated_firecrawl_credits: estCredits,
      batch: batch.slice(0, 50).map((l) => ({
        recordId: l.id, address: l.address, zip: l.zip, createdTime: l.createdTime ?? null,
        list_price: l.listPrice ?? null, has_url: !!(l.verificationUrl && l.verificationUrl.trim()),
      })),
      duration_ms: Date.now() - t0,
    });
  }

  // ── VERIFY-GATE (balance/breaker) — never spend into a drained wallet ──
  let preBalance: number | null = null;
  if (batch.length > 0) {
    try { preBalance = (await probeFirecrawlBalance()).remaining; } catch { preBalance = null; }
  }
  const breaker = await checkFirecrawlBreaker();
  const haltVerdict = shouldHaltVerify({ breakerTripped: breaker.tripped, balanceRemaining: preBalance });
  if (haltVerdict.halt) {
    await audit({
      agent: "scout",
      event: "backlog_reprice_halted",
      status: "confirmed_failure",
      inputSummary: { reason: haltVerdict.reason, balance_remaining: preBalance, spent_recent_hour: breaker.spentRecent, in_scope: inScope.length },
      outputSummary: { halted: true },
      decision: `verify_phase_halted_on_${haltVerdict.reason}`,
    });
    return NextResponse.json({
      ok: true,
      mode: "halted",
      reason: haltVerdict.reason,
      note: haltVerdict.balanceUnhealthy
        ? "Firecrawl wallet ≤0 — verify phase skipped before any spend. Top up, then re-run."
        : "Firecrawl spend breaker tripped this hour — verify phase skipped. Retry next window.",
      auth_kind: authKind,
      scope,
      in_scope_total: inScope.length,
      balance_remaining: preBalance,
      duration_ms: Date.now() - t0,
    });
  }

  // ── Apply: liveness re-verify → price the live ones ──
  const seedCache = new Map<string, ZipArvSeed | null>();
  const anchorCache = new Map<string, number>();
  let creditsUsed = 0;
  let paymentRequired = false;
  let budgetHit = false;
  const results: Array<Record<string, unknown>> = [];

  for (const l of batch) {
    if (Date.now() - t0 > BUDGET_MS) { budgetHit = true; break; }
    if (!l.address || l.address.trim() === "") {
      results.push({ recordId: l.id, action: "skipped_no_address" });
      continue;
    }
    const iso = new Date().toISOString();

    // (1) LIVENESS re-verify FIRST.
    let fc;
    try {
      const hasUrl = !!(l.verificationUrl && l.verificationUrl.trim());
      fc = hasUrl ? await verifyListingByUrl(l.verificationUrl, l.address) : await verifyListing(l.address);
    } catch (err) {
      results.push({ recordId: l.id, address: l.address, action: "verify_error", error: String(err).slice(0, 160) });
      continue;
    }
    creditsUsed += fc.creditsUsed;
    if (fc.paymentRequired) {
      paymentRequired = true;
      results.push({ recordId: l.id, address: l.address, action: "payment_required", credits: fc.creditsUsed });
      break; // wallet emptied mid-run — stop
    }
    if (!fc.resolved) {
      // Infra miss — do NOT mark dead on an unresolved scrape; leave as-is.
      results.push({ recordId: l.id, address: l.address, action: "unresolved", credits: fc.creditsUsed, error: fc.error ?? null });
      continue;
    }

    // (2a) Not live → mark Dead. Never priced, never texted.
    if (!fc.stillActive) {
      try {
        await updateListingRecord(l.id, { Live_Status: "Off Market", Outreach_Status: "Dead", Last_Verified: iso });
        results.push({ recordId: l.id, address: l.address, zip: l.zip, action: "marked_dead", credits: fc.creditsUsed });
        await audit({
          agent: "scout", event: "backlog_reprice_dead", status: "confirmed_success", recordId: l.id, ms: 0,
          inputSummary: { url: l.verificationUrl ?? null }, outputSummary: { still_active: false, credits: fc.creditsUsed },
          decision: "marked_dead_delisted",
        });
      } catch (err) {
        results.push({ recordId: l.id, address: l.address, action: "dead_write_failed", error: String(err).slice(0, 160) });
      }
      continue;
    }

    // (2b) Live → price off the seed table.
    const market = getMarketForListing({ state: l.state, zip: l.zip });
    const marketId = market?.id ?? "";
    let anchorPct = anchorCache.get(marketId);
    if (anchorPct == null) { anchorPct = await resolveAnchorPct(marketId || null); anchorCache.set(marketId, anchorPct); }
    if (l.zip && !seedCache.has(l.zip)) seedCache.set(l.zip, await getZipArvSeed(l.zip).catch(() => null));
    const seed = l.zip ? seedCache.get(l.zip) ?? null : null;

    const pricedW = priceOpenerWithSeed({
      listPrice: l.listPrice ?? null,
      storedArv: l.realArvMedian ?? null,
      storedArvConfidence: l.arvConfidence ?? null,
      estRehabMid: l.estRehabMid ?? null,
      estRehab: l.estRehab ?? null,
      sqft: l.buildingSqFt ?? null,
      arvPctMax: market?.buyer_params?.arv_pct_max ?? null,
      wholesaleFee: l.wholesaleFeeTarget ?? null,
      anchorPct,
      seed,
    });
    const priced = pricedW.result;

    if (priced.opener == null) {
      // No list price (and no usable ARV) → can't compute an opener. Re-confirm
      // live but leave it unpriced + in Review for manual handling.
      try { await updateListingRecord(l.id, { Live_Status: "Active", Last_Verified: iso }); } catch { /* best-effort */ }
      results.push({ recordId: l.id, address: l.address, zip: l.zip, action: "live_no_opener", basis: priced.basis, credits: fc.creditsUsed });
      continue;
    }

    const fields: Record<string, unknown> = {
      Rough_Opener_Amount: priced.opener,
      Opener_Basis: pricedW.basisLabel,
      Live_Status: "Active",
      Last_Verified: iso,
      // Outreach_Status intentionally UNTOUCHED — stays Review (no auto-promote).
    };
    if (priced.flagReseed) fields["Opener_Reseed_Flag"] = true;
    try {
      await updateListingRecord(l.id, fields);
      results.push({
        recordId: l.id, address: l.address, zip: l.zip, action: "priced",
        opener: priced.opener, basis: pricedW.basisLabel, arv_source: pricedW.arvSource,
        opener_vs_list_pct: l.listPrice ? Math.round((100 * priced.opener) / l.listPrice) : null,
        reseed_flagged: priced.flagReseed, credits: fc.creditsUsed,
      });
      await audit({
        agent: "crier", event: "backlog_reprice_priced", status: "confirmed_success", recordId: l.id, ms: 0,
        inputSummary: { list_price: l.listPrice ?? null, zip: l.zip, arv_source: pricedW.arvSource },
        outputSummary: { opener: priced.opener, basis: pricedW.basisLabel, credits: fc.creditsUsed },
        decision: "opener_written_status_review",
      });
    } catch (err) {
      results.push({ recordId: l.id, address: l.address, action: "price_write_failed", error: String(err).slice(0, 160) });
    }
  }

  // Persist this run's spend into the rolling-hour breaker bucket.
  await recordFirecrawlSpend(creditsUsed);
  let postBalance: number | null = preBalance;
  try { postBalance = (await probeFirecrawlBalance()).remaining; } catch { /* keep pre */ }

  const summary = {
    attempted: results.length,
    priced: results.filter((r) => r.action === "priced").length,
    marked_dead: results.filter((r) => r.action === "marked_dead").length,
    live_no_opener: results.filter((r) => r.action === "live_no_opener").length,
    unresolved: results.filter((r) => r.action === "unresolved").length,
    errors: results.filter((r) => String(r.action).includes("error") || String(r.action).includes("failed")).length,
    credits_used: creditsUsed,
    payment_required: paymentRequired,
    budget_hit: budgetHit,
    pre_balance: preBalance,
    post_balance: postBalance,
  };

  await audit({
    agent: "scout", event: "backlog_reprice_run", status: "confirmed_success",
    inputSummary: { auth_kind: authKind, scope, batch_size: batch.length },
    outputSummary: summary,
  });

  return NextResponse.json({
    ok: true,
    mode: "apply",
    auth_kind: authKind,
    scope,
    in_scope_total: inScope.length,
    summary,
    results: results.slice(0, 60),
    duration_ms: Date.now() - t0,
  });
}
