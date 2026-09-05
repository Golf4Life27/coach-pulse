"use client";

// MARK CONTRACT EXECUTED (2026-09-05) — the dashboard-side button that flips
// a deal into the back-half contract lifecycle. Calls
// POST /api/contract-lifecycle/executed/[recordId] (built in parallel);
// this component only collects the inputs and shows what that route
// returns — it does no math and owns no state beyond the form.

import { useState } from "react";

interface MarkContractExecutedProps {
  recordId: string;
  /** listing.contractOfferPrice, if already on record — prefills the form. */
  contractOfferPrice?: number | null;
}

export default function MarkContractExecuted({ recordId, contractOfferPrice }: MarkContractExecutedProps) {
  const [open, setOpen] = useState(false);
  const [contractPrice, setContractPrice] = useState(
    contractOfferPrice != null ? String(contractOfferPrice) : "",
  );
  const [executedAt, setExecutedAt] = useState(new Date().toISOString().slice(0, 10));
  const [assignmentPrice, setAssignmentPrice] = useState(
    contractOfferPrice != null ? String(contractOfferPrice + 10_000) : "",
  );
  const [optionDays, setOptionDays] = useState("10");
  const [closeDays, setCloseDays] = useState("21");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);

  // Contract price changed after the initial prefill — keep assignment
  // price synced to contract + 10,000 until the operator edits it directly.
  const [assignmentTouched, setAssignmentTouched] = useState(false);

  function handleContractPriceChange(value: string) {
    setContractPrice(value);
    if (!assignmentTouched) {
      const n = Number(value);
      setAssignmentPrice(Number.isFinite(n) && value !== "" ? String(n + 10_000) : "");
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch(`/api/contract-lifecycle/executed/${recordId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contractPrice: contractPrice ? Number(contractPrice) : null,
          executedAt,
          assignmentPrice: assignmentPrice ? Number(assignmentPrice) : null,
          optionDays: Number(optionDays),
          closeDays: Number(closeDays),
        }),
      });
      const json = await res.json().catch(() => ({}));
      setResult(json);
      if (!res.ok) setError(typeof json?.error === "string" ? json.error : `Request failed (${res.status})`);
    } catch (err) {
      setError(String(err));
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="bg-emerald-700 hover:bg-emerald-600 text-white text-xs font-semibold px-3 py-2 rounded min-h-[44px]"
      >
        Mark Contract Executed
      </button>
    );
  }

  return (
    <div className="bg-[#1c2128] border border-emerald-600/40 rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold text-white">Mark Contract Executed</h3>
        <button type="button" onClick={() => setOpen(false)} className="text-xs text-gray-500 hover:text-gray-300">
          Close
        </button>
      </div>
      <form onSubmit={handleSubmit} className="grid grid-cols-2 gap-3">
        <label className="text-xs text-gray-400 flex flex-col gap-1">
          Contract price
          <input
            type="number"
            value={contractPrice}
            onChange={(e) => handleContractPriceChange(e.target.value)}
            className="bg-[#0d1117] border border-[#30363d] rounded px-2 py-2 text-white text-sm"
          />
        </label>
        <label className="text-xs text-gray-400 flex flex-col gap-1">
          Executed date
          <input
            type="date"
            value={executedAt}
            onChange={(e) => setExecutedAt(e.target.value)}
            className="bg-[#0d1117] border border-[#30363d] rounded px-2 py-2 text-white text-sm"
          />
        </label>
        <label className="text-xs text-gray-400 flex flex-col gap-1">
          Assignment price
          <input
            type="number"
            value={assignmentPrice}
            onChange={(e) => {
              setAssignmentTouched(true);
              setAssignmentPrice(e.target.value);
            }}
            className="bg-[#0d1117] border border-[#30363d] rounded px-2 py-2 text-white text-sm"
          />
        </label>
        <label className="text-xs text-gray-400 flex flex-col gap-1">
          Option days
          <input
            type="number"
            value={optionDays}
            onChange={(e) => setOptionDays(e.target.value)}
            className="bg-[#0d1117] border border-[#30363d] rounded px-2 py-2 text-white text-sm"
          />
        </label>
        <label className="text-xs text-gray-400 flex flex-col gap-1">
          Close days
          <input
            type="number"
            value={closeDays}
            onChange={(e) => setCloseDays(e.target.value)}
            className="bg-[#0d1117] border border-[#30363d] rounded px-2 py-2 text-white text-sm"
          />
        </label>
        <div className="col-span-2">
          <button
            type="submit"
            disabled={submitting}
            className="w-full bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 text-white text-xs font-semibold px-3 py-2.5 rounded min-h-[44px]"
          >
            {submitting ? "Submitting…" : "Submit"}
          </button>
        </div>
      </form>
      {error && <p className="text-xs text-red-400">{error}</p>}
      {result != null && (
        <pre className="text-[10px] text-gray-400 bg-[#0d1117] border border-[#30363d] rounded p-2 overflow-x-auto whitespace-pre-wrap break-all">
          {JSON.stringify(result, null, 2)}
        </pre>
      )}
    </div>
  );
}
