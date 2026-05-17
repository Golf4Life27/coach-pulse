"use client";

/**
 * Sentinel room (Phase 9.4b).
 *
 * Intake agent. Maps to `lib/roster.ts` sentinel domain:
 * process-intake, verify-listing, multi-listing-detect. Surfaces
 * recent intake activity + Multi-Listing Queued pipeline state.
 */

import { useBriefing } from "../BriefingProvider";
import {
  summarizeAgentActivity,
  idleActivity,
} from "@/lib/maverick/agent-room";
import AgentRoom from "./AgentRoom";
import RecentEventsList from "./RecentEventsList";

export default function SentinelRoom() {
  const { briefing } = useBriefing();
  const activity = briefing
    ? summarizeAgentActivity(briefing.structured, "sentinel")
    : idleActivity("sentinel");

  const queued = briefing?.structured.pipeline_counts["Multi-Listing Queued"] ?? 0;
  const totalListings = Object.values(briefing?.structured.pipeline_counts ?? {}).reduce(
    (a, b) => a + b,
    0,
  );

  return (
    <AgentRoom
      agent="sentinel"
      displayName="Sentinel"
      role="Intake"
      activity={activity}
      href="/pipeline"
    >
      <div className="space-y-2">
        <div className="grid grid-cols-2 gap-2 text-[11px]">
          <div className="bg-[#161b22] rounded px-2 py-1">
            <div className="text-gray-500">Queued</div>
            <div className="text-gray-200 font-semibold text-sm">{queued}</div>
          </div>
          <div className="bg-[#161b22] rounded px-2 py-1">
            <div className="text-gray-500">Pipeline</div>
            <div className="text-gray-200 font-semibold text-sm">{totalListings}</div>
          </div>
        </div>
        <div className="border-t border-[#21262d] pt-2">
          <RecentEventsList
            activity={activity}
            emptyLabel="No Sentinel events in window"
          />
        </div>
      </div>
    </AgentRoom>
  );
}
