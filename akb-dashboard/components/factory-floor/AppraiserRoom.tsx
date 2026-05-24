"use client";

/**
 * Appraiser room (Phase 9.4b, extended Phase 4A.1 / Commit I.2).
 *
 * Valuation agent. Maps to roster appraiser domain: phase4*,
 * pricing-agent, arv-intelligence, arv-validate, rehab-calibration.
 * Surfaces:
 *   - RentCast quota burn (calls remaining, days to dry)
 *   - ARV calc coverage across active deals (current / stale / missing
 *     / low-confidence counts) — Phase 4A.1 wiring
 *   - Recent agent=appraiser audit events
 *
 * Tier overrides:
 *   - RentCast quota ≤3d → tier 2 (mirrors priority surface)
 *   - RentCast quota ≤7d → tier 1
 *   - ≥1 active deal with LOW confidence → tier 1 (manual review queue
 *     building up; not as urgent as a quota cliff, but visible)
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

  // ARV + Rehab coverage rollups across active deals. Computed inline
  // from briefing.active_deals; no separate briefing field needed.
  const activeDeals = briefing?.structured.active_deals ?? [];
  const arvCoverage = {
    total: activeDeals.length,
    current: activeDeals.filter((d) => d.arv_freshness === "current").length,
    stale: activeDeals.filter((d) => d.arv_freshness === "stale").length,
    missing: activeDeals.filter((d) => d.arv_freshness === "missing").length,
    low_confidence: activeDeals.filter((d) => d.arv_confidence === "LOW").length,
  };
  const rehabCoverage = {
    total: activeDeals.length,
    current: activeDeals.filter((d) => d.rehab_freshness === "current").length,
    stale: activeDeals.filter((d) => d.rehab_freshness === "stale").length,
    missing: activeDeals.filter((d) => d.rehab_freshness === "missing").length,
    heavy_or_gut: activeDeals.filter(
      (d) => d.bbc_tier === "Heavy" || d.bbc_tier === "Gut",
    ).length,
  };
  // Phase 4C.1 — Track mix across active deals. landlord_dominant
  // signals "money on the table if priced as flipper-only" — the
  // single most valuable signal from dual-track. flipper_dominant is
  // the conventional path. tie is rare; neither = no inputs available
  // (no ARV + no rent).
  const trackMix = {
    total: activeDeals.length,
    flipper_dominant: activeDeals.filter((d) => d.dominant_track === "flipper").length,
    landlord_dominant: activeDeals.filter((d) => d.dominant_track === "landlord").length,
    tie: activeDeals.filter((d) => d.dominant_track === "tie").length,
    neither: activeDeals.filter((d) => d.dominant_track === "neither").length,
  };

  let tierOverride: SeverityTier | undefined;
  if (daysToExhaustion != null && daysToExhaustion <= 3) tierOverride = 2;
  else if (daysToExhaustion != null && daysToExhaustion <= 7) tierOverride = 1;
  else if (arvCoverage.low_confidence > 0) tierOverride = 1;
  else if (rehabCoverage.heavy_or_gut > 0) tierOverride = 1;
  // landlord-dominant signals are the "money on the table" case —
  // surface them as tier 1 so Alex sees the dual-track value.
  else if (trackMix.landlord_dominant > 0) tierOverride = 1;

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
        {arvCoverage.total > 0 && (
          <div className="border-t border-[#21262d] pt-2">
            <div className="text-[10px] uppercase tracking-wide text-gray-500 mb-1">
              ARV across {arvCoverage.total} active
            </div>
            <div className="grid grid-cols-2 gap-2 text-[11px]">
              <div className="bg-[#161b22] rounded px-2 py-1">
                <div className="text-gray-500">Current</div>
                <div className="text-emerald-300 font-semibold text-sm">
                  {arvCoverage.current}
                </div>
              </div>
              <div className="bg-[#161b22] rounded px-2 py-1">
                <div className="text-gray-500">Stale &gt;30d</div>
                <div className={`font-semibold text-sm ${arvCoverage.stale > 0 ? "text-amber-300" : "text-gray-200"}`}>
                  {arvCoverage.stale}
                </div>
              </div>
              <div className="bg-[#161b22] rounded px-2 py-1">
                <div className="text-gray-500">Missing</div>
                <div className={`font-semibold text-sm ${arvCoverage.missing > 0 ? "text-amber-300" : "text-gray-200"}`}>
                  {arvCoverage.missing}
                </div>
              </div>
              <div className="bg-[#161b22] rounded px-2 py-1">
                <div className="text-gray-500">LOW conf</div>
                <div className={`font-semibold text-sm ${arvCoverage.low_confidence > 0 ? "text-orange-300" : "text-gray-200"}`}>
                  {arvCoverage.low_confidence}
                </div>
              </div>
            </div>
          </div>
        )}
        {trackMix.total > 0 && (trackMix.flipper_dominant + trackMix.landlord_dominant + trackMix.tie) > 0 && (
          <div className="border-t border-[#21262d] pt-2">
            <div className="text-[10px] uppercase tracking-wide text-gray-500 mb-1">
              Track mix across {trackMix.total} active
            </div>
            <div className="grid grid-cols-2 gap-2 text-[11px]">
              <div className="bg-[#161b22] rounded px-2 py-1">
                <div className="text-gray-500">Flipper</div>
                <div className="text-gray-200 font-semibold text-sm">
                  {trackMix.flipper_dominant}
                </div>
              </div>
              <div className="bg-[#161b22] rounded px-2 py-1">
                <div className="text-gray-500">Landlord</div>
                <div className={`font-semibold text-sm ${trackMix.landlord_dominant > 0 ? "text-emerald-300" : "text-gray-200"}`}>
                  {trackMix.landlord_dominant}
                </div>
              </div>
              <div className="bg-[#161b22] rounded px-2 py-1">
                <div className="text-gray-500">Tie</div>
                <div className="text-gray-200 font-semibold text-sm">{trackMix.tie}</div>
              </div>
              <div className="bg-[#161b22] rounded px-2 py-1">
                <div className="text-gray-500">No inputs</div>
                <div className={`font-semibold text-sm ${trackMix.neither > 0 ? "text-amber-300" : "text-gray-200"}`}>
                  {trackMix.neither}
                </div>
              </div>
            </div>
          </div>
        )}
        {rehabCoverage.total > 0 && (
          <div className="border-t border-[#21262d] pt-2">
            <div className="text-[10px] uppercase tracking-wide text-gray-500 mb-1">
              Rehab across {rehabCoverage.total} active
            </div>
            <div className="grid grid-cols-2 gap-2 text-[11px]">
              <div className="bg-[#161b22] rounded px-2 py-1">
                <div className="text-gray-500">Current</div>
                <div className="text-emerald-300 font-semibold text-sm">
                  {rehabCoverage.current}
                </div>
              </div>
              <div className="bg-[#161b22] rounded px-2 py-1">
                <div className="text-gray-500">Stale &gt;30d</div>
                <div className={`font-semibold text-sm ${rehabCoverage.stale > 0 ? "text-amber-300" : "text-gray-200"}`}>
                  {rehabCoverage.stale}
                </div>
              </div>
              <div className="bg-[#161b22] rounded px-2 py-1">
                <div className="text-gray-500">Missing</div>
                <div className={`font-semibold text-sm ${rehabCoverage.missing > 0 ? "text-amber-300" : "text-gray-200"}`}>
                  {rehabCoverage.missing}
                </div>
              </div>
              <div className="bg-[#161b22] rounded px-2 py-1">
                <div className="text-gray-500">Heavy/Gut</div>
                <div className={`font-semibold text-sm ${rehabCoverage.heavy_or_gut > 0 ? "text-orange-300" : "text-gray-200"}`}>
                  {rehabCoverage.heavy_or_gut}
                </div>
              </div>
            </div>
          </div>
        )}
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
