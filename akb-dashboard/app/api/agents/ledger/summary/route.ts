// Phase 15 / Q.4 — Ledger summary endpoint.
//
// GET /api/agents/ledger/summary
//
// Returns the operator's economics snapshot: revenue rollup +
// retirement progress + per-agent LLM cost attribution. Read-only
// (no Airtable writes, no LLM calls). Audit row tagged ledger so
// Pulse can baseline call rate.

import { NextResponse } from "next/server";
import { getDeals } from "@/lib/airtable";
import { readRecentFromKv } from "@/lib/audit-log";
import { audit } from "@/lib/audit-log";
import {
  computeRetirementProgress,
  readEconomicsConfig,
  rollupRevenue,
} from "@/lib/ledger/economics";
import { attributeCost } from "@/lib/ledger/cost-attribution";

export const runtime = "nodejs";
export const maxDuration = 30;

const DEFAULT_COST_WINDOW_HOURS = 168; // 7d

export async function GET(req: Request) {
  const t0 = Date.now();
  const url = new URL(req.url);
  const windowHoursParam = url.searchParams.get("cost_window_hours");
  const windowHours = windowHoursParam
    ? Math.max(1, parseInt(windowHoursParam, 10) || DEFAULT_COST_WINDOW_HOURS)
    : DEFAULT_COST_WINDOW_HOURS;

  const config = readEconomicsConfig();

  const [deals, auditEvents] = await Promise.all([
    getDeals().catch(() => []),
    readRecentFromKv(1000).catch(() => []),
  ]);

  const now = new Date();
  const revenue = rollupRevenue(deals, config);
  const retirement = computeRetirementProgress(deals, config, now);
  const costs = attributeCost(auditEvents, windowHours, now);

  await audit({
    agent: "ledger",
    event: "ledger_summary_read",
    status: "confirmed_success",
    inputSummary: {
      cost_window_hours: windowHours,
      deals_count: deals.length,
      audit_events_count: auditEvents.length,
    },
    outputSummary: {
      gross_assignment_fees: revenue.gross_assignment_fees,
      total_operator_take: revenue.total_operator_take,
      total_truck_fund: revenue.total_truck_fund,
      closed_count: revenue.closed_count,
      llm_total_usd: costs.total_usd,
      retirement_progress_pct: retirement.progress_pct,
    },
    decision: "ok",
    ms: Date.now() - t0,
  });

  return NextResponse.json({
    generated_at: now.toISOString(),
    elapsed_ms: Date.now() - t0,
    config,
    revenue,
    retirement,
    llm_costs: costs,
  });
}
