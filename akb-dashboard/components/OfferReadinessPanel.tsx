"use client";

// Offer-readiness checklist on the deal page — the four data points a deal
// needs before an offer goes out: Comps/ARV, Rehab, CMA, Buyer ceiling.
// Operator pillar (2026-06-08). Advisory today (red/green); the gate a
// future auto-offer must pass. CMA is derived from the Deal File; buyer
// ceiling has no persisted source yet (shown as the open item).

import { useEffect, useState } from "react";
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

  useEffect(() => {
    let alive = true;
    fetch(`/api/deal-dossier/${recordId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (alive) setHasOperatorCma(d?.found ? Boolean(d.hasOperatorCma) : false); })
      .catch(() => { if (alive) setHasOperatorCma(false); });
    return () => { alive = false; };
  }, [recordId]);

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
        buyerCeiling: null, // no persisted source yet — the open checklist item
      }),
    );
  }, [listing, hasOperatorCma]);

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
          <div key={it.key} className="flex items-start gap-2 text-xs">
            <span className={it.ok ? "text-emerald-400" : "text-red-400"}>{it.ok ? "✓" : "✗"}</span>
            <span className="text-gray-300 font-medium min-w-[150px]">{it.label}</span>
            <span className={it.ok ? "text-gray-400" : "text-red-400/80"}>{it.detail}</span>
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
