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
import { getActiveListingsForBrief, updateListingRecord } from "@/lib/airtable";
import { audit } from "@/lib/audit-log";
import {
  authenticate,
  hasDashboardSession,
  readAuthEnv,
  readAuthHeaders,
} from "@/lib/maverick/oauth/auth-waterfall";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";
import { verifyListingByUrl } from "@/lib/crawler/sources/firecrawl";
import { isActionableMarket } from "@/lib/markets/actionable";
import { isOutreachFresh, DEFAULT_FRESHNESS_HOURS } from "@/lib/outreach-freshness";
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
  const now = new Date();

  let active: Listing[];
  try {
    active = await getActiveListingsForBrief();
  } catch (err) {
    return NextResponse.json({ error: "active_fetch_failed", message: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }

  // Candidate set: has a cached URL, in an actionable market, and NOT
  // currently outreach-fresh (stale or never re-verified).
  const skippedNonActionable: Array<{ recordId: string; reason: string }> = [];
  const candidates = active.filter((l) => {
    if (!(l.verificationUrl && l.verificationUrl.trim() !== "")) return false;
    const market = isActionableMarket({ state: l.state, city: l.city, zip: l.zip });
    if (!market.actionable) {
      skippedNonActionable.push({ recordId: l.id, reason: market.reason ?? "non_actionable" });
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
  const batch = candidates.slice(0, limit);

  if (!apply) {
    return NextResponse.json({
      ok: true,
      mode: "dry_run",
      auth_kind: authKind,
      max_age_hours: maxAgeHours,
      active_total: active.length,
      due_total: candidates.length,
      skipped_non_actionable: skippedNonActionable.length,
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
    },
    results,
    duration_ms: Date.now() - t0,
  });
}
