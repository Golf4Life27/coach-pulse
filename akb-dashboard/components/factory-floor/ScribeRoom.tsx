"use client";

/**
 * Scribe room (Phase 5.2).
 *
 * Contract-handling agent. Reads DocuSign envelope rollup from the
 * shared briefing (one state read, multiple views — Phase 9.4
 * discipline) and surfaces:
 *
 *   - Active envelope count
 *   - Envelopes awaiting Alex's signature
 *   - Signed this week
 *   - Voided / declined / timed-out
 *
 * Tier override mirrors the spec rule:
 *   max_awaiting_alex_hours > 72 → tier 3 (SMS-escalation eligible)
 *   max_awaiting_alex_hours > 24 → tier 2
 *
 * When DocuSign env vars aren't provisioned yet (configured=false),
 * the room degrades to "Standing by — DocuSign credentials pending"
 * with a link to the App Setup docs. Per spec rule "Empty rooms
 * accurately communicate roster presence + agent inactivity."
 */

import { useBriefing } from "../BriefingProvider";
import {
  summarizeAgentActivity,
  idleActivity,
} from "@/lib/maverick/agent-room";
import AgentRoom from "./AgentRoom";
import RecentEventsList from "./RecentEventsList";
import type { SeverityTier } from "@/lib/maverick/severity";

const DOCUSIGN_INDEX_URL = "https://app.docusign.com/documents";

export default function ScribeRoom() {
  const { briefing } = useBriefing();
  const activity = briefing
    ? summarizeAgentActivity(briefing.structured, "scribe")
    : idleActivity("scribe");

  const docusign = briefing?.structured.external_signals.docusign;
  const configured = docusign?.configured ?? false;
  const rollup = docusign?.rollup;
  const maxAwaiting = rollup?.max_awaiting_alex_hours ?? null;

  // Tier elevations mirror the Phase 5 spec:
  //   >72h awaiting Alex → tier 3 (eligible for SMS escalation via 9.7)
  //   >24h awaiting Alex → tier 2
  let tierOverride: SeverityTier | undefined;
  if (maxAwaiting !== null && maxAwaiting > 72) tierOverride = 3;
  else if (maxAwaiting !== null && maxAwaiting > 24) tierOverride = 2;

  // Not-configured rendering: same "Standing by" treatment as the
  // generic stubs, but the body carries the specific reason so Alex
  // knows what action would light it up.
  if (!configured) {
    return (
      <AgentRoom
        agent="scribe"
        displayName="Scribe"
        role="Contract handling"
        activity={activity}
      >
        <div className="space-y-2">
          <p className="text-[11px] text-gray-500 italic">Standing by</p>
          <p className="text-[10px] text-gray-600">
            DocuSign credentials pending (Phase 12.x)
          </p>
        </div>
      </AgentRoom>
    );
  }

  return (
    <AgentRoom
      agent="scribe"
      displayName="Scribe"
      role="Contract handling"
      activity={activity}
      tierOverride={tierOverride}
      href={DOCUSIGN_INDEX_URL}
    >
      <div className="space-y-2">
        <div className="grid grid-cols-2 gap-2 text-[11px]">
          <div className="bg-[#161b22] rounded px-2 py-1">
            <div className="text-gray-500">Active</div>
            <div className="text-gray-200 font-semibold text-sm">
              {rollup?.active_count ?? 0}
            </div>
          </div>
          <div className="bg-[#161b22] rounded px-2 py-1">
            <div className="text-gray-500">Awaiting you</div>
            <div
              className={`font-semibold text-sm ${
                (rollup?.awaiting_alex_count ?? 0) > 0
                  ? "text-orange-300"
                  : "text-gray-200"
              }`}
            >
              {rollup?.awaiting_alex_count ?? 0}
              {maxAwaiting !== null && maxAwaiting > 0 && (
                <span className="text-[10px] text-gray-500 ml-1">
                  · {formatHours(maxAwaiting)} max
                </span>
              )}
            </div>
          </div>
          <div className="bg-[#161b22] rounded px-2 py-1">
            <div className="text-gray-500">Signed 7d</div>
            <div className="text-gray-200 font-semibold text-sm">
              {rollup?.signed_this_week ?? 0}
            </div>
          </div>
          <div className="bg-[#161b22] rounded px-2 py-1">
            <div className="text-gray-500">Voided / dead</div>
            <div className="text-gray-200 font-semibold text-sm">
              {rollup?.voided_or_expired ?? 0}
            </div>
          </div>
        </div>
        <div className="border-t border-[#21262d] pt-2">
          <RecentEventsList
            activity={activity}
            emptyLabel="No Scribe events in window"
          />
        </div>
      </div>
    </AgentRoom>
  );
}

function formatHours(h: number): string {
  if (h < 1) return "<1h";
  if (h < 24) return `${Math.round(h)}h`;
  return `${Math.round(h / 24)}d`;
}
