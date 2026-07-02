"use client";

/**
 * Maverick Top Priorities — the front-and-center "what needs YOU now" strip.
 *
 * Operator spec (2026-07-02): log in and see the most critical action items,
 * ranked by revenue potential × time urgency × operator-only-ness, each with
 * a link to where the work happens and the WHY behind it. Data comes from
 * /api/maverick/priorities (Maverick-curated, expiry-gated); the live-derived
 * MorningBriefing below remains the from-the-records layer.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  urgencyBucket,
  urgencyLabel,
  type OperatorAction,
  type UrgencyBucket,
} from "@/lib/maverick/operator-actions";

const BUCKET_STYLE: Record<UrgencyBucket, { border: string; chip: string; dot: string }> = {
  overdue: { border: "border-red-500/70", chip: "bg-red-950/60 text-red-300", dot: "bg-red-500 animate-pulse" },
  under_24h: { border: "border-red-500/40", chip: "bg-red-950/40 text-red-300", dot: "bg-red-400" },
  under_72h: { border: "border-yellow-500/40", chip: "bg-yellow-950/40 text-yellow-300", dot: "bg-yellow-400" },
  later: { border: "border-[#30363d]", chip: "bg-[#1c2128] text-gray-400", dot: "bg-blue-400" },
  none: { border: "border-[#30363d]", chip: "bg-[#1c2128] text-gray-400", dot: "bg-gray-500" },
};

function money(n: number | null): string | null {
  if (n == null) return null;
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

function postedAgo(iso: string, nowMs: number): string {
  const h = Math.max(0, Math.round((nowMs - new Date(iso).getTime()) / 3600_000));
  if (h < 1) return "just now";
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export default function MaverickTopPriorities() {
  const [actions, setActions] = useState<OperatorAction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/maverick/priorities", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { actions: OperatorAction[] };
      setActions(data.actions ?? []);
      setNow(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <section className="border border-[#30363d] rounded-lg bg-[#0d1117] overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-[#30363d] bg-[#161b22]">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-emerald-400" />
          <h2 className="text-sm font-bold text-white tracking-wide">
            MAVERICK — WHAT NEEDS YOU NOW
          </h2>
        </div>
        <button
          type="button"
          onClick={load}
          className="text-[11px] text-gray-500 hover:text-gray-300 transition-colors"
        >
          refresh
        </button>
      </div>

      {loading ? (
        <div className="px-4 py-5 text-xs text-gray-500">Maverick is ranking your queue…</div>
      ) : error ? (
        <div className="px-4 py-5 text-xs text-red-400">
          Priorities failed to load: {error}{" "}
          <button type="button" onClick={load} className="underline text-gray-400 hover:text-gray-200">
            retry
          </button>
        </div>
      ) : actions.length === 0 ? (
        <div className="px-4 py-5 text-xs text-gray-500">
          Nothing is log-jammed on you. Maverick is watching.
        </div>
      ) : (
        <ul className="divide-y divide-[#21262d]">
          {actions.slice(0, 5).map((a, idx) => {
            const bucket = urgencyBucket(a, new Date(now).toISOString());
            const v = BUCKET_STYLE[bucket];
            const deadline = urgencyLabel(a, new Date(now).toISOString());
            const rev = money(a.revenueUsd);
            const external = a.href?.startsWith("http");
            const body = (
              <div className={`border-l-4 ${v.border} px-4 py-3 hover:bg-[#161b22] transition-colors`}>
                <div className="flex items-start gap-3">
                  <span className={`w-2 h-2 rounded-full mt-1.5 flex-shrink-0 ${v.dot}`} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center flex-wrap gap-2">
                      <span className="text-[11px] font-bold text-gray-600">#{idx + 1}</span>
                      <span className="text-sm font-semibold text-white leading-snug">{a.title}</span>
                    </div>
                    <div className="flex items-center flex-wrap gap-2 mt-1.5">
                      {deadline && (
                        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${v.chip}`}>
                          ⏰ {deadline}
                        </span>
                      )}
                      {rev && (
                        <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-950/50 text-emerald-300">
                          💰 {rev}
                        </span>
                      )}
                      <span className="text-[10px] text-gray-600">
                        posted {postedAgo(a.postedAt, now)} by {a.postedBy}
                      </span>
                    </div>
                    <p className="text-xs text-gray-400 mt-2 leading-relaxed">{a.why}</p>
                    {a.instructions && (
                      <p className="text-[11px] text-gray-500 mt-1.5 leading-relaxed whitespace-pre-line">
                        {a.instructions}
                      </p>
                    )}
                  </div>
                  {a.href && (
                    <span className="text-[11px] text-blue-400 flex-shrink-0 mt-1">
                      {external ? "open ↗" : "go →"}
                    </span>
                  )}
                </div>
              </div>
            );
            return (
              <li key={a.id}>
                {a.href ? (
                  external ? (
                    <a href={a.href} target="_blank" rel="noopener noreferrer" className="block">
                      {body}
                    </a>
                  ) : (
                    <Link href={a.href} className="block">
                      {body}
                    </Link>
                  )
                ) : (
                  body
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
