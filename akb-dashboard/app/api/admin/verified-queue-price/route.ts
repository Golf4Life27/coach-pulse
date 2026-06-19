// Verified-queue pricing pass (M9, operator 2026-06-18).
// @agent: appraiser / maverick
//
// GET /api/admin/verified-queue-price
//   default     DRY-RUN: health preamble + the computed buyer-median pricing for
//               the verified batch. NO writes, NO sends.
//   ?apply=1    LIVE: after a HEALTHY preamble, write the MAO + transition
//               verified→priced through the sole-writer engine. STOPS at priced.
//   ?limit=N    cap the batch (default 10 — the watched first slice; max 300).
//
// SCOPE-LOCKED (operator): this pass + the reusable health preamble, nothing
// more. It NEVER advances Gate 1 / outreach_ready, never sends, never touches
// outreach_sent. Buyer-median-driven pricing only (no ARV multipliers); a record
// with no qualifying median HOLDs (stays verified, never a fabricated price).

import { NextResponse } from "next/server";
import { getListings, updateListingRecord } from "@/lib/airtable";
import { audit } from "@/lib/audit-log";
import {
  authenticate,
  hasDashboardSession,
  readAuthEnv,
  readAuthHeaders,
} from "@/lib/maverick/oauth/auth-waterfall";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";
import { checkSystemHealth } from "@/lib/health/system-health";
import { loadUnderwriteContextForListings } from "@/lib/track-aware-underwrite";
import { transitionToPriced } from "@/lib/pipeline-state/price-transition";
import { runAsyncPool } from "@/lib/crawler/async-pool";
import {
  planVerifiedQueuePricing,
  summarizeVerifiedPricing,
  type VerifiedPriceRow,
} from "@/lib/admin/verified-queue-price";

export const runtime = "nodejs";
export const maxDuration = 300;

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 300;
const BUDGET_MS = 250_000; // headroom under the 300s lambda ceiling
const CONCURRENCY = (() => {
  const raw = Number(process.env.VERIFIED_PRICE_CONCURRENCY);
  return Number.isFinite(raw) && raw >= 1 && raw <= 10 ? Math.floor(raw) : 4;
})();

export async function GET(req: Request) {
  const t0 = Date.now();
  const url = new URL(req.url);

  // ── Auth waterfall (mirror of the guarded admin routes) ──
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

  const apply = url.searchParams.get("apply") === "1";
  const limitRaw = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(MAX_LIMIT, Math.floor(limitRaw)) : DEFAULT_LIMIT;

  // ── HEALTH PREAMBLE — fail-closed. Halt the whole run (dry OR live) if KV is
  // down or the Firecrawl breaker is tripped. The underwrite/autoseed path fails
  // OPEN on a KV outage, so we refuse to run blind.
  const health = await checkSystemHealth();
  if (health.halt) {
    await audit({
      agent: "sentry",
      event: "verified_queue_price_halted",
      status: "confirmed_failure",
      inputSummary: { apply, limit, auth_kind: authKind },
      outputSummary: { halt_reasons: health.haltReasons, health },
    });
    return NextResponse.json(
      { halted: true, mode: apply ? "live" : "dry_run", reason: "health_preamble_halt", health },
      { status: 503 },
    );
  }

  // ── Select the verified queue ──
  const all = await getListings();
  const verified = all.filter((l) => ((l.pipelineStage ?? "") as string).trim() === "verified");
  const batch = verified.slice(0, limit);

  // ── Buyer-median underwrite (min-n gated in the loader) + plan ──
  const ctx = await loadUnderwriteContextForListings(batch);
  const rows = planVerifiedQueuePricing(batch, ctx);
  const summary = summarizeVerifiedPricing(rows);

  // ── DRY-RUN: report the math, write nothing ──
  if (!apply) {
    await audit({
      agent: "appraiser",
      event: "verified_queue_price_dry_run",
      status: "confirmed_success",
      inputSummary: { limit, auth_kind: authKind },
      outputSummary: { total_verified: verified.length, batch_size: batch.length, ...summary },
    });
    return NextResponse.json({
      mode: "dry_run",
      health,
      total_verified: verified.length,
      batch_size: batch.length,
      summary,
      ctx_errors: Object.fromEntries([...ctx.errors.entries()].slice(0, 40)),
      rows,
      duration_ms: Date.now() - t0,
    });
  }

  // ── LIVE: price + transition verified→priced through the sole-writer engine.
  // STOPS at priced — no Gate 1, no sends. HOLD rows are left at verified.
  const priceRows = rows.filter((r) => r.decision === "price");
  const deadline = t0 + BUDGET_MS;
  const byId = new Map(batch.map((l) => [l.id, l] as const));

  type Outcome = { recordId: string; transitioned: boolean; outcome: string; error: string | null };
  const pool = await runAsyncPool<VerifiedPriceRow, Outcome>({
    items: priceRows,
    concurrency: CONCURRENCY,
    shouldStopDispatch: () => Date.now() >= deadline,
    worker: async (r): Promise<Outcome> => {
      try {
        const l = byId.get(r.recordId);
        const iso = new Date().toISOString();
        const note =
          `[${iso}] PRICED via verified-queue pass (M9): buyer-median ${r.buyerMedianSource ?? "?"} ` +
          `$${(r.buyerMedian ?? 0).toLocaleString()} -> Investor_MAO $${(r.investorMao ?? 0).toLocaleString()} ` +
          `(${r.formula}, track ${r.track}). verified->priced.`;
        await updateListingRecord(r.recordId, {
          Underwritten_MAO: r.investorMao,
          Underwritten_MAO_Track: r.track,
          Verification_Notes: l?.notes ? `${l.notes}\n${note}` : note,
        });
        const tr = await transitionToPriced(
          r.recordId,
          "verified",
          `verified_queue_price:${r.buyerMedianSource ?? "median"}`,
        );
        return {
          recordId: r.recordId,
          transitioned: tr.ok && tr.outcome === "applied",
          outcome: tr.outcome,
          error: tr.ok ? null : tr.message,
        };
      } catch (e) {
        return { recordId: r.recordId, transitioned: false, outcome: "error", error: e instanceof Error ? e.message : String(e) };
      }
    },
  });

  const transitioned = pool.results.filter((x) => x.value.transitioned).length;
  const failed = pool.results.filter((x) => !x.value.transitioned).map((x) => x.value);
  await audit({
    agent: "appraiser",
    event: "verified_queue_price_live",
    status: failed.length > 0 ? "uncertain" : "confirmed_success",
    inputSummary: { limit, auth_kind: authKind },
    outputSummary: {
      total_verified: verified.length,
      priceable: priceRows.length,
      transitioned,
      failed: failed.length,
      budget_hit: pool.skipped.length > 0,
    },
  });

  return NextResponse.json({
    mode: "live",
    health,
    total_verified: verified.length,
    batch_size: batch.length,
    priceable: priceRows.length,
    transitioned,
    held: summary.held,
    failed,
    budget_hit: pool.skipped.length > 0,
    deferred_to_next_run: pool.skipped.length,
    summary,
    duration_ms: Date.now() - t0,
  });
}
