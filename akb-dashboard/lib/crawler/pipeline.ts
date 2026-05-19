// Phase 13.3 + 13.5 + 13.6 / Q.7 — Crawler intake pipeline.
//
// Composes the source adapters + quality gates + dedupe into a
// single intake flow. The /api/agents/sentinel/crawler/scan endpoint
// calls runCrawlerScan(); the function returns a structured result
// the operator can audit before any candidate is written to
// Listings_V1.
//
// **Pipeline charter:** Pulse-style read-only by default. The
// pipeline classifies and AUDITS — it does NOT write listings.
// Operator decides whether to promote candidates to live records
// via a separate apply step (gated like the appraiser backfill).

import { runIntakeGates, type IntakeGateAction } from "@/lib/intake/quality-gates";
import type {
  CrawlerCandidate,
  CrawlerScanResult,
  CrawlerSource,
  CrawlerSourceId,
} from "./types";
import { propstreamSource } from "./sources/propstream";
import {
  codeViolationsSource,
  probateSource,
  taxDelinquencySource,
} from "./sources/off-market";

export const SOURCES: Record<CrawlerSourceId, CrawlerSource> = {
  propstream: propstreamSource,
  probate: probateSource,
  tax_delinquency: taxDelinquencySource,
  code_violations: codeViolationsSource,
};

export interface ClassifiedCandidate {
  candidate: CrawlerCandidate;
  gate_action: IntakeGateAction;
  gate_reasons: string[];
}

/** Pure: run a candidate through the intake gates and return the
 *  combined classification. */
export function classifyCandidate(candidate: CrawlerCandidate): ClassifiedCandidate {
  const gates = runIntakeGates({
    body: candidate.body,
    agent_phone: candidate.agent_phone,
  });
  const reasons: string[] = [];
  if (gates.off_market.action !== "pass") reasons.push(gates.off_market.reason);
  if (gates.flip_score.action !== "pass") reasons.push(gates.flip_score.reason);
  if (gates.phone.action !== "pass") reasons.push(gates.phone.reason);
  return {
    candidate,
    gate_action: gates.action,
    gate_reasons: reasons,
  };
}

export interface CrawlerPipelineResult {
  source_scans: CrawlerScanResult[];
  total_candidates: number;
  classified: ClassifiedCandidate[];
  /** Counts by gate action for the operator at-a-glance. */
  action_counts: Record<IntakeGateAction, number>;
}

export interface RunCrawlerScanArgs {
  /** Subset of sources to run. Empty / undefined → run all credentialed. */
  sources?: CrawlerSourceId[];
  /** Per-source filter passed verbatim to adapter scan(). */
  filter?: Record<string, unknown>;
  /** Per-source cap on candidates. */
  limit?: number;
}

/** Compose: fan out to source adapters, classify candidates, return
 *  audit-ready result. NO writes — operator promotes via a separate
 *  apply step (out of scope for the framework commit). */
export async function runCrawlerScan(
  args: RunCrawlerScanArgs = {},
): Promise<CrawlerPipelineResult> {
  const targetSources =
    args.sources && args.sources.length > 0
      ? args.sources.map((id) => SOURCES[id]).filter(Boolean)
      : Object.values(SOURCES);

  const source_scans: CrawlerScanResult[] = [];
  for (const source of targetSources) {
    const result = await source.scan({ filter: args.filter, limit: args.limit });
    source_scans.push(result);
  }

  const all = source_scans.flatMap((r) => r.candidates);
  const classified = all.map(classifyCandidate);
  const action_counts: Record<IntakeGateAction, number> = {
    pass: 0,
    manual_review: 0,
    reject: 0,
  };
  for (const c of classified) action_counts[c.gate_action] += 1;

  return {
    source_scans,
    total_candidates: all.length,
    classified,
    action_counts,
  };
}
