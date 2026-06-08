// KV audit-tail surfacing — full entries by event / record.
// @agent: maverick
//
// GET /api/admin/audit-tail
//   ?event=listings_intake_live   filter to one event name (the intake
//                                  funnel: raw → accepted → duplicate →
//                                  rejected lives in outputSummary).
//   ?recordId=rec...              filter to one record's write trail.
//   ?limit=N                      KV entries to scan (default 500, max 1000).
//
// The existing /api/admin/audit-summary aggregates; this returns the RAW
// matching entries (inputSummary + outputSummary intact) so the operator
// can read a cron's funnel numbers or trace who wrote a field. Read-only.
//
// NOTE on retention: KV holds the most-recent ~5000 audit entries (the
// ring is lpush+ltrim'd). High-frequency crons (rehab every 5m, etc.)
// age out old entries fast — a multi-day-old write may no longer be in
// KV. An empty result for an old event means "aged out", not "never
// happened".
//
// Auth: dashboard cookie / CRON_SECRET / OAuth waterfall.

import { NextResponse } from "next/server";
import { readRecentFromKv, type AuditEntry } from "@/lib/audit-log";
import {
  authenticate,
  hasDashboardSession,
  readAuthEnv,
  readAuthHeaders,
} from "@/lib/maverick/oauth/auth-waterfall";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function GET(req: Request) {
  const t0 = Date.now();

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
      if (!auth.ok) return NextResponse.json({ error: "unauthorized", reason: auth.reason }, { status: 401 });
      authKind = auth.kind;
    }
  }

  const url = new URL(req.url);
  const event = url.searchParams.get("event");
  const recordId = url.searchParams.get("recordId");
  const limitRaw = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 1000) : 500;

  let entries: AuditEntry[];
  try {
    entries = await readRecentFromKv(limit);
  } catch (err) {
    return NextResponse.json(
      { error: "kv_read_failed", message: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }

  const matched = entries.filter(
    (e) => (!event || e.event === event) && (!recordId || e.recordId === recordId),
  );

  return NextResponse.json({
    ok: true,
    auth_kind: authKind,
    filters: { event, recordId, limit },
    scanned: entries.length,
    kv_oldest_ts: entries.length ? entries[entries.length - 1].ts : null,
    kv_newest_ts: entries.length ? entries[0].ts : null,
    matched_count: matched.length,
    entries: matched,
    duration_ms: Date.now() - t0,
  });
}
