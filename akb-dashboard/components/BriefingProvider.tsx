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
  useState,
  type ReactNode,
} from "react";
import { startVisibilityGatedPolling } from "@/lib/maverick/visibility-polling";
import {
  inferPrioritySignals,
  type PrioritySignal,
} from "@/lib/maverick/severity";
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

export default function BriefingProvider({ children }: { children: ReactNode }) {
  const [briefing, setBriefing] = useState<BriefingResponse | null>(null);
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
      setBriefing(body);
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
    return startVisibilityGatedPolling({
      intervalMs: REFRESH_INTERVAL_MS,
      onTick: fetchBriefing,
    });
  }, [fetchBriefing]);

  return (
    <BriefingContext.Provider
      value={{ briefing, signals, loading, error, lastFetched, refetch: fetchBriefing }}
    >
      {children}
    </BriefingContext.Provider>
  );
}
