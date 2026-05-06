"use client";

import { useState, useEffect, useCallback } from "react";
import { showToast } from "@/components/Toast";

interface Counts {
  newOutreach: number;
  multiListing: number;
}

export default function OutreachPanel() {
  const [counts, setCounts] = useState<Counts>({ newOutreach: 0, multiListing: 0 });
  const [firing, setFiring] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ sent: number; total: number } | null>(null);

  const fetchCounts = useCallback(async () => {
    try {
      const res = await fetch("/api/outreach-fire");
      if (res.ok) setCounts(await res.json());
    } catch { /* non-fatal */ }
  }, []);

  useEffect(() => {
    fetchCounts();
    const interval = setInterval(fetchCounts, 60_000);
    return () => clearInterval(interval);
  }, [fetchCounts]);

  const fire = async (mode: "new" | "multi", dryRun: boolean) => {
    const count = mode === "new" ? counts.newOutreach : counts.multiListing;
    const label = mode === "new" ? "new agents" : "multi-listing agents";

    if (!dryRun) {
      const ok = window.confirm(
        `Send ${count} texts to ${label}?\n\n30-second throttle between each text. This will take ~${Math.ceil(count * 30 / 60)} minutes.`
      );
      if (!ok) return;
    }

    const modeLabel = `${dryRun ? "Dry run" : "Firing"} ${mode === "multi" ? "multi-listing" : "new outreach"}`;
    setFiring(modeLabel);
    setProgress({ sent: 0, total: count });

    try {
      const body: Record<string, unknown> = {};
      if (mode === "multi") body.multiListing = true;
      if (dryRun) body.dryRun = true;

      const res = await fetch("/api/outreach-fire", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const data = await res.json();
      if (!res.ok) {
        showToast(data.error || "Outreach failed");
        return;
      }

      const sent = data.sent ?? 0;
      const skipped = data.skipped ?? 0;
      const failed = data.failed ?? 0;
      const multiQueued = data.multiQueued ?? 0;

      if (dryRun) {
        showToast(`Dry run: ${data.attempted ?? 0} records previewed`, "success");
      } else {
        showToast(
          `Sent: ${sent}, Skipped: ${skipped}, Failed: ${failed}${multiQueued ? `, Multi-queued: ${multiQueued}` : ""}`,
          sent > 0 ? "success" : "error"
        );
      }

      fetchCounts();
    } catch {
      showToast("Outreach request failed");
    } finally {
      setFiring(null);
      setProgress(null);
    }
  };

  const hasRecords = counts.newOutreach > 0 || counts.multiListing > 0;

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-bold text-gray-400 uppercase tracking-wider">
          Outreach
        </h2>
        {firing && (
          <span className="text-xs text-yellow-400 animate-pulse">
            {firing}...
            {progress && ` (${progress.sent}/${progress.total})`}
          </span>
        )}
      </div>

      {hasRecords && (
        <div className="flex gap-2 flex-wrap">
          <button
            type="button"
            onClick={() => fire("new", false)}
            disabled={firing !== null || counts.newOutreach === 0}
            className="bg-emerald-700 hover:bg-emerald-600 text-white text-xs font-semibold px-3 py-2 rounded transition-colors min-h-[44px] disabled:opacity-50"
          >
            Fire New Outreach
            {counts.newOutreach > 0 && (
              <span className="ml-1.5 bg-emerald-500/30 px-1.5 py-0.5 rounded text-[10px]">
                {counts.newOutreach}
              </span>
            )}
          </button>

          <button
            type="button"
            onClick={() => fire("multi", false)}
            disabled={firing !== null || counts.multiListing === 0}
            className="bg-blue-700 hover:bg-blue-600 text-white text-xs font-semibold px-3 py-2 rounded transition-colors min-h-[44px] disabled:opacity-50"
          >
            Fire Multi-Listing
            {counts.multiListing > 0 && (
              <span className="ml-1.5 bg-blue-500/30 px-1.5 py-0.5 rounded text-[10px]">
                {counts.multiListing}
              </span>
            )}
          </button>

          <div className="relative group">
            <button
              type="button"
              disabled={firing !== null}
              className="bg-[#30363d] hover:bg-[#3d444d] text-gray-300 text-xs font-semibold px-3 py-2 rounded transition-colors min-h-[44px] disabled:opacity-50"
            >
              Dry Run ▾
            </button>
            <div className="absolute top-full left-0 mt-1 bg-[#1c2128] border border-[#30363d] rounded shadow-lg hidden group-hover:block z-10 min-w-[160px]">
              <button
                type="button"
                onClick={() => fire("new", true)}
                disabled={firing !== null}
                className="block w-full text-left px-3 py-2 text-xs text-gray-300 hover:bg-[#30363d] disabled:opacity-50"
              >
                Preview New ({counts.newOutreach})
              </button>
              <button
                type="button"
                onClick={() => fire("multi", true)}
                disabled={firing !== null}
                className="block w-full text-left px-3 py-2 text-xs text-gray-300 hover:bg-[#30363d] disabled:opacity-50"
              >
                Preview Multi-Listing ({counts.multiListing})
              </button>
            </div>
          </div>
        </div>
      )}

      {!hasRecords && !firing && (
        <p className="text-xs text-gray-600">No records queued for outreach.</p>
      )}
    </section>
  );
}
