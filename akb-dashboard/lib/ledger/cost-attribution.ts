// Phase 15.2 / Q.4 — Per-agent LLM cost attribution.
//
// Reads synthesizer audit events and attributes estimated USD spend
// per agent. Cost table mirrors Pulse's token-burn detector (kept in
// sync intentionally — Pulse alerts on total burn; Ledger surfaces
// who spent it).

import type { AuditEntry } from "@/lib/audit-log";

// Per-event cost estimate in USD. Conservative upper bound. Keep
// in sync with lib/pulse/detectors/token-burn.ANTHROPIC_EVENT_COSTS_USD.
export const SYNTHESIZER_EVENT_COSTS: Record<string, number> = {
  jarvis_brief_synthesized: 0.08,
  maverick_chat_synthesized: 0.05,
  rehab_calibrated: 0.05,
  sentinel_classified: 0.02,
  sentinel_drafted: 0.04,
  crier_reply_drafted: 0.03,
  scout_warmup_drafted: 0.04,
  scout_outreach_drafted: 0.04,
  agent_context_synthesized: 0.005,
};

export interface AgentCostRow {
  agent: string;
  /** Call count over the window. */
  calls: number;
  /** Estimated USD spend (call counts × per-event cost table). */
  estimate_usd: number;
  /** Breakdown by event-label for operator audit. */
  by_event: Record<string, number>;
}

export interface CostAttribution {
  window_hours: number;
  total_calls: number;
  total_usd: number;
  per_agent: AgentCostRow[];
}

/** Pure: attribute synthesizer audit events to agents + estimate
 *  USD spend over the rolling window. */
export function attributeCost(
  audit: AuditEntry[],
  windowHours: number,
  now: Date,
): CostAttribution {
  const cutoff = now.getTime() - windowHours * 3_600_000;
  const byAgent: Record<string, AgentCostRow> = {};
  let totalCalls = 0;
  let totalUsd = 0;
  for (const e of audit) {
    if (e.status === "uncertain") continue;
    const cost = SYNTHESIZER_EVENT_COSTS[e.event];
    if (cost == null) continue;
    const t = new Date(e.ts).getTime();
    if (!Number.isFinite(t) || t < cutoff) continue;

    const row = byAgent[e.agent] ?? (byAgent[e.agent] = {
      agent: e.agent,
      calls: 0,
      estimate_usd: 0,
      by_event: {},
    });
    row.calls += 1;
    row.estimate_usd = Math.round((row.estimate_usd + cost) * 100) / 100;
    row.by_event[e.event] = (row.by_event[e.event] ?? 0) + 1;
    totalCalls += 1;
    totalUsd += cost;
  }
  // Sort agents by spend desc — biggest burner first.
  const per_agent = Object.values(byAgent).sort((a, b) => b.estimate_usd - a.estimate_usd);
  return {
    window_hours: windowHours,
    total_calls: totalCalls,
    total_usd: Math.round(totalUsd * 100) / 100,
    per_agent,
  };
}
