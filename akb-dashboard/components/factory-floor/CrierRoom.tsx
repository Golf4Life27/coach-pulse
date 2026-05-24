"use client";

/**
 * Crier room (Phase 9.4b — lead room).
 *
 * SMS dispatch agent. The user-instructed lead because Crier has the
 * richest real audit data + most-stable backend (post-Phase 11.1 Quo
 * probe fix). Surfaces:
 *
 *   - Quo probe state (green/amber/red) — drives a tierOverride when red
 *   - Texted universe size + Multi-Listing Queued (outbound funnel state)
 *   - Last 5 `agent=crier` audit events (timestamp + outcome)
 *
 * Click-through routes to /queue (the existing action queue page where
 * Crier sends are managed). Per-event click-through to deal detail is
 * provided by the recent-events list when records exist.
 */

import { useBriefing } from "../BriefingProvider";
import {
  summarizeAgentActivity,
  idleActivity,
} from "@/lib/maverick/agent-room";
import AgentRoom from "./AgentRoom";
import RecentEventsList from "./RecentEventsList";
import type { SeverityTier } from "@/lib/maverick/severity";

export default function CrierRoom() {
  const { briefing } = useBriefing();
  const activity = briefing
    ? summarizeAgentActivity(briefing.structured, "crier")
    : idleActivity("crier");

  const quo = briefing?.structured.external_signals.quo;
  const quoState = resolveQuoState(quo);
  const queued = briefing?.structured.pipeline_counts["Multi-Listing Queued"] ?? 0;
  const texted = briefing?.structured.texted_universe_size ?? 0;

  // Quo down is a tier 2 elevation regardless of audit-inferred tier —
  // mirrors the priority surface signal `quo_down` (severity.ts).
  const tierOverride: SeverityTier | undefined =
    quoState.tier > 0 ? quoState.tier : undefined;

  return (
    <AgentRoom
      agent="crier"
      displayName="Crier"
      role="SMS dispatch"
      activity={activity}
      tierOverride={tierOverride}
      href="/queue"
    >
      <div className="space-y-2">
        <div className="flex items-center justify-between text-[11px]">
          <span className="text-gray-400">Quo channel</span>
          <span className={`flex items-center gap-1 ${quoState.text}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${quoState.dot}`} />
            {quoState.label}
          </span>
        </div>
        <div className="grid grid-cols-2 gap-2 text-[11px]">
          <div className="bg-[#161b22] rounded px-2 py-1">
            <div className="text-gray-500">Queued</div>
            <div className="text-gray-200 font-semibold text-sm">{queued}</div>
          </div>
          <div className="bg-[#161b22] rounded px-2 py-1">
            <div className="text-gray-500">Texted</div>
            <div className="text-gray-200 font-semibold text-sm">{texted}</div>
          </div>
        </div>
        <div className="border-t border-[#21262d] pt-2">
          <RecentEventsList activity={activity} emptyLabel="No Crier events in window" />
        </div>
      </div>
    </AgentRoom>
  );
}

interface QuoStatePresentation {
  label: string;
  tier: SeverityTier;
  text: string;
  dot: string;
}

function resolveQuoState(
  quo: { api_responsive: boolean; api_key_configured: boolean } | undefined,
): QuoStatePresentation {
  if (!quo || !quo.api_key_configured) {
    return { label: "Not configured", tier: 1, text: "text-gray-400", dot: "bg-gray-500" };
  }
  if (!quo.api_responsive) {
    return { label: "Unresponsive", tier: 2, text: "text-orange-400", dot: "bg-orange-500 animate-pulse" };
  }
  return { label: "Responsive", tier: 0, text: "text-emerald-400", dot: "bg-emerald-500" };
}

