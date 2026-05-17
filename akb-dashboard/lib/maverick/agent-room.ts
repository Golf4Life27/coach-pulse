// Maverick — factory-floor agent room data shaping.
// @agent: maverick (Phase 9.4b)
//
// Pure helpers that project the briefing into per-agent slices for the
// Daily UX Spec §4.1 factory-floor rooms. Each room consumes
// `summarizeAgentActivity(briefing, agent)` to render header status +
// recent activity without re-implementing the same filter/cap logic.
//
// Tier inference for the room border:
//   tier 3 — any recent_failures for this agent in the window
//   tier 2 — agent had uncertain events but no failures
//   tier 1 — agent active (had any events) with all-success
//   tier 0 — no activity in window (room renders "standing by")
//
// Spec §4.2: "Each room is sized proportional to its current activity.
// Quiet agents show small footprints." Tier 0 vs 1+ drives that.

import type { SeverityTier } from "./severity";
import type { StructuredBriefing } from "./briefing";
import type { RecentAuditEvent } from "./sources/vercel-kv-audit";

export interface AgentActivity {
  agent: string;
  /** Severity tier driving room border + status pill color. */
  tier: SeverityTier;
  /** Total events this agent emitted in the briefing window. */
  total_events: number;
  /** Slim recent-event list for this agent only, newest first. */
  recent_events: RecentAuditEvent[];
  /** Newest event ts for this agent or null when idle. */
  newest_ts: string | null;
  /** Count of confirmed_failure entries for this agent in the window. */
  failure_count: number;
  /** Count of uncertain entries for this agent in the window. */
  uncertain_count: number;
  /** Whether this agent has activity in the briefing window. */
  active: boolean;
}

const DEFAULT_RECENT_LIMIT = 5;

/**
 * Project the briefing into one agent's activity slice. Pure.
 *
 * Returns a deterministic shape even when the agent has no events —
 * makes downstream room rendering branch-free on absence.
 */
export function summarizeAgentActivity(
  briefing: Pick<StructuredBriefing, "audit_summary">,
  agent: string,
  opts: { recentLimit?: number } = {},
): AgentActivity {
  const limit = opts.recentLimit ?? DEFAULT_RECENT_LIMIT;
  const events = briefing.audit_summary.recent_events.filter(
    (e) => e.agent === agent,
  );
  const total = briefing.audit_summary.by_agent[agent] ?? 0;
  const failures = events.filter((e) => e.status === "confirmed_failure").length;
  const uncertain = events.filter((e) => e.status === "uncertain").length;

  let tier: SeverityTier = 0;
  if (failures > 0) tier = 2;
  else if (uncertain > 0) tier = 1;
  else if (events.length > 0) tier = 1;

  return {
    agent,
    tier,
    total_events: total,
    recent_events: events.slice(0, limit),
    newest_ts: events.length > 0 ? events[0].ts : null,
    failure_count: failures,
    uncertain_count: uncertain,
    active: total > 0 || events.length > 0,
  };
}

/**
 * Pre-fetch idle state — used by factory-floor rooms to render a
 * structurally identical card before the first briefing lands. Avoids
 * a separate "loading" branch in every room component.
 */
export function idleActivity(agent: string): AgentActivity {
  return {
    agent,
    tier: 0,
    total_events: 0,
    recent_events: [],
    newest_ts: null,
    failure_count: 0,
    uncertain_count: 0,
    active: false,
  };
}

/**
 * Format an event timestamp into "Nm ago" / "Nh ago" / "Nd ago".
 * Pure; takes "now" as a parameter for testability.
 */
export function formatRelativeTs(ts: string, now: Date = new Date()): string {
  const t = new Date(ts).getTime();
  if (isNaN(t)) return ts;
  const deltaMs = now.getTime() - t;
  if (deltaMs < 0) return "just now";
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
