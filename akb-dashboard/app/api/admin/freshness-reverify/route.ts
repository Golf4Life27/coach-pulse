// Freshness re-verify pass (operator 2026-06-08, item 1).
//
// GET /api/admin/freshness-reverify
//   default        DRY-RUN: report which records are due for re-verify
//                  (active, has a cached Verification_URL, actionable
//                  market, Last_Verified stale/absent), oldest-first.
//   ?apply=1       re-scrape the known URL (1 Firecrawl credit each via
//                  verifyListingByUrl — NO discovery search), then stamp
//                  Last_Verified=now + Live_Status (Active / Off Market).
//   ?limit=N       cap re-verifies (default 15, max 50).
//   ?max_age_hours=N  freshness window (default 48).
//
// Purpose: keep the outreach-eligible set CONFIRMED-LIVE within the window
// without paying the 2-credit discovery search. A listing only becomes
// outreach-fresh (lib/outreach-freshness) after this pass re-confirms it
// Active. Paused/excluded markets are skipped — no credits on deals we
// can't price or assign (lib/markets/actionable).
//
// Auth: dashboard cookie / CRON_SECRET / OAuth waterfall.

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
import { verifyListingByUrl } from "@/lib/crawler/sources/firecrawl";
import { isPriceableMarket } from "@/lib/markets/actionable";
import { listSeededZips } from "@/lib/buyer-median-store";
import { listArvSeededZips } from "@/lib/zip-arv-seed-store";
import { isOutreachFresh, DEFAULT_FRESHNESS_HOURS } from "@/lib/outreach-freshness";
import { isH2Eligible } from "@/lib/h2-outreach";
import {
  isBumpReverifyCandidate,
  partitionReverifyBatch,
} from "@/lib/h2-outreach/bump-lane";
import type { Listing } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300;

const DEFAULT_LIMIT = 15;
const MAX_LIMIT = 50;
const BUDGET_MS = 180_000;

export async function GET(req: Request) {
  const t0 = Date.now();

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

  const url = new URL(req.url);
  const apply = url.searchParams.get("apply") === "1";
  const limitRaw = Number(url.searchParams.get("limit"));
  const limit = Math.min(MAX_LIMIT, Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : DEFAULT_LIMIT);
  const maxAgeRaw = Number(url.searchParams.get("max_age_hours"));
  const maxAgeHours = Number.isFinite(maxAgeRaw) && maxAgeRaw > 0 ? maxAgeRaw : DEFAULT_FRESHNESS_HOURS;
  // Scope: ?zips=48227,48228 (comma list) and/or ?state=MI restrict the pass
  // to a market. Empty = whole actionable cohort.
  const zipScope = new Set(
    (url.searchParams.get("zips") ?? "")
      .split(",")
      .map((z) => z.trim())
      .filter((z) => /^\d{5}$/.test(z)),
  );
  const stateScope = (url.searchParams.get("state") ?? "").trim().toUpperCase();
  const now = new Date();

  // Pool (2026-06-11 fix, spine recZNzKlsgtzlCLkY): was getActiveListingsForBrief
  // — Outreach_Status-BEARING records only — which made the entire status-EMPTY
  // first-touch supply invisible to the keep-warm pass. The 174-record
  // five-ZIP cohort went verify_stale with this route unable to even see it.
  // The pool is now "every record whose freshness MATTERS": H2-eligible
  // first-touch supply (status empty + Active + Auto Proceed + phone + v2,
  // via the same isH2Eligible the cron selects with — one gate, no drift)
  // plus the reply-bearing negotiation statuses the old pool carried.
  // 2026-07-09 budget fix: "Texted"/"Emailed" REMOVED from the keep-warm set.
  // They are not reply-bearing — they're one-and-done first touches whose
  // freshness serves nothing (they can't first-touch again; no bump lane
  // yet), and as the OLDEST stale records they consumed the entire daily
  // limit ahead of sendable supply: Mark Twain-class June records were
  // re-verified every 48h while the July first-touch cohort stranded at
  // depth 3 (7/08 probe: 41 verify_stale). Live threads stay warm; dead
  // air does not.
  // 2026-07-11 bump-lane re-admission (#33, spine recFYBbF5H9YU1GWm ruled
  // "re-admit THEN, budget-partitioned, not before" — the bump lane now
  // exists): Texted records regain a freshness consumer, but ONLY the
  // bump-waiting subset (silent v2 threads with bumps remaining whose next
  // bump lands inside the freshness window — isBumpReverifyCandidate), and
  // only at a MINORITY SHARE of each batch (partitionReverifyBatch): the
  // core pool (first-touch supply + live threads + liveness-unknown) keeps
  // ≥60% of the slots whenever it needs them. Exhausted/replied/DNT Texted
  // records stay out — dead air stays cold.
  const REPLY_BEARING = new Set(["Negotiating", "Response Received", "Counter Received", "Offer Accepted"]);
  let active: Listing[];
  let seededZips: Set<string>;
  try {
    let all: Listing[];
    // 2026-07-10 autopsy fix (the 43-stale cohort): this route filtered
    // markets against the LEGACY buyer-median store (10 Detroit ZIPs), so
    // every stale record outside Detroit was skipped as "non-priceable" by
    // EVERY freshness pass — the same wrong-store bug fixed in the send
    // path (PR #80). Priceability = the ARV seed store, unioned with the
    // legacy set.
    let arvZips: Set<string>;
    let medianZips: Set<string>;
    [all, arvZips, medianZips] = await Promise.all([getListings(), listArvSeededZips(), listSeededZips()]);
    seededZips = new Set<string>([...arvZips, ...medianZips]);
    // Third cohort (2026-07-09): untouched records whose Live_Status was
    // never stamped (6/30 Indy class) are invisible to isH2Eligible until
    // a verify pass writes Live_Status — which is exactly what THIS route
    // does. Admit them so they graduate into the sendable pool.
    const livenessUnknown = (l: Listing) =>
      (l.liveStatus ?? "").trim() === "" && (l.outreachStatus ?? "").trim() === "";
    active = all.filter(
      (l) =>
        isH2Eligible(l) ||
        REPLY_BEARING.has(l.outreachStatus ?? "") ||
        livenessUnknown(l) ||
        isBumpReverifyCandidate(l, now),
    );
  } catch (err) {
    return NextResponse.json({ error: "active_fetch_failed", message: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }

  // Candidate set: in the requested zip/state scope, has a cached URL, in a
  // PRICEABLE market (sourced arv_pct_max + seeded buyer-median — never spend
  // Firecrawl on a market we can't make an MAO-checked offer in), and NOT
  // currently outreach-fresh (stale or never re-verified).
  const skippedNonActionable: Array<{ recordId: string; reason: string }> = [];
  let outOfScope = 0;
  const candidates = active.filter((l) => {
    const zip = (l.zip ?? "").trim();
    if (zipScope.size > 0 && !zipScope.has(zip)) { outOfScope++; return false; }
    if (stateScope && (l.state ?? "").trim().toUpperCase() !== stateScope) { outOfScope++; return false; }
    if (!(l.verificationUrl && l.verificationUrl.trim() !== "")) return false;
    const market = isPriceableMarket({ state: l.state, city: l.city, zip: l.zip }, seededZips);
    if (!market.actionable) {
      skippedNonActionable.push({ recordId: l.id, reason: market.reason ?? "non_priceable" });
      return false;
    }
    return !isOutreachFresh({ lastVerified: l.lastVerified, liveStatus: l.liveStatus }, now, maxAgeHours).fresh;
  });

  // Oldest-first (never-verified = oldest).
  candidates.sort((a, b) => {
    const ta = a.lastVerified ? Date.parse(a.lastVerified) : -Infinity;
    const tb = b.lastVerified ? Date.parse(b.lastVerified) : -Infinity;
    return ta - tb;
  });
  // Budget partition (#33): bump-waiting Texted records take at most a
  // minority share of the batch; core supply (first-touch + live threads +
  // liveness-unknown) keeps priority. Spare core slots backfill with bumps.
  const bumpPool = candidates.filter((l) => isBumpReverifyCandidate(l, now));
  const corePool = candidates.filter((l) => !isBumpReverifyCandidate(l, now));
  const partition = partitionReverifyBatch(corePool, bumpPool, limit);
  const batch = partition.batch;

  if (!apply) {
    return NextResponse.json({
      ok: true,
      mode: "dry_run",
      auth_kind: authKind,
      max_age_hours: maxAgeHours,
      scope: { zips: [...zipScope], state: stateScope || null, out_of_scope: outOfScope },
      seeded_zips: [...seededZips],
      active_total: active.length,
      due_total: candidates.length,
      bump_partition: {
        bump_due: bumpPool.length,
        core_due: corePool.length,
        core_taken: partition.coreTaken,
        bump_taken: partition.bumpTaken,
      },
      skipped_non_priceable: skippedNonActionable.length,
      batch: batch.map((l) => ({ recordId: l.id, address: l.address, state: l.state, zip: l.zip, lastVerified: l.lastVerified ?? null, url: l.verificationUrl })),
      duration_ms: Date.now() - t0,
    });
  }

  // ── Apply: 1-credit known-URL re-scrape per record ────────────────
  const results: Array<{ recordId: string; address: string | null; stillActive: boolean | null; credits: number; newLiveStatus: string | null; error: string | null }> = [];
  let creditsUsed = 0;
  let paymentRequired = false;
  for (const l of batch) {
    if (Date.now() - t0 > BUDGET_MS) break;
    const iso = new Date().toISOString();
    try {
      const fc = await verifyListingByUrl(l.verificationUrl, l.address);
      creditsUsed += fc.creditsUsed;
      if (fc.paymentRequired) { paymentRequired = true; results.push({ recordId: l.id, address: l.address, stillActive: null, credits: fc.creditsUsed, newLiveStatus: null, error: "firecrawl_payment_required" }); break; }
      if (!fc.resolved) {
        // Couldn't re-scrape the page → leave as-is, just record (do NOT
        // mark off-market on an infra miss).
        results.push({ recordId: l.id, address: l.address, stillActive: null, credits: fc.creditsUsed, newLiveStatus: null, error: fc.error ?? "unresolved" });
        continue;
      }
      const newLive = fc.stillActive ? "Active" : "Off Market";
      await updateListingRecord(l.id, { Live_Status: newLive, Last_Verified: iso });
      results.push({ recordId: l.id, address: l.address, stillActive: fc.stillActive, credits: fc.creditsUsed, newLiveStatus: newLive, error: null });
      await audit({
        agent: "scout",
        event: "freshness_reverify",
        status: "confirmed_success",
        recordId: l.id,
        ms: 0,
        inputSummary: { url: l.verificationUrl, prior_last_verified: l.lastVerified ?? null },
        outputSummary: { still_active: fc.stillActive, new_live_status: newLive, credits: fc.creditsUsed },
        decision: fc.stillActive ? "reconfirmed_active" : "marked_off_market",
      });
    } catch (err) {
      results.push({ recordId: l.id, address: l.address, stillActive: null, credits: 0, newLiveStatus: null, error: String(err).slice(0, 160) });
    }
  }

  return NextResponse.json({
    ok: true,
    mode: "apply",
    auth_kind: authKind,
    summary: {
      attempted: results.length,
      reconfirmed_active: results.filter((r) => r.stillActive === true).length,
      marked_off_market: results.filter((r) => r.stillActive === false).length,
      unresolved: results.filter((r) => r.error && r.stillActive === null).length,
      credits_used: creditsUsed,
      payment_required: paymentRequired,
      bump_partition: {
        bump_due: bumpPool.length,
        core_due: corePool.length,
        core_taken: partition.coreTaken,
        bump_taken: partition.bumpTaken,
      },
    },
    results,
    duration_ms: Date.now() - t0,
  });
}
