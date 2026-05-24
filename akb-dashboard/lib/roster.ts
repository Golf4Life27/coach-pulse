// AKB Inevitable — canonical named-agent roster.
// @agent: maverick
//
// Single source of truth for the 10-agent roster (Continuity Layer
// Spec v1.2 §6). Re-exports the constant defined in
// `lib/maverick/write-state.ts` (which uses it for write_state's
// `attribution_agent` enum) so non-Maverick code has a clean import
// path that doesn't reach into Maverick's write-state internals.
//
// Phase 9.3 (5/16 audit) discovered that audit-log attribution
// across the codebase used operational tags (`phase4c`, `d3-cadence`,
// `orchestrator`, `agent-prior-counts`, etc.) rather than the
// canonical roster. This file is the migration target: every audit
// call site that emits a sub-agent attribution should use one of
// these names so Maverick's briefing + dashboard agent-rooms (Daily
// UX Spec §4.2) can credit work coherently.
//
// Domain mapping per Alex's 5/16 directive:
//
//   sentinel  — intake (process-intake, verify-listing, multi-listing-detect)
//   crier     — SMS dispatch (outreach-fire, jarvis-send, d3-cadence, quo)
//   sentry    — gate enforcement + governance/integrity
//               (orchestrator/*, bulk-dead, d3-backfill, d3-math-filter,
//                d3-scrub, admin-schema, NEVER-list enforcement)
//   forge     — outreach drafting (template/voice library, future)
//   scribe    — contract handling (DocuSign MCP — when wired)
//   scout     — buyer pipeline (buyers/*, match-to-deal)
//   pulse     — system self-monitoring (agent-prior-counts, future
//               drift detection, future model-registry monitoring)
//   appraiser — valuation (phase4*, pricing-agent, arv-intelligence,
//                arv-validate, rehab-calibration, pricing-intelligence,
//                validation-*)
//   ledger    — economics (revenue, costs, truck fund, retirement
//                meter — future)
//   maverick  — overseer / orchestrator role itself (load-state,
//                MCP, OAuth, recall, write-state, synthesize)

import {
  MAVERICK_ROSTER_AGENTS as _MAVERICK_ROSTER_AGENTS,
  type RosterAgent as _RosterAgent,
} from "./maverick/write-state";

/** The canonical 10-agent roster, ordered with Maverick (overseer) first. */
export const ROSTER_AGENTS = _MAVERICK_ROSTER_AGENTS;

/** Type-narrow union of all roster names. */
export type RosterAgent = _RosterAgent;

/**
 * Tag-and-domain reference used by JSDoc-only tooling + future
 * agent-room rendering (Phase 9.4). Keys mirror ROSTER_AGENTS.
 */
export const ROSTER_DOMAINS: Record<RosterAgent, string> = {
  maverick: "overseer — narrative synthesis + MCP + OAuth + recall + write_state",
  sentinel: "intake — PropStream ingestion, listing verification, NEVER-list",
  appraiser: "valuation — ARV, rehab calibration, dual-track pricing, comps",
  forge: "outreach drafting — templates, voice library (future)",
  crier: "SMS dispatch — Quo, outreach-fire, cadence",
  sentry: "gate enforcement + governance — orchestrator gates, integrity admins",
  scribe: "contract handling — DocuSign API (future)",
  scout: "buyer pipeline — warmup, matching, dispo",
  pulse: "system self-monitoring — drift, quota burn, model registry",
  ledger: "economics — revenue, costs, retirement progress (future)",
};
