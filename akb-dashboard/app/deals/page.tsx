"use client";

import { useState, useEffect, useCallback } from "react";
import DealCard from "@/components/DealCard";
import { Deal, Buyer } from "@/lib/types";
import { showToast } from "@/components/Toast";

export default function DealsPage() {
  const [deals, setDeals] = useState<Deal[]>([]);
  const [buyers, setBuyers] = useState<Buyer[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    try {
      const [dealsRes, buyersRes] = await Promise.all([
        fetch("/api/deals"),
        fetch("/api/buyers"),
      ]);
      if (!dealsRes.ok || !buyersRes.ok) throw new Error("API error");
      const [dealsData, buyersData] = await Promise.all([
        dealsRes.json(),
        buyersRes.json(),
      ]);
      setDeals(dealsData);
      setBuyers(buyersData);
    } catch {
      showToast("Failed to fetch deals data.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-gray-400 animate-pulse">Loading deals...</div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <h1 className="text-xl font-bold text-white">DEALS & CLOSING</h1>

      {/* Active Deals */}
      <section>
        <h2 className="text-sm font-bold text-gray-400 uppercase tracking-wider mb-3">
          Active Deals ({deals.length})
        </h2>
        {deals.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {deals.map((deal) => (
              <DealCard key={deal.id} deal={deal} />
            ))}
          </div>
        ) : (
          <div className="bg-[#1c2128] rounded-lg border border-[#30363d] p-8 text-center text-gray-500">
            No deals yet. Keep blitzing!
          </div>
        )}
      </section>

      {/* Buyer List */}
      <section>
        <h2 className="text-sm font-bold text-gray-400 uppercase tracking-wider mb-3">
          Buyer List ({buyers.length})
        </h2>
        <div className="bg-[#161b22] rounded-lg border border-[#30363d] overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-[#30363d] text-gray-400 uppercase tracking-wider">
                  <th className="text-left py-3 px-3">Name</th>
                  <th className="text-left py-3 px-3">Email</th>
                  <th className="text-left py-3 px-3">Preferred Cities</th>
                  <th className="text-center py-3 px-3">Cash Buyer</th>
                  <th className="text-center py-3 px-3">POF on File</th>
                  <th className="text-center py-3 px-3">Active</th>
                  <th className="text-center py-3 px-3">Status</th>
                </tr>
              </thead>
              <tbody>
                {buyers.map((b) => (
                  <tr
                    key={b.id}
                    className="border-b border-[#30363d]/50 hover:bg-[#1c2128] transition-colors"
                  >
                    <td className="py-3 px-3 text-white font-medium">{b.buyerName}</td>
                    <td className="py-3 px-3">
                      {b.buyerEmail ? (
                        <a
                          href={`mailto:${b.buyerEmail}`}
                          className="text-blue-400 hover:text-blue-300"
                        >
                          {b.buyerEmail}
                        </a>
                      ) : (
                        <span className="text-gray-600">—</span>
                      )}
                    </td>
                    <td className="py-3 px-3 text-gray-300 max-w-[200px] truncate">
                      {b.preferredCities || "—"}
                    </td>
                    <td className="py-3 px-3 text-center">
                      {b.cashBuyer ? (
                        <span className="text-emerald-400 font-bold">Y</span>
                      ) : (
                        <span className="text-gray-600">N</span>
                      )}
                    </td>
                    <td className="py-3 px-3 text-center">
                      {b.proofOfFundsOnFile ? (
                        <span className="text-emerald-400 font-bold">Y</span>
                      ) : (
                        <span className="text-gray-600">N</span>
                      )}
                    </td>
                    <td className="py-3 px-3 text-center">
                      {b.buyerActiveFlag ? (
                        <span className="text-emerald-400 font-bold">Y</span>
                      ) : (
                        <span className="text-gray-600">N</span>
                      )}
                    </td>
                    <td className="py-3 px-3 text-center">
                      {b.buyerStatus && (
                        <span className="px-1.5 py-0.5 rounded text-xs font-medium bg-blue-500/20 text-blue-400">
                          {b.buyerStatus}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
                {buyers.length === 0 && (
                  <tr>
                    <td colSpan={7} className="text-center py-8 text-gray-500">
                      No buyers in the system yet
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </div>
  );
}
