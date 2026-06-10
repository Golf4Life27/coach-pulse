"use client";

// INV-023 Pre-EMD DD Gate panel (2026-06-10). Self-contained by design —
// ships on the existing deal-detail surface (pipeline/[id]); the V2 Deal
// Room lifts it later. Renders only when a Deals row joins to the listing.
//
// Five operator attestations (writable), the evaluator-owned math gate +
// verdict (read-only — ruling 4: never hand-flipped), the persisted hold
// reasons, a Re-evaluate button, and the Request-EMD action that the
// backend REFUSES on any non-pass verdict.

import { useCallback, useEffect, useState } from "react";

interface PreEmdDeal {
  id: string;
  propertyAddress: string;
  contractPrice: number | null;
  underwrittenMao: number | null;
  preEmdCmaValidated: boolean;
  preEmdArvConfirmed: boolean;
  preEmdPhotosValidated: boolean;
  preEmdAssignmentClauseVerified: boolean;
  preEmdOperatorSignoff: boolean;
  preEmdMathGate: string;
  preEmdVerdict: string;
  preEmdLastEvaluatedAt: string | null;
  preEmdHoldReasons: string | null;
}

const ATTESTATIONS: Array<{ key: keyof PreEmdDeal; label: string; hint: string }> = [
  { key: "preEmdCmaValidated", label: "CMA validated", hint: "PE-01 — the CMA on record is fresh and sound" },
  { key: "preEmdArvConfirmed", label: "ARV source confirmed", hint: "sourced comps, never AVM, never fabricated" },
  { key: "preEmdPhotosValidated", label: "Photos validated", hint: "PE-06 — photos corroborate the rehab estimate" },
  { key: "preEmdAssignmentClauseVerified", label: "Assignment clause verified", hint: "PE-04 — EVERY state: assignment not prohibited in this contract" },
  { key: "preEmdOperatorSignoff", label: "Operator sign-off", hint: "PE-07 — final review before EMD (Lost-Phone Test)" },
];

function verdictBadge(verdict: string): string {
  switch (verdict) {
    case "pass": return "bg-emerald-500/15 text-emerald-400 border-emerald-500/40";
    case "block": return "bg-red-500/15 text-red-400 border-red-500/40";
    case "hold": return "bg-yellow-500/15 text-yellow-400 border-yellow-500/40";
    default: return "bg-gray-500/15 text-gray-400 border-gray-500/40";
  }
}

export default function PreEmdGatePanel({ recordId }: { recordId: string }) {
  const [deal, setDeal] = useState<PreEmdDeal | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [emdResult, setEmdResult] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch(`/api/deals/pre-emd-state?recordId=${encodeURIComponent(recordId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { setDeal(d?.found ? d.deal : null); setLoaded(true); })
      .catch(() => setLoaded(true));
  }, [recordId]);

  useEffect(() => { load(); }, [load]);

  async function toggle(key: keyof PreEmdDeal, value: boolean) {
    if (!deal) return;
    setBusy(String(key));
    try {
      await fetch("/api/deals/pre-emd-state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dealId: deal.id, field: key, value }),
      });
      load();
    } finally {
      setBusy(null);
    }
  }

  async function reEvaluate() {
    setBusy("evaluate");
    try {
      await fetch(`/api/orchestrator/pre-emd-evaluate?recordId=${encodeURIComponent(recordId)}`, { method: "POST" });
      load();
    } finally {
      setBusy(null);
    }
  }

  async function requestEmd() {
    if (!deal) return;
    setBusy("emd");
    setEmdResult(null);
    try {
      const res = await fetch("/api/deals/request-emd", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dealId: deal.id }),
      });
      const d = await res.json();
      setEmdResult(res.ok ? "EMD requested — wire workflow is now unblocked." : `REFUSED: ${d?.reason ?? d?.error ?? "unknown"}`);
      load();
    } catch {
      setEmdResult("REFUSED: network error");
    } finally {
      setBusy(null);
    }
  }

  // No deal row → no panel (the gate is deal-level state; pre-contract
  // listings simply don't render it).
  if (!loaded || !deal) return null;

  const verdict = deal.preEmdVerdict || "not_yet_evaluated";

  return (
    <div className="bg-[#1c2128] rounded-lg border border-[#30363d] p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold text-gray-300 uppercase tracking-wider">Pre-EMD DD Gate (INV-023)</h3>
        <span className={`text-xs font-bold px-2.5 py-1 rounded border ${verdictBadge(verdict)}`}>
          {verdict.toUpperCase().replace(/_/g, " ")}
        </span>
      </div>

      <div className="text-xs text-gray-400">
        Math gate (evaluator-owned):{" "}
        <span className={deal.preEmdMathGate === "green" ? "text-emerald-400 font-bold" : deal.preEmdMathGate === "red" ? "text-red-400 font-bold" : "text-gray-400"}>
          {deal.preEmdMathGate}
        </span>
        {deal.underwrittenMao != null && deal.contractPrice != null && (
          <span className="text-gray-500"> — MAO ${deal.underwrittenMao.toLocaleString()} vs contract ${deal.contractPrice.toLocaleString()}</span>
        )}
        {deal.preEmdLastEvaluatedAt && (
          <span className="text-gray-600"> · evaluated {deal.preEmdLastEvaluatedAt.slice(0, 16).replace("T", " ")}Z</span>
        )}
      </div>

      <div className="space-y-1.5">
        {ATTESTATIONS.map(({ key, label, hint }) => {
          const checked = deal[key] === true;
          return (
            <label key={String(key)} className="flex items-start gap-2 text-xs cursor-pointer" title={hint}>
              <input
                type="checkbox"
                checked={checked}
                disabled={busy === String(key)}
                onChange={(e) => toggle(key, e.target.checked)}
                className="mt-0.5"
              />
              <span className={checked ? "text-emerald-400" : "text-gray-300"}>{label}</span>
              <span className="text-gray-600">{hint}</span>
            </label>
          );
        })}
      </div>

      {deal.preEmdHoldReasons && verdict !== "pass" && (
        <pre className="text-[10px] text-yellow-300/80 bg-[#161b22] rounded border border-[#30363d] p-2 whitespace-pre-wrap max-h-40 overflow-y-auto">
          {deal.preEmdHoldReasons}
        </pre>
      )}

      <div className="flex items-center gap-2">
        <button
          onClick={reEvaluate}
          disabled={busy != null}
          className="text-xs bg-[#30363d] hover:bg-[#3d444d] text-gray-200 px-3 py-1.5 rounded disabled:opacity-50"
        >
          {busy === "evaluate" ? "Evaluating…" : "Re-evaluate"}
        </button>
        <button
          onClick={requestEmd}
          disabled={busy != null || verdict !== "pass"}
          title={verdict !== "pass" ? "EMD never fires on a non-pass verdict" : "Fire the EMD request"}
          className="text-xs bg-emerald-600/80 hover:bg-emerald-600 text-white px-3 py-1.5 rounded disabled:opacity-40"
        >
          {busy === "emd" ? "Requesting…" : "Request EMD"}
        </button>
        {emdResult && <span className={`text-[10px] ${emdResult.startsWith("REFUSED") ? "text-red-400" : "text-emerald-400"}`}>{emdResult}</span>}
      </div>
    </div>
  );
}
