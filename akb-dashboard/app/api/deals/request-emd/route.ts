// INV-023 EMD-fire path — REFUSES unless the Pre-EMD verdict is pass.
// @agent: orchestrator
//
// POST /api/deals/request-emd { dealId }   (GET mirror for MCP compat)
//
// The wire NEVER goes out on a hold or block. This route re-reads the
// PERSISTED Pre_EMD_Verdict from the Deals row (the evaluator's output —
// the consumer's read path, not a re-computation) and:
//   verdict !== "pass"  → 503 with the verdict + the persisted hold
//                         reasons. Nothing written.
//   verdict === "pass"  → stamps EMD_Status="Requested" +
//                         EMD_Requested_At=today. The downstream Forge
//                         ship owns the actual wire workflow; this is the
//                         gate it must pass through.
//
// Staleness guard: a pass older than PRE_EMD_VERDICT_MAX_AGE_HOURS
// (default 24h) is refused — re-run the evaluator first. A verdict is a
// snapshot, not a permanent license.
//
// Auth: dashboard cookie / CRON_SECRET / OAuth waterfall.

import { NextResponse } from "next/server";
import { getDeals, updateDealRecord } from "@/lib/airtable";
import { audit } from "@/lib/audit-log";
import {
  authenticate,
  hasDashboardSession,
  readAuthEnv,
  readAuthHeaders,
} from "@/lib/maverick/oauth/auth-waterfall";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";
import { evaluatePreEmdGate, emdAdvanceDecision } from "@/lib/orchestrator/pre-emd-gate";
import { assemblePreEmdGateInputForDeal } from "@/lib/orchestrator/pre-emd-gate-live";

export const runtime = "nodejs";
export const maxDuration = 30;

const VERDICT_MAX_AGE_HOURS = Number(process.env.PRE_EMD_VERDICT_MAX_AGE_HOURS ?? "24");

async function handle(req: Request) {
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
  let dealId = url.searchParams.get("dealId") ?? "";
  if (!dealId && req.method === "POST") {
    try {
      const body = (await req.json()) as { dealId?: string };
      dealId = body.dealId ?? "";
    } catch { /* fall through */ }
  }
  if (!dealId) return NextResponse.json({ error: "dealId required" }, { status: 400 });

  const deals = await getDeals().catch(() => []);
  const deal = deals.find((d) => d.id === dealId) ?? null;
  if (!deal) return NextResponse.json({ error: "deal_not_found", dealId }, { status: 404 });

  // ── INV-023 HARD GATE (live) — the structural answer to 23 Fields Ave. ──
  // The EMD advance is physically refused unless the Pre-EMD due-diligence
  // gate returns ADVANCE_UNLOCKED. Fail-closed: the assembler maps any
  // missing data to a BLOCKING input, so absence → BLOCKED. This is the
  // mandatory entry the EMD path must pass through; it runs BEFORE (and in
  // addition to) the persisted-verdict read below.
  const gate = evaluatePreEmdGate(await assemblePreEmdGateInputForDeal(deal));
  const gateDecision = emdAdvanceDecision(gate);
  if (!gateDecision.allowed) {
    await audit({
      agent: "orchestrator",
      event: "emd_request_refused",
      status: "confirmed_failure",
      recordId: dealId,
      inputSummary: { auth_kind: authKind, pre_emd_gate_verdict: gate.verdict },
      outputSummary: { reason: gateDecision.reason, blocked: gate.blocked },
    });
    return NextResponse.json(
      {
        ok: false,
        refused: true,
        reason: gateDecision.reason,
        pre_emd_gate_verdict: gate.verdict,
        blocked_checks: gateDecision.blocked_checks,
        detail:
          "INV-023 Pre-EMD gate is BLOCKED — EMD never fires until every due-diligence check is green. Each blocked check names the input it needs. Populate the missing inputs and re-run /api/orchestrator/pre-emd-evaluate.",
      },
      { status: gateDecision.httpStatus },
    );
  }

  const verdict = (deal.preEmdVerdict ?? "not_yet_evaluated").toLowerCase();
  const refuse = async (reason: string, status: number) => {
    await audit({
      agent: "orchestrator",
      event: "emd_request_refused",
      status: "confirmed_failure",
      recordId: dealId,
      inputSummary: { auth_kind: authKind, verdict },
      outputSummary: { reason },
    });
    return NextResponse.json(
      {
        ok: false,
        refused: true,
        reason,
        verdict,
        hold_reasons: deal.preEmdHoldReasons ?? null,
        last_evaluated_at: deal.preEmdLastEvaluatedAt ?? null,
        detail: "EMD never fires on a non-pass verdict. Run /api/orchestrator/pre-emd-evaluate?recordId=<listing> and clear the holds first.",
      },
      { status },
    );
  };

  if (verdict !== "pass") {
    return refuse(`pre_emd_verdict_${verdict}`, 503);
  }
  // Staleness: a pass is a snapshot, not a permanent license.
  const evalAt = deal.preEmdLastEvaluatedAt ? Date.parse(deal.preEmdLastEvaluatedAt) : NaN;
  if (!Number.isFinite(evalAt) || Date.now() - evalAt > VERDICT_MAX_AGE_HOURS * 3_600_000) {
    return refuse(`pre_emd_verdict_stale (> ${VERDICT_MAX_AGE_HOURS}h) — re-run the evaluator`, 503);
  }

  const today = new Date().toISOString().slice(0, 10);
  try {
    await updateDealRecord(dealId, {
      EMD_Status: "Requested",
      EMD_Requested_At: today,
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: "write_failed", message: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }

  await audit({
    agent: "orchestrator",
    event: "emd_requested",
    status: "confirmed_success",
    recordId: dealId,
    inputSummary: { auth_kind: authKind, verdict, last_evaluated_at: deal.preEmdLastEvaluatedAt ?? null },
    outputSummary: { emd_status: "Requested", emd_requested_at: today },
    decision: "emd_request_fired_on_pass_verdict",
  });

  return NextResponse.json({
    ok: true,
    dealId,
    verdict,
    emd_status: "Requested",
    emd_requested_at: today,
    duration_ms: Date.now() - t0,
  });
}

export async function GET(req: Request) { return handle(req); }
export async function POST(req: Request) { return handle(req); }
