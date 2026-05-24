"use client";

/**
 * Appraiser Buyer Intelligence panel (Phase 4C.1 / Commit K.2).
 *
 * Shows the dual-track MAOs side-by-side with the dominant track
 * highlighted. Same shape pattern as AppraiserArvPanel /
 * AppraiserRehabPanel.
 *
 * Three states:
 *   1. ARV + Rehab + Rent all present → render both tracks side-by-side
 *      with the dominant one tier-colored. Show cap rate + market tier.
 *      "Refresh rent" action re-pulls RentCast.
 *   2. ARV + Rehab present but rent missing → flipper-only render +
 *      "Pull rent" button (hits endpoint, falls back to landlord track
 *      on success).
 *   3. Inputs missing (no ARV or no Rehab) → render nothing actionable;
 *      direct user to run ARV + Rehab first.
 */

import { useState } from "react";
import type { Listing } from "@/lib/types";
import {
  computeDualTrack,
  getMarketCapRate,
  type DominantTrack,
} from "@/lib/appraiser/buyer-intelligence";
import { pickCalibratedRehab } from "@/lib/appraiser/mao-range";

export interface AppraiserBuyerIntelligencePanelProps {
  recordId: string;
  listing: Pick<
    Listing,
    | "realArvMedian"
    | "estRehab"
    | "estRehabMid"
    | "wholesaleFeeTarget"
    | "estimatedMonthlyRent"
    | "state"
  >;
}

function formatCurrency(n: number | null | undefined): string {
  if (n == null) return "—";
  return `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

function trackLabel(track: DominantTrack): string {
  switch (track) {
    case "flipper":
      return "Flipper wins";
    case "landlord":
      return "Landlord wins";
    case "tie":
      return "Tracks tied";
    case "neither":
      return "No tracks computable";
  }
}

const TRACK_STYLES: Record<DominantTrack, { border: string; text: string }> = {
  flipper: { border: "border-emerald-800", text: "text-emerald-400" },
  landlord: { border: "border-emerald-700", text: "text-emerald-400" },
  tie: { border: "border-amber-800", text: "text-amber-400" },
  neither: { border: "border-[#30363d]", text: "text-gray-300" },
};

export default function AppraiserBuyerIntelligencePanel({
  recordId,
  listing,
}: AppraiserBuyerIntelligencePanelProps) {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rehabPick = pickCalibratedRehab({
    estRehabMid: listing.estRehabMid,
    estRehab: listing.estRehab,
  });

  const dualTrack = computeDualTrack({
    arvMid: listing.realArvMedian ?? null,
    estRehab: rehabPick.value,
    wholesaleFee: listing.wholesaleFeeTarget ?? null,
    monthlyRent: listing.estimatedMonthlyRent ?? null,
    state: listing.state,
  });

  const capRateInfo = getMarketCapRate(listing.state);
  const style = TRACK_STYLES[dualTrack.dominant_track];

  // Inputs gate: can't compute anything without ARV + rehab.
  if (listing.realArvMedian == null || rehabPick.value == null) {
    return (
      <div className="bg-[#1c2128] rounded-lg border border-[#30363d] p-3 space-y-2">
        <h3 className="text-[10px] font-bold text-gray-500 uppercase tracking-wider">
          Appraiser — Buyer Intelligence
        </h3>
        <p className="text-[11px] text-gray-500 italic">
          {listing.realArvMedian == null && rehabPick.value == null
            ? "Needs ARV + Rehab first."
            : listing.realArvMedian == null
              ? "Needs ARV first."
              : "Needs Rehab first."}
        </p>
      </div>
    );
  }

  const runRent = async () => {
    setError(null);
    setRunning(true);
    try {
      const res = await fetch(
        `/api/agents/appraiser/buyer-intelligence/${recordId}?force_rent=1`,
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message ?? body.reason ?? body.error ?? `HTTP ${res.status}`);
      }
      if (typeof window !== "undefined") window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className={`bg-[#1c2128] rounded-lg border ${style.border} p-3 space-y-2`}>
      <div className="flex items-center justify-between">
        <h3 className={`text-[10px] font-bold uppercase tracking-wider ${style.text}`}>
          Appraiser — {trackLabel(dualTrack.dominant_track)}
        </h3>
        <button
          type="button"
          onClick={runRent}
          disabled={running}
          className="text-[10px] text-gray-500 hover:text-gray-300 disabled:opacity-50"
        >
          {running ? "Refreshing…" : listing.estimatedMonthlyRent != null ? "Refresh rent" : "Pull rent"}
        </button>
      </div>
      <div className="grid grid-cols-2 gap-2 text-[11px]">
        <div
          className={`rounded px-2 py-1 ${dualTrack.dominant_track === "flipper" ? "bg-emerald-950/40 border border-emerald-800" : "bg-[#161b22]"}`}
        >
          <div className="text-gray-500 flex items-center gap-1">
            Flipper MAO
            {dualTrack.dominant_track === "flipper" && (
              <span className="text-emerald-300 text-[9px]">★</span>
            )}
          </div>
          <div className="text-gray-200 font-semibold text-sm">
            {formatCurrency(dualTrack.flipper_mao)}
          </div>
          <div className="text-[9px] text-gray-600">arv − rehab − fee</div>
        </div>
        <div
          className={`rounded px-2 py-1 ${dualTrack.dominant_track === "landlord" ? "bg-emerald-950/40 border border-emerald-800" : "bg-[#161b22]"}`}
        >
          <div className="text-gray-500 flex items-center gap-1">
            Landlord MAO
            {dualTrack.dominant_track === "landlord" && (
              <span className="text-emerald-300 text-[9px]">★</span>
            )}
          </div>
          <div className="text-gray-200 font-semibold text-sm">
            {formatCurrency(dualTrack.landlord_mao)}
          </div>
          <div className="text-[9px] text-gray-600">rent×12/cap − rehab − fee</div>
        </div>
      </div>
      <div className="flex items-center justify-between text-[10px] text-gray-500">
        <span>
          <span className="text-gray-600">Rent:</span>{" "}
          <span className="text-gray-400">
            {listing.estimatedMonthlyRent != null
              ? `$${listing.estimatedMonthlyRent.toLocaleString()}/mo`
              : "—"}
          </span>
        </span>
        <span>
          <span className="text-gray-600">Cap:</span>{" "}
          <span className="text-gray-400">
            {(capRateInfo.rate * 100).toFixed(1)}% ({capRateInfo.tier})
          </span>
        </span>
      </div>
      {dualTrack.dominant_track === "landlord" &&
        dualTrack.flipper_mao != null &&
        dualTrack.landlord_mao != null && (
          <p className="text-[10px] text-emerald-300">
            ★ Landlord beats flipper by{" "}
            {formatCurrency(dualTrack.landlord_mao - dualTrack.flipper_mao)} —
            creative-finance candidate.
          </p>
        )}
      {listing.estimatedMonthlyRent == null && (
        <p className="text-[10px] text-gray-500 italic">
          No rent on file. Click "Pull rent" to fetch RentCast estimate and
          surface the landlord track.
        </p>
      )}
      {error && <p className="text-[10px] text-red-400">{error}</p>}
    </div>
  );
}
