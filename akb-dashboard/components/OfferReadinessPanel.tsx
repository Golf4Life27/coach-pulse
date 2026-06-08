"use client";

// Offer-readiness checklist on the deal page — the four data points a deal
// needs before an offer goes out: Comps/ARV, Rehab, CMA, Buyer ceiling.
// Operator pillar (2026-06-08). Advisory today (red/green); the gate a
// future auto-offer must pass. CMA is derived from the Deal File; buyer
// ceiling has no persisted source yet (shown as the open item).

import { useCallback, useEffect, useState } from "react";
import { computeOfferReadiness, type OfferReadiness } from "@/lib/offer-readiness";

interface ListingBits {
  realArvMedian?: number | null;
  arvConfidence?: "HIGH" | "MED" | "LOW" | null;
  arvCompCount?: number | null;
  estRehab?: number | null;
  estRehabMid?: number | null;
  rehabConfidenceScore?: number | null;
}

export default function OfferReadinessPanel({
  recordId,
  listing,
}: {
  recordId: string;
  listing: ListingBits;
}) {
  const [hasOperatorCma, setHasOperatorCma] = useState<boolean | null>(null);
  const [readiness, setReadiness] = useState<OfferReadiness | null>(null);

  // Buyer_Median (γ-path) — read from Property_Intel via the deal route.
  const [buyerMedian, setBuyerMedian] = useState<{ value: number | null; source: string | null; fetchedAt: string | null }>(
    { value: null, source: null, fetchedAt: null },
  );
  const [showInput, setShowInput] = useState(false);
  const [bmValue, setBmValue] = useState("");
  const [bmExportDate, setBmExportDate] = useState("");
  const [bmSample, setBmSample] = useState("");
  const [bmError, setBmError] = useState<string | null>(null);
  const [bmSaving, setBmSaving] = useState(false);

  const loadBuyerMedian = useCallback(() => {
    fetch(`/api/deal/${recordId}/buyer-median`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d) setBuyerMedian({ value: d.value ?? null, source: d.source ?? null, fetchedAt: d.fetchedAt ?? null }); })
      .catch(() => {});
  }, [recordId]);

  useEffect(() => {
    let alive = true;
    fetch(`/api/deal-dossier/${recordId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (alive) setHasOperatorCma(d?.found ? Boolean(d.hasOperatorCma) : false); })
      .catch(() => { if (alive) setHasOperatorCma(false); });
    loadBuyerMedian();
    return () => { alive = false; };
  }, [recordId, loadBuyerMedian]);

  useEffect(() => {
    setReadiness(
      computeOfferReadiness({
        realArvMedian: listing.realArvMedian,
        arvConfidence: listing.arvConfidence,
        arvCompCount: listing.arvCompCount,
        estRehab: listing.estRehab,
        estRehabMid: listing.estRehabMid,
        rehabConfidenceScore: listing.rehabConfidenceScore,
        hasOperatorCma: hasOperatorCma ?? false,
        buyerCeiling: buyerMedian.value, // now real — Property_Intel γ-path
      }),
    );
  }, [listing, hasOperatorCma, buyerMedian.value]);

  async function saveBuyerMedian() {
    setBmSaving(true);
    setBmError(null);
    try {
      const res = await fetch(`/api/deal/${recordId}/buyer-median`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Source is FIXED to investorbase_manual — never offer an unsourced
        // option; the server enforces the same rule as a backstop.
        body: JSON.stringify({
          value: bmValue,
          source: "investorbase_manual",
          exportDate: bmExportDate,
          sampleSize: bmSample || undefined,
        }),
      });
      const d = await res.json();
      if (!res.ok) {
        setBmError(d?.reason ?? d?.error ?? "save failed");
        return;
      }
      setShowInput(false);
      setBmValue("");
      setBmExportDate("");
      setBmSample("");
      loadBuyerMedian();
    } catch {
      setBmError("network error");
    } finally {
      setBmSaving(false);
    }
  }

  if (!readiness) return null;

  return (
    <div className="bg-[#1c2128] rounded-lg border border-[#30363d] p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold text-gray-300 uppercase tracking-wider">Offer Readiness</h3>
        <span
          className={`text-xs font-bold px-2.5 py-1 rounded border ${
            readiness.ready
              ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/40"
              : "bg-yellow-500/15 text-yellow-400 border-yellow-500/40"
          }`}
        >
          {readiness.ready ? "READY TO OFFER" : `NOT READY — missing ${readiness.missing.length}`}
        </span>
      </div>

      <div className="space-y-1.5">
        {readiness.items.map((it) => (
          <div key={it.key}>
            <div className="flex items-start gap-2 text-xs">
              <span className={it.ok ? "text-emerald-400" : "text-red-400"}>{it.ok ? "✓" : "✗"}</span>
              <span className="text-gray-300 font-medium min-w-[150px]">{it.label}</span>
              <span className={it.ok ? "text-gray-400" : "text-red-400/80"}>
                {it.key === "buyer_ceiling" && buyerMedian.value != null
                  ? `$${buyerMedian.value.toLocaleString()}${buyerMedian.source ? ` · ${buyerMedian.source}` : ""}${buyerMedian.fetchedAt ? ` · ${buyerMedian.fetchedAt.slice(0, 10)}` : ""}`
                  : it.detail}
              </span>
              {it.key === "buyer_ceiling" && (
                <button
                  onClick={() => { setShowInput((s) => !s); setBmError(null); }}
                  className="ml-auto text-[10px] text-cyan-400 hover:text-cyan-300"
                >
                  {buyerMedian.value != null ? "Update" : "Enter"}
                </button>
              )}
            </div>

            {it.key === "buyer_ceiling" && showInput && (
              <div className="mt-2 ml-6 p-3 bg-[#161b22] rounded border border-[#30363d] space-y-2">
                <p className="text-[10px] text-amber-300/90">
                  InvestorBase exports only. The value is stamped
                  <span className="font-mono"> investorbase_manual</span> + export date —
                  unsourced numbers are refused.
                </p>
                <div className="flex flex-wrap gap-2">
                  <input
                    value={bmValue}
                    onChange={(e) => setBmValue(e.target.value)}
                    placeholder="Buyer median $"
                    className="bg-[#0d1117] border border-[#30363d] rounded px-2 py-1 text-xs text-white w-32"
                  />
                  <input
                    type="date"
                    value={bmExportDate}
                    onChange={(e) => setBmExportDate(e.target.value)}
                    title="InvestorBase export date"
                    className="bg-[#0d1117] border border-[#30363d] rounded px-2 py-1 text-xs text-white"
                  />
                  <input
                    value={bmSample}
                    onChange={(e) => setBmSample(e.target.value)}
                    placeholder="# comps (opt)"
                    className="bg-[#0d1117] border border-[#30363d] rounded px-2 py-1 text-xs text-white w-24"
                  />
                  <button
                    onClick={saveBuyerMedian}
                    disabled={bmSaving}
                    className="text-xs bg-cyan-600/80 hover:bg-cyan-600 text-white px-3 py-1 rounded disabled:opacity-50"
                  >
                    {bmSaving ? "Saving…" : "Save"}
                  </button>
                </div>
                {bmError && <p className="text-[10px] text-red-400">{bmError}</p>}
              </div>
            )}
          </div>
        ))}
      </div>

      {!readiness.ready && (
        <p className="text-[10px] text-gray-500">
          An offer should carry all four. Missing items must be filled before sending.
        </p>
      )}
    </div>
  );
}
