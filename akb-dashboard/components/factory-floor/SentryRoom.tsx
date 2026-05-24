"use client";

/**
 * Sentry room (Phase 9.4b).
 *
 * Gate enforcement + governance. Maps to roster sentry domain:
 * orchestrator/* gates, d3-backfill, d3-math-filter, d3-scrub,
 * NEVER-list enforcement. Surfaces D3 manual fix queue (open_decisions
 * the briefing exposes) + recent sentry events.
 */

import { useBriefing } from "../BriefingProvider";
import {
  summarizeAgentActivity,
  idleActivity,
} from "@/lib/maverick/agent-room";
import AgentRoom from "./AgentRoom";
import RecentEventsList from "./RecentEventsList";
import type { SeverityTier } from "@/lib/maverick/severity";

export default function SentryRoom() {
  const { briefing } = useBriefing();
  const activity = briefing
    ? summarizeAgentActivity(briefing.structured, "sentry")
    : idleActivity("sentry");

  const openDecisions = briefing?.structured.open_decisions.length ?? 0;
  const responseReceived = briefing?.structured.pipeline_counts["Response Received"] ?? 0;

  // Pending manual-fix items elevate Sentry to tier 1 even when no
  // events fired in the window — work is queued, not idle.
  const tierOverride: SeverityTier | undefined =
    openDecisions > 0 ? 1 : undefined;

  return (
    <AgentRoom
      agent="sentry"
      displayName="Sentry"
      role="Gate enforcement"
      activity={activity}
      tierOverride={tierOverride}
      href="/queue"
    >
      <div className="space-y-2">
        <div className="grid grid-cols-2 gap-2 text-[11px]">
          <div className="bg-[#161b22] rounded px-2 py-1">
            <div className="text-gray-500">Manual fix</div>
            <div className="text-gray-200 font-semibold text-sm">{openDecisions}</div>
          </div>
          <div className="bg-[#161b22] rounded px-2 py-1">
            <div className="text-gray-500">Responses</div>
            <div className="text-gray-200 font-semibold text-sm">{responseReceived}</div>
          </div>
        </div>
        <div className="border-t border-[#21262d] pt-2">
          <RecentEventsList
            activity={activity}
            emptyLabel="No Sentry events in window"
          />
        </div>
      </div>
    </AgentRoom>
  );
}
