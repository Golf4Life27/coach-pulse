// Build Ledger API — what is in the works, each step's status/% progress,
// and the operator's action items. The durable list Alex reads every
// morning (operator directive 2026-09-05).
//
// GET  -> { ok, summary, steps }
// POST -> upsert one step, matched on (Project, Step): { project, step,
//         status?, progressPct?, owner?, actionItem?, nextStep?, notes? }
//
// Auth: same waterfall as /api/admin/audit-tail (dashboard cookie ->
// CRON_SECRET / bearer / OAuth waterfall).

import { NextResponse } from "next/server";
import {
  fetchBuildLedger,
  summarizeBuildLedger,
  upsertBuildStep,
  type BuildOwner,
  type BuildStatus,
} from "@/lib/build-ledger";
import {
  authenticate,
  hasDashboardSession,
  readAuthEnv,
  readAuthHeaders,
} from "@/lib/maverick/oauth/auth-waterfall";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";

export const runtime = "nodejs";
export const maxDuration = 30;

async function checkAuth(req: Request): Promise<{ ok: true; authKind: string } | { ok: false; res: NextResponse }> {
  const cookieHeader = req.headers.get("cookie");
  if (hasDashboardSession(cookieHeader)) return { ok: true, authKind: "dashboard_session" };
  const env = readAuthEnv();
  const headers = readAuthHeaders(req);
  const authRequired = kvConfigured() || env.cronSecret !== null || env.bearerDevToken !== null;
  if (!authRequired) return { ok: true, authKind: "none" };
  const auth = await authenticate(headers, env, kvProd);
  if (!auth.ok) {
    return { ok: false, res: NextResponse.json({ error: "unauthorized", reason: auth.reason }, { status: 401 }) };
  }
  return { ok: true, authKind: auth.kind };
}

export async function GET(req: Request) {
  const auth = await checkAuth(req);
  if (!auth.ok) return auth.res;

  try {
    const steps = await fetchBuildLedger();
    const summary = summarizeBuildLedger(steps, new Date());
    return NextResponse.json({ ok: true, summary, steps });
  } catch (err) {
    console.error("[build-ledger] GET failed:", err);
    return NextResponse.json(
      { ok: false, error: "build_ledger_read_failed", detail: String(err) },
      { status: 502 },
    );
  }
}

const VALID_STATUSES = new Set<BuildStatus>(["Idea", "Planned", "In Progress", "Blocked", "Done", "Parked"]);
const VALID_OWNERS = new Set<BuildOwner>(["machine", "operator"]);

export async function POST(req: Request) {
  const auth = await checkAuth(req);
  if (!auth.ok) return auth.res;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const project = typeof body.project === "string" ? body.project.trim() : "";
  const step = typeof body.step === "string" ? body.step.trim() : "";
  if (!project || !step) {
    return NextResponse.json({ ok: false, error: "project_and_step_required" }, { status: 400 });
  }

  const status = typeof body.status === "string" && VALID_STATUSES.has(body.status as BuildStatus)
    ? (body.status as BuildStatus)
    : undefined;
  if (body.status !== undefined && status === undefined) {
    return NextResponse.json({ ok: false, error: "invalid_status" }, { status: 400 });
  }
  const owner = typeof body.owner === "string" && VALID_OWNERS.has(body.owner as BuildOwner)
    ? (body.owner as BuildOwner)
    : undefined;
  if (body.owner !== undefined && owner === undefined) {
    return NextResponse.json({ ok: false, error: "invalid_owner" }, { status: 400 });
  }
  const progressPct = typeof body.progressPct === "number" && Number.isFinite(body.progressPct)
    ? Math.max(0, Math.min(100, body.progressPct))
    : undefined;

  try {
    const record = await upsertBuildStep({
      project,
      step,
      status,
      progressPct,
      owner,
      actionItem: typeof body.actionItem === "string" ? body.actionItem : undefined,
      nextStep: typeof body.nextStep === "string" ? body.nextStep : undefined,
      notes: typeof body.notes === "string" ? body.notes : undefined,
    });
    return NextResponse.json({ ok: true, step: record });
  } catch (err) {
    console.error("[build-ledger] POST failed:", err);
    return NextResponse.json(
      { ok: false, error: "build_ledger_write_failed", detail: String(err) },
      { status: 502 },
    );
  }
}
