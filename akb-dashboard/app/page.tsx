"use client";

import { useState, useEffect, useCallback } from "react";
import MetricCard from "@/components/MetricCard";
import ActionQueue from "@/components/ActionQueue";
import BriefingStrip from "@/components/BriefingStrip";
import { Briefing, DashboardStats } from "@/lib/types";
import { showToast } from "@/components/Toast";

const LAST_LOGIN_KEY = "akb_dashboard_last_login";

export default function ActNowPage() {
  const [briefing, setBriefing] = useState<Briefing | null>(null);
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [previousLogin, setPreviousLogin] = useState<string | null>(null);

  // Read previous login once on mount, then stamp the current visit.
  useEffect(() => {
    try {
      const prev = window.localStorage.getItem(LAST_LOGIN_KEY);
      setPreviousLogin(prev);
      window.localStorage.setItem(LAST_LOGIN_KEY, new Date().toISOString());
    } catch {
      // localStorage unavailable (private mode, SSR) — non-fatal.
    }
  }, []);

  const fetchData = useCallback(async () => {
    try {
      const [briefingRes, statsRes] = await Promise.all([
        fetch("/api/briefing"),
        fetch("/api/stats"),
      ]);
      if (!briefingRes.ok || !statsRes.ok) throw new Error("API error");
      const [briefingData, statsData] = await Promise.all([
        briefingRes.json(),
        statsRes.json(),
      ]);
      setBriefing(briefingData);
      setStats(statsData);
      setLastUpdated(new Date());
    } catch {
      showToast("Failed to refresh dashboard. Showing last known data.");
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 60_000);
    return () => clearInterval(interval);
  }, [fetchData]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-white">ACT NOW</h1>
        <div className="flex items-center gap-3">
          {lastUpdated && (
            <span className="text-xs text-gray-500">
              Updated {lastUpdated.toLocaleTimeString()}
            </span>
          )}
          <button
            type="button"
            onClick={fetchData}
            className="text-xs bg-[#1c2128] border border-[#30363d] text-gray-300 px-3 py-1.5 rounded hover:bg-[#30363d] transition-colors"
          >
            Refresh
          </button>
        </div>
      </div>

      <BriefingStrip briefing={briefing} previousLogin={previousLogin} />

      <ActionQueue />

      {stats && (
        <section>
          <h2 className="text-sm font-bold text-gray-500 uppercase tracking-wider mb-3">
            Ambient Stats
          </h2>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
            <MetricCard label="Negotiating" value={stats.negotiating} color="orange" />
            <MetricCard label="Responses" value={stats.responseReceived} color="yellow" />
            <MetricCard label="Texted / Emailed" value={stats.textedEmailed} color="blue" />
            <MetricCard label="Dead" value={stats.dead} color="gray" />
            <MetricCard label="Auto Proceed" value={stats.autoProceed} color="teal" />
            <MetricCard label="Verified Active" value={stats.verifiedActive} color="green" />
          </div>
        </section>
      )}
    </div>
  );
}
