// Stale Auto-Proceed outreach cleanup — one-time pre-H2-live mass reset.
// @agent: sentry
//
// POST /api/admin/cleanup-stale-outreach
//   body (all optional): { dry_run?: boolean, limit?: number }
//
// dry_run DEFAULTS TRUE — a write only happens on an explicit
// { "dry_run": false }. Reset path is Do_Not_Text=true + a provenance
// note (NON-destructive, reversible, preserves outreach history). DELETE
// is intentionally NOT implemented here: it is irreversible and gated on
// explicit operator confirmation.
//
// Selector (pure, lib/admin/cleanup-stale-outreach):
//   Outreach_Status empty + Execution_Path "Auto Proceed" +
//   Live_Status "Active" + Agent_Phone present + not already Do_Not_Text.
//   never-resurface addresses are EXCLUDED; restricted-state matches are
//   flagged P1 (expected 0) but still reset.
//
// Auth: the standard waterfall (OAuth mat_ / CRON_SECRET+x-vercel-cron /
// dev bearer) plus the same-origin dashboard cookie.
//
// Batching: Airtable's real 10-records-per-PATCH cap (NOT 50 as the brief
// listed). Sequential batches with per-batch try/catch isolation.

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
import {
  selectStaleOutreach,
  buildCleanupNote,
  toSampleRow,
} from "@/lib/admin/cleanup-stale-outreach";

export const runtime = "nodejs";
export const maxDuration = 300;

const BATCH_SIZE = 10;
const TODAY_ISO = "2026-05-26";

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export async function POST(req: Request) {
  const t0 = Date.now();

  // ── Auth waterfall (+ dashboard cookie) ──────────────────────────
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

  // ── Params: dry_run defaults TRUE ────────────────────────────────
  let body: { dry_run?: unknown; limit?: unknown } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    body = {};
  }
  const dryRun = body.dry_run !== false; // anything but explicit false stays dry
  const limit =
    typeof body.limit === "number" && body.limit > 0 ? Math.floor(body.limit) : null;

  // ── Select ───────────────────────────────────────────────────────
  const allListings = await getListings();
  const recordsScanned = allListings.length;
  const { eligible, excludedNeverResurface, restrictedStateViolations } =
    selectStaleOutreach(allListings);

  const queue = limit != null ? eligible.slice(0, limit) : eligible;

  const integrity = {
    restricted_state_violations: restrictedStateViolations.length,
    restricted_state_sample: restrictedStateViolations.slice(0, 10).map(toSampleRow),
    excluded_never_resurface: excludedNeverResurface.length,
    never_resurface_sample: excludedNeverResurface.slice(0, 10).map(toSampleRow),
  };

  // ── Dry-run: report only ─────────────────────────────────────────
  if (dryRun) {
    await audit({
      agent: "sentry",
      event: "cleanup_stale_outreach_dry_run",
      status: "confirmed_success",
      inputSummary: { auth_kind: authKind, dry_run: true, limit },
      outputSummary: {
        recordsScanned,
        recordsEligible: eligible.length,
        recordsToWrite: queue.length,
        ...integrity,
      },
      decision: "dry_run",
      ms: Date.now() - t0,
    });
    return NextResponse.json({
      mode: "dry_run",
      elapsed_ms: Date.now() - t0,
      action: "do_not_text",
      recordsScanned,
      recordsEligible: eligible.length,
      recordsToWrite: queue.length,
      integrity,
      sample_20: queue.slice(0, 20).map(toSampleRow),
    });
  }

  // ── Apply: Do_Not_Text=true + provenance note, batches of 10 ─────
  interface BatchOutcome {
    batch_index: number;
    record_ids: string[];
    success_count: number;
    error: string | null;
  }
  const batchOutcomes: BatchOutcome[] = [];
  const batches = chunk(queue, BATCH_SIZE);
  let recordsUpdated = 0;
  let recordsSkippedError = 0;

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const writes: BatchUpdateRequest[] = batch.map((l) => ({
      recordId: l.id,
      fields: {
        Do_Not_Text: true,
        Verification_Notes: buildCleanupNote(l.notes, TODAY_ISO),
      },
    }));
    try {
      const outcomes = await patchListingsBatch(writes);
      const successCount = outcomes.filter((o) => o.error == null).length;
      const errorCount = outcomes.length - successCount;
      recordsUpdated += successCount;
      recordsSkippedError += errorCount;
      batchOutcomes.push({
        batch_index: i,
        record_ids: batch.map((l) => l.id),
        success_count: successCount,
        error: errorCount > 0 ? `${errorCount} records missing from echo` : null,
      });
    } catch (err) {
      recordsSkippedError += batch.length;
      batchOutcomes.push({
        batch_index: i,
        record_ids: batch.map((l) => l.id),
        success_count: 0,
        error: String(err),
      });
    }
  }

  await audit({
    agent: "sentry",
    event: "cleanup_stale_outreach_apply",
    status: recordsSkippedError > 0 ? "uncertain" : "confirmed_success",
    inputSummary: { auth_kind: authKind, dry_run: false, limit },
    outputSummary: {
      recordsScanned,
      recordsEligible: eligible.length,
      recordsUpdated,
      recordsSkippedError,
      batch_count: batches.length,
      batch_size: BATCH_SIZE,
      ...integrity,
    },
    decision: "writes_applied",
    ms: Date.now() - t0,
  });

  return NextResponse.json({
    mode: "apply",
    elapsed_ms: Date.now() - t0,
    action: "do_not_text",
    recordsScanned,
    recordsEligible: eligible.length,
    recordsUpdated,
    recordsSkippedError,
    batch_count: batches.length,
    batch_size: BATCH_SIZE,
    integrity,
    batch_outcomes_sample: batchOutcomes.slice(0, 20),
  });
}
