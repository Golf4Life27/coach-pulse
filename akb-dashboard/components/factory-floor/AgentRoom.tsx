"use client";

/**
 * Factory-floor agent room shell (Phase 9.4b).
 *
 * Generic card primitive for each named-agent station per Daily UX
 * Spec §4.1. Each room is sized proportional to its current activity
 * — quiet agents show small footprints; active agents fill more space
 * via per-room body content.
 *
 * Tier coloring (border + status pill) flows from the agent's recent
 * activity via `summarizeAgentActivity` (lib/maverick/agent-room.ts).
 * Visual treatment reuses TIER_VISUAL from severity.ts so the
 * Shepherd panel + priority surface + agent rooms all read the same
 * source of truth for tier color.
 */

import Link from "next/link";
import { TIER_VISUAL, type SeverityTier } from "@/lib/maverick/severity";
import { formatRelativeTs, type AgentActivity } from "@/lib/maverick/agent-room";

export interface AgentRoomProps {
  /** Roster name (lowercase) — used for aria-label + analytics. */
  agent: string;
  /** Display name (capitalized) shown in the header. */
  displayName: string;
  /** Short role descriptor under the name (e.g., "SMS dispatch"). */
  role: string;
  /** Activity slice from `summarizeAgentActivity` — drives tier + footer. */
  activity: AgentActivity;
  /** Optional severity override — when room-specific signals (e.g. Quo down) need to elevate beyond the activity-inferred tier. */
  tierOverride?: SeverityTier;
  /** Optional click-through to the agent's detail surface. */
  href?: string | null;
  /** Per-agent body content. */
  children?: React.ReactNode;
}

export default function AgentRoom({
  agent,
  displayName,
  role,
  activity,
  tierOverride,
  href,
  children,
}: AgentRoomProps) {
  const tier: SeverityTier =
    tierOverride !== undefined
      ? (Math.max(tierOverride, activity.tier) as SeverityTier)
      : activity.tier;
  const visual = TIER_VISUAL[tier];

  const header = (
    <div className={`flex items-center justify-between px-3 py-2 border-b ${visual.border}`}>
      <div className="min-w-0">
        <h3 className={`text-sm font-bold ${visual.text} truncate`}>{displayName}</h3>
        <p className="text-[10px] uppercase tracking-wide text-gray-500 truncate">{role}</p>
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        <span
          className={`w-2 h-2 rounded-full ${visual.dot}`}
          aria-label={`Status: ${visual.label}`}
        />
      </div>
    </div>
  );

  const footer = (
    <div className="border-t border-[#30363d] px-3 py-1.5 text-[10px] text-gray-500 flex items-center justify-between">
      <span>
        {activity.active
          ? `${activity.total_events} event${activity.total_events === 1 ? "" : "s"} · last ${activity.newest_ts ? formatRelativeTs(activity.newest_ts) : "—"}`
          : "Idle in window"}
      </span>
      {activity.failure_count > 0 && (
        <span className="text-red-400">{activity.failure_count} failed</span>
      )}
    </div>
  );

  const card = (
    <div
      className={`bg-[#0d1117] border ${visual.border} rounded-lg flex flex-col h-full ${visual.bg} transition-colors hover:bg-[#161b22]`}
      role="region"
      aria-label={`${displayName} agent room`}
    >
      {header}
      <div className="flex-1 px-3 py-2 text-xs text-gray-300 overflow-hidden">
        {children}
      </div>
      {footer}
    </div>
  );

  if (href) {
    return (
      <Link href={href} className="block" data-agent={agent}>
        {card}
      </Link>
    );
  }
  return <div data-agent={agent}>{card}</div>;
}
