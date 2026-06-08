// INV-026 — Wife-Retirement Progress Meter API.
// @agent: maverick
//
// GET /api/admin/progress-meter
//   → the three load-bearing numbers (Lost-Phone stall count, deal
//     velocity $/mo, operator hours/wk) + build-completion, computed
//     from the stage registry + live Deals.
//   ?snapshot=1  → also persist a build_event to Spine (for the
//                  material-movement trend the INV-026 brief tracks).
//
// % complete is the SECONDARY number by design — the brief is explicit
// that operator-required → operator-optional progress (the stall count)
// is the real metric. The roadmap that pairs with this lives at
// docs/specs/V1_Roadmap_to_100.md and is generated from the same
// lib/progress-meter/stages.ts registry, so meter and roadmap can't drift.
//
// Auth: dashboard cookie / CRON_SECRET / OAuth waterfall.

import { NextResponse } from "next/server";
import { getDeals } from "@/lib/airtable";
import { audit } from "@/lib/audit-log";
import {
  authenticate,
  hasDashboardSession,
  readAuthEnv,
  readAuthHeaders,
} from "@/lib/maverick/oauth/auth-waterfall";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";
import { writeState } from "@/lib/maverick/write-state";
import { buildMeterSnapshot, type ClosedDeal } from "@/lib/progress-meter/compute";
import { PIPELINE_STAGES } from "@/lib/progress-meter/stages";
import type { Deal } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

/** A deal counts as realized when status flips to Closed (the singleSelect
 *  "Closed" choice). closedAt prefers the assignment-executed date, falls
 *  back to scheduled-closing, and is null when neither is set (→ undated,
 *  excluded from the windowed velocity but still visible in the raw set). */
function toClosedDeal(d: Deal): ClosedDeal | null {
  const realized = d.status === "Closed" || d.closingStatus === "Closed";
  if (!realized) return null;
  return {
    closedAt: d.assignmentExecutedAt ?? d.closingScheduledDate ?? null,
    assignmentFee: d.assignmentFee,
  };
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
  const persist = url.searchParams.get("snapshot") === "1";

  let deals: Deal[] = [];
  let dealsError: string | null = null;
  try {
    deals = await getDeals();
  } catch (err) {
    // Velocity degrades to $0 (visible) rather than failing the whole
    // meter — the stall count + completion don't depend on Deals.
    dealsError = err instanceof Error ? err.message : String(err);
  }

  const closed: ClosedDeal[] = deals
    .map(toClosedDeal)
    .filter((d): d is ClosedDeal => d !== null);

  const snapshot = buildMeterSnapshot({ deals: closed });

  // Pair every number with its mover: the per-stage path-to-100.
  const roadmap = PIPELINE_STAGES.map((s) => ({
    station: s.station,
    id: s.id,
    name: s.name,
    completionPct: s.completionPct,
    risk: s.lostPhoneRisk,
    stalls: s.stallsWithoutOperator,
    blockers: s.blockers,
    pathTo100: s.pathTo100,
  }));

  let spineRecordId: string | null = null;
  if (persist) {
    try {
      const res = await writeState({
        event_type: "build_event",
        title: `INV-026 meter: ${snapshot.lostPhone.stallCount} stall / $${snapshot.velocity.monthlyNetUsd}/mo / build ${snapshot.completion.overallPct}%`,
        description: snapshot.headline,
        reasoning:
          "Progress-meter snapshot. Stall count is the load-bearing metric (operator-required → operator-optional); velocity + build% are secondary.",
        attribution_agent: "maverick",
      });
      spineRecordId = res.spine_record_id;
    } catch (err) {
      console.error("[progress-meter] Spine write failed:", err);
    }
  }

  await audit({
    agent: "maverick",
    event: "progress_meter",
    status: "confirmed_success",
    inputSummary: { auth_kind: authKind, persist, deals_error: dealsError },
    outputSummary: {
      stall_count: snapshot.lostPhone.stallCount,
      high_risk: snapshot.lostPhone.high,
      monthly_net_usd: snapshot.velocity.monthlyNetUsd,
      build_pct: snapshot.completion.overallPct,
      spine_record_id: spineRecordId,
    },
    ms: Date.now() - t0,
  });

  return NextResponse.json({
    ok: true,
    auth_kind: authKind,
    deals_error: dealsError,
    snapshot,
    roadmap,
    spine_record_id: spineRecordId,
    duration_ms: Date.now() - t0,
  });
}
