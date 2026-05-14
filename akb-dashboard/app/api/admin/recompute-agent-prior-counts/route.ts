// Path Y — recurring recompute of Agent_Prior_Outreach_Count from
// normalized phones.
//
// GET /api/admin/recompute-agent-prior-counts[?dry_run=1&limit=N]
//
// Replaces the Make scenario that previously populated this field
// (which grouped by raw Agent_Phone string and undercounted/overcounted
// in both directions — 5/14 finding). Logic lives in
// lib/agent-prior-counts.ts so it's unit-testable.
//
// Default: apply mode (writes back). Add ?dry_run=1 to inspect without
// writing. The function is idempotent — repeated runs that find no
// drift produce zero writes.
//
// Wired to Vercel cron in vercel.json (every 6 hours). Manual GET also
// works for ad-hoc inspection. Audit-logs every run with the diagnostic
// counters Alex asked for in the 5/14 spec.

import { NextResponse } from "next/server";
import { getListings, updateListingRecord } from "@/lib/airtable";
import { audit } from "@/lib/audit-log";
import {
  computeAgentPriorCounts,
  changedUpdates,
  type PriorCountUpdate,
} from "@/lib/agent-prior-counts";

export const runtime = "nodejs";
export const maxDuration = 90;

export async function GET(req: Request) {
  const t0 = Date.now();
  const url = new URL(req.url);
  // Default to apply (cron + manual both want writes). Explicit
  // ?dry_run=1 inspects without writing.
  const dryRun = url.searchParams.get("dry_run") === "1";
  const limitParam = url.searchParams.get("limit");
  const limit = limitParam ? Math.max(1, parseInt(limitParam, 10) || 0) : null;

  const allListings = await getListings();
  const result = computeAgentPriorCounts(allListings);
  const changed = changedUpdates(result.updates);
  const writeQueue = limit != null ? changed.slice(0, limit) : changed;

  interface WriteOutcome {
    recordId: string;
    previousCount: number | null;
    newCount: number;
    written: boolean;
    error: string | null;
  }
  const writeOutcomes: WriteOutcome[] = [];
  let recordsUpdated = 0;
  let writeErrors = 0;

  if (!dryRun) {
    for (const u of writeQueue) {
      try {
        await updateListingRecord(u.recordId, {
          Agent_Prior_Outreach_Count: u.newCount,
        });
        writeOutcomes.push({
          recordId: u.recordId,
          previousCount: u.previousCount,
          newCount: u.newCount,
          written: true,
          error: null,
        });
        recordsUpdated++;
      } catch (err) {
        writeOutcomes.push({
          recordId: u.recordId,
          previousCount: u.previousCount,
          newCount: u.newCount,
          written: false,
          error: String(err),
        });
        writeErrors++;
      }
    }
  }

  // Skip diagnostics: distinguish phone-failed-to-normalize from
  // status-not-eligible for visibility.
  const skippedEmailInPhone = result.skipped.filter(
    (s) => s.reason === "phone_failed_to_normalize",
  ).length;
  const skippedNotEligibleStatus = result.skipped.filter(
    (s) => s.reason === "status_not_eligible",
  ).length;

  await audit({
    agent: "agent-prior-counts",
    event: "recompute_run",
    status: writeErrors > 0 ? "confirmed_failure" : "confirmed_success",
    inputSummary: {
      dryRun,
      limit,
      recordsScanned: allListings.length,
    },
    outputSummary: {
      normalizedPhones: result.distinctNormalizedPhones,
      phonesOnMultipleListings: result.phonesOnMultipleListings,
      eligibleRecords: result.updates.length,
      driftedRecords: changed.length,
      recordsUpdated: dryRun ? 0 : recordsUpdated,
      writeErrors: dryRun ? 0 : writeErrors,
      recordsSkipped_emailInPhone: skippedEmailInPhone,
      recordsSkipped_notEligibleStatus: skippedNotEligibleStatus,
    },
    decision: dryRun ? "dry_run" : "writes_applied",
    ms: Date.now() - t0,
  });

  return NextResponse.json({
    mode: dryRun ? "dry_run" : "apply",
    elapsed_ms: Date.now() - t0,
    recordsScanned: allListings.length,
    normalizedPhones: result.distinctNormalizedPhones,
    phonesOnMultipleListings: result.phonesOnMultipleListings,
    eligibleRecords: result.updates.length,
    driftedRecords: changed.length,
    recordsUpdated: dryRun ? "(dry-run — no writes)" : recordsUpdated,
    writeErrors: dryRun ? 0 : writeErrors,
    recordsSkipped_emailInPhone: skippedEmailInPhone,
    recordsSkipped_notEligibleStatus: skippedNotEligibleStatus,
    // Sample of drifted records (cap to keep payload sane).
    drift_sample: (dryRun ? changed : writeQueue)
      .slice(0, 50)
      .map((u: PriorCountUpdate) => ({
        recordId: u.recordId,
        agentPhoneRaw: u.agentPhoneRaw,
        agentPhoneNormalized: u.agentPhoneNormalized,
        previousCount: u.previousCount,
        newCount: u.newCount,
      })),
    write_outcomes_sample: dryRun ? null : writeOutcomes.slice(0, 50),
  });
}
