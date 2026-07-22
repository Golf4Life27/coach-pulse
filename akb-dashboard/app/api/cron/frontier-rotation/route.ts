// Weekly frontier rotation pass (#37). @agent: scout
//
// GET /api/cron/frontier-rotation
//   default        DRY-RUN: report budget, rotation health, promotion +
//                  retirement-candidate decisions. Zero writes.
//   ?apply=1       promote staged→launch (bounded by sustainable capacity)
//                  and file retirement-candidate PROPOSALS. Retirement is
//                  NEVER auto-applied — the registry's *_30d stats are
//                  latest-run snapshots, not true 30-day evidence, so
//                  pausing a ZIP stays an operator decision (one-tap via
//                  the /queue proposal).
//
// Spends ZERO paid API calls — reads the registry, patches tiers, writes
// proposals. The budget it reports is the same governor the intake belt
// clamps to (lib/crawler/frontier-governor).

import { NextResponse } from "next/server";
import { audit } from "@/lib/audit-log";
import {
  authenticate,
  hasDashboardSession,
  readAuthEnv,
  readAuthHeaders,
} from "@/lib/maverick/oauth/auth-waterfall";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";
import { getAllRegistryRows, promoteStagedZip, createStagedZips } from "@/lib/zip-registry";
import {
  computeDailyCrawlBudget,
  frontierDecisions,
  DEFAULT_RENTCAST_MONTHLY_PLAN,
  TARGET_CYCLE_DAYS,
} from "@/lib/crawler/frontier-governor";
import { decideStaging, targetStagedBacklog } from "@/lib/crawler/frontier-stage";
import { isActionableMarket } from "@/lib/markets/actionable";
import {
  getMarketForListing,
  getRestrictedStates,
  openerArvPctMax,
  NON_DISCLOSURE_STATES,
} from "@/lib/markets/registry";

export const runtime = "nodejs";
export const maxDuration = 120;

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
  const now = new Date();

  let rows;
  try {
    rows = await getAllRegistryRows();
  } catch (err) {
    return NextResponse.json(
      { error: "zip_registry_fetch_failed", message: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }

  const monthlyPlanRaw = Number(process.env.RENTCAST_MONTHLY_PLAN);
  const budget = computeDailyCrawlBudget({
    monthlyPlan: Number.isFinite(monthlyPlanRaw) && monthlyPlanRaw > 0
      ? Math.floor(monthlyPlanRaw)
      : DEFAULT_RENTCAST_MONTHLY_PLAN,
    // The weekly pass uses plan-pro-rata (no burn estimate here) — the
    // conservative basis; the intake governor refines per-run.
    estimatedRemaining: null,
    now,
  });

  const decisions = frontierDecisions({
    rows: rows.map((r) => ({
      recordId: r.recordId,
      zip: r.zip,
      marketTier: r.marketTier,
      wholesaleRestricted: r.wholesaleRestricted,
      lastIngestedAt: r.lastIngestedAt,
      recordsIngested30d: r.recordsIngested30d,
      acceptRate30d: r.acceptRate30d,
      // Tiered-cadence inputs (chew-and-move-on, 2026-07-22): paused markets
      // hold no capacity seats; opener-HOLD markets cost the trickle rate;
      // the zero-yield streak drives the chewed discount.
      pausedMarket: !isActionableMarket({ state: r.state, city: r.market, zip: r.zip }).actionable,
      openerHold:
        openerArvPctMax(getMarketForListing({ state: r.state, zip: r.zip }), r.state) == null,
      zeroYieldStreak: r.belowThresholdStreak,
    })),
    dailyBudget: budget.dailyBudget,
    now,
  });

  const health = {
    registry_total: rows.length,
    eligible_now: decisions.eligibleNow,
    sustainable_zips: decisions.sustainableZips,
    capacity_left: decisions.capacityLeft,
    current_daily_cost: decisions.currentDailyCost,
    paused_excluded: decisions.pausedExcluded,
    target_cycle_days: TARGET_CYCLE_DAYS,
    daily_budget: budget.dailyBudget,
    budget_basis: budget.basis,
  };

  const promoted: Array<{ zip: string; recordId: string; error: string | null }> = [];
  const proposals = { attempted: 0, created: 0, error: null as string | null };

  // ── Auto-stage (chew-and-move-on, 2026-07-22): keep the promotion queue
  // fed from the expansion-metro config. Computed in BOTH modes so a dry
  // run previews exactly what apply would stage; rows are only created on
  // apply. Staged rows spend nothing — promotion capacity stays the gate.
  const stagedBacklog = rows.filter((r) => (r.marketTier ?? "").trim() === "staged").length;
  const staging = decideStaging({
    existingZips: new Set(rows.map((r) => r.zip)),
    restrictedStates: getRestrictedStates(),
    nonDisclosureStates: NON_DISCLOSURE_STATES,
    stagedBacklog,
    targetBacklog: targetStagedBacklog(decisions.capacityLeft),
    maxPerPass: 30,
  });
  const stagingResult = { attempted: staging.toStage.length, created: 0, error: null as string | null };

  if (apply) {
    if (staging.toStage.length > 0) {
      try {
        stagingResult.created = await createStagedZips(staging.toStage);
      } catch (err) {
        stagingResult.error = err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200);
      }
    }
    // ── Promotion: staged → launch, within capacity ──────────────────
    const byId = new Map(rows.map((r) => [r.recordId, r] as const));
    for (const p of decisions.promote) {
      try {
        await promoteStagedZip(p.recordId, {
          note: `frontier-rotation: staged→launch (capacity ${decisions.capacityLeft} at ${budget.dailyBudget} calls/day × ${TARGET_CYCLE_DAYS}d cycle)`,
          existingNotes: byId.get(p.recordId)?.notes ?? null,
        });
        promoted.push({ zip: p.zip, recordId: p.recordId, error: null });
      } catch (err) {
        promoted.push({ zip: p.zip, recordId: p.recordId, error: String(err).slice(0, 160) });
      }
    }

    // ── Retirement candidates → operator proposals (never auto-pause) ─
    const proposalsTable = process.env.AGENT_PROPOSALS_TABLE_ID ?? null;
    if (decisions.retireCandidates.length > 0 && proposalsTable && process.env.AIRTABLE_PAT) {
      try {
        const baseId = process.env.AIRTABLE_BASE_ID || "appp8inLAGTg4qpEZ";
        const pendingRes = await fetch(
          `https://api.airtable.com/v0/${baseId}/${proposalsTable}?` +
            new URLSearchParams({
              filterByFormula: `AND({Status}="Pending",{Proposal_Type}="frontier_retire")`,
              "fields[]": "Record_ID",
            }).toString(),
          { headers: { Authorization: `Bearer ${process.env.AIRTABLE_PAT}` }, cache: "no-store" },
        );
        const pendingIds = new Set<string>();
        if (pendingRes.ok) {
          const body = (await pendingRes.json()) as { records?: Array<{ fields: Record<string, unknown> }> };
          for (const r of body.records ?? []) {
            if (typeof r.fields.Record_ID === "string") pendingIds.add(r.fields.Record_ID);
          }
        }
        const toCreate = decisions.retireCandidates.filter((c) => !pendingIds.has(c.row.recordId));
        proposals.attempted = decisions.retireCandidates.length;
        if (toCreate.length > 0) {
          const createRes = await fetch(`https://api.airtable.com/v0/${baseId}/${proposalsTable}`, {
            method: "POST",
            headers: { Authorization: `Bearer ${process.env.AIRTABLE_PAT}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              records: toCreate.slice(0, 10).map((c, i) => ({
                fields: {
                  Proposal_ID: `frontier_retire-${t0}-${i}`,
                  Proposal_Type: "frontier_retire",
                  Priority: "NORMAL",
                  Record_ID: c.row.recordId,
                  Record_Address: `ZIP ${c.row.zip}`,
                  Reasoning:
                    `Frontier retirement candidate: ZIP ${c.row.zip} — ${c.reason}. ` +
                    `Approving pauses the ZIP in ZIP_Registry (frees ~${Math.round(30 / TARGET_CYCLE_DAYS)} RentCast calls/mo). ` +
                    `Snapshot stats only — decline if the ZIP deserves more cycles.`,
                  Suggested_Action_Payload: JSON.stringify({
                    recordId: c.row.recordId,
                    action: "frontier_retire",
                    zip: c.row.zip,
                  }),
                  Status: "Pending",
                },
              })),
              typecast: true,
            }),
          });
          if (createRes.ok) proposals.created = Math.min(toCreate.length, 10);
          else proposals.error = `proposals_create_${createRes.status}`;
        }
      } catch (err) {
        proposals.error = err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200);
      }
    }
  }

  await audit({
    agent: "scout",
    event: apply ? "frontier_rotation_apply" : "frontier_rotation_dry_run",
    status: "confirmed_success",
    inputSummary: { auth_kind: authKind, apply },
    outputSummary: {
      ...health,
      promoted: promoted.filter((p) => !p.error).length,
      retire_candidates: decisions.retireCandidates.length,
      proposals_created: proposals.created,
      staged_created: stagingResult.created,
      staged_backlog: stagedBacklog,
      staging_queue_exhausted: staging.queueExhausted,
    },
    ms: Date.now() - t0,
  });

  return NextResponse.json({
    ok: true,
    mode: apply ? "apply" : "dry_run",
    auth_kind: authKind,
    health,
    promote: decisions.promote.map((r) => ({ zip: r.zip, recordId: r.recordId })),
    promoted,
    retire_candidates: decisions.retireCandidates.map((c) => ({ zip: c.row.zip, reason: c.reason })),
    proposals,
    staging: {
      ...stagingResult,
      staged_backlog_before: stagedBacklog,
      to_stage: staging.toStage.map((s) => ({ zip: s.zip, market: s.market })),
      metros_opened: staging.metrosOpened,
      skipped: staging.skipped,
      queue_exhausted: staging.queueExhausted,
    },
    duration_ms: Date.now() - t0,
  });
}
