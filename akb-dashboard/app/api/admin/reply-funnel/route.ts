// Reply-funnel report — the cohort question the send side never asked.
// @agent: sentinel
//
// GET /api/admin/reply-funnel
//   → READ-ONLY, always. Rolls every record carrying a genuine inbound into
//     {outcome, classification × outcome, dropped work-list} and reports the
//     load-bearing number: replies → contracts.
//   ?limit=N       — cap the dropped work-list in the response (default 25).
//
// Reads the persisted Reply_Classification triple (lib/inbound/
// reply-classification.ts). Records whose reply predates that fix report as
// "(unclassified)" — classificationCoveragePct is the meter for how much
// backfill is still outstanding, so a partially-backfilled base reports its
// own incompleteness instead of quietly under-counting a bucket.
//
// Auth: dashboard cookie / CRON_SECRET / OAuth waterfall. Writes NOTHING.

import { NextResponse } from "next/server";
import { getListings } from "@/lib/airtable";
import {
  authenticate,
  hasDashboardSession,
  readAuthEnv,
  readAuthHeaders,
} from "@/lib/maverick/oauth/auth-waterfall";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";
import { rollupReplyFunnel, type ReplyFunnelInput } from "@/lib/outreach/reply-funnel";

export const runtime = "nodejs";
export const maxDuration = 120;

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
  const rawLimit = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(200, Math.floor(rawLimit)) : 25;

  let listings;
  try {
    listings = await getListings({ includeLegacy: true });
  } catch (err) {
    return NextResponse.json(
      { error: "listings_fetch_failed", message: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }

  // Only records with a genuine inbound enter the funnel — Last_Inbound_At is
  // stamped exclusively by the reply paths (scan-replies / scan-comms /
  // capture), all of which strip self-echo and bot autoreplies first.
  const replied: ReplyFunnelInput[] = listings
    .filter((l) => Boolean(l.lastInboundAt))
    .map((l) => ({
      id: l.id,
      address: l.address,
      outreachStatus: l.outreachStatus,
      lastInboundAt: l.lastInboundAt ?? null,
      contractExecutedAt: l.contractExecutedAt ?? null,
      replyClassification: l.replyClassification ?? null,
      replyDecisionKind: l.replyDecisionKind ?? null,
    }));

  const summary = rollupReplyFunnel(replied);
  const totalTexted = listings.filter((l) => Boolean(l.lastOutreachDate)).length;

  return NextResponse.json({
    ok: true,
    auth_kind: authKind,
    took_ms: Date.now() - t0,
    // The top-of-funnel context the reply numbers only mean something against.
    outbound: {
      ever_texted: totalTexted,
      replies: summary.replies,
      reply_rate_pct: totalTexted === 0 ? 0 : Math.round((summary.replies / totalTexted) * 1000) / 10,
    },
    classification_coverage: {
      classified: summary.classified,
      of: summary.replies,
      pct: summary.classificationCoveragePct,
      note:
        summary.classificationCoveragePct >= 100
          ? "complete"
          : "incomplete — replies predating the 2026-07-31 persistence fix report as (unclassified); run /api/admin/reply-triage-backfill",
    },
    by_outcome: summary.byOutcome,
    by_classification_outcome: summary.byClassificationOutcome,
    reply_to_contract_pct: summary.replyToContractPct,
    dropped: {
      count: summary.dropped.length,
      note: "replied, never advanced past the send-side status — threads nobody answered",
      sample: summary.dropped.slice(0, limit),
    },
  });
}
