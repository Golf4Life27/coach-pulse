"use client";

// Lost-Phone strip — "is the machine alive" in five seconds. Always visible,
// one row, horizontally scrollable on phones. Tap a cell for its provenance.

import { useState } from "react";
import { useV2Data, type HealthSignal } from "../_lib/data";

const LED: Record<HealthSignal["state"], string> = {
  ok: "bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.9)]",
  warn: "bg-amber-400 shadow-[0_0_6px_rgba(251,191,36,0.9)]",
  fault: "bg-red-500 shadow-[0_0_8px_rgba(239,68,68,1)] animate-pulse",
  nodata: "bg-zinc-600",
};

const VALUE_TONE: Record<HealthSignal["state"], string> = {
  ok: "text-emerald-300",
  warn: "text-amber-300",
  fault: "text-red-400",
  nodata: "text-zinc-500",
};

export default function HealthStrip() {
  const { health, lastFetched, loading, refresh } = useV2Data();
  const [openDetail, setOpenDetail] = useState<string | null>(null);

  const detail = health.find((h) => h.label === openDetail);

  return (
    <div className="border-b border-zinc-800 bg-[#0a0c10]">
      <div className="flex items-stretch overflow-x-auto no-scrollbar">
        {health.map((h) => (
          <button
            key={h.label}
            onClick={() => setOpenDetail(openDetail === h.label ? null : h.label)}
            className={`flex min-w-[8rem] flex-1 flex-col gap-0.5 border-r border-zinc-800/70 px-3 py-2 text-left transition-colors hover:bg-zinc-900 ${
              openDetail === h.label ? "bg-zinc-900" : ""
            }`}
          >
            <span className="flex items-center gap-1.5 text-[10px] font-bold tracking-[0.15em] text-zinc-500">
              <span className={`h-1.5 w-1.5 rounded-full ${LED[h.state]}`} />
              {h.label}
            </span>
            <span className={`font-mono text-sm font-semibold ${VALUE_TONE[h.state]}`}>
              {loading && h.state === "nodata" ? "…" : h.value}
            </span>
          </button>
        ))}
        <button
          onClick={refresh}
          title={lastFetched ? `data fetched ${new Date(lastFetched).toLocaleTimeString()}` : "refresh"}
          className="flex items-center px-3 text-zinc-600 hover:text-zinc-300"
        >
          <span className={`text-sm ${loading ? "animate-spin" : ""}`}>⟳</span>
        </button>
      </div>
      {detail && (
        <div className="border-t border-zinc-800/70 px-3 py-1.5 text-sm text-zinc-400">
          <span className="font-bold text-zinc-300">{detail.label}</span> — {detail.detail}
        </div>
      )}
    </div>
  );
}
