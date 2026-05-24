"use client";

/**
 * Scout room (Phase 9.4b).
 *
 * Buyer pipeline. Maps to roster scout domain: buyers/*,
 * match-to-deal, warmup-sequence. Surfaces buyer pipeline counts +
 * recent scout events.
 *
 * NOTE: buyer-specific pipeline state lives in /buyers; the briefing
 * does not currently expose buyer counts. When that data ships
 * (briefing schema extension under Phase 9.4 rules), this room will
 * surface buyer warmth states.
 */

import { useBriefing } from "../BriefingProvider";
import {
  summarizeAgentActivity,
  idleActivity,
} from "@/lib/maverick/agent-room";
import AgentRoom from "./AgentRoom";
import RecentEventsList from "./RecentEventsList";

export default function ScoutRoom() {
  const { briefing } = useBriefing();
  const activity = briefing
    ? summarizeAgentActivity(briefing.structured, "scout")
    : idleActivity("scout");

  return (
    <AgentRoom
      agent="scout"
      displayName="Scout"
      role="Buyer pipeline"
      activity={activity}
      href="/buyers"
    >
      <div className="space-y-2">
        <p className="text-[11px] text-gray-500">
          Buyer warmup + matching. Detail in <span className="text-gray-300">/buyers</span>.
        </p>
        <div className="border-t border-[#21262d] pt-2">
          <RecentEventsList
            activity={activity}
            emptyLabel="No Scout events in window"
          />
        </div>
      </div>
    </AgentRoom>
  );
}
