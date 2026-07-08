"use client";

import { useState, useEffect, useCallback } from "react";
import MaverickTopPriorities from "@/components/MaverickTopPriorities";
import MissionControl from "@/components/MissionControl";
import MorningBriefing from "@/components/MorningBriefing";
import PipelineBoard from "@/components/PipelineBoard";
import OutreachPanel from "@/components/OutreachPanel";
import JarvisChat from "@/components/JarvisChat";
import JarvisGreeting from "@/components/JarvisGreeting";
import FactoryFloor from "@/components/factory-floor/FactoryFloor";
import { showToast } from "@/components/Toast";

const LAST_LOGIN_KEY = "akb_dashboard_last_login";

export default function CommandCenter() {
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    try {
      window.localStorage.setItem(LAST_LOGIN_KEY, new Date().toISOString());
    } catch { /* non-fatal */ }
  }, []);

  const refresh = useCallback(() => {
    setRefreshKey((k) => k + 1);
    setLastUpdated(new Date());
    showToast("Refreshed", "success");
  }, []);

  useEffect(() => {
    setLastUpdated(new Date());
  }, []);

  return (
    <div className="space-y-6" key={refreshKey}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-white">COMMAND CENTER</h1>
        <div className="flex items-center gap-3">
          {lastUpdated && (
            <span className="text-xs text-gray-500">
              {lastUpdated.toLocaleTimeString()}
            </span>
          )}
          <JarvisChat />
          <button
            type="button"
            onClick={refresh}
            className="text-xs bg-[#1c2128] border border-[#30363d] text-gray-300 px-3 py-1.5 rounded hover:bg-[#30363d] transition-colors"
          >
            Refresh
          </button>
        </div>
      </div>

      {/* Maverick Top Priorities — the operator's ranked "what needs YOU now"
          strip (revenue × urgency × operator-only). Curated via
          /api/maverick/priorities; expiry-gated against staleness. */}
      <MaverickTopPriorities />

      {/* Mission Control — the live daily belt: crawled → accepted → sent →
          replies, cron heartbeats, event tape (operator spec 2026-07-04). */}
      <MissionControl />

      {/* Jarvis ACT NOW — the ONE decision surface on the landing page
          (operator 2026-07-08: "action items presented cleanly, orderly, with
          reasoning"). Fed by /api/jarvis-brief, which now HARD-gates staleness:
          no card older than JARVIS_DECISION_MAX_AGE_HOURS (default 10 days).
          Cold threads route to the bump/re-engagement lane in /queue instead. */}
      <JarvisGreeting />

      {/* Phase 9.4 — factory-floor agent rooms */}
      <FactoryFloor />

      {/* Morning Briefing — auto-generated prioritized actions */}
      <MorningBriefing />

      {/* Outreach Controls */}
      <OutreachPanel />

      {/* Pipeline Board — Kanban view */}
      <PipelineBoard />

      {/* JarvisFeed + legacy ActionQueue removed 2026-07-08 — both duplicated
          /queue (the transactional approve-and-send surface) and buried live
          decisions under noise. One queue, one Act Now, one strip. */}
    </div>
  );
}
