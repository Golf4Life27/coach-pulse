"use client";

// Median sanity rail (adjudication recXJrM7EYK3pEFmF item 6).
//
// One of the ZIP median's three surviving roles after the property-up
// keystone: CROSS-CHECK the property-up number. Flags ≥25% divergence
// for operator review. NEVER gates a send — it is a lamp, not a brake.
//
// property_up_mao preference: persisted Underwritten_Property_MAO when
// the property-up pipeline has written it; otherwise the V1.3 display
// floor (ARV − rehab − fee) as the best property-up-shaped number on
// the record. The median side reads through the EXISTING buyer-median
// consumer route (one read path, no parallel build).

import { useEffect, useState } from "react";
import { computeSanityRail, type SanityRailResult } from "@/lib/pricing/sanity-rail";

export interface PricingSanityRailProps {
  recordId: string;
  /** Persisted Underwritten_Property_MAO (preferred when present). */
  underwrittenPropertyMao: number | null;
  /** Fallback property-up-shaped number: ARV − rehab − fee (V1.3 floor). */
  displayFloor: number | null;
}

export default function PricingSanityRail({ recordId, underwrittenPropertyMao, displayFloor }: PricingSanityRailProps) {
  const [rail, setRail] = useState<SanityRailResult | null>(null);
  const [median, setMedian] = useState<{ value: number; track: string } | null>(null);

  const propertyUp = underwrittenPropertyMao ?? displayFloor;

  useEffect(() => {
    if (propertyUp == null) return;
    let cancelled = false;
    fetch(`/api/deal/${recordId}/buyer-median`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || !d || d.value == null) return;
        setMedian({ value: d.value, track: d.track ?? "?" });
        setRail(computeSanityRail(propertyUp, d.value));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [recordId, propertyUp]);

  // Absent inputs → render nothing. An absent rail is absent, never fabricated.
  if (propertyUp == null || rail == null || rail.deltaPct == null || median == null) return null;

  return (
    <div
      className={`rounded px-2 py-1.5 border text-[10px] ${
        rail.flagged
          ? "bg-amber-950/40 border-amber-700/60 text-amber-200"
          : "bg-[#161b22] border-[#30363d] text-gray-400"
      }`}
    >
      <span className="font-semibold uppercase tracking-wider mr-2">
        {rail.flagged ? "⚠ Median rail" : "Median rail"}
      </span>
      {rail.description}
      <span className="text-gray-500"> · ZIP {median.track} median · informs, never gates</span>
    </div>
  );
}
