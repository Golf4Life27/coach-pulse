// Weekly silent per-market anchor calibration (operator brief 2026-06-13,
// spine recZ6tBZRmfFOLwqo). @agent: crier
//
// Runs Mondays 06:00 UTC. Per priceable market:
//   1. Pull the trailing-7-day send cohort + reply cohort from
//      Listings_V1 (Last_Outreach_Date / Last_Inbound_At / Outreach_Status).
//   2. Decide the next anchor via lib/markets/anchor-calibration step
//      rules (sample gate + baseline gate + step + clamps + breaker).
//   3. Persist the new state to KV and write ONE audit row:
//        agent: "crier", event: "market_anchor_calibration"
//      Never surfaces to UI. Never alerts the operator. The breaker
//      tripped this cycle writes an "operator-review" audit row — still
//      no alert, still no UI: visible to the operator only when they
//      pull the audit log themselves (per the brief's invisibility rule).
//
// Auth: cron-only path (CRON_SECRET) + the standard waterfall.

import { NextResponse } from "next/server";
import { audit } from "@/lib/audit-log";
import { getListings } from "@/lib/airtable";
import { getMarketForListing } from "@/lib/markets/registry";
import { loadAnchorState, saveAnchorState } from "@/lib/markets/anchor";
import {
  decideAnchorMove,
  applyDecision,
  type CalibrationSample,
} from "@/lib/markets/anchor-calibration";
import {
  authenticate,
  hasDashboardSession,
  readAuthEnv,
  readAuthHeaders,
} from "@/lib/maverick/oauth/auth-waterfall";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";

export const runtime = "nodejs";
export const maxDuration = 60;

const CYCLE_WINDOW_DAYS = 7;

function tsWithinDays(iso: string | null | undefined, now: Date, days: number): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return false;
  return now.getTime() - t <= days * 86_400_000;
}

function tsAfter(iso: string | null | undefined, sinceIso: string | null | undefined): boolean {
  if (!iso || !sinceIso) return false;
  const t = Date.parse(iso);
  const since = Date.parse(sinceIso);
  if (!Number.isFinite(t) || !Number.isFinite(since)) return false;
  return t >= since;
}

export async function GET(req: Request) {
  const t0 = Date.now();
  const now = new Date();

  // ── Auth waterfall (same as every guarded cron) ──
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

  const all = await getListings();

  // Per market: trailing-window sends + replies + engaged_replies,
  // plus the cumulative-since-baseline-start send count for the
  // baseline-establishment gate.
  interface MarketBucket {
    cycle: CalibrationSample;
    cumulativeBaselineSends: number;
    sendsSinceLastChange: number;
  }
  const buckets = new Map<string, MarketBucket>();

  // Pre-load each market's state so we can ask its baselineStartedAt
  // (needed to count cumulative sends).
  const stateCache = new Map<string, Awaited<ReturnType<typeof loadAnchorState>>>();
  const ensureState = async (marketId: string) => {
    let s = stateCache.get(marketId);
    if (s != null) return s;
    s = await loadAnchorState(marketId, now);
    stateCache.set(marketId, s);
    return s;
  };

  for (const l of all) {
    const market = getMarketForListing({ state: l.state, zip: l.zip });
    if (!market) continue;
    const marketId = market.id;
    const state = await ensureState(marketId);
    let b = buckets.get(marketId);
    if (!b) {
      b = { cycle: { sends: 0, replies: 0, engagedReplies: 0 }, cumulativeBaselineSends: 0, sendsSinceLastChange: 0 };
      buckets.set(marketId, b);
    }
    const sentRecently = tsWithinDays(l.lastOutreachDate ?? null, now, CYCLE_WINDOW_DAYS);
    const repliedRecently =
      tsWithinDays(l.lastInboundAt ?? null, now, CYCLE_WINDOW_DAYS) &&
      tsAfter(l.lastInboundAt ?? null, l.lastOutreachDate ?? null);
    if (sentRecently) b.cycle.sends++;
    if (repliedRecently) {
      b.cycle.replies++;
      if ((l.outreachStatus ?? "") === "Negotiating") b.cycle.engagedReplies++;
    }
    // Cumulative since baseline started (sends only).
    if (state.baselineStartedAt && tsAfter(l.lastOutreachDate ?? null, state.baselineStartedAt)) {
      b.cumulativeBaselineSends++;
    }
    const since = state.lastAnchorChangeAt ?? state.baselineStartedAt;
    if (tsAfter(l.lastOutreachDate ?? null, since)) b.sendsSinceLastChange++;
  }

  const results: Array<{
    market: string;
    old_anchor: number;
    new_anchor: number;
    applied_step: number;
    reason: string;
    reply_rate: number;
    engaged_reply_rate: number;
    baseline_reply_rate: number | null;
    sends_this_cycle: number;
    sends_since_last_change: number;
    breaker_tripped: boolean;
  }> = [];

  for (const [marketId, bucket] of buckets) {
    const state = await ensureState(marketId);
    // Sync the bookkeeping read from Airtable INTO the persisted state
    // before deciding (the source of truth is the record set; KV is the
    // bookkeeping cache).
    const synced = { ...state, sendsSinceLastChange: bucket.sendsSinceLastChange };
    const decision = decideAnchorMove(synced, bucket.cycle, bucket.cumulativeBaselineSends, now);
    const next = applyDecision(synced, decision, now);
    await saveAnchorState(next);

    // Audit row — silent, no UI, no alert. Captures everything the
    // operator needs if they pull the audit log themselves.
    await audit({
      agent: "crier",
      event: "market_anchor_calibration",
      status: "confirmed_success",
      inputSummary: {
        market: marketId,
        sends_this_cycle: bucket.cycle.sends,
        replies_this_cycle: bucket.cycle.replies,
        engaged_replies_this_cycle: bucket.cycle.engagedReplies,
        cumulative_baseline_sends: bucket.cumulativeBaselineSends,
        sends_since_last_change: bucket.sendsSinceLastChange,
      },
      outputSummary: {
        old_anchor: state.anchorPct,
        new_anchor: decision.newAnchorPct,
        applied_step: decision.appliedStep,
        reason: decision.reason,
        reply_rate: decision.metrics.replyRate,
        engaged_reply_rate: decision.metrics.engagedReplyRate,
        baseline_reply_rate: next.baselineReplyRate,
        breaker_tripped_this_cycle: decision.breakerTrippedThisCycle,
      },
    });

    // The brief explicitly separates the breaker case: still silent
    // (no UI, no alert), but it gets its own audit row so a future
    // operator pull can find it without grep gymnastics.
    if (decision.breakerTrippedThisCycle) {
      await audit({
        agent: "crier",
        event: "market_anchor_breaker_tripped",
        status: "confirmed_failure",
        inputSummary: { market: marketId, anchor_at_trip: decision.newAnchorPct },
        outputSummary: {
          reason: "pinned_at_ceiling_with_near_zero_replies_two_cycles",
          recommendation: "operator-review — market may be unworkable at penciling price, or arv_pct_max may be wrong",
        },
        decision: "operator_review_flag",
      });
    }

    results.push({
      market: marketId,
      old_anchor: state.anchorPct,
      new_anchor: decision.newAnchorPct,
      applied_step: decision.appliedStep,
      reason: decision.reason,
      reply_rate: decision.metrics.replyRate,
      engaged_reply_rate: decision.metrics.engagedReplyRate,
      baseline_reply_rate: next.baselineReplyRate,
      sends_this_cycle: bucket.cycle.sends,
      sends_since_last_change: bucket.sendsSinceLastChange,
      breaker_tripped: decision.breakerTrippedThisCycle,
    });
  }

  return NextResponse.json({
    ok: true,
    auth_kind: authKind,
    cycle_window_days: CYCLE_WINDOW_DAYS,
    markets_evaluated: results.length,
    results,
    duration_ms: Date.now() - t0,
  });
}
