// H2 Auto-Proceed queue re-verification (admin).  @agent: scout / crier
//
// GET  /api/admin/reverify-queue            → DRY run (report only)
// POST /api/admin/reverify-queue  body: { dry_run?: boolean (default TRUE),
//                                          limit?: number }
//
// Re-runs the CURRENT classifier over the existing H2-eligible queue — the
// gap the deployed listings-intake cron does NOT cover (that cron verifies
// NEW intake and skips known addresses). For each eligible listing:
//   verifyListing(address) → classifyVerifiedListing → planRequalification:
//     renovated / turnkey / new-construction / condition-missing → Review
//     inactive                                                   → Off Market
//     clean distress (accept)                                    → keep
//     Firecrawl INFRA failure                                    → skip (NO write)
//
// Safety: dry_run DEFAULTS TRUE — a write happens only on explicit
// { "dry_run": false }. Firecrawl infra failures NEVER demote (see
// lib/admin/reverify-queue.ts). Demotions are reversible (status flips,
// no delete) and carry a Verification_Notes provenance line.
//
// MUST run in the prod env where FIRECRAWL_API_KEY lives — without it,
// every listing returns firecrawl_not_configured → skip_unverified (no
// writes), which the summary surfaces loudly.
//
// Auth: the standard waterfall (CRON_SECRET / OAuth / dev bearer) + the
// same-origin dashboard cookie, matching the other /api/admin/* routes.

import { NextResponse } from "next/server";
import { getListings, patchListingsBatch, type BatchUpdateRequest } from "@/lib/airtable";
import { audit } from "@/lib/audit-log";
import {
  authenticate,
  hasDashboardSession,
  readAuthEnv,
  readAuthHeaders,
} from "@/lib/maverick/oauth/auth-waterfall";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";
import { selectH2Eligible } from "@/lib/h2-outreach";
import {
  verifyListing,
  classifyVerifiedListing,
  FIRECRAWL_RATE_LIMIT_PER_MINUTE,
} from "@/lib/crawler/sources/firecrawl";
import { runAsyncPool, makeRateGate } from "@/lib/crawler/async-pool";
import {
  planRequalification,
  requalWriteFields,
  buildRequalNote,
  type RequalAction,
} from "@/lib/admin/reverify-queue";
import type { Listing } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300;

const FIRECRAWL_MAX_CONCURRENT = Number(process.env.FIRECRAWL_MAX_CONCURRENT ?? "20");
const FIRECRAWL_TIME_BUDGET_MS = 270_000; // stop dispatching new scrapes; in-flight finish
const BATCH_SIZE = 10; // Airtable batched-PATCH hard cap
const ISO_DATE = "2026-05-28";

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

interface PlanRow {
  recordId: string;
  address: string;
  action: RequalAction["action"];
  reason: string;
}

async function authorize(req: Request): Promise<{ ok: true; kind: string } | { ok: false; resp: Response }> {
  const cookieHeader = req.headers.get("cookie");
  if (hasDashboardSession(cookieHeader)) return { ok: true, kind: "dashboard_session" };
  const env = readAuthEnv();
  const headers = readAuthHeaders(req);
  const authRequired = kvConfigured() || env.cronSecret !== null || env.bearerDevToken !== null;
  if (!authRequired) return { ok: true, kind: "none" };
  const auth = await authenticate(headers, env, kvProd);
  if (!auth.ok) {
    return { ok: false, resp: NextResponse.json({ error: "unauthorized", reason: auth.reason }, { status: 401 }) };
  }
  return { ok: true, kind: auth.kind };
}

async function run(req: Request, dryRun: boolean, limit: number | null): Promise<Response> {
  const t0 = Date.now();
  const auth = await authorize(req);
  if (!auth.ok) return auth.resp;

  let listings: Listing[];
  try {
    listings = await getListings();
  } catch (err) {
    return NextResponse.json({ error: "listings_fetch_failed", detail: String(err) }, { status: 502 });
  }
  let eligible = selectH2Eligible(listings);
  const eligibleCount = eligible.length;
  if (limit != null && limit > 0) eligible = eligible.slice(0, limit);

  // Firecrawl verify — bounded concurrency + global rate gate + wall-clock
  // guard (in-flight calls finish; undispatched land in pool.skipped).
  const rateGate = makeRateGate(FIRECRAWL_RATE_LIMIT_PER_MINUTE);
  const pool = await runAsyncPool({
    items: eligible,
    concurrency: FIRECRAWL_MAX_CONCURRENT,
    beforeDispatch: rateGate,
    shouldStopDispatch: () => Date.now() - t0 > FIRECRAWL_TIME_BUDGET_MS,
    worker: async (l: Listing) => verifyListing(l.address, {}),
  });

  const byRecord = new Map<string, Listing>(eligible.map((l) => [l.id, l]));
  const plan: PlanRow[] = [];
  const counts = { keep: 0, demote_review: 0, demote_dead: 0, skip_unverified: 0 };
  for (const { item, value: fc } of pool.results) {
    const action = planRequalification(classifyVerifiedListing(fc));
    counts[action.action]++;
    plan.push({ recordId: item.id, address: item.address, action: action.action, reason: action.reason });
  }

  const demotions = plan.filter((p) => p.action === "demote_review" || p.action === "demote_dead");
  const summary = {
    mode: dryRun ? "dry_run" : "apply",
    eligible_count: eligibleCount,
    processed: pool.results.length,
    time_budget_skipped: pool.skipped.length, // undispatched — never written
    counts,
    demotions,
    unverified: plan.filter((p) => p.action === "skip_unverified"),
  };

  if (dryRun) {
    await audit({
      agent: "scout",
      event: "h2_reverify_dry_run",
      status: "confirmed_success",
      inputSummary: { auth_kind: auth.kind, eligible_count: eligibleCount, processed: pool.results.length },
      outputSummary: counts,
    });
    return NextResponse.json(summary);
  }

  // ── APPLY: build demotion writes, batch ≤10, per-batch try/catch. ──
  const reqs: BatchUpdateRequest[] = demotions.map((d) => {
    const l = byRecord.get(d.recordId)!;
    const action: RequalAction =
      d.action === "demote_dead" ? { action: "demote_dead", reason: d.reason } : { action: "demote_review", reason: d.reason };
    return {
      recordId: d.recordId,
      fields: {
        ...requalWriteFields(action),
        Verification_Notes: buildRequalNote(l.notes, ISO_DATE, action),
      },
    };
  });

  const applied: Array<{ recordId: string; error: string | null }> = [];
  for (const batch of chunk(reqs, BATCH_SIZE)) {
    try {
      const outcomes = await patchListingsBatch(batch);
      for (const o of outcomes) applied.push({ recordId: o.recordId, error: o.error });
    } catch (err) {
      for (const b of batch) applied.push({ recordId: b.recordId, error: String(err) });
    }
  }
  const writeErrors = applied.filter((a) => a.error).length;
  await audit({
    agent: "scout",
    event: "h2_reverify_apply",
    status: writeErrors > 0 ? "uncertain" : "confirmed_success",
    inputSummary: { auth_kind: auth.kind, eligible_count: eligibleCount, demotions: demotions.length },
    outputSummary: { ...counts, write_errors: writeErrors },
  });
  return NextResponse.json({ ...summary, applied, write_errors: writeErrors });
}

export async function GET(req: Request): Promise<Response> {
  // GET is always a dry run — convenience for an operator browser/curl check.
  return run(req, true, readLimit(new URL(req.url).searchParams.get("limit")));
}

export async function POST(req: Request): Promise<Response> {
  let body: { dry_run?: boolean; limit?: number } = {};
  try {
    const text = await req.text();
    if (text.trim()) body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const dryRun = body.dry_run !== false; // defaults TRUE — write only on explicit false
  const limit = typeof body.limit === "number" && body.limit > 0 ? Math.floor(body.limit) : null;
  return run(req, dryRun, limit);
}

function readLimit(raw: string | null): number | null {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}
