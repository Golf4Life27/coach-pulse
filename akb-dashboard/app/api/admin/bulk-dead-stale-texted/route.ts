// Bulk-dead stale Texted records — Alex 5/14 policy.
//
// GET /api/admin/bulk-dead-stale-texted[?dry_run=1&limit=N]
//
// Filter: Outreach_Status = "Texted" AND Last_Outreach_Date < 2026-05-07
// (the 5/7 + 5/12 cohort is the legitimate D3-cadence pool and is
// spared by the date cutoff).
//
// Per-record:
//   - Read existing Notes
//   - Idempotency check via lib/bulk-dead-annotation (skips records
//     that already carry "BULK DEAD per stale records policy")
//   - Compute days-since-Last_Outreach_Date
//   - Append the bulk-dead annotation
//   - Set Outreach_Status → Dead
//
// Batching: 10 records per Airtable PATCH (Airtable's actual cap; not
// 50 as the spec listed — surface-level note in chat). Sequential
// batches with per-batch audit + try/catch isolation.
//
// Idempotent: re-running over the same cohort produces zero writes
// because every record will have the sentinel from the prior run.
//
// Dry-run default off. Pass ?dry_run=1 to inspect without writes.
// Pass ?limit=N to cap writes for staged rollout.
//
// One-time operation by design — no cron wiring. Endpoint stays in
// the codebase for future stale-cleanup patterns.

import { NextResponse } from "next/server";
import { getListings, patchListingsBatch, type BatchUpdateRequest } from "@/lib/airtable";
import { audit } from "@/lib/audit-log";
import { annotateBulkDead } from "@/lib/bulk-dead-annotation";

export const runtime = "nodejs";
export const maxDuration = 90;

// Date cutoff. Records with Last_Outreach_Date STRICTLY BEFORE this
// date are bulk-dead. The 25 records dated 2026-05-07 and 2026-05-12
// stay live for D3 cadence.
const STALE_CUTOFF_ISO = "2026-05-07";

// Match airtable.ts AIRTABLE_BATCH_LIMIT. Re-stated here so this
// endpoint is self-documenting about its batch granularity.
const BATCH_SIZE = 10;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export async function GET(req: Request) {
  const t0 = Date.now();
  const url = new URL(req.url);
  const dryRun = url.searchParams.get("dry_run") === "1";
  const limitParam = url.searchParams.get("limit");
  const limit = limitParam ? Math.max(1, parseInt(limitParam, 10) || 0) : null;
  const now = new Date();

  const allListings = await getListings();
  const recordsScanned = allListings.length;

  // Eligibility: Texted + Last_Outreach_Date strictly before cutoff.
  const eligible = allListings.filter((l) => {
    const status = (l.outreachStatus ?? "").toLowerCase();
    if (status !== "texted") return false;
    const lod = l.lastOutreachDate;
    if (!lod) return false;
    return lod < STALE_CUTOFF_ISO; // lexicographic compare on ISO date works
  });

  // Per-record decisions (still pure — no writes yet).
  type AnnotateRow = {
    recordId: string;
    address: string;
    daysSince: number;
    previousNotes: string | null;
    newNotes: string;
  };
  const toAnnotate: AnnotateRow[] = [];
  const skippedAlreadyDone: string[] = [];
  const skippedMissingDate: string[] = [];

  for (const l of eligible) {
    const result = annotateBulkDead({
      recordId: l.id,
      currentNotes: l.notes,
      lastOutreachDate: l.lastOutreachDate,
      now,
    });
    switch (result.decision) {
      case "annotate":
        toAnnotate.push({
          recordId: l.id,
          address: l.address,
          daysSince: result.daysSince,
          previousNotes: l.notes ?? null,
          newNotes: result.newNotes,
        });
        break;
      case "skip_already_annotated":
        skippedAlreadyDone.push(l.id);
        break;
      case "skip_missing_outreach_date":
        skippedMissingDate.push(l.id);
        break;
    }
  }

  const queue = limit != null ? toAnnotate.slice(0, limit) : toAnnotate;

  // Dry-run: report what would happen; no writes.
  if (dryRun) {
    await audit({
      agent: "bulk-dead",
      event: "bulk_dead_dry_run",
      status: "confirmed_success",
      inputSummary: { dryRun: true, limit, stale_cutoff: STALE_CUTOFF_ISO },
      outputSummary: {
        recordsScanned,
        recordsEligible: eligible.length,
        recordsToWrite: queue.length,
        recordsSkippedAlreadyDone: skippedAlreadyDone.length,
        recordsSkippedMissingDate: skippedMissingDate.length,
      },
      decision: "dry_run",
      ms: Date.now() - t0,
    });
    return NextResponse.json({
      mode: "dry_run",
      elapsed_ms: Date.now() - t0,
      stale_cutoff: STALE_CUTOFF_ISO,
      recordsScanned,
      recordsEligible: eligible.length,
      recordsToWrite: queue.length,
      recordsSkippedAlreadyDone: skippedAlreadyDone.length,
      recordsSkippedMissingDate: skippedMissingDate.length,
      annotate_sample: queue.slice(0, 10).map((r) => ({
        recordId: r.recordId,
        address: r.address,
        daysSince: r.daysSince,
      })),
    });
  }

  // Apply mode: chunk into batches of 10, PATCH each, isolate errors.
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
    const writes: BatchUpdateRequest[] = batch.map((r) => ({
      recordId: r.recordId,
      fields: {
        Outreach_Status: "Dead",
        Verification_Notes: r.newNotes,
      },
    }));
    try {
      const outcomes = await patchListingsBatch(writes);
      // patchListingsBatch never returns per-record errors today
      // (Airtable's all-or-nothing semantics mean batch either fully
      // succeeds or throws). The "absent from response" branch is
      // defensive — count any that come back without an echo as a
      // failure to be safe.
      const successCount = outcomes.filter((o) => o.error == null).length;
      const errorCount = outcomes.length - successCount;
      recordsUpdated += successCount;
      recordsSkippedError += errorCount;
      batchOutcomes.push({
        batch_index: i,
        record_ids: batch.map((r) => r.recordId),
        success_count: successCount,
        error: errorCount > 0 ? `${errorCount} records missing from echo` : null,
      });
    } catch (err) {
      const msg = String(err);
      recordsSkippedError += batch.length;
      batchOutcomes.push({
        batch_index: i,
        record_ids: batch.map((r) => r.recordId),
        success_count: 0,
        error: msg,
      });
      // Continue to next batch instead of aborting. Audit captures the
      // batch failure; spot-check after the run finds any gaps.
    }
  }

  await audit({
    agent: "bulk-dead",
    event: "bulk_dead_apply",
    status: recordsSkippedError > 0 ? "uncertain" : "confirmed_success",
    inputSummary: { dryRun: false, limit, stale_cutoff: STALE_CUTOFF_ISO },
    outputSummary: {
      recordsScanned,
      recordsEligible: eligible.length,
      recordsUpdated,
      recordsSkippedAlreadyDone: skippedAlreadyDone.length,
      recordsSkippedMissingDate: skippedMissingDate.length,
      recordsSkippedError,
      batch_count: batches.length,
      batch_size: BATCH_SIZE,
    },
    decision: "writes_applied",
    ms: Date.now() - t0,
  });

  return NextResponse.json({
    mode: "apply",
    elapsed_ms: Date.now() - t0,
    stale_cutoff: STALE_CUTOFF_ISO,
    recordsScanned,
    recordsEligible: eligible.length,
    recordsUpdated,
    recordsSkippedAlreadyDone: skippedAlreadyDone.length,
    recordsSkippedMissingDate: skippedMissingDate.length,
    recordsSkippedError,
    batch_count: batches.length,
    batch_size: BATCH_SIZE,
    // Cap output to keep response payload bounded — the audit log
    // is the durable record.
    batch_outcomes_sample: batchOutcomes.slice(0, 20),
    annotate_sample: queue.slice(0, 5).map((r) => ({
      recordId: r.recordId,
      address: r.address,
      daysSince: r.daysSince,
    })),
  });
}
