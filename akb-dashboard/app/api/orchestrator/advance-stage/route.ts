// POST /api/orchestrator/advance-stage  { recordId, target_stage, override_reason? }
// GET  /api/orchestrator/advance-stage?recordId=...&target_stage=...&override_reason=...
//
// Advances a listing's Pipeline_Stage. By default, runs the gate that
// transitions to target_stage and refuses to advance unless the gate
// passes. override_reason bypasses the gate check with a logged
// exception (spec §7 Override Protocol).
//
// Inviolable items (spec §7 — never overridable):
//   - PO-04 NEVER-list match
//   - PO-05 restricted state
//   - PC-05 inspection contingency (Gate 4)
//   - PC-16 Memphis assignability (Gate 4)
// These rules block even with an override_reason.

import { NextResponse } from "next/server";
import { updateListingRecord } from "@/lib/airtable";
import { audit } from "@/lib/audit-log";
import { runGate } from "@/lib/orchestrator/gate-runner";
import {
  PRE_OUTREACH_GATE,
  PRE_OUTREACH_CHECKS,
  PRE_OUTREACH_CONFIG,
} from "@/lib/orchestrator/pre-outreach-checks";
import {
  PRE_SEND_GATE,
  PRE_SEND_CHECKS,
  PRE_SEND_CONFIG,
} from "@/lib/orchestrator/pre-send-checks";
import {
  PRE_NEGOTIATION_GATE,
  PRE_NEGOTIATION_CHECKS,
  PRE_NEGOTIATION_CONFIG,
} from "@/lib/orchestrator/pre-negotiation-checks";
import {
  PRE_CONTRACT_GATE,
  PRE_CONTRACT_CHECKS,
  PRE_CONTRACT_CONFIG,
} from "@/lib/orchestrator/pre-contract-checks";
import {
  ALL_PIPELINE_STAGES,
  type PipelineStage,
} from "@/lib/orchestrator/types";

export const runtime = "nodejs";
export const maxDuration = 60;

// Map target_stage → gate that gates that transition. Gate 5 added when
// its check module lands. Gate 3 (pre_negotiation) is primarily a
// diagnostic gate — runs every time a reply lands, gates every
// negotiation move — but advancing to 'negotiating' on first reply is
// the natural transition handler.
const STAGE_GATE_MAP: Partial<Record<PipelineStage, {
  gate: typeof PRE_OUTREACH_GATE | typeof PRE_SEND_GATE | typeof PRE_NEGOTIATION_GATE | typeof PRE_CONTRACT_GATE;
  checks: typeof PRE_OUTREACH_CHECKS | typeof PRE_SEND_CHECKS | typeof PRE_NEGOTIATION_CHECKS | typeof PRE_CONTRACT_CHECKS;
  config: Record<string, unknown>;
}>> = {
  outreach_ready: {
    gate: PRE_OUTREACH_GATE,
    checks: PRE_OUTREACH_CHECKS,
    config: PRE_OUTREACH_CONFIG as unknown as Record<string, unknown>,
  },
  outreach_sent: {
    gate: PRE_SEND_GATE,
    checks: PRE_SEND_CHECKS,
    config: PRE_SEND_CONFIG as unknown as Record<string, unknown>,
  },
  negotiating: {
    gate: PRE_NEGOTIATION_GATE,
    checks: PRE_NEGOTIATION_CHECKS,
    config: PRE_NEGOTIATION_CONFIG as unknown as Record<string, unknown>,
  },
  under_contract: {
    gate: PRE_CONTRACT_GATE,
    checks: PRE_CONTRACT_CHECKS,
    config: PRE_CONTRACT_CONFIG as unknown as Record<string, unknown>,
  },
};

// Inviolable item IDs — fail-block even when override_reason is supplied.
// Per spec §7 Override Protocol — these rules CANNOT be bypassed.
const INVIOLABLE_ITEM_IDS = new Set<string>([
  "PO-04", // NEVER-list match
  "PO-05", // restricted state (IL/MO/SC/NC/OK/ND)
  "PC-05", // inspection contingency present
  "PC-16", // Memphis assignability (TN)
]);

async function executeAdvance(opts: {
  recordId: string;
  target_stage: string;
  override_reason: string | null;
}) {
  const t0 = Date.now();
  const { recordId, target_stage, override_reason } = opts;

  if (!recordId.startsWith("rec")) {
    return NextResponse.json({ error: "Invalid recordId" }, { status: 400 });
  }
  if (!ALL_PIPELINE_STAGES.includes(target_stage as PipelineStage)) {
    return NextResponse.json(
      {
        error: "Invalid target_stage",
        allowed: ALL_PIPELINE_STAGES,
      },
      { status: 400 },
    );
  }
  const stage = target_stage as PipelineStage;
  const entry = STAGE_GATE_MAP[stage];
  if (!entry) {
    return NextResponse.json(
      {
        error: `No gate registered for target_stage=${stage} yet — orchestrator only implements Gate 1 (outreach_ready) so far`,
        implemented_stages: Object.keys(STAGE_GATE_MAP),
      },
      { status: 501 },
    );
  }

  // ── Run the gate ────────────────────────────────────────────────────
  const gateResult = await runGate({
    gate: entry.gate,
    recordId,
    checks: entry.checks,
    config: entry.config,
  });

  // ── Inviolable check ───────────────────────────────────────────────
  const inviolableFails = gateResult.results.filter(
    (r) => r.status === "fail" && INVIOLABLE_ITEM_IDS.has(r.item_id),
  );
  if (inviolableFails.length > 0) {
    await audit({
      agent: "sentry",
      event: "advance_stage_refused",
      status: "confirmed_failure",
      recordId,
      inputSummary: { target_stage: stage, override_reason },
      outputSummary: {
        reason: "inviolable_block",
        inviolable_blockers: inviolableFails.map((r) => r.item_id),
      },
      decision: "refused_inviolable",
      ms: Date.now() - t0,
    });
    return NextResponse.json(
      {
        advanced: false,
        reason: "inviolable_block",
        message: `Cannot advance — inviolable items failed: ${inviolableFails.map((r) => r.item_id).join(", ")}. Override is NOT permitted.`,
        gate_result: gateResult,
      },
      { status: 409 },
    );
  }

  // ── Override path ──────────────────────────────────────────────────
  if (override_reason) {
    if (override_reason.trim().length < 5) {
      return NextResponse.json(
        { error: "override_reason must be at least 5 characters" },
        { status: 400 },
      );
    }
    const drift = await updateListingRecord(recordId, {
      Pipeline_Stage: stage,
    });
    await audit({
      agent: "sentry",
      event: "advance_stage_override",
      status: "uncertain", // override means we bypassed normal gate — flag for review
      recordId,
      inputSummary: { target_stage: stage, override_reason },
      outputSummary: {
        gate_overall_status: gateResult.overall_status,
        blockers: gateResult.blockers,
        warnings: gateResult.warnings,
        data_missing: gateResult.data_missing,
        airtable_drift_count: drift.length,
      },
      decision: "manual_override",
      ms: Date.now() - t0,
    });
    return NextResponse.json({
      advanced: true,
      new_stage: stage,
      via_override: true,
      override_reason,
      gate_result: gateResult,
      airtable_drift: drift,
    });
  }

  // ── Normal path ────────────────────────────────────────────────────
  if (gateResult.overall_status !== "pass") {
    return NextResponse.json(
      {
        advanced: false,
        reason: gateResult.overall_status,
        message: `Gate ${entry.gate.id} did not pass. Blockers: ${gateResult.blockers.join(", ") || "—"}. Data missing: ${gateResult.data_missing.join(", ") || "—"}. Use override_reason if you've reviewed and intend to bypass.`,
        gate_result: gateResult,
      },
      { status: 409 },
    );
  }
  const drift = await updateListingRecord(recordId, { Pipeline_Stage: stage });
  await audit({
    agent: "sentry",
    event: "advance_stage",
    status: "confirmed_success",
    recordId,
    inputSummary: { target_stage: stage },
    outputSummary: {
      gate_overall_status: gateResult.overall_status,
      airtable_drift_count: drift.length,
    },
    decision: "advanced",
    ms: Date.now() - t0,
  });
  return NextResponse.json({
    advanced: true,
    new_stage: stage,
    via_override: false,
    gate_result: gateResult,
    airtable_drift: drift,
  });
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  return executeAdvance({
    recordId: url.searchParams.get("recordId") ?? "",
    target_stage: url.searchParams.get("target_stage") ?? "",
    override_reason: url.searchParams.get("override_reason"),
  });
}

export async function POST(req: Request) {
  let body: { recordId?: string; target_stage?: string; override_reason?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  return executeAdvance({
    recordId: body.recordId ?? "",
    target_stage: body.target_stage ?? "",
    override_reason: body.override_reason ?? null,
  });
}
