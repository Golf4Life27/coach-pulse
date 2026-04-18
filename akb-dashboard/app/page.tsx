"use client";

import { useState, useEffect, useCallback } from "react";
import MetricCard from "@/components/MetricCard";
import NegotiationCard from "@/components/NegotiationCard";
import OutreachQueue from "@/components/OutreachQueue";
import { Listing, DashboardStats } from "@/lib/types";
import { showToast } from "@/components/Toast";

export default function ActNowPage() {
  const [listings, setListings] = useState<Listing[]>([]);
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const [listingsRes, statsRes] = await Promise.all([
        fetch("/api/listings"),
        fetch("/api/stats"),
      ]);

      if (!listingsRes.ok || !statsRes.ok) {
        throw new Error("API error");
      }

      const [listingsData, statsData] = await Promise.all([
        listingsRes.json(),
        statsRes.json(),
      ]);

      setListings(listingsData);
      setStats(statsData);
      setLastUpdated(new Date());
    } catch {
      showToast("Failed to fetch data. Showing last known data.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 60000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const negotiations = listings.filter(
    (l) => l.outreachStatus === "Negotiating"
  );

  const outreachQueue = listings.filter(
    (l) =>
      l.liveStatus === "Active" &&
      !l.outreachStatus &&
      l.executionPath === "Auto Proceed" &&
      l.approvedForOutreach !== 1
  );

  const onDeckH2Count = listings.filter(
    (l) => l.approvedForOutreach === 1 && !l.outreachStatus
  ).length;

  const todayISO = new Date().toISOString().split("T")[0];
  const textedTodayCount = listings.filter(
    (l) =>
      l.outreachStatus === "Texted" &&
      typeof l.lastOutreachDate === "string" &&
      l.lastOutreachDate.startsWith(todayISO)
  ).length;

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-gray-400 animate-pulse">Loading pipeline...</div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-white">ACT NOW</h1>
        <div className="flex items-center gap-3">
          {lastUpdated && (
            <span className="text-xs text-gray-500">
              Updated {lastUpdated.toLocaleTimeString()}
            </span>
          )}
          <button
            onClick={fetchData}
            className="text-xs bg-[#1c2128] border border-[#30363d] text-gray-300 px-3 py-1.5 rounded hover:bg-[#30363d] transition-colors"
          >
            Refresh
          </button>
        </div>
      </div>

      {/* Metric Cards */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          <MetricCard label="Negotiating" value={stats.negotiating} color="orange" />
          <MetricCard label="Responses" value={stats.responseReceived} color="yellow" />
          <MetricCard label="Texted / Emailed" value={stats.textedEmailed} color="blue" />
          <MetricCard label="Dead" value={stats.dead} color="gray" />
          <MetricCard label="On Deck for H2" value={onDeckH2Count} color="teal" />
          <MetricCard label="Texted Today" value={textedTodayCount} color="green" />
        </div>
      )}

      {/* Active Negotiations */}
      <section>
        <h2 className="text-sm font-bold text-gray-400 uppercase tracking-wider mb-3">
          Active Negotiations ({negotiations.length})
        </h2>
        {negotiations.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {negotiations.map((listing) => (
              <NegotiationCard key={listing.id} listing={listing} />
            ))}
          </div>
        ) : (
          <div className="bg-[#1c2128] rounded-lg border border-[#30363d] p-8 text-center text-gray-500">
            No active negotiations. Time to blitz!
          </div>
        )}
      </section>

      {/* Outreach Queue */}
      <section>
        <h2 className="text-sm font-bold text-gray-400 uppercase tracking-wider mb-3">
          Outreach Queue — Ready to Blitz ({outreachQueue.length})
        </h2>
        <div className="bg-[#161b22] rounded-lg border border-[#30363d] overflow-hidden">
          <OutreachQueue listings={outreachQueue} />
        </div>
      </section>
    </div>
  );
}
