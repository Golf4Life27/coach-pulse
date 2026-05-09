"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { Listing } from "@/lib/types";
import { showToast } from "@/components/Toast";

const DEAD_STATUSES = new Set(["Dead", "Walked", "Terminated", "No Response"]);
const REJECTED_PATHS = new Set(["Reject"]);

const COLUMNS = [
  { key: "Response Received", label: "New Response", color: "border-orange-500" },
  { key: "Negotiating", label: "Negotiating", color: "border-yellow-500" },
  { key: "Offer Accepted", label: "Offer Accepted", color: "border-emerald-500" },
  { key: "Texted", label: "Texted", color: "border-blue-500" },
  { key: "Emailed", label: "Emailed", color: "border-purple-500" },
] as const;

function daysSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return Math.floor((Date.now() - d.getTime()) / 86_400_000);
}

function lastTouch(l: Listing): string | null {
  return [l.lastInboundAt, l.lastOutboundAt, l.lastOutreachDate]
    .filter(Boolean)
    .sort()
    .pop() ?? null;
}

function formatCurrency(n: number | null): string {
  if (n == null) return "—";
  return "$" + Math.round(n).toLocaleString("en-US");
}

function staleClass(days: number | null): string {
  if (days === null) return "";
  if (days >= 4) return "border-red-500/60 bg-red-500/5";
  if (days >= 2) return "border-yellow-500/60 bg-yellow-500/5";
  return "";
}

interface CardData {
  listing: Listing;
  daysSinceTouch: number | null;
  offer: number | null;
  lastActivityLine: string;
}

function getLastLine(notes: string | null): string {
  if (!notes) return "No activity";
  const lines = notes.split("\n").filter((l) => l.trim());
  const last = lines[lines.length - 1] ?? "No activity";
  return last.slice(0, 80);
}

export default function PipelineBoard() {
  const [listings, setListings] = useState<Listing[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [killed, setKilled] = useState<Set<string>>(new Set());
  const [killing, setKilling] = useState<string | null>(null);

  const handleKill = async (recordId: string) => {
    setKilling(recordId);
    try {
      const res = await fetch("/api/actions/mark_dead", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recordId }),
      });
      if (!res.ok) { showToast("Failed to mark dead"); return; }
      setKilled((prev) => new Set(prev).add(recordId));
      showToast("Marked Dead", "success");
    } catch { showToast("Failed"); }
    finally { setKilling(null); }
  };

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch("/api/listings");
      if (!res.ok) throw new Error();
      const data: Listing[] = await res.json();
      setListings(
        data.filter(
          (l) =>
            !DEAD_STATUSES.has(l.outreachStatus ?? "") &&
            !REJECTED_PATHS.has(l.executionPath ?? "") &&
            l.actionCardState !== "Cleared" &&
            l.outreachStatus
        )
      );
    } catch {
      showToast("Failed to load pipeline");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  if (loading) {
    return (
      <div className="text-gray-500 text-sm animate-pulse py-4">
        Loading pipeline...
      </div>
    );
  }

  const columnData = COLUMNS.map((col) => {
    const cards: CardData[] = listings
      .filter((l) => l.outreachStatus === col.key && !killed.has(l.id))
      .map((l) => ({
        listing: l,
        daysSinceTouch: daysSince(lastTouch(l)),
        offer: l.listPrice ? Math.ceil((l.listPrice * 0.65) / 250) * 250 : null,
        lastActivityLine: getLastLine(l.notes),
      }))
      .sort((a, b) => (b.daysSinceTouch ?? 0) - (a.daysSinceTouch ?? 0));

    return { ...col, cards };
  });

  return (
    <section>
      <h2 className="text-sm font-bold text-gray-400 uppercase tracking-wider mb-3">
        Pipeline
      </h2>
      <div className="flex gap-3 overflow-x-auto pb-2">
        {columnData.map((col) => (
          <div
            key={col.key}
            className="min-w-[240px] max-w-[280px] flex-shrink-0"
          >
            <div className={`border-t-2 ${col.color} bg-[#161b22] rounded-lg border border-[#30363d] overflow-hidden`}>
              <div className="px-3 py-2 border-b border-[#30363d] flex justify-between items-center">
                <h3 className="text-xs font-bold text-gray-300 uppercase tracking-wider">
                  {col.label}
                </h3>
                <span className="text-[10px] text-gray-500 bg-[#0d1117] px-1.5 py-0.5 rounded">
                  {col.cards.length}
                </span>
              </div>
              <div className="p-2 space-y-2 max-h-[60vh] overflow-y-auto">
                {col.cards.length === 0 && (
                  <p className="text-xs text-gray-600 text-center py-4">Empty</p>
                )}
                {col.cards.map((card) => {
                  const isExpanded = expanded === card.listing.id;
                  const stale = staleClass(card.daysSinceTouch);

                  return (
                    <div
                      key={card.listing.id}
                      className={`bg-[#1c2128] rounded border border-[#30363d] p-2.5 cursor-pointer transition-colors hover:border-gray-500 ${stale}`}
                      onClick={() =>
                        setExpanded(isExpanded ? null : card.listing.id)
                      }
                    >
                      <div className="flex justify-between items-start mb-1">
                        <Link
                          href={`/pipeline/${card.listing.id}`}
                          className="text-xs text-white font-semibold hover:underline leading-tight"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {card.listing.address}
                        </Link>
                        {card.daysSinceTouch !== null && (
                          <span
                            className={`text-[10px] font-bold ml-1 flex-shrink-0 ${
                              card.daysSinceTouch >= 4
                                ? "text-red-400"
                                : card.daysSinceTouch >= 2
                                  ? "text-yellow-400"
                                  : "text-gray-500"
                            }`}
                          >
                            {card.daysSinceTouch}d
                          </span>
                        )}
                      </div>
                      <p className="text-[10px] text-gray-500">
                        {[card.listing.city, card.listing.state].filter(Boolean).join(", ")}
                        {card.listing.agentName ? ` · ${card.listing.agentName}` : ""}
                      </p>
                      <div className="flex justify-between mt-1 text-[10px]">
                        <span className="text-gray-500">
                          List {formatCurrency(card.listing.listPrice)}
                        </span>
                        <span className="text-emerald-400">
                          Offer {formatCurrency(card.offer)}
                        </span>
                      </div>
                      <p className="text-[10px] text-gray-500 mt-1 truncate">
                        {card.lastActivityLine}
                      </p>

                      {isExpanded && (
                        <div
                          className="mt-2 pt-2 border-t border-[#30363d] space-y-2"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {card.listing.agentPhone && (
                            <a
                              href={`tel:${card.listing.agentPhone}`}
                              className="block text-[10px] text-blue-400"
                            >
                              {card.listing.agentPhone}
                            </a>
                          )}
                          {card.listing.agentEmail && (
                            <a
                              href={`mailto:${card.listing.agentEmail}`}
                              className="block text-[10px] text-blue-400"
                            >
                              {card.listing.agentEmail}
                            </a>
                          )}
                          {card.listing.notes && (
                            <div className="max-h-[120px] overflow-y-auto">
                              <p className="text-[10px] text-gray-400 whitespace-pre-wrap leading-relaxed">
                                {card.listing.notes.slice(-500)}
                              </p>
                            </div>
                          )}
                          <div className="flex gap-1.5 pt-1">
                            <Link
                              href={`/pipeline/${card.listing.id}`}
                              className="text-[10px] bg-[#30363d] hover:bg-[#3d444d] text-gray-300 px-2 py-1 rounded"
                            >
                              Open
                            </Link>
                            <button
                              type="button"
                              onClick={() => handleKill(card.listing.id)}
                              disabled={killing === card.listing.id}
                              className="text-[10px] bg-red-900/40 hover:bg-red-900/60 text-red-300 px-2 py-1 rounded disabled:opacity-50"
                            >
                              {killing === card.listing.id ? "..." : "Kill"}
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
