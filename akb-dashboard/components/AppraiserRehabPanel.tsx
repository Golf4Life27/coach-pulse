"use client";

/**
 * Appraiser rehab panel (Phase 4B.1 / Commit J.2).
 *
 * Mirrors AppraiserArvPanel. Three states:
 *
 *   1. Listing has computed rehab (estRehabMid + rehabEstimatedAt) →
 *      render value + BBC tier + market tier + multiplier + vision
 *      confidence + red-flag chips + click-to-expand line-items table
 *      + "Refresh" button.
 *
 *   2. No rehab computed → "Run rehab" button. Hits the endpoint;
 *      on success reload the page so values land.
 *
 *   3. Compute in flight → button shows "Running… (15-30s — Vision call)".
 *
 * Rehab_Line_Items_JSON is written by the Phase 4B.1 endpoint and
 * contains { bbc_tier, market_tier, market_multiplier,
 * anchor_per_sqft, calibrated_rate_per_sqft, vision_condition,
 * vision_line_items }. Older records from the existing pricing
 * route may not have this; in that case we render the simpler view
 * without the calibration block.
 */

import { useState } from "react";
import type { Listing } from "@/lib/types";
import { BBC_ANCHOR_PER_SQFT, type BbcTier } from "@/lib/appraiser/rehab-calibration";

export interface AppraiserRehabPanelProps {
  recordId: string;
  listing: Pick<
    Listing,
    | "estRehab"
    | "estRehabLow"
    | "estRehabMid"
    | "estRehabHigh"
    | "rehabConfidenceScore"
    | "rehabEstimatedAt"
    | "rehabLineItemsJson"
    | "rehabRedFlags"
    | "buildingSqFt"
  >;
}

interface VisionLineItem {
  category?: string;
  estimate_low?: number;
  estimate_high?: number;
  confidence?: string;
  notes?: string;
}

interface ParsedRehabJson {
  bbc_tier?: BbcTier;
  market_tier?: string;
  market_multiplier?: number;
  anchor_per_sqft?: number;
  calibrated_rate_per_sqft?: number;
  vision_condition?: string;
  vision_line_items?: VisionLineItem[];
}

function parseRehabJson(json: string | null | undefined): ParsedRehabJson | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed as ParsedRehabJson;
  } catch {
    return null;
  }
}

function formatCurrency(n: number | null | undefined): string {
  if (n == null) return "—";
  return `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

function formatAge(iso: string | null | undefined): string {
  if (!iso) return "never";
  const t = new Date(iso).getTime();
  if (isNaN(t)) return "—";
  const days = Math.floor((Date.now() - t) / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "1d ago";
  return `${days}d ago`;
}

const BBC_TIER_STYLES: Record<BbcTier, { border: string; text: string }> = {
  Cosmetic: { border: "border-emerald-800", text: "text-emerald-400" },
  Light: { border: "border-emerald-800", text: "text-emerald-400" },
  Medium: { border: "border-amber-800", text: "text-amber-400" },
  Heavy: { border: "border-orange-700", text: "text-orange-400" },
  Gut: { border: "border-red-700", text: "text-red-400" },
};

export default function AppraiserRehabPanel({ recordId, listing }: AppraiserRehabPanelProps) {
  const [running, setRunning] = useState(false);
  const [showItems, setShowItems] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rehabMid = listing.estRehabMid ?? listing.estRehab ?? null;
  const hasRehab = rehabMid != null && listing.rehabEstimatedAt != null;
  const parsed = parseRehabJson(listing.rehabLineItemsJson);
  const bbcTier: BbcTier | null =
    parsed?.bbc_tier ??
    (rehabMid != null && listing.buildingSqFt != null && listing.buildingSqFt > 0
      ? inferTierFromRate(rehabMid / listing.buildingSqFt)
      : null);
  const style = bbcTier ? BBC_TIER_STYLES[bbcTier] : { border: "border-[#30363d]", text: "text-gray-300" };
  const lineItems = parsed?.vision_line_items ?? [];
  const redFlags = (listing.rehabRedFlags ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const runRehab = async () => {
    setError(null);
    setRunning(true);
    try {
      const res = await fetch(`/api/agents/appraiser/rehab/${recordId}`);
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

  if (!hasRehab) {
    return (
      <div className="bg-[#1c2128] rounded-lg border border-[#30363d] p-3 space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-[10px] font-bold text-gray-500 uppercase tracking-wider">
            Appraiser — Rehab
          </h3>
        </div>
        <p className="text-[11px] text-gray-500 italic">No rehab estimated yet.</p>
        <button
          type="button"
          onClick={runRehab}
          disabled={running}
          className="bg-emerald-700 hover:bg-emerald-600 text-white text-[11px] font-semibold px-3 py-1.5 rounded disabled:opacity-50"
        >
          {running ? "Running… (15-30s — Vision call)" : "Run rehab"}
        </button>
        {error && <p className="text-[10px] text-red-400">{error}</p>}
      </div>
    );
  }

  return (
    <div className={`bg-[#1c2128] rounded-lg border ${style.border} p-3 space-y-2`}>
      <div className="flex items-center justify-between">
        <h3 className={`text-[10px] font-bold uppercase tracking-wider ${style.text}`}>
          Appraiser — Rehab {bbcTier ?? ""}
        </h3>
        <button
          type="button"
          onClick={runRehab}
          disabled={running}
          className="text-[10px] text-gray-500 hover:text-gray-300 disabled:opacity-50"
        >
          {running ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      <div className="grid grid-cols-3 gap-2 text-[11px]">
        <div className="bg-[#161b22] rounded px-2 py-1">
          <div className="text-gray-500">Mid</div>
          <div className="text-gray-200 font-semibold text-sm">{formatCurrency(rehabMid)}</div>
        </div>
        <div className="bg-[#161b22] rounded px-2 py-1">
          <div className="text-gray-500">Low</div>
          <div className="text-gray-300 text-sm">{formatCurrency(listing.estRehabLow)}</div>
        </div>
        <div className="bg-[#161b22] rounded px-2 py-1">
          <div className="text-gray-500">High</div>
          <div className="text-gray-300 text-sm">{formatCurrency(listing.estRehabHigh)}</div>
        </div>
      </div>
      {parsed && (
        <div className="text-[10px] text-gray-500 flex flex-wrap gap-x-3 gap-y-1">
          {parsed.market_tier && (
            <span>
              <span className="text-gray-600">Market:</span>{" "}
              <span className="text-gray-400">{parsed.market_tier}</span>
              {parsed.market_multiplier != null && (
                <span className="text-gray-600"> ×{parsed.market_multiplier}</span>
              )}
            </span>
          )}
          {parsed.anchor_per_sqft != null && (
            <span>
              <span className="text-gray-600">Anchor:</span>{" "}
              <span className="text-gray-400">${parsed.anchor_per_sqft}/sqft</span>
            </span>
          )}
          {parsed.calibrated_rate_per_sqft != null && (
            <span>
              <span className="text-gray-600">Calibrated:</span>{" "}
              <span className="text-gray-400">${parsed.calibrated_rate_per_sqft}/sqft</span>
            </span>
          )}
          {parsed.vision_condition && (
            <span>
              <span className="text-gray-600">Vision:</span>{" "}
              <span className="text-gray-400">{parsed.vision_condition}</span>
            </span>
          )}
        </div>
      )}
      {redFlags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {redFlags.map((flag) => (
            <span
              key={flag}
              className="text-[9px] uppercase bg-red-900/40 border border-red-800 text-red-300 px-1.5 py-0.5 rounded"
            >
              ⚠ {flag.replace(/_/g, " ")}
            </span>
          ))}
        </div>
      )}
      <div className="flex items-center justify-between text-[10px] text-gray-500">
        <span>
          Confidence{" "}
          <span className="text-gray-400">{listing.rehabConfidenceScore ?? "—"}/100</span>
        </span>
        <span>Estimated {formatAge(listing.rehabEstimatedAt)}</span>
      </div>
      {lineItems.length > 0 && (
        <div className="border-t border-[#21262d] pt-2">
          <button
            type="button"
            onClick={() => setShowItems((v) => !v)}
            className="text-[10px] text-gray-400 hover:text-gray-200"
            aria-expanded={showItems}
          >
            {showItems ? "▴ Hide" : "▾ Show"} {lineItems.length} line items
          </button>
          {showItems && (
            <div className="mt-2 max-h-[280px] overflow-y-auto">
              <table className="w-full text-[10px]">
                <thead className="text-gray-500">
                  <tr className="border-b border-[#30363d]">
                    <th className="text-left pb-1 pr-2">Category</th>
                    <th className="text-left pb-1 pr-2">Low</th>
                    <th className="text-left pb-1 pr-2">High</th>
                    <th className="text-left pb-1">Notes</th>
                  </tr>
                </thead>
                <tbody className="text-gray-300">
                  {lineItems.map((li, i) => (
                    <tr key={i} className="border-b border-[#21262d]">
                      <td className="py-1 pr-2 font-semibold">{li.category ?? "—"}</td>
                      <td className="py-1 pr-2 font-mono">{formatCurrency(li.estimate_low)}</td>
                      <td className="py-1 pr-2 font-mono">{formatCurrency(li.estimate_high)}</td>
                      <td className="py-1 text-gray-400">{li.notes ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
      {error && <p className="text-[10px] text-red-400">{error}</p>}
    </div>
  );
}

// Lightweight inference for the legacy-write case where Rehab_Line_Items_JSON
// doesn't yet carry bbc_tier (records last touched by the old Pricing
// Agent path). Pure; mirrors lib/appraiser/rehab-calibration.classifyBbcTierFromRate.
function inferTierFromRate(ratePerSqft: number): BbcTier {
  if (ratePerSqft < 18.5) return "Cosmetic";
  if (ratePerSqft < 26) return "Light";
  if (ratePerSqft < 40) return "Medium";
  if (ratePerSqft < 60) return "Heavy";
  return "Gut";
}

// Suppress unused-import warning on BBC_ANCHOR_PER_SQFT — re-exported
// via the type import to keep the panel's bundle small.
void BBC_ANCHOR_PER_SQFT;
