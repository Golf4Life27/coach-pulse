"use client";

/**
 * Shared briefing fetch + cache provider (Phase 9.4a).
 *
 * One fetch of `/api/maverick/load-state` per session, polled at the
 * briefing cache TTL via `startVisibilityGatedPolling` (Phase 11.7
 * convention). All consumers — Shepherd panel, factory-floor agent
 * rooms, future polling client surfaces — read from this context
 * instead of issuing their own fetches.
 *
 * Per Daily UX Spec rule (Phase 9.4): "One state read, multiple views."
 * Introducing a second briefing call path is prohibited; if a room
 * needs data the briefing doesn't include, extend the briefing schema
 * once (see Checklist 11.6 directive).
 *
 * The provider sits inside AuthGate in app/layout.tsx so unauthenticated
 * sessions don't fire any briefing calls.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { startVisibilityGatedPolling } from "@/lib/maverick/visibility-polling";
import {
  inferPrioritySignals,
  type PrioritySignal,
} from "@/lib/maverick/severity";
import { diffAgentActivity } from "@/lib/maverick/agent-room";
import type { StructuredBriefing, SourceHealth } from "@/lib/maverick/briefing";
import type { SourceName } from "@/lib/maverick/types";

const REFRESH_INTERVAL_MS = 90_000;

export interface BriefingResponse {
  generated_at?: string;
  duration_ms?: number;
  structured: StructuredBriefing;
  source_health: Record<SourceName, SourceHealth>;
}

export interface BriefingContextValue {
  briefing: BriefingResponse | null;
  signals: PrioritySignal[];
  loading: boolean;
  error: string | null;
  lastFetched: Date | null;
  refetch: () => void;
  /**
   * Phase 9.6 — agents whose `by_agent` count increased on the most
   * recent fetch. Drives factory-floor pulse animations. Cleared by
   * the provider after the animation duration so the same room
   * doesn't pulse forever between fetches.
   */
  pulsedAgents: Set<string>;
}

const BriefingContext = createContext<BriefingContextValue | null>(null);

/**
 * Read the current briefing. Throws when called outside the provider —
 * a missing provider is a wiring bug, not a runtime fallback condition.
 */
export function useBriefing(): BriefingContextValue {
  const ctx = useContext(BriefingContext);
  if (!ctx) {
    throw new Error("useBriefing must be called inside <BriefingProvider>");
  }
  return ctx;
}

// Pulse duration matches the keyframe in globals.css.
const PULSE_CLEAR_MS = 1_800;

export default function BriefingProvider({ children }: { children: ReactNode }) {
  const [briefing, setBriefing] = useState<BriefingResponse | null>(null);
  const [signals, setSignals] = useState<PrioritySignal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastFetched, setLastFetched] = useState<Date | null>(null);
  const [pulsedAgents, setPulsedAgents] = useState<Set<string>>(() => new Set());

  // Hold the prior briefing's by_agent map across renders without
  // triggering re-render on its own. Pulse-diff is derived from this
  // on each successful fetch.
  const prevByAgent = useRef<Record<string, number> | null>(null);
  const pulseClearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchBriefing = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/maverick/load-state?format=structured");
      if (!res.ok) {
        throw new Error(`load-state ${res.status}`);
      }
      const body = (await res.json()) as BriefingResponse;
      const nextByAgent = body.structured.audit_summary.by_agent;
      const pulses = diffAgentActivity(prevByAgent.current, nextByAgent);
      prevByAgent.current = nextByAgent;

      setBriefing(body);
      setSignals(inferPrioritySignals(body));
      setLastFetched(new Date());

      if (pulses.size > 0) {
        setPulsedAgents(pulses);
        if (pulseClearTimer.current) clearTimeout(pulseClearTimer.current);
        pulseClearTimer.current = setTimeout(() => {
          setPulsedAgents(new Set());
        }, PULSE_CLEAR_MS);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchBriefing();
    return startVisibilityGatedPolling({
      intervalMs: REFRESH_INTERVAL_MS,
      onTick: fetchBriefing,
    });
  }, [fetchBriefing]);

  useEffect(
    () => () => {
      if (pulseClearTimer.current) clearTimeout(pulseClearTimer.current);
    },
    [],
  );

  return (
    <BriefingContext.Provider
      value={{
        briefing,
        signals,
        loading,
        error,
        lastFetched,
        refetch: fetchBriefing,
        pulsedAgents,
      }}
    >
      {children}
    </BriefingContext.Provider>
  );
}
