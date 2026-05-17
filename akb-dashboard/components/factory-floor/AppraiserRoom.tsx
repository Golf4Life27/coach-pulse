"use client";

/**
 * Appraiser room (Phase 9.4b).
 *
 * Valuation agent. Maps to roster appraiser domain: phase4*,
 * pricing-agent, arv-intelligence, arv-validate, rehab-calibration.
 * Surfaces RentCast quota burn (the main appraiser cost driver) +
 * recent appraiser events.
 */

import { useBriefing } from "../BriefingProvider";
import {
  summarizeAgentActivity,
  idleActivity,
} from "@/lib/maverick/agent-room";
import AgentRoom from "./AgentRoom";
import RecentEventsList from "./RecentEventsList";
import type { SeverityTier } from "@/lib/maverick/severity";

export default function AppraiserRoom() {
  const { briefing } = useBriefing();
  const activity = briefing
    ? summarizeAgentActivity(briefing.structured, "appraiser")
    : idleActivity("appraiser");

  const rent = briefing?.structured.external_signals.rentcast;
  const daysToExhaustion = rent?.burn_rate.days_until_exhaustion_estimate ?? null;
  const callsRemaining = rent?.burn_rate.estimated_calls_remaining ?? null;

  // Quota exhaustion within 3 days mirrors the priority surface signal.
  let tierOverride: SeverityTier | undefined;
  if (daysToExhaustion != null && daysToExhaustion <= 3) tierOverride = 2;
  else if (daysToExhaustion != null && daysToExhaustion <= 7) tierOverride = 1;

  return (
    <AgentRoom
      agent="appraiser"
      displayName="Appraiser"
      role="Valuation"
      activity={activity}
      tierOverride={tierOverride}
      href="/pipeline"
    >
      <div className="space-y-2">
        <div className="grid grid-cols-2 gap-2 text-[11px]">
          <div className="bg-[#161b22] rounded px-2 py-1">
            <div className="text-gray-500">RentCast left</div>
            <div className="text-gray-200 font-semibold text-sm">
              {callsRemaining != null ? callsRemaining : "—"}
            </div>
          </div>
          <div className="bg-[#161b22] rounded px-2 py-1">
            <div className="text-gray-500">Days to dry</div>
            <div className="text-gray-200 font-semibold text-sm">
              {daysToExhaustion != null ? `${daysToExhaustion}d` : "—"}
            </div>
          </div>
        </div>
        <div className="border-t border-[#21262d] pt-2">
          <RecentEventsList
            activity={activity}
            emptyLabel="No Appraiser events in window"
          />
        </div>
      </div>
    </AgentRoom>
  );
}
