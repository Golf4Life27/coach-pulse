"use client";

import { useState } from "react";
import { ProspectiveBuyer } from "@/lib/types";
import { showToast } from "@/components/Toast";

interface BuyerOutreachQueueProps {
  buyers: ProspectiveBuyer[];
}

const COMPANY_KEYWORDS = ["llc", "inc", "trust", "corp", "corporation", "company", "ltd", "lp", "partners", "holdings", "group", "enterprises", "properties", "investments", "capital", "realty", "real estate"];

function getGreetingName(buyer: ProspectiveBuyer): string {
  const name = buyer.fullName || "";
  const lower = name.toLowerCase();
  const looksLikeCompany = COMPANY_KEYWORDS.some((kw) => lower.includes(kw));
  if (looksLikeCompany) {
    return buyer.company || name;
  }
  return name.split(" ")[0] || buyer.company || "there";
}

function buildMailtoLink(buyer: ProspectiveBuyer): string {
  if (!buyer.email) return "#";

  const greeting = getGreetingName(buyer);
  const property = buyer.propertyPurchased || "a property";

  const subject = "Cash Deal — SA 78207 — 3/2 SFR — $105K — ARV $185K";

  const body = `Hi ${greeting},

I noticed you purchased ${property} in San Antonio. I'm a local wholesaler and I have a deal in your area you might be interested in.

Property: 3 Bed / 2 Bath / 1,100 sqft — SFR
Location: San Antonio, TX 78207
Price: $105,000
ARV: $176K-$194K
Est. Rehab: ~$15K
Est. Profit: $65K+
Terms: Cash, as-is, quick close
Closing: April 13, 2026

Reply to this email if you'd like the address and full details.

Alex Balog
AKB Solutions LLC
alex@akb-properties.com`;

  return `mailto:${encodeURIComponent(buyer.email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

function cleanPhone(phone: string): string {
  return phone.replace(/[^+\d]/g, "");
}

export default function BuyerOutreachQueue({ buyers }: BuyerOutreachQueueProps) {
  const [fadingOut, setFadingOut] = useState<Set<string>>(new Set());
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState<Set<string>>(new Set());

  const visible = buyers.filter((b) => !removed.has(b.id));

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
      const res = await fetch("/api/mark-buyer-emailed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recordId: id }),
      });
      if (!res.ok) throw new Error();
      showToast("Marked as Emailed", "success");
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
    if (!window.confirm("Mark this buyer as Not Interested?")) return;
    setLoading((prev) => new Set(prev).add(id));
    try {
      const res = await fetch("/api/kill-buyer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recordId: id }),
      });
      if (!res.ok) throw new Error();
      showToast("Marked as Not Interested", "success");
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

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-[#30363d] text-gray-400 uppercase tracking-wider">
            <th className="text-left py-3 px-2">Name</th>
            <th className="text-left py-3 px-2">Company</th>
            <th className="text-left py-3 px-2">Email</th>
            <th className="text-left py-3 px-2">Phone</th>
            <th className="text-left py-3 px-2">Property Purchased</th>
            <th className="text-left py-3 px-2">ZIP</th>
            <th className="text-center py-3 px-2">Actions</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((buyer) => (
            <tr
              key={buyer.id}
              className={`border-b border-[#30363d]/50 hover:bg-[#1c2128] transition-all duration-500 ${
                fadingOut.has(buyer.id) ? "opacity-0 scale-y-0" : "opacity-100"
              }`}
            >
              <td className="py-3 px-2 text-white font-medium">
                {buyer.fullName || "—"}
              </td>
              <td className="py-3 px-2 text-gray-400">
                {buyer.company || "—"}
              </td>
              <td className="py-3 px-2">
                {buyer.email ? (
                  <a
                    href={`mailto:${buyer.email}`}
                    className="text-blue-400 hover:text-blue-300"
                  >
                    {buyer.email}
                  </a>
                ) : (
                  <span className="text-gray-600">—</span>
                )}
              </td>
              <td className="py-3 px-2">
                {buyer.phone ? (
                  <a
                    href={`tel:${cleanPhone(buyer.phone)}`}
                    className="text-blue-400 hover:text-blue-300"
                  >
                    {buyer.phone}
                  </a>
                ) : (
                  <span className="text-gray-600">—</span>
                )}
              </td>
              <td className="py-3 px-2 text-gray-300 max-w-[200px] truncate">
                {buyer.propertyPurchased || "—"}
              </td>
              <td className="py-3 px-2 text-gray-300">{buyer.zip || "—"}</td>
              <td className="py-3 px-2 text-center">
                <div className="flex gap-1 justify-center">
                  {buyer.email && (
                    <a
                      href={buildMailtoLink(buyer)}
                      className="inline-flex items-center justify-center bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold px-3 py-2 rounded transition-colors min-h-[44px] min-w-[44px]"
                    >
                      Email
                    </a>
                  )}
                  <button
                    onClick={() => handleLog(buyer.id)}
                    disabled={loading.has(buyer.id)}
                    className="inline-flex items-center justify-center bg-green-700 hover:bg-green-600 text-white text-xs font-semibold px-3 py-2 rounded transition-colors min-h-[44px] disabled:opacity-50"
                  >
                    {loading.has(buyer.id) ? "..." : "Log"}
                  </button>
                  <button
                    onClick={() => handleKill(buyer.id)}
                    disabled={loading.has(buyer.id)}
                    className="inline-flex items-center justify-center bg-red-700 hover:bg-red-600 text-white text-xs font-semibold px-3 py-2 rounded transition-colors min-h-[44px] disabled:opacity-50"
                  >
                    Kill
                  </button>
                </div>
              </td>
            </tr>
          ))}
          {visible.length === 0 && (
            <tr>
              <td colSpan={7} className="text-center py-8 text-gray-500">
                No buyers to contact — queue is clear
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
