// Maverick severity tier inference + visual treatment.
// @agent: maverick (Phase 9.5)
//
// Daily UX Spec §5 defines four tiers Maverick uses to surface
// things to Alex. This module classifies signals from the
// load-state response into tiers + provides the Tailwind class
// helpers so every surface (Shepherd panel, priority cards, agent
// rooms) reads tier-colored treatment from one source.
//
// Tier 0 — routine handled silently (no visual interrupt)
// Tier 1 — standard BroCard (neutral; needs eyes, not urgent)
// Tier 2 — priority signal (orange; act today, not within the hour)
// Tier 3 — critical (red; act now, blocking modal + SMS push in 9.7)
//
// Tier classification is intentionally CLIENT-SIDE for Commit B —
// the load-state response carries structured signals that the UI
// interprets. Once Pulse (Phase 14) ships, server-side confidence
// scoring may overlay this. Until then, deterministic inference
// keeps the surface predictable for Alex.

export type SeverityTier = 0 | 1 | 2 | 3;

export interface TierVisual {
  /** Border accent class (e.g. "border-emerald-700"). */
  border: string;
  /** Text accent class (e.g. "text-emerald-400"). */
  text: string;
  /** Background tint class (subtle, semi-transparent). */
  bg: string;
  /** Pulse-dot color used in collapsed Shepherd-panel status pill. */
  dot: string;
  /** Human-readable label rendered in the status pill. */
  label: string;
}

export const TIER_VISUAL: Record<SeverityTier, TierVisual> = {
  0: {
    border: "border-[#30363d]",
    text: "text-gray-400",
    bg: "bg-transparent",
    dot: "bg-gray-500",
    label: "Watching",
  },
  1: {
    border: "border-emerald-800",
    text: "text-emerald-400",
    bg: "bg-emerald-950/30",
    dot: "bg-emerald-500",
    label: "Needs eyes",
  },
  2: {
    border: "border-orange-700",
    text: "text-orange-400",
    bg: "bg-orange-950/30",
    dot: "bg-orange-500 animate-pulse",
    label: "Priority",
  },
  3: {
    border: "border-red-700",
    text: "text-red-400",
    bg: "bg-red-950/30",
    dot: "bg-red-500 animate-pulse",
    label: "Critical",
  },
};

export interface PrioritySignal {
  /** Stable key for React lists. */
  id: string;
  tier: SeverityTier;
  /** Single-line headline rendered as card title. */
  title: string;
  /** Optional reasoning rendered as card body. */
  reason: string | null;
  /** Optional roster-agent attribution for agent-room routing. */
  agent: string | null;
  /** Optional href for the card's primary action. */
  href: string | null;
}

interface MinimalBriefingShape {
  source_health: Record<
    string,
    { ok: boolean; error: string | null; staleness_seconds: number }
  >;
  structured: {
    staleness_warnings: string[];
    active_deals: Array<{ id?: string; address?: string | null }>;
    open_decisions: unknown[];
    recent_key_decisions: unknown[];
    audit_summary: {
      recent_failures: Array<{
        agent: string;
        event: string;
        error: string | null;
        recordId: string | null;
        ts: string;
      }>;
      mcp_call_latency: {
        samples: number;
        p95_ms: number | null;
        over_target_count: number;
        p95_target_ms: number;
      };
    };
    external_signals: {
      quo: { api_responsive: boolean; api_key_configured: boolean };
      rentcast: {
        api_responsive: boolean;
        burn_rate: { days_until_exhaustion_estimate: number | null };
      };
    };
  };
}

/**
 * Derive ordered priority signals from a briefing. Highest-tier
 * items first; ties broken by source_health weight then alphabetic
 * stability. Pure — testable without UI.
 */
export function inferPrioritySignals(b: MinimalBriefingShape): PrioritySignal[] {
  const signals: PrioritySignal[] = [];

  // ── Infrastructure tier ──────────────────────────────────────────
  // Source-down signals. >5 sources down → tier 3 (cascading floor).
  // 1-5 → tier 2.
  const sourcesDown = Object.values(b.source_health).filter((s) => !s.ok);
  if (sourcesDown.length > 5) {
    signals.push({
      id: "sources_down_critical",
      tier: 3,
      title: `${sourcesDown.length} sources down — briefing fidelity degraded`,
      reason: sourcesDown
        .map((s) => `${s.error ?? "unreachable"}`)
        .slice(0, 3)
        .join("; "),
      agent: "maverick",
      href: null,
    });
  } else if (sourcesDown.length > 0) {
    signals.push({
      id: "sources_down",
      tier: 2,
      title: `${sourcesDown.length} source${sourcesDown.length === 1 ? "" : "s"} degraded`,
      reason: b.structured.staleness_warnings.slice(0, 3).join("; ") || null,
      agent: "maverick",
      href: null,
    });
  }

  // Quo health — Crier signal.
  const quo = b.structured.external_signals.quo;
  if (quo.api_key_configured && !quo.api_responsive) {
    signals.push({
      id: "quo_down",
      tier: 2,
      title: "Crier is dark — Quo unresponsive",
      reason: "Outbound cadence stalled. Check Quo API status.",
      agent: "crier",
      href: null,
    });
  }

  // RentCast burn-rate — Appraiser/Pulse signal.
  const rent = b.structured.external_signals.rentcast;
  const days = rent.burn_rate.days_until_exhaustion_estimate;
  if (days != null && days <= 3) {
    signals.push({
      id: "rentcast_exhaustion_imminent",
      tier: 3,
      title: `RentCast quota exhausts in ~${days}d at current burn`,
      reason: "Appraiser will lose comp/rent data soon. Throttle or upgrade.",
      agent: "appraiser",
      href: null,
    });
  } else if (days != null && days <= 7) {
    signals.push({
      id: "rentcast_exhaustion_soon",
      tier: 2,
      title: `RentCast burn rate: ~${days}d to exhaustion`,
      reason: "Watch quota; consider throttling pricing-agent runs.",
      agent: "appraiser",
      href: null,
    });
  }

  // MCP P95 over target — Maverick self-instrumentation.
  const lat = b.structured.audit_summary.mcp_call_latency;
  if (lat.over_target_count > 0 && lat.p95_ms != null) {
    signals.push({
      id: "mcp_latency_over_target",
      tier: 2,
      title: `Maverick P95 over target (${(lat.p95_ms / 1000).toFixed(1)}s)`,
      reason: `${lat.over_target_count} call${lat.over_target_count === 1 ? "" : "s"} above ${(lat.p95_target_ms / 1000).toFixed(0)}s ceiling`,
      agent: "maverick",
      href: null,
    });
  }

  // ── Agent failures — recent_failures audit entries.
  const failures = b.structured.audit_summary.recent_failures.slice(0, 5);
  for (const f of failures) {
    signals.push({
      id: `failure_${f.ts}_${f.agent}`,
      tier: 2,
      title: `${f.agent}/${f.event} failed`,
      reason: f.error?.slice(0, 120) ?? null,
      agent: f.agent,
      href: f.recordId ? `/pipeline/${f.recordId}` : null,
    });
  }

  // ── Open decisions — tier 1 (needs eyes, not urgent).
  if (b.structured.open_decisions.length > 0) {
    signals.push({
      id: "open_decisions",
      tier: 1,
      title: `${b.structured.open_decisions.length} open decision${b.structured.open_decisions.length === 1 ? "" : "s"} in queue`,
      reason: "Pending agents in D3 manual fix queue.",
      agent: "sentry",
      href: "/queue",
    });
  }

  // ── Active deals — tier 1 (visible, not urgent).
  if (b.structured.active_deals.length > 0) {
    signals.push({
      id: "active_deals",
      tier: 1,
      title: `${b.structured.active_deals.length} active deal${b.structured.active_deals.length === 1 ? "" : "s"} in flight`,
      reason: b.structured.active_deals
        .slice(0, 3)
        .map((d) => d.address ?? d.id ?? "—")
        .filter(Boolean)
        .join(", "),
      agent: "appraiser",
      href: "/pipeline",
    });
  }

  // Sort by tier descending so highest urgency renders first.
  signals.sort((a, b2) => b2.tier - a.tier);
  return signals;
}

/**
 * Resolve the top tier across signals — drives the Shepherd panel
 * status pill color. Returns 0 when no signals are present.
 */
export function maxTier(signals: PrioritySignal[]): SeverityTier {
  let max: SeverityTier = 0;
  for (const s of signals) {
    if (s.tier > max) max = s.tier;
  }
  return max;
}
