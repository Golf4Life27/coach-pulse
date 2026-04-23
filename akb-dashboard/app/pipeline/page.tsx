"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import MetricCard from "@/components/MetricCard";
import {
  OutreachFunnel,
  MarketBreakdown,
  DOMDistribution,
  OfferTierBreakdown,
} from "@/components/Charts";
import FollowUpModal from "@/components/FollowUpModal";
import { Listing, DashboardStats } from "@/lib/types";
import { formatCurrency, buildSMSLink } from "@/lib/utils";
import { showToast } from "@/components/Toast";

interface FollowUpState {
  variants: Array<{ label: string; body: string }>;
  context: {
    address: string;
    list_price: number;
    our_offer: number;
    agent_first_name: string;
    days_since_contact: number;
    last_reply_excerpt: string;
  };
  agentPhone: string;
}

export default function PipelinePage() {
  const [listings, setListings] = useState<Listing[]>([]);
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);

  // Follow-up modal state
  const [followUp, setFollowUp] = useState<FollowUpState | null>(null);
  const [followUpLoading, setFollowUpLoading] = useState<string | null>(null);
  const [followUpError, setFollowUpError] = useState<{ recordId: string; message: string } | null>(null);

  // Filters
  const [cityFilter, setCityFilter] = useState("");
  const [outreachFilter, setOutreachFilter] = useState("");
  const [executionFilter, setExecutionFilter] = useState("");
  const [tierFilter, setTierFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [search, setSearch] = useState("");

  // Sort
  const [sortField, setSortField] = useState<string>("dom");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const fetchData = useCallback(async () => {
    try {
      const [listingsRes, statsRes] = await Promise.all([
        fetch("/api/listings"),
        fetch("/api/stats"),
      ]);
      if (!listingsRes.ok || !statsRes.ok) throw new Error("API error");
      const [listingsData, statsData] = await Promise.all([
        listingsRes.json(),
        statsRes.json(),
      ]);
      setListings(listingsData);
      setStats(statsData);
    } catch {
      showToast("Failed to fetch pipeline data.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleDraftFollowUp = useCallback(async (listing: Listing) => {
    setFollowUpLoading(listing.id);
    setFollowUpError(null);
    try {
      const res = await fetch("/api/claude/draft-followup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recordId: listing.id }),
      });
      const data = await res.json();
      if (!res.ok) {
        setFollowUpError({ recordId: listing.id, message: data.error || `Error ${res.status}` });
        return;
      }
      setFollowUp({
        variants: data.variants,
        context: data.context,
        agentPhone: listing.agentPhone || "",
      });
    } catch {
      setFollowUpError({ recordId: listing.id, message: "Network error" });
    } finally {
      setFollowUpLoading(null);
    }
  }, []);

  const cities = useMemo(
    () => [...new Set(listings.map((l) => l.city).filter(Boolean))].sort(),
    [listings]
  );

  const filtered = useMemo(() => {
    let result = listings;
    if (cityFilter) result = result.filter((l) => l.city === cityFilter);
    if (outreachFilter)
      result = result.filter((l) => (l.outreachStatus || "Not Contacted") === outreachFilter);
    if (executionFilter)
      result = result.filter((l) => l.executionPath === executionFilter);
    if (tierFilter)
      result = result.filter((l) => l.offerTier === tierFilter);
    if (statusFilter)
      result = result.filter((l) => l.liveStatus === statusFilter);
    if (search) {
      const q = search.toLowerCase();
      result = result.filter(
        (l) =>
          l.address?.toLowerCase().includes(q) ||
          l.agentName?.toLowerCase().includes(q)
      );
    }

    result.sort((a, b) => {
      let aVal: string | number = 0;
      let bVal: string | number = 0;

      switch (sortField) {
        case "dom":
          aVal = a.dom ?? 0;
          bVal = b.dom ?? 0;
          break;
        case "listPrice":
          aVal = a.listPrice ?? 0;
          bVal = b.listPrice ?? 0;
          break;
        case "address":
          aVal = a.address ?? "";
          bVal = b.address ?? "";
          break;
        case "city":
          aVal = a.city ?? "";
          bVal = b.city ?? "";
          break;
        default:
          aVal = a.dom ?? 0;
          bVal = b.dom ?? 0;
      }

      if (typeof aVal === "string") {
        return sortDir === "asc"
          ? aVal.localeCompare(bVal as string)
          : (bVal as string).localeCompare(aVal);
      }
      return sortDir === "asc"
        ? (aVal as number) - (bVal as number)
        : (bVal as number) - (aVal as number);
    });

    return result;
  }, [listings, cityFilter, outreachFilter, executionFilter, tierFilter, statusFilter, search, sortField, sortDir]);

  const toggleSort = (field: string) => {
    if (sortField === field) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDir("desc");
    }
  };

  const SortIcon = ({ field }: { field: string }) => {
    if (sortField !== field)
      return <span className="text-gray-600 ml-1">↕</span>;
    return (
      <span className="text-emerald-400 ml-1">
        {sortDir === "asc" ? "↑" : "↓"}
      </span>
    );
  };

  const selectClass =
    "bg-[#0d1117] border border-[#30363d] text-gray-300 text-xs rounded px-2 py-1.5 focus:outline-none focus:border-emerald-500";

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-gray-400 animate-pulse">Loading pipeline...</div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold text-white">PIPELINE</h1>

      {/* Metric Cards */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <MetricCard label="Total Records" value={stats.totalRecords} color="gray" />
          <MetricCard label="Verified Active" value={stats.verifiedActive} color="green" />
          <MetricCard label="Auto Proceed" value={stats.autoProceed} color="teal" />
          <MetricCard label="Manual Review" value={stats.manualReview} color="yellow" />
          <MetricCard label="Rejected" value={stats.rejected} color="red" />
        </div>
      )}

      {/* Charts */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <OutreachFunnel listings={listings} />
        <MarketBreakdown listings={listings} />
        <DOMDistribution listings={listings} />
        <OfferTierBreakdown listings={listings} />
      </div>

      {/* Filters */}
      <div className="bg-[#161b22] rounded-lg border border-[#30363d] p-4">
        <div className="flex flex-wrap gap-3 mb-4">
          <input
            type="text"
            placeholder="Search address or agent..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="bg-[#0d1117] border border-[#30363d] text-gray-300 text-xs rounded px-3 py-1.5 focus:outline-none focus:border-emerald-500 w-full md:w-48"
          />
          <select
            value={cityFilter}
            onChange={(e) => setCityFilter(e.target.value)}
            className={selectClass}
          >
            <option value="">All Cities</option>
            {cities.map((c) => (
              <option key={c} value={c!}>{c}</option>
            ))}
          </select>
          <select
            value={outreachFilter}
            onChange={(e) => setOutreachFilter(e.target.value)}
            className={selectClass}
          >
            <option value="">All Outreach</option>
            <option value="Not Contacted">Not Contacted</option>
            <option value="Texted">Texted</option>
            <option value="Emailed">Emailed</option>
            <option value="Response Received">Response Received</option>
            <option value="Negotiating">Negotiating</option>
            <option value="Dead">Dead</option>
          </select>
          <select
            value={executionFilter}
            onChange={(e) => setExecutionFilter(e.target.value)}
            className={selectClass}
          >
            <option value="">All Paths</option>
            <option value="Auto Proceed">Auto Proceed</option>
            <option value="Manual Review">Manual Review</option>
            <option value="Reject">Reject</option>
          </select>
          <select
            value={tierFilter}
            onChange={(e) => setTierFilter(e.target.value)}
            className={selectClass}
          >
            <option value="">All Tiers</option>
            <option value="A">Tier A</option>
            <option value="B">Tier B</option>
            <option value="C">Tier C</option>
            <option value="D">Tier D</option>
          </select>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className={selectClass}
          >
            <option value="">All Status</option>
            <option value="Active">Active</option>
            <option value="Off Market">Off Market</option>
            <option value="Pending">Pending</option>
            <option value="Under Contract">Under Contract</option>
            <option value="Sold">Sold</option>
            <option value="URL Not Found">URL Not Found</option>
          </select>
        </div>

        <div className="text-xs text-gray-500 mb-3">
          Showing {filtered.length} of {listings.length} records
        </div>

        {/* Table */}
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-[#30363d] text-gray-400 uppercase tracking-wider">
                <th
                  className="text-left py-3 px-2 cursor-pointer hover:text-white"
                  onClick={() => toggleSort("address")}
                >
                  Address <SortIcon field="address" />
                </th>
                <th
                  className="text-left py-3 px-2 cursor-pointer hover:text-white"
                  onClick={() => toggleSort("city")}
                >
                  City <SortIcon field="city" />
                </th>
                <th
                  className="text-right py-3 px-2 cursor-pointer hover:text-white"
                  onClick={() => toggleSort("listPrice")}
                >
                  List Price <SortIcon field="listPrice" />
                </th>
                <th className="text-right py-3 px-2">MAO</th>
                <th
                  className="text-right py-3 px-2 cursor-pointer hover:text-white"
                  onClick={() => toggleSort("dom")}
                >
                  DOM <SortIcon field="dom" />
                </th>
                <th className="text-center py-3 px-2">Tier</th>
                <th className="text-center py-3 px-2">Status</th>
                <th className="text-center py-3 px-2">Path</th>
                <th className="text-center py-3 px-2">Outreach</th>
                <th className="text-left py-3 px-2">Agent</th>
                <th className="text-center py-3 px-2">Link</th>
              </tr>
            </thead>
            <tbody>
              {filtered.slice(0, 200).map((l) => (
                <tr
                  key={l.id}
                  className="border-b border-[#30363d]/50 hover:bg-[#1c2128] transition-colors"
                >
                  <td className="py-2 px-2 text-white font-medium max-w-[200px] truncate">
                    {l.address}
                  </td>
                  <td className="py-2 px-2 text-gray-300">{l.city}</td>
                  <td className="py-2 px-2 text-right text-gray-300">
                    {formatCurrency(l.listPrice)}
                  </td>
                  <td className="py-2 px-2 text-right text-emerald-400">
                    {formatCurrency(l.mao)}
                  </td>
                  <td className="py-2 px-2 text-right text-white">{l.dom ?? "—"}</td>
                  <td className="py-2 px-2 text-center">
                    {l.offerTier && (
                      <span className="px-1.5 py-0.5 rounded text-xs font-bold bg-blue-500/20 text-blue-400">
                        {l.offerTier}
                      </span>
                    )}
                  </td>
                  <td className="py-2 px-2 text-center">
                    <StatusBadge value={l.liveStatus} />
                  </td>
                  <td className="py-2 px-2 text-center">
                    <PathBadge value={l.executionPath} />
                  </td>
                  <td className="py-2 px-2 text-center">
                    <OutreachBadge value={l.outreachStatus} />
                  </td>
                  <td className="py-2 px-2 text-gray-300 max-w-[120px] truncate">
                    {l.agentName || "—"}
                  </td>
                  <td className="py-2 px-2 text-center">
                    <div className="flex gap-1 justify-center items-center">
                      {(l.outreachStatus === "Negotiating" || l.outreachStatus === "Offer Accepted") && (
                        <>
                          <button
                            onClick={() => handleDraftFollowUp(l)}
                            disabled={followUpLoading === l.id}
                            className="bg-purple-600 hover:bg-purple-500 text-white text-xs font-semibold px-2 py-2 rounded transition-colors min-h-[44px] disabled:opacity-50 whitespace-nowrap"
                          >
                            {followUpLoading === l.id ? "..." : "Draft"}
                          </button>
                          {followUpError?.recordId === l.id && (
                            <span className="text-red-400 text-xs max-w-[80px] truncate" title={followUpError.message}>
                              {followUpError.message}
                            </span>
                          )}
                        </>
                      )}
                      {l.agentPhone && (
                        <a
                          href={buildSMSLink(l.agentPhone, l.agentName, l.address, l.city, l.mao)}
                          className="text-emerald-400 hover:text-emerald-300 min-w-[44px] min-h-[44px] inline-flex items-center justify-center"
                        >
                          SMS
                        </a>
                      )}
                      {l.verificationUrl && (
                        <a
                          href={l.verificationUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-400 hover:text-blue-300"
                        >
                          🔗
                        </a>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {filtered.length > 200 && (
            <div className="text-center py-3 text-xs text-gray-500">
              Showing first 200 of {filtered.length} results
            </div>
          )}
        </div>
      </div>

      {/* Follow-up Modal */}
      {followUp && (
        <FollowUpModal
          variants={followUp.variants}
          context={followUp.context}
          agentPhone={followUp.agentPhone}
          onClose={() => setFollowUp(null)}
        />
      )}
    </div>
  );
}

function StatusBadge({ value }: { value: string | null }) {
  if (!value) return <span className="text-gray-600">—</span>;
  const colors: Record<string, string> = {
    Active: "bg-green-500/20 text-green-400",
    "Off Market": "bg-gray-500/20 text-gray-400",
    Pending: "bg-yellow-500/20 text-yellow-400",
    "Under Contract": "bg-blue-500/20 text-blue-400",
    Sold: "bg-purple-500/20 text-purple-400",
    "URL Not Found": "bg-red-500/20 text-red-400",
  };
  return (
    <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${colors[value] || "bg-gray-500/20 text-gray-400"}`}>
      {value}
    </span>
  );
}

function PathBadge({ value }: { value: string | null }) {
  if (!value) return <span className="text-gray-600">—</span>;
  const colors: Record<string, string> = {
    "Auto Proceed": "bg-teal-500/20 text-teal-400",
    "Manual Review": "bg-yellow-500/20 text-yellow-400",
    Reject: "bg-red-500/20 text-red-400",
  };
  return (
    <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${colors[value] || "bg-gray-500/20 text-gray-400"}`}>
      {value}
    </span>
  );
}

function OutreachBadge({ value }: { value: string | null }) {
  const display = value || "Not Contacted";
  const colors: Record<string, string> = {
    Negotiating: "bg-orange-500/20 text-orange-400",
    "Response Received": "bg-yellow-500/20 text-yellow-400",
    Texted: "bg-blue-500/20 text-blue-400",
    Emailed: "bg-blue-500/20 text-blue-400",
    Dead: "bg-gray-500/20 text-gray-400",
    "Not Contacted": "bg-gray-500/10 text-gray-500",
  };
  return (
    <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${colors[display] || "bg-gray-500/20 text-gray-400"}`}>
      {display}
    </span>
  );
}
