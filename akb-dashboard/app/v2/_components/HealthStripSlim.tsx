"use client";

// Slim always-visible health strip for the V1 header (charter ruling 4) —
// "is the machine alive" in five seconds, one short row under the nav.
// AKBdash tokens; LED + value per signal; tap a cell for its provenance.
// Honest zero: every cell renders "no signal" when its source isn't wired.

import { useState } from "react";
import { useV2Data, type HealthSignal } from "../_lib/data";

const LED: Record<HealthSignal["state"], string> = {
  ok: "bg-emerald-400",
  warn: "bg-amber-400",
  fault: "bg-red-500 animate-pulse",
  nodata: "bg-gray-600",
};

const VALUE_TONE: Record<HealthSignal["state"], string> = {
  ok: "text-emerald-300",
  warn: "text-amber-300",
  fault: "text-red-400",
  nodata: "text-gray-500",
};

export default function HealthStripSlim() {
  const { health, loading, refresh } = useV2Data();
  const [openDetail, setOpenDetail] = useState<string | null>(null);
  const detail = health.find((h) => h.label === openDetail);

  return (
    <div className="bg-[#161b22] border-b border-[#30363d]">
      <div className="max-w-7xl mx-auto px-4 flex items-center gap-4 overflow-x-auto py-1">
        {health.map((h) => (
          <button
            key={h.label}
            type="button"
            onClick={() => setOpenDetail(openDetail === h.label ? null : h.label)}
            className="flex items-center gap-1.5 shrink-0 text-[10px] hover:opacity-80 transition-opacity"
            title={h.detail}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${LED[h.state]}`} />
            <span className="font-bold tracking-wider text-gray-500">{h.label}</span>
            <span className={`font-mono font-semibold ${VALUE_TONE[h.state]}`}>
              {loading && h.state === "nodata" ? "…" : h.value}
            </span>
          </button>
        ))}
        <button
          type="button"
          onClick={refresh}
          className="ml-auto shrink-0 text-gray-600 hover:text-gray-300 text-xs"
          title="refresh health signals"
        >
          <span className={loading ? "inline-block animate-spin" : ""}>⟳</span>
        </button>
      </div>
      {detail && (
        <div className="max-w-7xl mx-auto px-4 pb-1 text-[10px] text-gray-500">
          <span className="font-bold text-gray-400">{detail.label}</span> — {detail.detail}
        </div>
      )}
    </div>
  );
}
