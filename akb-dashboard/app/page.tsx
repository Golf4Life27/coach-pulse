"use client";

import { useState, useEffect, useCallback } from "react";
import MorningBriefing from "@/components/MorningBriefing";
import PipelineBoard from "@/components/PipelineBoard";
import OutreachPanel from "@/components/OutreachPanel";
import JarvisFeed from "@/components/JarvisFeed";
import JarvisChat from "@/components/JarvisChat";
import ActionQueue from "@/components/ActionQueue";
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

      {/* Morning Briefing — auto-generated prioritized actions */}
      <MorningBriefing />

      {/* Outreach Controls */}
      <OutreachPanel />

      {/* Jarvis Inbound Feed */}
      <JarvisFeed />

      {/* Pipeline Board — Kanban view */}
      <PipelineBoard />

      {/* Legacy Action Queue — keeping for now as fallback */}
      <details className="group">
        <summary className="text-xs text-gray-600 cursor-pointer hover:text-gray-400 select-none">
          Show legacy Action Queue
        </summary>
        <div className="mt-3">
          <ActionQueue />
        </div>
      </details>
    </div>
  );
}
