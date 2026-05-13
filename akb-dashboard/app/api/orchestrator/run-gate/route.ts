// GET /api/orchestrator/run-gate?recordId=...&gate_id=...
// POST /api/orchestrator/run-gate { recordId, gate_id }
//
// Runs a Gate against a record and returns the GateRunResult. Does NOT
// advance Pipeline_Stage — that's a separate endpoint (advance-stage).
// This endpoint is purely diagnostic; the gate-runner audit-logs every
// run regardless of overall_status.
//
// GET form mirrors POST for Vercel MCP web_fetch_vercel_url compat.

import { NextResponse } from "next/server";
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

export const runtime = "nodejs";
export const maxDuration = 60;

// Registry of known gates. Add Gates 4-5 here as their check modules land.
const GATES = {
  pre_outreach: {
    gate: PRE_OUTREACH_GATE,
    checks: PRE_OUTREACH_CHECKS,
    config: PRE_OUTREACH_CONFIG as unknown as Record<string, unknown>,
  },
  pre_send: {
    gate: PRE_SEND_GATE,
    checks: PRE_SEND_CHECKS,
    config: PRE_SEND_CONFIG as unknown as Record<string, unknown>,
  },
  pre_negotiation: {
    gate: PRE_NEGOTIATION_GATE,
    checks: PRE_NEGOTIATION_CHECKS,
    config: PRE_NEGOTIATION_CONFIG as unknown as Record<string, unknown>,
  },
} as const;

type KnownGateId = keyof typeof GATES;

async function executeRunGate(recordId: string | null, gateId: string | null) {
  if (!recordId || !recordId.startsWith("rec")) {
    return NextResponse.json({ error: "Invalid or missing recordId" }, { status: 400 });
  }
  if (!gateId || !(gateId in GATES)) {
    return NextResponse.json(
      {
        error: "Unknown gate_id",
        known_gates: Object.keys(GATES),
      },
      { status: 400 },
    );
  }
  const entry = GATES[gateId as KnownGateId];
  const result = await runGate({
    gate: entry.gate,
    recordId,
    checks: entry.checks,
    config: entry.config,
  });
  return NextResponse.json(result);
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  return executeRunGate(url.searchParams.get("recordId"), url.searchParams.get("gate_id"));
}

export async function POST(req: Request) {
  let body: { recordId?: string; gate_id?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  return executeRunGate(body.recordId ?? null, body.gate_id ?? null);
}
