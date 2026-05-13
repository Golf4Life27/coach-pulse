// Orchestrator types per AKB_Deal_Flow_Orchestrator_Spec §3.2.
//
// The gate-runner consumes Gate definitions + a recordId, fetches all
// declared data sources in parallel, runs each ChecklistItem's check
// function against the assembled context, and returns a GateRunResult.
//
// CheckStatus has four semantic states (pass/fail/warning/data_missing)
// but maps to the system-wide three-state audit per Alex's design note
// (5/13):
//
//   pass         → confirmed_success
//   fail         → confirmed_failure
//   warning      → uncertain  (reasoning surfaces "warning")
//   data_missing → uncertain  (reasoning surfaces "data_missing" +
//                              dependency for morning-brief routing)

import type { Listing } from "@/lib/types";
import type { AuditEntry } from "@/lib/audit-log";

export type PipelineStage =
  | "intake"
  | "verified"
  | "priced"
  | "outreach_ready"
  | "outreach_sent"
  | "negotiating"
  | "offer_drafted"
  | "under_contract"
  | "dispo_active"
  | "assignment_signed"
  | "closed"
  | "dead";

export const ALL_PIPELINE_STAGES: PipelineStage[] = [
  "intake",
  "verified",
  "priced",
  "outreach_ready",
  "outreach_sent",
  "negotiating",
  "offer_drafted",
  "under_contract",
  "dispo_active",
  "assignment_signed",
  "closed",
  "dead",
];

export type DataSource =
  | "airtable_listing"
  | "airtable_deal"
  | "quo_thread"
  | "gmail_thread"
  | "live_listing"
  | "cma"
  | "buyer_pipeline"
  | "pricing_agent_run"
  | "audit_log"
  | "pa_document"
  | "title_prelim";

export type FailureAction = "block" | "warn" | "surface_to_alex";

export type CheckStatus = "pass" | "fail" | "warning" | "data_missing";

export interface ChecklistItem {
  id: string;
  description: string;
  data_sources: DataSource[];
  pass_criteria: string; // human-readable; code path lives in check function
  failure_action: FailureAction;
  blocking: boolean;
}

export interface Gate {
  id: string;
  stage_from: PipelineStage | null; // null = any stage allowed
  stage_to: PipelineStage;
  items: ChecklistItem[];
}

export interface CheckResult {
  item_id: string;
  status: CheckStatus;
  reasoning: string;
  // What the check actually examined. For data_missing items, includes
  // the missing data_source(s) so the morning brief can surface
  // "Gate X item Y blocked on missing data Z for record W."
  data_examined: Record<string, unknown>;
  // Failure action propagated from the item — useful for the dashboard
  // to know whether to block or just surface.
  failure_action: FailureAction;
}

export interface GateRunResult {
  gate_id: string;
  recordId: string;
  stage_from: PipelineStage | null;
  stage_to: PipelineStage;
  current_stage: PipelineStage | null; // listing's current Pipeline_Stage
  overall_status: "pass" | "fail" | "incomplete";
  // overall_status semantics:
  //   pass        — every blocking item passed; warnings + data_missing OK
  //                 if non-blocking (warnings always non-blocking;
  //                 data_missing blocks per spec §6)
  //   fail        — at least one blocking item failed or data_missing
  //                 on a blocking item
  //   incomplete  — listing not found / cannot fetch data
  results: CheckResult[];
  blockers: string[]; // item_ids that produced status=fail
  warnings: string[]; // item_ids that produced status=warning
  data_missing: string[]; // item_ids that produced status=data_missing
  // Shared context echo for the morning brief
  property_address?: string;
  computed_at: string;
  elapsed_ms: number;
}

// Pre-fetched data context — populated by gate-runner before running
// any check. Each check function reads from this; no check makes its
// own external calls. Spec §5 Data Source Mandate.
export interface GateContext {
  recordId: string;
  listing: Listing | null;
  auditLog?: AuditEntry[] | null;
  // Future gates will add: deal, quoThread, gmailThread, liveListing,
  // cma, buyerPipeline, pricingAgentRun, paDocument, titlePrelim.
}

export type CheckFn = (ctx: GateContext, config: Record<string, unknown>) => CheckResult;
