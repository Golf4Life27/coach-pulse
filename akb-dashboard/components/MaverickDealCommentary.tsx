"use client";

/**
 * Maverick deal-detail commentary panel (Phase 9.8).
 *
 * Daily UX Spec §7.1: "Maverick's commentary — a small panel on this
 * page showing Maverick's reasoning specific to this deal."
 *
 * Reads the shared BriefingProvider context (no new briefing call
 * path) and projects per-deal signals via `inferDealCommentary`.
 * Severity tier from 9.5 drives the card border treatment. When no
 * rule fires, renders the watching empty state per spec — never
 * fakes content.
 *
 * Collapsed by default; click expand to surface reasoning.
 */

import { useState } from "react";
import { useBriefing } from "./BriefingProvider";
import {
  inferDealCommentary,
  type DealCommentaryListing,
} from "@/lib/maverick/deal-commentary";
import { TIER_VISUAL, type SeverityTier } from "@/lib/maverick/severity";

export interface MaverickDealCommentaryProps {
  recordId: string;
  listing: DealCommentaryListing;
}

export default function MaverickDealCommentary({
  recordId,
  listing,
}: MaverickDealCommentaryProps) {
  const { briefing, loading } = useBriefing();
  const [expanded, setExpanded] = useState(false);
  const signals = inferDealCommentary(briefing?.structured ?? null, recordId, listing);

  // Tier reflects the strongest signal; empty state is tier 0.
  const tier: SeverityTier = signals.length > 0 ? signals[0].tier : 0;
  const visual = TIER_VISUAL[tier];

  // Empty / watching state — explicit per spec.
  if (signals.length === 0) {
    return (
      <div
        className={`bg-[#1c2128] rounded-lg border ${visual.border} p-3 flex items-center gap-2`}
        aria-label="Maverick commentary (watching)"
      >
        <img
          src="/maverick-avatar.webp"
          srcSet="/maverick-avatar.webp 1x, /maverick-avatar@2x.webp 2x"
          alt="Maverick"
          width={20}
          height={20}
          className="rounded-full object-cover flex-shrink-0"
        />
        <span className="text-xs text-gray-400">
          {loading && !briefing
            ? "Loading commentary…"
            : "Maverick is watching this deal."}
        </span>
      </div>
    );
  }

  const lead = signals[0];

  return (
    <div
      className={`bg-[#1c2128] rounded-lg border ${visual.border} ${visual.bg}`}
      aria-label="Maverick commentary"
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-start gap-2 p-3 text-left hover:bg-[#21262d] transition-colors rounded-lg"
        aria-expanded={expanded}
      >
        <img
          src="/maverick-avatar.webp"
          srcSet="/maverick-avatar.webp 1x, /maverick-avatar@2x.webp 2x"
          alt="Maverick"
          width={24}
          height={24}
          className="rounded-full object-cover flex-shrink-0 mt-0.5"
        />
        <div className="flex-1 min-w-0">
          <p className={`text-xs font-semibold ${visual.text}`}>{lead.headline}</p>
          {lead.agent && (
            <p className="text-[10px] text-gray-500 mt-0.5">
              attributed to <span className="text-gray-400">{lead.agent}</span>
              {signals.length > 1 && (
                <span className="ml-2">· {signals.length - 1} more signal{signals.length - 1 === 1 ? "" : "s"}</span>
              )}
            </p>
          )}
        </div>
        <span className="text-[10px] text-gray-500 flex-shrink-0 mt-0.5">
          {expanded ? "▴" : "▾"}
        </span>
      </button>
      {expanded && (
        <div className={`border-t ${visual.border} px-3 py-2 space-y-2`}>
          {signals.map((s) => {
            const sVisual = TIER_VISUAL[s.tier];
            return (
              <div key={s.id} className="text-[11px]">
                <p className={`font-semibold ${sVisual.text}`}>{s.headline}</p>
                {s.reason && <p className="text-gray-400 mt-0.5">{s.reason}</p>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
