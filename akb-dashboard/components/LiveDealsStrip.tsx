"use client";

// LIVE DEALS — the operator's active money, always visible above the
// conveyor (operator 2026-07-12). Every record in a negotiation status, any
// era, with its sourced numbers and a ball-in-court signal. This is the
// surface that stopped the 3123 Sunbeam class of deal from being invisible:
// an email-worked legacy deal heading to contract now shows here with its
// price, ceiling, and "your move" flag, ranked to the top when it needs you.
//
// Sourced numbers only — a dollar figure renders only when its field is set.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { RankedLiveDeal } from "@/lib/live-deals";

interface Payload {
  total: number;
  needs_you: number;
  deals: RankedLiveDeal[];
}

const STATUS_STYLE: Record<string, string> = {
  "Offer Accepted": "bg-emerald-950/60 text-emerald-300 border-emerald-500/40",
  "Counter Received": "bg-amber-950/60 text-amber-300 border-amber-500/40",
  "Response Received": "bg-sky-950/60 text-sky-300 border-sky-500/40",
  Negotiating: "bg-violet-950/60 text-violet-300 border-violet-500/40",
};

function usd(n: number | null): string | null {
  return n == null ? null : `$${Math.round(n).toLocaleString("en-US")}`;
}

function ago(iso: string | null, nowMs: number): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  const m = Math.max(0, Math.round((nowMs - t) / 60_000));
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export default function LiveDealsStrip() {
  const [data, setData] = useState<Payload | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/live-deals", { cache: "no-store" });
      if (!res.ok) return;
      setData((await res.json()) as Payload);
      setNowMs(Date.now());
    } catch {
      /* fail silent — the conveyor + header carry the rest */
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 120_000);
    const clock = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => {
      clearInterval(t);
      clearInterval(clock);
    };
  }, [load]);

  // Nothing live → render nothing. The 🎯 header still carries the count.
  if (!data || data.deals.length === 0) return null;

  return (
    <section className="space-y-2">
      <h2 className="text-sm font-bold text-white tracking-wide">
        LIVE DEALS <span className="text-gray-500 font-normal">({data.total}</span>
        {data.needs_you > 0 && (
          <span className="text-emerald-400 font-normal"> · {data.needs_you} your move</span>
        )}
        <span className="text-gray-500 font-normal">)</span>
      </h2>

      <div className="space-y-2">
        {data.deals.map((d) => {
          const price = usd(d.contractPrice);
          const list = usd(d.listPrice);
          const headroom = d.headroom;
          return (
            <Link
              key={d.id}
              href={d.href}
              className={`flex items-center gap-3 rounded-xl border bg-[#0d1117] px-4 py-3 min-h-[56px] transition-colors hover:bg-[#161b22] ${
                d.needsYou ? "border-l-2 border-l-emerald-500 border-y-[#30363d] border-r-[#30363d]" : "border-[#30363d]"
              }`}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span
                    className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${
                      STATUS_STYLE[d.status] ?? "bg-gray-800 text-gray-300 border-gray-600"
                    }`}
                  >
                    {d.status}
                  </span>
                  <span className="text-sm font-semibold text-white truncate">{d.street}</span>
                  {d.legacy && (
                    <span
                      className="text-[9px] text-gray-500 uppercase tracking-wide"
                      title="Pre-v2 record — shown here because an active negotiation is current-era work, never hidden by the forward ruling."
                    >
                      legacy
                    </span>
                  )}
                </div>
                <div className="mt-1 flex items-center gap-2 flex-wrap text-[11px]">
                  {price ? (
                    <span className="font-bold text-white tabular-nums">{price}</span>
                  ) : (
                    <span className="text-gray-600">no price on record</span>
                  )}
                  {list && <span className="text-gray-500 tabular-nums">list {list}</span>}
                  {headroom != null &&
                    (headroom >= 0 ? (
                      <span className="text-emerald-400 tabular-nums" title="Contract sits under your underwritten ceiling (MAO).">
                        ${Math.round(headroom / 1000)}k under ceiling
                      </span>
                    ) : (
                      <span className="text-red-400 tabular-nums" title="Contract is ABOVE your underwritten ceiling — review before proceeding.">
                        ⚠ ${Math.abs(Math.round(headroom / 1000))}k over ceiling
                      </span>
                    ))}
                </div>
              </div>

              <div className="flex flex-col items-end gap-1 flex-shrink-0">
                <span
                  className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${
                    d.needsYou
                      ? "bg-emerald-950/60 text-emerald-300 border-emerald-500/40"
                      : "bg-gray-900 text-gray-400 border-gray-700"
                  }`}
                >
                  {d.needsYou ? "Your move" : "Waiting on them"}
                </span>
                <span className="text-[10px] text-gray-500">{ago(d.lastActivityAt, nowMs)}</span>
              </div>
            </Link>
          );
        })}
      </div>
    </section>
  );
}
