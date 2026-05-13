// Shared gate-runner per AKB_Deal_Flow_Orchestrator_Spec §3.3.
//
// runGate() is the canonical execution path: given a Gate definition and
// a recordId, it:
//
//   1. Identifies the unique data sources declared across all items.
//   2. Fetches every source in parallel (spec §10.2 performance target).
//   3. Builds a GateContext with the pre-fetched data.
//   4. Runs each item's check function against the context.
//   5. Composes a GateRunResult.
//   6. Emits ONE composite audit entry per gate run with three-state
//      status mapping per Alex's 5/13 design note:
//        pass    → confirmed_success
//        fail    → confirmed_failure
//        warning/data_missing on non-blocking → uncertain
//        data_missing on blocking → confirmed_failure (spec §6: treated as block)
//      The composite audit includes every CheckResult inline so the
//      morning brief can render "Gate X item Y blocked on missing data
//      Z for record W" without trawling individual entries.

import { getListing } from "@/lib/airtable";
import { audit, readRecentFromKv, type AuditEntry } from "@/lib/audit-log";
import type {
  CheckFn,
  CheckResult,
  DataSource,
  Gate,
  GateContext,
  GateRunResult,
  PipelineStage,
} from "./types";

interface RunGateOpts {
  gate: Gate;
  recordId: string;
  /** Per-item check functions, keyed by ChecklistItem.id (e.g., "PO-01") */
  checks: Record<string, CheckFn>;
  /** Per-gate config object passed to every check function */
  config: Record<string, unknown>;
}

export async function runGate(opts: RunGateOpts): Promise<GateRunResult> {
  const t0 = Date.now();
  const { gate, recordId, checks, config } = opts;

  // ── 1. Collect required data sources ───────────────────────────────
  const requiredSources = new Set<DataSource>();
  for (const item of gate.items) {
    for (const src of item.data_sources) requiredSources.add(src);
  }

  // ── 2. Parallel fetch ──────────────────────────────────────────────
  // Each source has its own fetcher. Add to this switch as new gates
  // declare new sources. Missing fetchers throw (the gate-runner is
  // misconfigured) — that's loud failure, not silent.
  const fetchPromises: Promise<unknown>[] = [];
  const fetchKeys: DataSource[] = [];
  for (const src of requiredSources) {
    fetchKeys.push(src);
    fetchPromises.push(fetchSource(src, recordId));
  }
  const fetchResults = await Promise.allSettled(fetchPromises);
  const fetched: Partial<Record<DataSource, unknown>> = {};
  const fetchErrors: Partial<Record<DataSource, string>> = {};
  fetchResults.forEach((res, i) => {
    const key = fetchKeys[i];
    if (res.status === "fulfilled") fetched[key] = res.value;
    else fetchErrors[key] = String(res.reason);
  });

  // ── 3. Build context ───────────────────────────────────────────────
  const listing = (fetched.airtable_listing as Awaited<ReturnType<typeof getListing>> | undefined) ?? null;
  const auditLog = (fetched.audit_log as AuditEntry[] | undefined) ?? null;
  const ctx: GateContext = {
    recordId,
    listing,
    auditLog,
  };

  // ── 4. Run checks ──────────────────────────────────────────────────
  const results: CheckResult[] = [];
  for (const item of gate.items) {
    const checkFn = checks[item.id];
    if (!checkFn) {
      results.push({
        item_id: item.id,
        status: "data_missing",
        reasoning: `No check function registered for item ${item.id}. Gate config + check map mismatch.`,
        data_examined: { error: "missing_check_fn" },
        failure_action: item.failure_action,
      });
      continue;
    }
    // If a required source failed to fetch, surface as data_missing
    // without invoking the check (it would null-deref).
    const missingSources = item.data_sources.filter((s) => fetchErrors[s] != null);
    if (missingSources.length > 0) {
      results.push({
        item_id: item.id,
        status: "data_missing",
        reasoning: `Required data source(s) failed to fetch: ${missingSources.join(", ")}`,
        data_examined: {
          missing_sources: missingSources,
          fetch_errors: Object.fromEntries(
            missingSources.map((s) => [s, fetchErrors[s] ?? "unknown"]),
          ),
        },
        failure_action: item.failure_action,
      });
      continue;
    }
    try {
      results.push(checkFn(ctx, config));
    } catch (err) {
      results.push({
        item_id: item.id,
        status: "data_missing",
        reasoning: `Check function threw: ${String(err)}`,
        data_examined: { error: String(err) },
        failure_action: item.failure_action,
      });
    }
  }

  // ── 5. Compose overall status ──────────────────────────────────────
  const blockers: string[] = [];
  const warnings: string[] = [];
  const dataMissing: string[] = [];
  for (const r of results) {
    if (r.status === "fail") blockers.push(r.item_id);
    else if (r.status === "warning") warnings.push(r.item_id);
    else if (r.status === "data_missing") dataMissing.push(r.item_id);
  }

  // data_missing on a blocking item is treated as fail per spec §6.
  const blockingDataMissing = results.filter(
    (r) => r.status === "data_missing" && gate.items.find((i) => i.id === r.item_id)?.blocking,
  );
  const hardBlocked = blockers.length > 0 || blockingDataMissing.length > 0;
  const overall_status: "pass" | "fail" | "incomplete" = !listing
    ? "incomplete"
    : hardBlocked
      ? "fail"
      : "pass";

  // ── 6. Audit ───────────────────────────────────────────────────────
  // pass    → confirmed_success
  // fail    → confirmed_failure
  // incomplete → uncertain (listing not found / can't even examine)
  const auditStatus =
    overall_status === "pass"
      ? "confirmed_success"
      : overall_status === "fail"
        ? "confirmed_failure"
        : "uncertain";

  const result: GateRunResult = {
    gate_id: gate.id,
    recordId,
    stage_from: gate.stage_from,
    stage_to: gate.stage_to,
    current_stage: (listing?.pipelineStage as PipelineStage | null | undefined) ?? null,
    overall_status,
    results,
    blockers,
    warnings,
    data_missing: dataMissing,
    property_address: listing?.address,
    computed_at: new Date().toISOString(),
    elapsed_ms: Date.now() - t0,
  };

  await audit({
    agent: "orchestrator",
    event: "gate_run",
    status: auditStatus,
    recordId,
    inputSummary: {
      gate_id: gate.id,
      stage_from: gate.stage_from,
      stage_to: gate.stage_to,
      current_stage: result.current_stage,
      address: listing?.address,
    },
    outputSummary: {
      overall_status,
      blockers,
      warnings,
      data_missing: dataMissing,
      // Embed the full check results so the morning brief has enough
      // context to render per-item failures without re-running anything.
      // Per Alex's design note 5/13: "log enough context that the
      // morning brief can surface 'Gate X item Y blocked on missing
      // data Z for record W'."
      results: results.map((r) => ({
        item_id: r.item_id,
        status: r.status,
        reasoning: r.reasoning,
        failure_action: r.failure_action,
      })),
    },
    decision: overall_status,
    ms: result.elapsed_ms,
  });

  return result;
}

// Source fetcher dispatcher. Each gate's required sources resolve here.
// Throws when a source has no registered fetcher (misconfig = loud).
async function fetchSource(src: DataSource, recordId: string): Promise<unknown> {
  switch (src) {
    case "airtable_listing":
      return await getListing(recordId);
    case "audit_log":
      // Pulls last 200 entries from KV (durable when configured, else
      // memory ring). Check functions filter by event/agent/window.
      return await readRecentFromKv(200);
    // Future sources for Gates 3-5:
    case "airtable_deal":
    case "quo_thread":
    case "gmail_thread":
    case "live_listing":
    case "cma":
    case "buyer_pipeline":
    case "pricing_agent_run":
    case "pa_document":
    case "title_prelim":
      throw new Error(
        `Source "${src}" has no registered fetcher yet — add to gate-runner.ts fetchSource() when implementing the gate that needs it.`,
      );
  }
}
