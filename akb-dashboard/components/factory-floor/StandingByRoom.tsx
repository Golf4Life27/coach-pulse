"use client";

/**
 * Standing-by room (Phase 9.4b).
 *
 * Generic stub for agents that exist in the roster but have no shipped
 * implementation yet: Forge, Scribe, Ledger, Pulse. Per Daily UX Spec
 * §4.2 ("Each room is sized proportional to its current activity.
 * Quiet agents show small footprints.") — these render minimally with
 * a "Standing by" label + the phase that ships them.
 *
 * Per user direction: "Empty rooms accurately communicate roster
 * presence + agent inactivity." Do not pad with fake activity.
 *
 * If audit events DO start appearing for these agents (because work
 * landed elsewhere), the recent_events list still renders them — the
 * room upgrades to active automatically without code changes here.
 */

import { useBriefing } from "../BriefingProvider";
import {
  summarizeAgentActivity,
  idleActivity,
} from "@/lib/maverick/agent-room";
import AgentRoom from "./AgentRoom";
import RecentEventsList from "./RecentEventsList";

export interface StandingByRoomProps {
  agent: string;
  displayName: string;
  role: string;
  /** Short note explaining what ships this agent (e.g. "Phase 5 — Scribe"). */
  shipsIn: string;
}

export default function StandingByRoom({
  agent,
  displayName,
  role,
  shipsIn,
}: StandingByRoomProps) {
  const { briefing } = useBriefing();
  const activity = briefing
    ? summarizeAgentActivity(briefing.structured, agent)
    : idleActivity(agent);

  return (
    <AgentRoom
      agent={agent}
      displayName={displayName}
      role={role}
      activity={activity}
    >
      <div className="space-y-2">
        <p className="text-[11px] text-gray-500 italic">Standing by</p>
        <p className="text-[10px] text-gray-600">{shipsIn}</p>
        {activity.active && (
          <div className="border-t border-[#21262d] pt-2">
            <RecentEventsList activity={activity} />
          </div>
        )}
      </div>
    </AgentRoom>
  );
}
