// Phase 4D / L.1 — BroCard pricing block.
//
// Renders the v1.3 range envelope inside the BroCard's CardBlock so the
// operator sees the dual-track math output at glance. Three render
// modes keyed on `pricing.mode`:
//
//   phase4   — Full envelope. Dominant value highlighted, secondary
//              track shown alongside, list price + soft ceiling
//              indicator below. ★ marks dominant track.
//   legacy   — Outreach / contract offer-price strip with a "LEGACY"
//              badge so the operator knows math is stale.
//   no_math  — "No math yet" affordance — surface points the operator
//              at the deal-detail page where the Run-ARV / Run-Rehab
//              buttons live (no new endpoints in 4D scope).
//
// L.2 will add the modifier-inputs tooltip + the soft-ceiling indicator
// as a visual gradient. L.1 keeps it tight: structure + modes.

import Link from "next/link";
import type { BroCardPricing, BroCardDominantTrack } from "@/types/jarvis";

function formatCurrency(n: number | null | undefined): string {
  if (n == null) return "—";
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

function trackLabel(track: BroCardDominantTrack): string {
  switch (track) {
    case "flipper":
      return "flipper";
    case "landlord":
      return "landlord";
    case "tie":
      return "tie";
    case "neither":
      return "—";
  }
}

const TRACK_BORDER: Record<BroCardDominantTrack, string> = {
  flipper: "border-emerald-700/60",
  landlord: "border-emerald-700/60",
  tie: "border-amber-700/60",
  neither: "border-[#30363d]",
};

function Phase4Block({ pricing }: { pricing: Extract<BroCardPricing, { mode: "phase4" }> }) {
  const { range } = pricing;
  const dt = range.dual_track;
  const dominantTrack: BroCardDominantTrack = dt?.dominant_track ?? "neither";
  const borderClass = TRACK_BORDER[dominantTrack];

  // When both tracks are computable, render side-by-side. Otherwise
  // render the single floor as a primary line.
  const flipperVal = dt?.flipper_mao ?? null;
  const landlordVal = dt?.landlord_mao ?? null;
  const bothTracks = flipperVal != null && landlordVal != null;

  const targetDiffersFromFloor =
    range.target != null && range.floor != null && range.target !== range.floor;

  return (
    <div className={`bg-[#0d1117] rounded border ${borderClass} px-3 py-2 space-y-1.5`}>
      <div className="flex items-center justify-between text-[10px] uppercase tracking-wider">
        <span className="text-gray-500">Pricing</span>
        <span className="text-gray-500">
          dominant: <span className="text-gray-300">{trackLabel(dominantTrack)}</span>
        </span>
      </div>

      {bothTracks ? (
        <div className="grid grid-cols-2 gap-2 text-[11px]">
          <div
            className={`rounded px-2 py-1 ${
              dominantTrack === "flipper"
                ? "bg-emerald-950/40 border border-emerald-800/60"
                : "bg-[#161b22] border border-transparent"
            }`}
          >
            <div className="text-gray-500 flex items-center gap-1">
              Flipper{dominantTrack === "flipper" && <span className="text-emerald-300 text-[9px]">★</span>}
            </div>
            <div className="text-gray-100 font-semibold text-sm">{formatCurrency(flipperVal)}</div>
          </div>
          <div
            className={`rounded px-2 py-1 ${
              dominantTrack === "landlord"
                ? "bg-emerald-950/40 border border-emerald-800/60"
                : "bg-[#161b22] border border-transparent"
            }`}
          >
            <div className="text-gray-500 flex items-center gap-1">
              Landlord{dominantTrack === "landlord" && <span className="text-emerald-300 text-[9px]">★</span>}
            </div>
            <div className="text-gray-100 font-semibold text-sm">{formatCurrency(landlordVal)}</div>
          </div>
        </div>
      ) : (
        <div className="flex items-baseline gap-2">
          <span className="text-[10px] text-gray-500 uppercase tracking-wider">Floor</span>
          <span className="text-base font-semibold text-gray-100">{formatCurrency(range.floor)}</span>
          {targetDiffersFromFloor && (
            <>
              <span className="text-[10px] text-gray-600 ml-1">→</span>
              <span className="text-[10px] text-gray-500 uppercase tracking-wider">Target</span>
              <span className="text-sm font-semibold text-gray-200">{formatCurrency(range.target)}</span>
            </>
          )}
        </div>
      )}

      <div className="flex items-center justify-between text-[10px] text-gray-500">
        <span>
          <span className="text-gray-600">List:</span>{" "}
          <span className="text-gray-400">{formatCurrency(range.list_price)}</span>
        </span>
        {range.soft_ceiling != null && (
          <span className={range.exceeds_soft_ceiling ? "text-amber-400" : "text-gray-500"}>
            <span className="text-gray-600">Soft ceiling:</span>{" "}
            <span className={range.exceeds_soft_ceiling ? "text-amber-300" : "text-gray-400"}>
              {formatCurrency(range.soft_ceiling)}
            </span>
            {range.exceeds_soft_ceiling && <span className="ml-1">⚠</span>}
          </span>
        )}
      </div>

      {dominantTrack === "landlord" && flipperVal != null && landlordVal != null && (
        <p className="text-[10px] text-emerald-300/90">
          ★ Landlord beats flipper by {formatCurrency(landlordVal - flipperVal)} — creative-finance candidate.
        </p>
      )}
    </div>
  );
}

function LegacyBlock({
  pricing,
  recordId,
}: {
  pricing: Extract<BroCardPricing, { mode: "legacy" }>;
  recordId: string;
}) {
  return (
    <div className="bg-[#0d1117] rounded border border-amber-800/40 px-3 py-2 space-y-1.5">
      <div className="flex items-center justify-between text-[10px] uppercase tracking-wider">
        <span className="text-amber-400 font-semibold">Legacy</span>
        <span className="text-gray-500">pre-Phase 4 math</span>
      </div>
      <div className="grid grid-cols-2 gap-2 text-[11px]">
        <div className="rounded px-2 py-1 bg-[#161b22]">
          <div className="text-gray-500">Outreach offer</div>
          <div className="text-gray-200 font-semibold text-sm">
            {formatCurrency(pricing.outreach_offer_price)}
          </div>
        </div>
        <div className="rounded px-2 py-1 bg-[#161b22]">
          <div className="text-gray-500">Contract offer</div>
          <div className="text-gray-200 font-semibold text-sm">
            {formatCurrency(pricing.contract_offer_price)}
          </div>
        </div>
      </div>
      <div className="flex items-center justify-between text-[10px] text-gray-500">
        <span>
          <span className="text-gray-600">List:</span>{" "}
          <span className="text-gray-400">{formatCurrency(pricing.list_price)}</span>
        </span>
        <Link
          href={`/pipeline/${recordId}`}
          className="text-amber-400 hover:text-amber-300 underline pointer-events-auto relative z-20"
        >
          Run Appraiser →
        </Link>
      </div>
    </div>
  );
}

function NoMathBlock({
  pricing,
  recordId,
}: {
  pricing: Extract<BroCardPricing, { mode: "no_math" }>;
  recordId: string;
}) {
  return (
    <div className="bg-[#0d1117] rounded border border-[#30363d] px-3 py-2 space-y-1">
      <div className="flex items-center justify-between text-[10px] uppercase tracking-wider">
        <span className="text-gray-500">Pricing</span>
        <span className="text-gray-600">no math yet</span>
      </div>
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-gray-400 italic">
          {pricing.list_price != null
            ? `List ${formatCurrency(pricing.list_price)} — no ARV / rehab on file.`
            : "No pricing inputs on file."}
        </span>
        <Link
          href={`/pipeline/${recordId}`}
          className="text-blue-400 hover:text-blue-300 underline pointer-events-auto relative z-20"
        >
          Run Appraiser →
        </Link>
      </div>
    </div>
  );
}

export default function PricingBlock({
  pricing,
  recordId,
}: {
  pricing: BroCardPricing;
  recordId: string;
}) {
  switch (pricing.mode) {
    case "phase4":
      return <Phase4Block pricing={pricing} />;
    case "legacy":
      return <LegacyBlock pricing={pricing} recordId={recordId} />;
    case "no_math":
      return <NoMathBlock pricing={pricing} recordId={recordId} />;
  }
}
