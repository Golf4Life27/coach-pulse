"use client";

// Persistent north-star + belt-health header (silver-platter cockpit).
//
// Always visible, on every page: 🎯 live negotiations this month vs the
// 10/20/50 pace ladder (honest math from lib/north-star-pace), plus the two
// belt heartbeats (intake / send) as status dots WITH labels — a status
// color never carries meaning alone.

import { useCallback, useEffect, useState } from "react";
import { northStarPace, type PaceVerdict } from "@/lib/north-star-pace";

interface Heartbeat {
  last: string | null;
  freshness: "ok" | "late" | "stale" | string;
}

interface HeartbeatPayload {
  north_star?: { live_negotiations_this_month?: number };
  heartbeats?: { intake?: Heartbeat; send?: Heartbeat };
}

const FRESHNESS_DOT: Record<string, string> = {
  ok: "bg-emerald-400",
  late: "bg-amber-400",
  stale: "bg-red-500",
};

const PACE_CHIP: Record<PaceVerdict["tone"], string> = {
  good: "bg-emerald-950/60 text-emerald-300 border-emerald-500/40",
  warning: "bg-amber-950/60 text-amber-300 border-amber-500/40",
  behind: "bg-red-950/60 text-red-300 border-red-500/50",
};

export default function NorthStarHeader() {
  const [count, setCount] = useState<number | null>(null);
  const [beats, setBeats] = useState<{ intake: Heartbeat | null; send: Heartbeat | null }>({
    intake: null,
    send: null,
  });

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/maverick/heartbeat", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as HeartbeatPayload;
      setCount(data.north_star?.live_negotiations_this_month ?? null);
      setBeats({ intake: data.heartbeats?.intake ?? null, send: data.heartbeats?.send ?? null });
    } catch {
      /* header degrades silently; MissionControl carries the detail */
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 120_000);
    return () => clearInterval(t);
  }, [load]);

  const pace = count != null ? northStarPace(count, new Date()) : null;

  return (
    <div className="border-b border-[#21262d] bg-[#0d1117]">
      <div className="max-w-7xl mx-auto px-4 py-2 flex items-center justify-between gap-3 overflow-x-auto">
        <div className="flex items-center gap-2 flex-shrink-0">
          <span className="text-base" aria-hidden>
            🎯
          </span>
          {count == null || pace == null ? (
            <span className="text-xs text-gray-500">north star loading…</span>
          ) : (
            <>
              <span className="text-sm font-bold text-white tabular-nums">{count}</span>
              <span className="text-[11px] text-gray-500">live negotiations · goal 10·20·50</span>
              <span
                className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${PACE_CHIP[pace.tone]}`}
                title={`Month ${Math.round(pace.monthFraction * 100)}% elapsed · straight-line projection ≈ ${pace.projected}/mo`}
              >
                {pace.headline}
              </span>
            </>
          )}
        </div>

        <div className="flex items-center gap-3 flex-shrink-0 text-[10px] text-gray-500">
          {(["intake", "send"] as const).map((k) => {
            const b = beats[k];
            const dot = b ? (FRESHNESS_DOT[b.freshness] ?? "bg-gray-500") : "bg-gray-600";
            return (
              <span key={k} className="inline-flex items-center gap-1.5" title={b?.last ? `last ${k}: ${new Date(b.last).toLocaleString()}` : `${k}: unknown`}>
                <span className={`w-2 h-2 rounded-full ${dot}`} />
                {k} {b ? b.freshness : "—"}
              </span>
            );
          })}
        </div>
      </div>
    </div>
  );
}
