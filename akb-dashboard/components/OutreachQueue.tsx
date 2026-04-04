"use client";

import { useState } from "react";
import { Listing } from "@/lib/types";
import { formatCurrency, buildSMSLink } from "@/lib/utils";
import { showToast } from "@/components/Toast";

interface OutreachQueueProps {
  listings: Listing[];
}

export default function OutreachQueue({ listings }: OutreachQueueProps) {
  const [sortField, setSortField] = useState<"dom" | "listPrice" | "city">("dom");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [fadingOut, setFadingOut] = useState<Set<string>>(new Set());
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState<Set<string>>(new Set());

  const sorted = [...listings]
    .filter((l) => !removed.has(l.id))
    .sort((a, b) => {
      let aVal: number | string = 0;
      let bVal: number | string = 0;
      if (sortField === "dom") {
        aVal = a.dom ?? 0;
        bVal = b.dom ?? 0;
      } else if (sortField === "listPrice") {
        aVal = a.listPrice ?? 0;
        bVal = b.listPrice ?? 0;
      } else {
        aVal = a.city ?? "";
        bVal = b.city ?? "";
      }
      if (typeof aVal === "string") {
        return sortDir === "asc" ? aVal.localeCompare(bVal as string) : (bVal as string).localeCompare(aVal);
      }
      return sortDir === "asc" ? (aVal as number) - (bVal as number) : (bVal as number) - (aVal as number);
    });

  const toggleSort = (field: "dom" | "listPrice" | "city") => {
    if (sortField === field) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDir("desc");
    }
  };

  const fadeAndRemove = (id: string) => {
    setFadingOut((prev) => new Set(prev).add(id));
    setTimeout(() => {
      setRemoved((prev) => new Set(prev).add(id));
      setFadingOut((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }, 500);
  };

  const handleLog = async (id: string) => {
    setLoading((prev) => new Set(prev).add(id));
    try {
      const res = await fetch("/api/mark-texted", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recordId: id }),
      });
      if (!res.ok) throw new Error();
      showToast("Marked as Texted", "success");
      fadeAndRemove(id);
    } catch {
      showToast("Failed to update record");
    } finally {
      setLoading((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const handleKill = async (id: string) => {
    if (!window.confirm("Are you sure you want to mark this lead as Dead?")) return;
    setLoading((prev) => new Set(prev).add(id));
    try {
      const res = await fetch("/api/mark-dead", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recordId: id }),
      });
      if (!res.ok) throw new Error();
      showToast("Marked as Dead", "success");
      fadeAndRemove(id);
    } catch {
      showToast("Failed to update record");
    } finally {
      setLoading((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const SortIcon = ({ field }: { field: string }) => {
    if (sortField !== field) return <span className="text-gray-600 ml-1">↕</span>;
    return <span className="text-emerald-400 ml-1">{sortDir === "asc" ? "↑" : "↓"}</span>;
  };

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-[#30363d] text-gray-400 uppercase tracking-wider">
            <th className="text-left py-3 px-2">Address</th>
            <th
              className="text-left py-3 px-2 cursor-pointer hover:text-white"
              onClick={() => toggleSort("city")}
            >
              City <SortIcon field="city" />
            </th>
            <th className="text-right py-3 px-2">List Price</th>
            <th className="text-right py-3 px-2">MAO</th>
            <th
              className="text-right py-3 px-2 cursor-pointer hover:text-white"
              onClick={() => toggleSort("dom")}
            >
              DOM <SortIcon field="dom" />
            </th>
            <th className="text-center py-3 px-2">Tier</th>
            <th className="text-left py-3 px-2">Agent</th>
            <th className="text-center py-3 px-2">Actions</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((listing) => (
            <tr
              key={listing.id}
              className={`border-b border-[#30363d]/50 hover:bg-[#1c2128] transition-all duration-500 ${
                fadingOut.has(listing.id) ? "opacity-0 scale-y-0" : "opacity-100"
              }`}
            >
              <td className="py-3 px-2 text-white font-medium">{listing.address}</td>
              <td className="py-3 px-2 text-gray-300">{listing.city}</td>
              <td className="py-3 px-2 text-right text-gray-300">
                {formatCurrency(listing.listPrice)}
              </td>
              <td className="py-3 px-2 text-right text-emerald-400 font-medium">
                {formatCurrency(listing.mao)}
              </td>
              <td className="py-3 px-2 text-right text-white">{listing.dom ?? "—"}</td>
              <td className="py-3 px-2 text-center">
                {listing.offerTier && (
                  <span className="px-1.5 py-0.5 rounded text-xs font-bold bg-blue-500/20 text-blue-400">
                    {listing.offerTier}
                  </span>
                )}
              </td>
              <td className="py-3 px-2 text-gray-300">{listing.agentName || "—"}</td>
              <td className="py-3 px-2 text-center">
                <div className="flex gap-1 justify-center">
                  {listing.agentPhone && (
                    <a
                      href={buildSMSLink(
                        listing.agentPhone,
                        listing.agentName,
                        listing.address,
                        listing.city,
                        listing.mao
                      )}
                      className="inline-flex items-center justify-center bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold px-3 py-2 rounded transition-colors min-h-[44px] min-w-[44px]"
                    >
                      SMS
                    </a>
                  )}
                  <button
                    onClick={() => handleLog(listing.id)}
                    disabled={loading.has(listing.id)}
                    className="inline-flex items-center justify-center bg-green-700 hover:bg-green-600 text-white text-xs font-semibold px-3 py-2 rounded transition-colors min-h-[44px] disabled:opacity-50"
                  >
                    {loading.has(listing.id) ? "..." : "Log"}
                  </button>
                  <button
                    onClick={() => handleKill(listing.id)}
                    disabled={loading.has(listing.id)}
                    className="inline-flex items-center justify-center bg-red-700 hover:bg-red-600 text-white text-xs font-semibold px-3 py-2 rounded transition-colors min-h-[44px] disabled:opacity-50"
                  >
                    Kill
                  </button>
                  {listing.verificationUrl && (
                    <a
                      href={listing.verificationUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center justify-center bg-[#30363d] hover:bg-[#3d444d] text-gray-300 text-xs px-2 py-2 rounded transition-colors min-h-[44px]"
                    >
                      🔗
                    </a>
                  )}
                </div>
              </td>
            </tr>
          ))}
          {sorted.length === 0 && (
            <tr>
              <td colSpan={8} className="text-center py-8 text-gray-500">
                No properties ready for outreach
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
