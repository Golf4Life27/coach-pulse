// Maverick operator-priorities — the dashboard's "what needs YOU now" feed.
// @agent: maverick
//
// GET  → ranked live operator actions (curated queue, expired/done filtered).
//        Open like /api/morning-briefing: read-only, same trust boundary as
//        the rest of the dashboard surface.
// POST → { upsert?: OperatorAction[], complete?: string[] } — Maverick
//        sessions/automation manage the queue. WRITE-guarded by the standard
//        auth waterfall (OAuth / CRON_SECRET+x-vercel-cron / dev bearer) or
//        the same-origin dashboard cookie, and audited.
//
// Anti-staleness doctrine: items REQUIRE expiresAt (upserts without a valid
// future-parseable expiresAt are rejected), the GET filters expired/done, and
// the card UI shows posted-age. A stale "authoritative" card is worse than an
// empty strip — MorningBriefing below remains the live-derived truth layer.

import { NextResponse } from "next/server";
import { audit } from "@/lib/audit-log";
import {
  authenticate,
  hasDashboardSession,
  readAuthEnv,
  readAuthHeaders,
} from "@/lib/maverick/oauth/auth-waterfall";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";
import {
  rankOperatorActions,
  readOperatorActions,
  upsertOperatorActions,
  completeOperatorActions,
  type OperatorAction,
} from "@/lib/maverick/operator-actions";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function GET() {
  if (!kvConfigured()) {
    return NextResponse.json({ actions: [], generated_at: new Date().toISOString(), kv: false });
  }
  const nowIso = new Date().toISOString();
  const all = await readOperatorActions(kvProd);
  const ranked = rankOperatorActions(all, nowIso);
  return NextResponse.json({
    actions: ranked,
    generated_at: nowIso,
    total_stored: all.length,
    kv: true,
  });
}

const REQUIRED_STRING_FIELDS = ["id", "title", "why", "expiresAt", "postedAt", "postedBy"] as const;

function validateAction(x: unknown): x is OperatorAction {
  if (typeof x !== "object" || x == null) return false;
  const a = x as Record<string, unknown>;
  for (const f of REQUIRED_STRING_FIELDS) {
    if (typeof a[f] !== "string" || (a[f] as string).length === 0) return false;
  }
  // expiresAt must parse and sit in the future — the anti-staleness rail.
  const exp = new Date(a.expiresAt as string).getTime();
  if (!Number.isFinite(exp) || exp <= Date.now()) return false;
  if (a.revenueUsd != null && typeof a.revenueUsd !== "number") return false;
  if (a.deadlineAt != null && typeof a.deadlineAt !== "string") return false;
  if (a.href != null && typeof a.href !== "string") return false;
  if (a.instructions != null && typeof a.instructions !== "string") return false;
  return true;
}

export async function POST(req: Request) {
  const t0 = Date.now();

  // ── Auth waterfall (+ dashboard cookie) — writes are never open ──
  const cookieHeader = req.headers.get("cookie");
  let authKind: "dashboard_session" | "oauth" | "cron" | "bearer_dev" | "none" = "none";
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

  if (!kvConfigured()) {
    return NextResponse.json({ error: "kv_not_configured" }, { status: 503 });
  }

  let body: { upsert?: unknown; complete?: unknown } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    body = {};
  }

  const upsertRaw = Array.isArray(body.upsert) ? body.upsert : [];
  const valid = upsertRaw.filter(validateAction);
  const invalid = upsertRaw.length - valid.length;
  const completeIds = Array.isArray(body.complete)
    ? body.complete.filter((x): x is string => typeof x === "string")
    : [];

  if (valid.length === 0 && completeIds.length === 0) {
    return NextResponse.json(
      {
        error: "nothing_to_do",
        hint: "body.upsert (OperatorAction[], each with future expiresAt) and/or body.complete (string ids)",
        invalid_upserts: invalid,
      },
      { status: 400 },
    );
  }

  const upserted = valid.length > 0 ? await upsertOperatorActions(kvProd, valid) : { total: undefined };
  const completed = completeIds.length > 0 ? await completeOperatorActions(kvProd, completeIds) : { completed: 0 };

  await audit({
    agent: "maverick",
    event: "operator_actions_write",
    status: "confirmed_success",
    inputSummary: { auth_kind: authKind, upserts: valid.length, invalid_upserts: invalid, completes: completeIds },
    outputSummary: { total_stored: upserted.total, completed: completed.completed },
    decision: "operator_queue_updated",
    ms: Date.now() - t0,
  });

  return NextResponse.json({
    ok: true,
    upserted: valid.length,
    invalid_upserts: invalid,
    completed: completed.completed,
    total_stored: upserted.total,
  });
}
