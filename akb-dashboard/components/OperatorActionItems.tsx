"use client";

// Operator action items on the Queue — wire #2 (SYSTEM_HANDOFF.md).
// Shows the things that need Alex's decision (e.g. cold seller counters the
// Quo sweep surfaced) with the verbatim reply + context, a link straight to
// the deal page (which now carries the Deal File), and resolve/defer.

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { showToast } from "@/components/Toast";

interface ActionItem {
  id: string;
  title: string;
  sourceRecordId: string | null;
  actionRequired: string | null;
  context: string | null;
  verbatimReply: string | null;
  status: string;
  priority: string;
  createdAt: string | null;
}

const PRIORITY: Record<string, string> = {
  high: "border-red-500 text-red-400",
  medium: "border-yellow-500 text-yellow-400",
  low: "border-gray-500 text-gray-400",
};

export default function OperatorActionItems() {
  const [items, setItems] = useState<ActionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState<Set<string>>(new Set());

  const fetchItems = useCallback(async () => {
    try {
      const res = await fetch("/api/operator-actions");
      if (!res.ok) throw new Error("api");
      const data = await res.json();
      setItems(data.items ?? []);
    } catch {
      // quiet — the section just stays empty if it can't load
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchItems(); }, [fetchItems]);

  const setStatus = async (id: string, status: "resolved" | "deferred") => {
    setActing((p) => new Set(p).add(id));
    try {
      const res = await fetch("/api/operator-actions", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, status }),
      });
      if (!res.ok) { showToast("Failed to update"); return; }
      showToast(status === "resolved" ? "Resolved" : "Deferred", "success");
      setItems((prev) => prev.filter((i) => i.id !== id));
    } catch {
      showToast("Failed to update");
    } finally {
      setActing((p) => { const n = new Set(p); n.delete(id); return n; });
    }
  };

  if (loading) return null;
  if (items.length === 0) return null; // nothing needs you → show nothing

  return (
    <div className="space-y-3">
      <h2 className="text-lg font-bold text-white">
        Needs your decision{" "}
        <span className="text-sm text-gray-500 font-normal">({items.length})</span>
      </h2>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {items.map((it) => {
          const colors = PRIORITY[it.priority] ?? "border-gray-500 text-gray-400";
          const busy = acting.has(it.id);
          return (
            <div key={it.id} className={`bg-[#1c2128] rounded-lg border-l-4 ${colors.split(" ")[0]} border border-[#30363d] p-4 space-y-2`}>
              <div className="flex items-center justify-between">
                <span className={`text-[10px] font-bold uppercase tracking-wider ${colors.split(" ")[1]}`}>{it.priority}</span>
                {it.createdAt && <span className="text-[10px] text-gray-600">{new Date(it.createdAt).toLocaleDateString()}</span>}
              </div>
              <h3 className="text-white font-semibold text-sm">{it.title}</h3>
              {it.verbatimReply && (
                <div className="bg-[#0d1117] border border-[#30363d] rounded px-2 py-1.5">
                  <p className="text-[11px] text-gray-300 whitespace-pre-wrap leading-relaxed">{it.verbatimReply}</p>
                </div>
              )}
              {it.actionRequired && <p className="text-xs text-gray-400 leading-relaxed">{it.actionRequired}</p>}
              <div className="flex gap-2 items-center pt-1">
                {it.sourceRecordId && (
                  <Link href={`/pipeline/${it.sourceRecordId}`} className="text-[11px] bg-blue-700 hover:bg-blue-600 text-white px-3 py-2 rounded min-h-[40px] inline-flex items-center">Open deal</Link>
                )}
                <button type="button" onClick={() => setStatus(it.id, "resolved")} disabled={busy} className="text-[11px] bg-emerald-700 hover:bg-emerald-600 text-white px-3 py-2 rounded min-h-[40px] disabled:opacity-50">Resolve</button>
                <button type="button" onClick={() => setStatus(it.id, "deferred")} disabled={busy} className="text-[11px] bg-[#30363d] hover:bg-[#3d444d] text-gray-300 px-3 py-2 rounded min-h-[40px] disabled:opacity-50">Defer</button>
              </div>
            </div>
          );
        })}
      </div>
      <div className="border-t border-[#30363d] pt-2" />
    </div>
  );
}
