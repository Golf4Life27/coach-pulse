// D3 Phase 0a — Pre-flight scrub endpoint.
//
// GET /api/admin/d3-scrub?dry_run=1[&limit=N&apply=0]
//
// Scans Listings_V1 for Outreach_Status="Texted" records, classifies
// each into one of seven buckets via lib/d3-scrub.classifyTexted(),
// surfaces bucket counts + pending_writes.
//
// Dry-run by default. Apply mode (apply=1) writes Do_Not_Text=true and
// Pipeline_Stage=dead per the classification. Writes go through
// updateListingRecord → patchAndVerify so the drift detector + audit
// log cover every change.
//
// Per Alex 5/13 D3 directive §3: this is the prerequisite to follow-up
// cadence. No follow-up can fire until scrub has classified the Texted
// universe. Report back before deciding whether ambiguous records get
// live re-verification (Phase 0b — expensive) or just status_check
// routing (Phase 1 cadence).

import { NextResponse } from "next/server";
import {
  getListings,
  updateListingRecord,
  createManualFixQueueRecord,
} from "@/lib/airtable";
import { audit } from "@/lib/audit-log";
import { classifyTexted, summarize, type ScrubResult } from "@/lib/d3-scrub";

export const runtime = "nodejs";
export const maxDuration = 90;

export async function GET(req: Request) {
  const t0 = Date.now();
  const url = new URL(req.url);
  // Default to dry-run. Apply requires explicit ?apply=1.
  const apply = url.searchParams.get("apply") === "1";
  const limitParam = url.searchParams.get("limit");
  const limit = limitParam ? Math.max(1, parseInt(limitParam, 10) || 0) : null;

  // Pull all listings, filter to Texted in-memory. getListings caches +
  // pulls full table; for one-shot scrub the cache miss is acceptable.
  const allListings = await getListings();
  const texted = allListings.filter(
    (l) => (l.outreachStatus ?? "").toLowerCase() === "texted",
  );
  const subset = limit != null ? texted.slice(0, limit) : texted;

  const results: ScrubResult[] = subset.map((l) => classifyTexted(l));
  const summary = summarize(results);

  // Build a quick lookup of the source listing for invalid_phone records
  // so we can populate denormalized fields on the manual-fix-queue rows.
  const listingById = new Map(subset.map((l) => [l.id, l]));

  // Apply writes (only when apply=1 explicitly).
  const writeOutcomes: Array<{
    recordId: string;
    fields_written: string[];
    drift_count: number;
    error: string | null;
  }> = [];
  const manualFixQueueOutcomes: Array<{
    recordId: string;
    queue_record_id: string | null;
    error: string | null;
  }> = [];
  if (apply) {
    const today = new Date().toISOString().slice(0, 10);
    for (const r of results) {
      // Invalid-phone records get routed to D3_Manual_Fix_Queue instead
      // of (or in addition to) Listings_V1 writes. Per Alex 5/13 Option B:
      // reusable infrastructure, not a one-shot chat surface.
      if (r.bucket === "skip_invalid_phone") {
        const src = listingById.get(r.recordId);
        if (!src) {
          manualFixQueueOutcomes.push({
            recordId: r.recordId,
            queue_record_id: null,
            error: "source listing not found in subset map",
          });
          continue;
        }
        try {
          const out = await createManualFixQueueRecord({
            Address: src.address || "(missing address)",
            Source_Listing: [r.recordId],
            Agent_First_Name: src.agentName,
            Agent_Phone_Raw: src.agentPhone,
            Issue_Category: "invalid_phone_format",
            Detected_Date: today,
            Detected_By: "D3 Phase 0a",
            Resolution_Status: "pending",
            Notes: r.reasoning,
          });
          manualFixQueueOutcomes.push({
            recordId: r.recordId,
            queue_record_id: out.recordId,
            error: null,
          });
        } catch (err) {
          manualFixQueueOutcomes.push({
            recordId: r.recordId,
            queue_record_id: null,
            error: String(err),
          });
        }
        continue;
      }
      if (!r.pending_writes || Object.keys(r.pending_writes).length === 0) continue;
      try {
        const drift = await updateListingRecord(r.recordId, r.pending_writes);
        writeOutcomes.push({
          recordId: r.recordId,
          fields_written: Object.keys(r.pending_writes),
          drift_count: drift.length,
          error: null,
        });
      } catch (err) {
        writeOutcomes.push({
          recordId: r.recordId,
          fields_written: [],
          drift_count: 0,
          error: String(err),
        });
      }
    }
  }

  // Composite audit per scrub run — surfaces bucket counts + apply mode.
  // Individual records that get writes also get audited via the
  // patchAndVerify chain (airtable-write events).
  const hasWriteErrors =
    apply &&
    (writeOutcomes.some((w) => w.error != null) ||
      manualFixQueueOutcomes.some((m) => m.error != null));
  const auditStatus = hasWriteErrors
    ? "confirmed_failure"
    : summary.never_list_warning
      ? "uncertain"
      : "confirmed_success";
  await audit({
    agent: "d3-scrub",
    event: "scrub_run",
    status: auditStatus,
    inputSummary: {
      apply,
      limit,
      total_texted: texted.length,
      examined: subset.length,
    },
    outputSummary: {
      summary,
      writes_applied: apply ? writeOutcomes.length : 0,
      write_errors: apply ? writeOutcomes.filter((w) => w.error != null).length : 0,
      manual_fix_queue_rows_created: apply
        ? manualFixQueueOutcomes.filter((m) => m.error == null).length
        : 0,
      manual_fix_queue_errors: apply
        ? manualFixQueueOutcomes.filter((m) => m.error != null).length
        : 0,
      never_list_warning: summary.never_list_warning,
    },
    decision: apply ? "writes_applied" : "dry_run",
    ms: Date.now() - t0,
  });

  return NextResponse.json({
    mode: apply ? "apply" : "dry_run",
    elapsed_ms: Date.now() - t0,
    texted_total_in_airtable: texted.length,
    examined: subset.length,
    summary,
    write_outcomes: apply ? writeOutcomes : "skipped (dry_run)",
    manual_fix_queue_outcomes: apply ? manualFixQueueOutcomes : "skipped (dry_run)",
    // Per-record results capped at 200 in response to keep payload sane.
    // Full dataset lives in audit log; this is for at-a-glance inspection.
    results_sample: results.slice(0, 200).map((r) => ({
      recordId: r.recordId,
      bucket: r.bucket,
      reasoning: r.reasoning,
      pending_writes: r.pending_writes,
    })),
  });
}
