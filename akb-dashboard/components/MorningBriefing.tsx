"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { showToast } from "@/components/Toast";

interface BriefingItem {
  recordId: string;
  address: string;
  city: string | null;
  state: string | null;
  agentName: string | null;
  agentPhone: string | null;
  listPrice: number | null;
  offer: number | null;
  outreachStatus: string | null;
  daysSinceTouch: number | null;
  lastActivity: string;
}

interface MorningBriefingData {
  signNow: BriefingItem[];
  respondToday: BriefingItem[];
  counterDecisions: BriefingItem[];
  followUp: BriefingItem[];
  stale: BriefingItem[];
  stats: {
    totalActive: number;
    negotiating: number;
    responseReceived: number;
    offerAccepted: number;
    texted: number;
    dead: number;
  };
}

function formatCurrency(n: number | null): string {
  if (n == null) return "—";
  return "$" + Math.round(n).toLocaleString("en-US");
}

const PREVIEW_LIMIT = 5;

interface SectionProps {
  title: string;
  icon: string;
  color: string;
  items: BriefingItem[];
}

function BriefingSection({ title, icon, color, items }: SectionProps) {
  const [expanded, setExpanded] = useState(false);
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
      if (!res.ok) {
        showToast("Failed to mark dead");
        return;
      }
      setKilled((prev) => new Set(prev).add(recordId));
      showToast("Marked Dead", "success");
    } catch {
      showToast("Failed");
    } finally {
      setKilling(null);
    }
  };

  if (items.length === 0) return null;

  const liveItems = items.filter((i) => !killed.has(i.recordId));
  const visible = expanded ? liveItems : liveItems.slice(0, PREVIEW_LIMIT);
  const hasMore = liveItems.length > PREVIEW_LIMIT;

  return (
    <div className="space-y-2">
      <h3 className={`text-xs font-bold uppercase tracking-wider ${color}`}>
        {icon} {title} ({liveItems.length})
      </h3>
      <div className="space-y-1.5">
        {visible.map((item) => {
          const loc = [item.city, item.state].filter(Boolean).join(", ");
          return (
            <Link
              key={item.recordId}
              href={`/pipeline/${item.recordId}`}
              className="bg-[#1c2128] rounded border border-[#30363d] p-2.5 flex items-center justify-between gap-3 cursor-pointer hover:border-gray-500 transition-colors block"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-white font-semibold truncate">
                    {item.address}{loc ? `, ${loc}` : ""}
                  </span>
                  {item.daysSinceTouch !== null && (
                    <span
                      className={`text-[10px] font-bold flex-shrink-0 ${
                        item.daysSinceTouch >= 4
                          ? "text-red-400"
                          : item.daysSinceTouch >= 2
                            ? "text-yellow-400"
                            : "text-gray-500"
                      }`}
                    >
                      {item.daysSinceTouch}d
                    </span>
                  )}
                </div>
                <p className="text-[10px] text-gray-500 truncate mt-0.5">
                  {item.agentName ?? "—"} · {formatCurrency(item.listPrice)} → {formatCurrency(item.offer)} · {item.lastActivity}
                </p>
              </div>
              <div className="flex gap-1.5 flex-shrink-0" onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}>
                {item.agentPhone && (
                  <a
                    href={`tel:${item.agentPhone}`}
                    className="text-[10px] text-blue-400 hover:text-blue-300"
                    onClick={(e) => e.stopPropagation()}
                  >
                    Call
                  </a>
                )}
                <button
                  type="button"
                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); handleKill(item.recordId); }}
                  disabled={killing === item.recordId}
                  className="text-[10px] bg-red-900/40 hover:bg-red-900/60 text-red-300 px-2 py-1 rounded disabled:opacity-50"
                >
                  {killing === item.recordId ? "..." : "Kill"}
                </button>
              </div>
            </Link>
          );
        })}
      </div>
      {hasMore && (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="text-[10px] text-gray-500 hover:text-gray-300 transition-colors"
        >
          {expanded ? "Show less" : `Show all (${liveItems.length})`}
        </button>
      )}
    </div>
  );
}

export default function MorningBriefing() {
  const [data, setData] = useState<MorningBriefingData | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchBriefing = useCallback(async () => {
    try {
      const res = await fetch("/api/morning-briefing");
      if (!res.ok) throw new Error();
      setData(await res.json());
    } catch {
      showToast("Failed to load briefing");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchBriefing();
  }, [fetchBriefing]);

  if (loading) {
    return (
      <div className="bg-[#1c2128] rounded-lg border border-[#30363d] p-4 text-gray-500 text-sm animate-pulse">
        Scanning pipeline...
      </div>
    );
  }

  if (!data) return null;

  const totalActions =
    data.signNow.length +
    data.respondToday.length +
    data.counterDecisions.length +
    data.followUp.length +
    data.stale.length;

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-bold text-gray-400 uppercase tracking-wider">
          Morning Briefing
          {totalActions > 0 && (
            <span className="ml-2 text-white bg-orange-500/20 text-orange-400 px-1.5 py-0.5 rounded text-[10px]">
              {totalActions} actions
            </span>
          )}
        </h2>
        <div className="flex gap-2 text-[10px] text-gray-500">
          <span>{data.stats.negotiating} negotiating</span>
          <span>·</span>
          <span>{data.stats.responseReceived} responses</span>
          <span>·</span>
          <span>{data.stats.offerAccepted} accepted</span>
          <span>·</span>
          <span>{data.stats.texted} texted</span>
        </div>
      </div>

      {totalActions === 0 && (
        <div className="bg-[#1c2128] rounded-lg border border-[#30363d] p-6 text-center text-gray-500 text-sm">
          Pipeline is clean — no immediate actions needed.
        </div>
      )}

      <BriefingSection
        title="SIGN NOW"
        icon="🔥"
        color="text-red-400"
        items={data.signNow}
      />
      <BriefingSection
        title="RESPOND TODAY"
        icon="💬"
        color="text-orange-400"
        items={data.respondToday}
      />
      <BriefingSection
        title="COUNTER DECISIONS"
        icon="⚖️"
        color="text-yellow-400"
        items={data.counterDecisions}
      />
      <BriefingSection
        title="FOLLOW UP"
        icon="📩"
        color="text-blue-400"
        items={data.followUp}
      />
      <BriefingSection
        title="STALE"
        icon="⏰"
        color="text-gray-400"
        items={data.stale}
      />
    </section>
  );
}
