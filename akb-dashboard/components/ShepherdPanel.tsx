"use client";

/**
 * Shepherd panel (Phase 9.1).
 *
 * Persistent Maverick presence on every page per Daily UX Spec §3.1
 * + Character Spec §6. Fixed bottom-right (mobile-friendly; rail
 * placement is design-pass territory later). Two states:
 *
 *   Collapsed — small floating button with tier-colored dot + label.
 *     Click to expand. Tooltip on hover surfaces the lead headline.
 *
 *   Expanded — slide-up panel with priority surface (MaverickPriority)
 *     + refresh + close. Auto-refresh every 90s (matches briefing
 *     cache TTL). Manual refresh in header.
 *
 * Wires `/api/maverick/load-state` directly — same endpoint the MCP
 * server uses. Reads the structured briefing client-side and infers
 * severity tiers (Phase 9.5) deterministically.
 *
 * No avatar yet — placeholder dog emoji. Phase 9.9 swaps for the
 * canonical German Shepherd asset.
 */

import { useCallback, useEffect, useState } from "react";
import MaverickPriority from "./MaverickPriority";
import {
  inferPrioritySignals,
  maxTier,
  TIER_VISUAL,
  type PrioritySignal,
} from "@/lib/maverick/severity";

const REFRESH_INTERVAL_MS = 90_000; // briefing cache TTL

interface BriefingResponse {
  source_health: Record<
    string,
    { ok: boolean; error: string | null; staleness_seconds: number }
  >;
  structured: Parameters<typeof inferPrioritySignals>[0]["structured"];
}

export default function ShepherdPanel() {
  const [open, setOpen] = useState(false);
  const [signals, setSignals] = useState<PrioritySignal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastFetched, setLastFetched] = useState<Date | null>(null);

  const fetchBriefing = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/maverick/load-state?format=structured");
      if (!res.ok) {
        throw new Error(`load-state ${res.status}`);
      }
      const body = (await res.json()) as BriefingResponse;
      setSignals(inferPrioritySignals(body));
      setLastFetched(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchBriefing();
    const id = setInterval(fetchBriefing, REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [fetchBriefing]);

  const tier = maxTier(signals);
  const visual = TIER_VISUAL[tier];
  const headline =
    signals.length === 0
      ? "All clear"
      : signals[0].title.length > 32
        ? signals[0].title.slice(0, 32) + "…"
        : signals[0].title;

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={signals.length > 0 ? signals[0].title : "Maverick is watching"}
        // Mobile: stacks above the green CommandBar FAB (bottom-6 right-6,
        // lg:hidden). Desktop: bottom-right corner; FAB is hidden so no
        // collision.
        className={`fixed bottom-20 right-4 lg:bottom-4 z-40 flex items-center gap-2 pl-1.5 pr-3 py-1.5 rounded-full shadow-lg bg-[#161b22] border ${visual.border} transition-colors hover:bg-[#1c2128]`}
        aria-label="Open Maverick Shepherd panel"
      >
        <span className={`absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full ${visual.dot}`} />
        <img
          src="/maverick-avatar.webp"
          srcSet="/maverick-avatar.webp 1x, /maverick-avatar@2x.webp 2x"
          alt="Maverick"
          width={24}
          height={24}
          className="rounded-full object-cover"
        />
        <span className={`text-xs font-semibold ${visual.text} max-w-[160px] truncate`}>
          {visual.label === "Watching" ? "Maverick" : headline}
        </span>
      </button>
    );
  }

  return (
    <div
      // Expanded panel stacks above mobile FAB; desktop bottom-right.
      className="fixed bottom-20 right-4 lg:bottom-4 z-40 w-80 max-w-[calc(100vw-2rem)] max-h-[70vh] bg-[#0d1117] border border-[#30363d] rounded-lg shadow-2xl flex flex-col"
      role="dialog"
      aria-label="Maverick Shepherd panel"
    >
      <div className={`flex items-center justify-between px-3 py-2 border-b ${visual.border}`}>
        <div className="flex items-center gap-2 min-w-0">
          <div className="relative flex-shrink-0">
            <img
              src="/maverick-avatar.webp"
              srcSet="/maverick-avatar.webp 1x, /maverick-avatar@2x.webp 2x"
              alt="Maverick"
              width={28}
              height={28}
              className="rounded-full object-cover"
            />
            <span className={`absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full ${visual.dot}`} />
          </div>
          <h2 className={`text-sm font-bold ${visual.text} truncate`}>
            Maverick — {visual.label}
          </h2>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <button
            type="button"
            onClick={fetchBriefing}
            disabled={loading}
            className="text-[11px] text-gray-400 hover:text-white px-2 py-1 rounded disabled:opacity-50"
            aria-label="Refresh briefing"
          >
            ↻
          </button>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="text-gray-400 hover:text-white text-lg leading-none px-1"
            aria-label="Close Shepherd panel"
          >
            ×
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">
        <MaverickPriority
          signals={signals}
          loading={loading && signals.length === 0}
          error={error}
          onRetry={fetchBriefing}
        />
      </div>
      {lastFetched && !loading && (
        <div className="border-t border-[#30363d] px-3 py-1.5 text-[10px] text-gray-600">
          Last refresh: {lastFetched.toLocaleTimeString()}
        </div>
      )}
    </div>
  );
}
