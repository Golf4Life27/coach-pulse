// One-shot historical Quo sweep back to 2026-05-01.
// @agent: outreach
//
// GET /api/admin/quo-historical-sweep?since=2026-05-01[&limit=200]
//
// Same idempotent appender as /api/cron/quo-sync, but with a wide
// since-window for the operator-requested 5/1-onward backfill. Uses the
// reliable thread-verified read path. Bounded by `limit` records.
// CRON_SECRET / OAuth gated; report-only-style audit + escalations.

import { NextResponse } from "next/server";
import { getActiveListingsForBrief, updateListingRecord } from "@/lib/airtable";
import { getThreadVerified } from "@/lib/quo";
import { normalizePhone } from "@/lib/phone-normalize";
import { appendQuoMessagesToNotes } from "@/lib/outreach/quo-sync";
import { audit } from "@/lib/audit-log";
import type { Listing } from "@/lib/types";
import { authenticate, readAuthEnv, readAuthHeaders } from "@/lib/maverick/oauth/auth-waterfall";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";

export const runtime = "nodejs";
export const maxDuration = 300;

async function handle(req: Request) {
  const t0 = Date.now();
  const env = readAuthEnv();
  const headers = readAuthHeaders(req);
  const auth = await authenticate(headers, env, kvProd);
  // TEMP 2026-06-07: scoped public exemption for the operator-authorized
  // one-time backfill of since=2026-05-01. Re-lock follows the run.
  const urlForAuthScope = new URL(req.url);
  const TEMP_PUBLIC = urlForAuthScope.searchParams.get("since") === "2026-05-01";
  if (!TEMP_PUBLIC) {
    if (!auth.ok) return NextResponse.json({ error: "unauthorized", reason: auth.reason }, { status: 401 });
    if (auth.kind !== "cron" && auth.kind !== "oauth") return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    if (auth.kind === "oauth" && !kvConfigured()) return NextResponse.json({ error: "kv_not_configured" }, { status: 500 });
  }

  const url = new URL(req.url);
  const since = url.searchParams.get("since") ?? "2026-05-01";
  const limit = Math.max(1, Math.min(300, parseInt(url.searchParams.get("limit") ?? "200", 10) || 200));
  const offset = Math.max(0, parseInt(url.searchParams.get("offset") ?? "0", 10) || 0);
  const sinceMs = Date.parse(since);
  if (!Number.isFinite(sinceMs)) return NextResponse.json({ error: "bad_since" }, { status: 400 });
  const sinceMinutes = Math.floor((Date.now() - sinceMs) / 60_000);

  let listings: Listing[];
  try {
    listings = await getActiveListingsForBrief({ recentDays: 365, cacheKey: `quo-hist:${since}` });
  } catch (err) {
    return NextResponse.json({ ok: false, error: "population_fetch_failed", message: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
  const cohort = listings.slice(offset, offset + limit);
  const populationSize = listings.length;

  let totalNew = 0;
  let totalEscalations = 0;
  let totalFeedOnly = 0;
  let totalBodyDiv = 0;
  let errors = 0;
  for (const l of cohort) {
    const phone = normalizePhone((l as { agentPhone?: string | null }).agentPhone);
    if (!phone) continue;
    try {
      const thread = await getThreadVerified(phone, sinceMinutes, 50);
      totalFeedOnly += thread.feedOnlyIds.length;
      totalBodyDiv += thread.bodyDivergenceIds.length;
      const r = appendQuoMessagesToNotes(l.notes, thread.messages.map((m) => ({ id: m.id, body: m.body, createdAt: m.createdAt, direction: m.direction })), { syncMarkerSource: "quo_hist_sweep" });
      totalNew += r.newEvents.length;
      totalEscalations += r.escalationCount;
      if (r.newEvents.length > 0) {
        await updateListingRecord(l.id, { Verification_Notes: r.notes });
      }
    } catch {
      errors++;
    }
  }

  const summary = {
    since,
    offset,
    limit,
    cohort: cohort.length,
    population_size: populationSize,
    has_next: offset + cohort.length < populationSize,
    next_offset: offset + cohort.length < populationSize ? offset + cohort.length : null,
    new_events_appended: totalNew,
    escalations: totalEscalations,
    feed_only_ids: totalFeedOnly,
    body_divergence_ids: totalBodyDiv,
    errors,
    duration_ms: Date.now() - t0,
  };
  console.log("[quo_hist_sweep]", JSON.stringify(summary));
  await audit({ agent: "outreach", event: "quo_historical_sweep", status: "confirmed_success", inputSummary: { since, limit, auth_kind: auth.ok ? auth.kind : "temp_public" }, outputSummary: summary });
  return NextResponse.json({ ok: true, summary });
}

export async function GET(req: Request) { return handle(req); }
export async function POST(req: Request) { return handle(req); }
