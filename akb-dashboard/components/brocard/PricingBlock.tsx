"use client";

// Phase 4D — BroCard pricing block.
//
// Renders the v1.3 range envelope inside the BroCard's CardBlock so the
// operator sees the dual-track math output at glance. Three render
// modes keyed on `pricing.mode`:
//
//   phase4   — Full envelope. Dominant value highlighted, secondary
//              track shown alongside, three-stop bar (floor → soft
//              ceiling → list price) below, expand-on-click reveals
//              the modifier inputs that drove the calc.
//   legacy   — Outreach / contract offer-price strip with a "LEGACY"
//              badge so the operator knows math is stale.
//   no_math  — "No math yet" affordance — surface points the operator
//              at the deal-detail page where the Run-ARV / Run-Rehab
//              buttons live (no new endpoints in 4D scope).
//
// L.1: structure + modes. L.2: three-stop bar + modifier-inputs tooltip
// + soft-ceiling caution indicator.

import Link from "next/link";
import { useState } from "react";
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

// Three-stop range bar: floor → soft_ceiling → list_price with the
// target stacked on the floor (or separated once Phase 13 motivation
// scoring lands and target ≠ floor). The bar normalizes to the largest
// value present so floor-above-list landlord deals still render legibly.
function RangeBar({
  floor,
  target,
  softCeiling,
  listPrice,
  exceedsSoftCeiling,
}: {
  floor: number | null;
  target: number | null;
  softCeiling: number | null;
  listPrice: number | null;
  exceedsSoftCeiling: boolean;
}) {
  if (listPrice == null || floor == null) return null;
  const barMax = Math.max(listPrice, target ?? 0, floor, softCeiling ?? 0);
  if (barMax <= 0) return null;
  const pct = (v: number | null): number | null =>
    v == null ? null : Math.max(0, Math.min(100, (v / barMax) * 100));
  const floorPct = pct(floor);
  const targetPct = pct(target);
  const softCeilingPct = pct(softCeiling);
  const listPct = pct(listPrice);
  const targetDiffersFromFloor =
    target != null && floor != null && Math.abs(target - floor) >= 500;

  return (
    <div className="relative h-1.5 bg-[#161b22] rounded-full mt-0.5">
      {/* Floor → list span shaded so the operative range is visually
          continuous; soft-ceiling sits inside this span. */}
      {floorPct != null && listPct != null && (
        <div
          className="absolute top-0 h-1.5 bg-emerald-500/15 rounded-full"
          style={{ left: `${floorPct}%`, width: `${Math.max(0, listPct - floorPct)}%` }}
        />
      )}
      {/* Floor marker */}
      {floorPct != null && (
        <div
          className="absolute -top-0.5 w-1 h-2.5 bg-emerald-400 rounded-sm"
          style={{ left: `calc(${floorPct}% - 2px)` }}
          aria-label="floor"
        />
      )}
      {/* Target marker — only when meaningfully separate from floor
          (suppress overlap until Phase 13 motivation scoring lands). */}
      {targetDiffersFromFloor && targetPct != null && (
        <div
          className="absolute -top-0.5 w-1 h-2.5 bg-amber-300 rounded-sm"
          style={{ left: `calc(${targetPct}% - 2px)` }}
          aria-label="target"
        />
      )}
      {/* Soft ceiling marker — vertical dashed line at 75% of list.
          When exceedsSoftCeiling, render in caution amber. */}
      {softCeilingPct != null && (
        <div
          className={`absolute -top-1 w-0.5 h-3.5 ${exceedsSoftCeiling ? "bg-amber-400" : "bg-amber-500/40"}`}
          style={{ left: `calc(${softCeilingPct}% - 1px)` }}
          aria-label="soft ceiling"
        />
      )}
      {/* List marker */}
      {listPct != null && (
        <div
          className="absolute -top-0.5 w-1 h-2.5 bg-gray-300 rounded-sm"
          style={{ left: `calc(${listPct}% - 2px)` }}
          aria-label="list price"
        />
      )}
    </div>
  );
}

function RehabSourceBadge({ source }: { source: "phase_4b_calibrated" | "legacy_est_rehab" | "none" }) {
  if (source === "phase_4b_calibrated") {
    return (
      <span className="ml-1 text-[9px] uppercase tracking-wider px-1 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/30 text-emerald-300">
        calibrated
      </span>
    );
  }
  if (source === "legacy_est_rehab") {
    return (
      <span className="ml-1 text-[9px] uppercase tracking-wider px-1 py-0.5 rounded bg-amber-500/15 border border-amber-500/30 text-amber-300">
        legacy
      </span>
    );
  }
  return null;
}

function ModifierInputsPanel({ pricing }: { pricing: Extract<BroCardPricing, { mode: "phase4" }> }) {
  const { range } = pricing;
  const mi = range.modifier_inputs;
  const dt = range.dual_track;
  return (
    <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[10px] bg-[#161b22] rounded px-2 py-1.5">
      <div>
        <span className="text-gray-600">ARV:</span>{" "}
        <span className="text-gray-300">{formatCurrency(mi.arv_mid)}</span>
      </div>
      <div>
        <span className="text-gray-600">Rehab:</span>{" "}
        <span className="text-gray-300">{formatCurrency(mi.est_rehab)}</span>
        <RehabSourceBadge source={mi.rehab_source} />
      </div>
      <div>
        <span className="text-gray-600">Wholesale fee:</span>{" "}
        <span className="text-gray-300">{formatCurrency(mi.wholesale_fee)}</span>
      </div>
      <div>
        <span className="text-gray-600">Buyer profit:</span>{" "}
        <span className="text-gray-300">{formatCurrency(mi.buyer_profit)}</span>
      </div>
      {mi.monthly_rent != null && (
        <div>
          <span className="text-gray-600">Rent:</span>{" "}
          <span className="text-gray-300">{formatCurrency(mi.monthly_rent)}/mo</span>
        </div>
      )}
      {dt != null && (
        <div>
          <span className="text-gray-600">Cap:</span>{" "}
          <span className="text-gray-300">{(dt.cap_rate * 100).toFixed(1)}%</span>
          <span className="text-gray-600 ml-1">({dt.cap_rate_tier})</span>
        </div>
      )}
      {mi.state && (
        <div>
          <span className="text-gray-600">State:</span>{" "}
          <span className="text-gray-300">{mi.state}</span>
        </div>
      )}
      {mi.seller_motivation_score != null ? (
        <div>
          <span className="text-gray-600">Motivation:</span>{" "}
          <span className="text-gray-300">{mi.seller_motivation_score}/5</span>
        </div>
      ) : (
        <div className="text-gray-600 italic">Motivation: —</div>
      )}
    </div>
  );
}

function Phase4Block({ pricing }: { pricing: Extract<BroCardPricing, { mode: "phase4" }> }) {
  const [showInputs, setShowInputs] = useState(false);
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

      <RangeBar
        floor={range.floor}
        target={range.target}
        softCeiling={range.soft_ceiling}
        listPrice={range.list_price}
        exceedsSoftCeiling={range.exceeds_soft_ceiling}
      />

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

      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setShowInputs((s) => !s);
        }}
        className="text-[10px] text-gray-500 hover:text-gray-300 pointer-events-auto relative z-20"
        aria-expanded={showInputs}
      >
        {showInputs ? "Hide inputs ▴" : "Show inputs ▾"}
      </button>
      {showInputs && <ModifierInputsPanel pricing={pricing} />}
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
