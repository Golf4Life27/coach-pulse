"use client";

import { useState, useEffect, useCallback } from "react";
import MetricCard from "@/components/MetricCard";
import BuyerOutreachQueue from "@/components/BuyerOutreachQueue";
import { ProspectiveBuyer } from "@/lib/types";
import { showToast } from "@/components/Toast";

export default function BuyersPage() {
  const [buyers, setBuyers] = useState<ProspectiveBuyer[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch("/api/prospective-buyers");
      if (!res.ok) throw new Error("API error");
      const data = await res.json();
      setBuyers(data);
      setLastUpdated(new Date());
    } catch {
      showToast("Failed to fetch buyer data.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 60000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const total = buyers.length;
  const notContacted = buyers.filter(
    (b) => !b.outreachStatus || b.outreachStatus === "Not Contacted"
  ).length;
  const emailed = buyers.filter((b) => b.outreachStatus === "Emailed").length;
  const responded = buyers.filter(
    (b) => b.outreachStatus === "Responded" || b.outreachStatus === "Interested"
  ).length;

  const queue = buyers.filter(
    (b) => !b.outreachStatus || b.outreachStatus === "Not Contacted"
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-gray-400 animate-pulse">Loading buyers...</div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-white">BUYERS</h1>
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
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <MetricCard label="Total Prospects" value={total} color="gray" />
        <MetricCard label="Not Contacted" value={notContacted} color="blue" />
        <MetricCard label="Emailed" value={emailed} color="teal" />
        <MetricCard label="Responded" value={responded} color="green" />
      </div>

      {/* Buyer Outreach Queue */}
      <section>
        <h2 className="text-sm font-bold text-gray-400 uppercase tracking-wider mb-3">
          Buyer Outreach Queue ({queue.length})
        </h2>
        <div className="bg-[#161b22] rounded-lg border border-[#30363d] overflow-hidden">
          <BuyerOutreachQueue buyers={queue} />
        </div>
      </section>
    </div>
  );
}
