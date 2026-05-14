// D3 — One-shot backfill for Agent_Prior_Outreach_Count using
// normalized phones.
//
// GET /api/admin/d3-backfill-agent-prior-outreach-count?apply=1[&limit=N]
//
// Why: 5/14 inspection found Listings_V1 stores phones in inconsistent
// formats ("(713) 231-1129" vs "713-231-1129") and the upstream Make
// scenario that populates Agent_Prior_Outreach_Count does NOT
// normalize before grouping. Result: the field undercounts cross-
// listing matches and Layer 1 of the D3 depth-gate inherits that
// false-negative rate.
//
// What this does: rebuilds the count via E.164 normalization
// (lib/phone-normalize.ts) and writes corrected values back to
// Listings_V1.Agent_Prior_Outreach_Count for every Texted or
// Negotiating record that has a non-null Agent_Phone. Records that
// already match the computed value are SKIPPED to avoid noise writes.
//
// Audit-flagged data_source: "backfill_normalized_phone_count" so the
// proxy-source is distinguishable from future Make scenario writes.
//
// Note: the upstream Make scenario will overwrite these values next
// time it runs unless someone updates it to normalize first. This
// endpoint is "ship Layer 1 today against accurate data"; the long-
// term fix is updating the Make scenario.

import { NextResponse } from "next/server";
import { getListings, updateListingRecord } from "@/lib/airtable";
import { audit } from "@/lib/audit-log";
import { normalizePhone } from "@/lib/phone-normalize";

export const runtime = "nodejs";
export const maxDuration = 90;

export async function GET(req: Request) {
  const t0 = Date.now();
  const url = new URL(req.url);
  const apply = url.searchParams.get("apply") === "1";
  const limitParam = url.searchParams.get("limit");
  const limit = limitParam ? Math.max(1, parseInt(limitParam, 10) || 0) : null;

  const allListings = await getListings();

  // Build normalized-phone → count map across Texted + Negotiating.
  const phoneCount = new Map<string, number>();
  for (const l of allListings) {
    const status = (l.outreachStatus ?? "").toLowerCase();
    if (status !== "texted" && status !== "negotiating") continue;
    const normalized = normalizePhone(l.agentPhone);
    if (!normalized) continue;
    phoneCount.set(normalized, (phoneCount.get(normalized) ?? 0) + 1);
  }

  // Determine the target Agent_Prior_Outreach_Count for each record.
  // Definition (matching the existing field's spec): "count of OTHER
  // records with same Agent_Phone in Texted/Negotiating." So
  // expected = totalForPhone - (1 if this record itself counts) - 0
  // (others don't count themselves).
  const candidates = allListings.filter((l) => {
    const status = (l.outreachStatus ?? "").toLowerCase();
    return status === "texted" || status === "negotiating";
  });
  const subset = limit != null ? candidates.slice(0, limit) : candidates;

  interface Outcome {
    recordId: string;
    agent_phone_raw: string | null;
    agent_phone_normalized: string | null;
    previous_count: number | null;
    new_count: number | null;
    written: boolean;
    skipped_reason: string | null;
    error: string | null;
  }

  const outcomes: Outcome[] = [];
  let written = 0;
  let skipped_unchanged = 0;
  let skipped_no_normalize = 0;
  let write_errors = 0;

  for (const l of subset) {
    const normalized = normalizePhone(l.agentPhone);
    if (!normalized) {
      outcomes.push({
        recordId: l.id,
        agent_phone_raw: l.agentPhone,
        agent_phone_normalized: null,
        previous_count: l.agentPriorOutreachCount ?? null,
        new_count: null,
        written: false,
        skipped_reason: "phone failed to normalize",
        error: null,
      });
      skipped_no_normalize++;
      continue;
    }
    const total = phoneCount.get(normalized) ?? 0;
    // Self contributes 1 to total (this record itself is Texted/Negotiating),
    // so "OTHER records" = total - 1.
    const newCount = Math.max(0, total - 1);
    const prev = l.agentPriorOutreachCount ?? 0;
    if (prev === newCount) {
      outcomes.push({
        recordId: l.id,
        agent_phone_raw: l.agentPhone,
        agent_phone_normalized: normalized,
        previous_count: prev,
        new_count: newCount,
        written: false,
        skipped_reason: "unchanged",
        error: null,
      });
      skipped_unchanged++;
      continue;
    }

    if (!apply) {
      outcomes.push({
        recordId: l.id,
        agent_phone_raw: l.agentPhone,
        agent_phone_normalized: normalized,
        previous_count: prev,
        new_count: newCount,
        written: false,
        skipped_reason: null,
        error: null,
      });
      continue;
    }

    try {
      await updateListingRecord(l.id, {
        Agent_Prior_Outreach_Count: newCount,
      });
      await audit({
        agent: "d3-backfill-prior-count",
        event: "agent_prior_outreach_count_backfilled",
        status: "confirmed_success",
        recordId: l.id,
        inputSummary: {
          agent_phone_raw: l.agentPhone,
          agent_phone_normalized: normalized,
          previous_count: prev,
        },
        outputSummary: {
          data_source: "backfill_normalized_phone_count",
          new_count: newCount,
        },
        decision: "rewrote",
      });
      outcomes.push({
        recordId: l.id,
        agent_phone_raw: l.agentPhone,
        agent_phone_normalized: normalized,
        previous_count: prev,
        new_count: newCount,
        written: true,
        skipped_reason: null,
        error: null,
      });
      written++;
    } catch (err) {
      outcomes.push({
        recordId: l.id,
        agent_phone_raw: l.agentPhone,
        agent_phone_normalized: normalized,
        previous_count: prev,
        new_count: newCount,
        written: false,
        skipped_reason: null,
        error: String(err),
      });
      write_errors++;
    }
  }

  await audit({
    agent: "d3-backfill-prior-count",
    event: "backfill_run",
    status: apply && write_errors > 0 ? "confirmed_failure" : "confirmed_success",
    inputSummary: {
      apply,
      limit,
      total_candidates: candidates.length,
      examined: subset.length,
    },
    outputSummary: {
      written: apply ? written : 0,
      would_write_in_dry_run: apply
        ? null
        : outcomes.filter((o) => o.new_count !== null && o.skipped_reason == null).length,
      skipped_unchanged,
      skipped_no_normalize,
      write_errors,
      distinct_normalized_phones: phoneCount.size,
      phones_appearing_on_multiple_listings: [...phoneCount.values()].filter((c) => c > 1).length,
    },
    decision: apply ? "writes_applied" : "dry_run",
    ms: Date.now() - t0,
  });

  return NextResponse.json({
    mode: apply ? "apply" : "dry_run",
    elapsed_ms: Date.now() - t0,
    total_candidates: candidates.length,
    examined: subset.length,
    distinct_normalized_phones: phoneCount.size,
    phones_appearing_on_multiple_listings: [...phoneCount.values()].filter((c) => c > 1).length,
    summary: {
      written: apply ? written : `(would write) ${outcomes.filter((o) => o.new_count !== null && o.skipped_reason == null).length}`,
      skipped_unchanged,
      skipped_no_normalize,
      write_errors: apply ? write_errors : 0,
    },
    outcomes_sample: outcomes
      .filter((o) => o.skipped_reason !== "unchanged")
      .slice(0, 50),
  });
}
