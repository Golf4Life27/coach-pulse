"use client";

// Deal File panel — shows the latest underwrite (Deal_Dossiers) on the deal
// page. Wire #1 of the dashboard reconciliation (SYSTEM_HANDOFF.md): the
// dossier was written but never displayed. Plain-English labels — no
// internal shorthand on the glass.

import { useEffect, useState } from "react";
import { formatCurrency } from "@/lib/utils";

interface DealFile {
  found: boolean;
  dealNumber: number | null;
  verdict: string | null;
  pessimisticMao: number | null;
  stickyFloor: number | null;
  marginOverFloor: number | null;
  awaiting: string | null;
  createdAt: string | null;
  markdown: string | null;
}

const VERDICT: Record<string, { label: string; cls: string }> = {
  robust: { label: "STRONG — clears your floor with margin", cls: "bg-emerald-500/15 text-emerald-400 border-emerald-500/40" },
  marginal: { label: "THIN — barely clears your floor", cls: "bg-yellow-500/15 text-yellow-400 border-yellow-500/40" },
  fails_floor: { label: "FAILS — worst-case max offer is below your floor", cls: "bg-red-500/15 text-red-400 border-red-500/40" },
  hold: { label: "HOLD — missing data to decide", cls: "bg-gray-500/15 text-gray-400 border-gray-500/40" },
};

export default function DealFilePanel({ recordId }: { recordId: string }) {
  const [df, setDf] = useState<DealFile | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetch(`/api/deal-dossier/${recordId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: DealFile | null) => { if (alive) setDf(d); })
      .catch(() => {})
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [recordId]);

  if (loading) return null; // stay quiet until we know

  if (!df || !df.found) {
    return (
      <div className="bg-[#1c2128] rounded-lg border border-[#30363d] p-4">
        <h3 className="text-sm font-bold text-gray-300 uppercase tracking-wider">Deal File</h3>
        <p className="text-xs text-gray-500 mt-1">No underwrite built yet for this property.</p>
      </div>
    );
  }

  const v = df.verdict
    ? VERDICT[df.verdict] ?? { label: df.verdict, cls: "bg-gray-500/15 text-gray-400 border-gray-500/40" }
    : null;
  const marginPos = (df.marginOverFloor ?? 0) >= 0;

  return (
    <div className="bg-[#1c2128] rounded-lg border border-[#30363d] p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold text-gray-300 uppercase tracking-wider">
          Deal File{df.dealNumber != null ? ` #${String(df.dealNumber).padStart(3, "0")}` : ""}
        </h3>
        {df.createdAt && (
          <span className="text-[10px] text-gray-600">built {new Date(df.createdAt).toLocaleDateString()}</span>
        )}
      </div>

      {v && (
        <div className={`inline-block text-xs font-bold px-2.5 py-1 rounded border ${v.cls}`}>{v.label}</div>
      )}

      <div className="grid grid-cols-3 gap-2 text-xs">
        <div>
          <span className="text-gray-500">Max offer (worst-case)</span>
          <p className="text-white font-medium">{df.pessimisticMao != null ? formatCurrency(df.pessimisticMao) : "—"}</p>
        </div>
        <div>
          <span className="text-gray-500">Your floor</span>
          <p className="text-white font-medium">{df.stickyFloor != null ? formatCurrency(df.stickyFloor) : "—"}</p>
        </div>
        <div>
          <span className="text-gray-500">Margin</span>
          <p className={`font-medium ${marginPos ? "text-emerald-400" : "text-red-400"}`}>
            {df.marginOverFloor != null ? formatCurrency(df.marginOverFloor) : "—"}
          </p>
        </div>
      </div>

      {df.markdown && (
        <div>
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className="text-[11px] text-blue-400 hover:underline"
          >
            {open ? "Hide full underwrite" : "Show full underwrite"}
          </button>
          {open && (
            <pre className="mt-2 max-h-[360px] overflow-y-auto text-[11px] text-gray-300 whitespace-pre-wrap leading-relaxed bg-[#0d1117] rounded p-3 border border-[#30363d]">
              {df.markdown}
            </pre>
          )}
        </div>
      )}

      {df.awaiting && <p className="text-[10px] text-gray-500">Awaiting: {df.awaiting}</p>}
    </div>
  );
}
