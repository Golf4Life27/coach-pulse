"use client";

/**
 * Pulse room (Phase 14 / O.3).
 *
 * Reads `briefing.structured.pulse.active_detections` — populated by
 * the aggregator from lib/pulse/active-store (KV). Renders count
 * pills by severity + top-3 detection headlines with age. Click-
 * through to `/pulse` for the full queue + manual scan.
 *
 * Visual treatment routes through TIER_VISUAL — the room's border /
 * status dot reflects the highest-severity active detection (tier
 * 3 for critical, tier 2 for warning, tier 1 for info). The
 * tierOverride seam on AgentRoom lets us elevate beyond the
 * activity-inferred tier when there's a critical Pulse fire even if
 * Pulse's audit log is otherwise quiet.
 */

import { useBriefing } from "../BriefingProvider";
import {
  summarizeAgentActivity,
  idleActivity,
  formatRelativeTs,
} from "@/lib/maverick/agent-room";
import type { SeverityTier } from "@/lib/maverick/severity";
import type { PulseSeverity } from "@/lib/pulse/types";
import AgentRoom from "./AgentRoom";

const SEVERITY_PILL: Record<PulseSeverity, { bg: string; text: string; label: string }> = {
  critical: { bg: "bg-red-500/15", text: "text-red-300", label: "CRIT" },
  warning: { bg: "bg-orange-500/15", text: "text-orange-300", label: "WARN" },
  info: { bg: "bg-emerald-500/15", text: "text-emerald-300", label: "INFO" },
};

function pulseSeverityToTier(severity: PulseSeverity): SeverityTier {
  if (severity === "critical") return 3;
  if (severity === "warning") return 2;
  return 1;
}

export default function PulseRoom() {
  const { briefing } = useBriefing();
  const activity = briefing
    ? summarizeAgentActivity(briefing.structured, "pulse")
    : idleActivity("pulse");

  const detections = briefing?.structured.pulse.active_detections ?? [];
  const lastScanAt = briefing?.structured.pulse.last_scan_at ?? null;

  const countBySeverity = {
    critical: detections.filter((d) => d.severity === "critical").length,
    warning: detections.filter((d) => d.severity === "warning").length,
    info: detections.filter((d) => d.severity === "info").length,
  };

  // Tier override: when a critical / warning detection is active,
  // bump the room's tier above what audit-activity alone would imply.
  // Critical → 3, warning → 2, info → 1, none → no override.
  const tierOverride: SeverityTier | undefined =
    countBySeverity.critical > 0
      ? 3
      : countBySeverity.warning > 0
        ? 2
        : countBySeverity.info > 0
          ? 1
          : undefined;

  const top = detections.slice(0, 3);

  return (
    <AgentRoom
      agent="pulse"
      displayName="Pulse"
      role="Self-monitoring"
      activity={activity}
      tierOverride={tierOverride}
      href="/pulse"
    >
      <div className="space-y-2">
        {/* Severity count strip. */}
        <div className="grid grid-cols-3 gap-1.5 text-[11px]">
          {(["critical", "warning", "info"] as const).map((s) => {
            const pill = SEVERITY_PILL[s];
            const count = countBySeverity[s];
            const dim = count === 0 ? "opacity-40" : "";
            return (
              <div
                key={s}
                className={`rounded px-2 py-1 ${pill.bg} ${dim}`}
              >
                <div className={`text-[9px] uppercase tracking-wider ${pill.text}`}>{pill.label}</div>
                <div className={`text-sm font-semibold ${pill.text}`}>{count}</div>
              </div>
            );
          })}
        </div>

        {/* Top 3 active detection headlines. */}
        {top.length > 0 ? (
          <div className="space-y-1 border-t border-[#21262d] pt-2">
            {top.map((d) => {
              const pill = SEVERITY_PILL[d.severity];
              return (
                <div key={d.id} className="text-[10px] leading-tight">
                  <div className="flex items-start gap-1.5">
                    <span
                      className={`flex-shrink-0 text-[9px] uppercase tracking-wider px-1 py-0.5 rounded ${pill.bg} ${pill.text}`}
                    >
                      {pill.label}
                    </span>
                    <span className="text-gray-300 line-clamp-2 break-words">{d.title}</span>
                  </div>
                  <div className="text-[9px] text-gray-500 ml-[3.25rem]">
                    {formatRelativeTs(d.first_seen_at)}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="border-t border-[#21262d] pt-2 text-[10px] text-gray-500 italic">
            {lastScanAt
              ? `All clear · last scan ${formatRelativeTs(lastScanAt)}`
              : "No scan yet — open /pulse to fire one"}
          </div>
        )}

        {detections.length > 3 && (
          <div className="text-[10px] text-gray-500 italic">
            +{detections.length - 3} more →
          </div>
        )}
      </div>
    </AgentRoom>
  );
}
