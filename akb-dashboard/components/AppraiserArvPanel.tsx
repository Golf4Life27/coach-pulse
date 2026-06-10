"use client";

/**
 * Appraiser ARV panel (Phase 4A.1 / Commit I.3).
 *
 * Deal-detail surface for the standalone ARV endpoint at
 * /api/agents/appraiser/arv/[recordId]. Three states:
 *
 *   1. Listing has computed ARV (realArvMedian + arvValidatedAt) →
 *      render the value + confidence label + comp count + avg $/sqft
 *      + click-to-expand comps table + "Refresh" button.
 *
 *   2. Listing has no ARV computed yet → render "No ARV computed yet"
 *      + "Run ARV" button. Button hits the endpoint; on success the
 *      page reloads to surface the fresh values.
 *
 *   3. Compute in flight → spinner + cancellable. The endpoint can take
 *      10-20s (RentCast call + filtering + math).
 *
 * The panel reads listing.arv* directly (no briefing fetch needed); the
 * "Run ARV" action POSTs to the endpoint which writes back to Airtable,
 * then reloads the page so the listing fetch picks up the new values.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { Listing } from "@/lib/types";

export interface AppraiserArvPanelProps {
  recordId: string;
  listing: Pick<
    Listing,
    | "realArvMedian"
    | "realArvLow"
    | "realArvHigh"
    | "arvConfidence"
    | "arvCompCount"
    | "arvCompAvgPrSqFt"
    | "arvCompDetailsJson"
    | "arvValidatedAt"
    | "estRehab"
    | "wholesaleFeeTarget"
    | "listPrice"
  >;
}

interface ParsedComp {
  price?: number;
  sqft?: number | null;
  per_sqft?: number;
  distance?: number | null;
  sale_date?: string | null;
  beds?: number | null;
  bathrooms?: number | null;
  cluster?: string;
  formatted_address?: string | null;
}

// Lookup URLs for one-click comp verification. Zillow's homes search and
// Redfin's universal search both honor a free-text address query and
// route the user to the property card if it's indexed. If RentCast hands
// us a comp without an address (legacy persisted JSON), we hide the
// links rather than ship dead anchors.
function zillowLookupUrl(address: string): string {
  return `https://www.zillow.com/homes/${encodeURIComponent(address)}_rb/`;
}
function redfinLookupUrl(address: string): string {
  // Redfin has no clean public address-search URL — their
  // /stingray/do/location-autocomplete returns JSON. Route through
  // Google site-search so Alex still lands on the Redfin record card
  // in one click. Reliable and indexed.
  return `https://www.google.com/search?q=${encodeURIComponent(`site:redfin.com ${address}`)}`;
}

function parseComps(json: string | null | undefined): ParsedComp[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
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

const CONFIDENCE_STYLES: Record<NonNullable<Listing["arvConfidence"]>, { border: string; text: string }> = {
  HIGH: { border: "border-emerald-800", text: "text-emerald-400" },
  MED: { border: "border-amber-800", text: "text-amber-400" },
  LOW: { border: "border-orange-700", text: "text-orange-400" },
};

export default function AppraiserArvPanel({ recordId, listing }: AppraiserArvPanelProps) {
  const router = useRouter();
  const [running, setRunning] = useState(false);
  const [showComps, setShowComps] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasArv = listing.realArvMedian != null && listing.arvValidatedAt != null;
  const confidence = listing.arvConfidence ?? null;
  const style = confidence ? CONFIDENCE_STYLES[confidence] : { border: "border-[#30363d]", text: "text-gray-300" };
  const comps = parseComps(listing.arvCompDetailsJson);

  // v1.3 floor calc — same formula as lib/appraiser/mao-range.ts but
  // inline here so the panel doesn't have to round-trip to compute the
  // display value. When backend ARV was computed, this is the floor
  // that endpoint also returned. Surfaced for at-a-glance reference.
  const floor =
    listing.realArvMedian != null && listing.estRehab != null
      ? Math.max(listing.realArvMedian - listing.estRehab - (listing.wholesaleFeeTarget ?? 15000), 0)
      : null;
  const softCeiling =
    listing.listPrice != null && listing.listPrice > 0
      ? Math.round(listing.listPrice * 0.75)
      : null;
  const exceedsSoftCeiling = floor != null && softCeiling != null && floor > softCeiling;

  const runArv = async () => {
    setError(null);
    setRunning(true);
    try {
      const res = await fetch(`/api/agents/appraiser/arv/${recordId}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message ?? body.reason ?? body.error ?? `HTTP ${res.status}`);
      }
      // Re-render the server component tree so the listing read picks up the
      // fresh values. Avoid window.location.reload(): a hard reload unmounts
      // AuthGate, and on auth-hardening-V1 boundaries we want the SPA state
      // (running flag, panel scroll) preserved.
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  if (!hasArv) {
    return (
      <div className="bg-[#1c2128] rounded-lg border border-[#30363d] p-3 space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-[10px] font-bold text-gray-500 uppercase tracking-wider">Appraiser</h3>
        </div>
        <p className="text-[11px] text-gray-500 italic">No ARV computed yet.</p>
        <button
          type="button"
          onClick={runArv}
          disabled={running}
          className="bg-emerald-700 hover:bg-emerald-600 text-white text-[11px] font-semibold px-3 py-1.5 rounded disabled:opacity-50"
        >
          {running ? "Running… (10-20s)" : "Run ARV"}
        </button>
        {error && <p className="text-[10px] text-red-400">{error}</p>}
      </div>
    );
  }

  return (
    <div className={`bg-[#1c2128] rounded-lg border ${style.border} p-3 space-y-2`}>
      <div className="flex items-center justify-between">
        <h3 className={`text-[10px] font-bold uppercase tracking-wider ${style.text}`}>
          Appraiser — ARV {confidence ?? ""}
        </h3>
        <button
          type="button"
          onClick={runArv}
          disabled={running}
          className="text-[10px] text-gray-500 hover:text-gray-300 disabled:opacity-50"
        >
          {running ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      <div className="grid grid-cols-3 gap-2 text-[11px]">
        <div className="bg-[#161b22] rounded px-2 py-1">
          <div className="text-gray-500">ARV (mid)</div>
          <div className="text-gray-200 font-semibold text-sm">
            {formatCurrency(listing.realArvMedian)}
          </div>
        </div>
        <div className="bg-[#161b22] rounded px-2 py-1">
          <div className="text-gray-500">Floor (V2.1)</div>
          <div className={`font-semibold text-sm ${exceedsSoftCeiling ? "text-orange-300" : "text-gray-200"}`}>
            {formatCurrency(floor)}
          </div>
        </div>
        <div className="bg-[#161b22] rounded px-2 py-1">
          <div className="text-gray-500">Comps</div>
          <div className="text-gray-200 font-semibold text-sm">
            {listing.arvCompCount ?? comps.length ?? "—"}
          </div>
        </div>
      </div>
      {exceedsSoftCeiling && (
        <p className="text-[10px] text-orange-300">
          ⚠ Floor exceeds 75% of List ({formatCurrency(softCeiling)}) — review math before locking
        </p>
      )}
      <div className="flex items-center justify-between text-[10px] text-gray-500">
        <span>Avg ${listing.arvCompAvgPrSqFt?.toFixed(0) ?? "—"}/sqft</span>
        <span>Validated {formatAge(listing.arvValidatedAt)}</span>
      </div>
      {comps.length > 0 && (
        <div className="border-t border-[#21262d] pt-2">
          <button
            type="button"
            onClick={() => setShowComps((v) => !v)}
            className="text-[10px] text-gray-400 hover:text-gray-200"
            aria-expanded={showComps}
          >
            {showComps ? "▴ Hide" : "▾ Show"} {comps.length} comps
          </button>
          {showComps && (
            <div className="mt-2 max-h-[300px] overflow-y-auto">
              <table className="w-full text-[10px]">
                <thead className="text-gray-500">
                  <tr className="border-b border-[#30363d]">
                    <th className="text-left pb-1 pr-2">Address</th>
                    <th className="text-left pb-1 pr-2">Price</th>
                    <th className="text-left pb-1 pr-2">SqFt</th>
                    <th className="text-left pb-1 pr-2">$/sqft</th>
                    <th className="text-left pb-1 pr-2">Dist</th>
                    <th className="text-left pb-1 pr-2">Sold</th>
                    <th className="text-left pb-1">Verify</th>
                  </tr>
                </thead>
                <tbody className="text-gray-300">
                  {comps.slice(0, 25).map((c, i) => {
                    const addr = c.formatted_address ?? null;
                    return (
                      <tr key={i} className="border-b border-[#21262d]">
                        <td className="py-1 pr-2 text-gray-200">
                          {addr ?? <span className="text-gray-600 italic">address pending</span>}
                        </td>
                        <td className="py-1 pr-2 font-mono">{formatCurrency(c.price)}</td>
                        <td className="py-1 pr-2">{c.sqft ?? "—"}</td>
                        <td className="py-1 pr-2 font-mono">${c.per_sqft?.toFixed(0) ?? "—"}</td>
                        <td className="py-1 pr-2">{c.distance != null ? `${c.distance.toFixed(2)}mi` : "—"}</td>
                        <td className="py-1 pr-2 text-gray-500">{c.sale_date?.slice(0, 10) ?? "—"}</td>
                        <td className="py-1">
                          {addr ? (
                            <span className="flex gap-1.5">
                              <a
                                href={zillowLookupUrl(addr)}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-blue-400 hover:text-blue-300 underline"
                                title={`Look up ${addr} on Zillow`}
                              >
                                Z
                              </a>
                              <a
                                href={redfinLookupUrl(addr)}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-red-400 hover:text-red-300 underline"
                                title={`Look up ${addr} on Redfin (via Google site search)`}
                              >
                                R
                              </a>
                            </span>
                          ) : (
                            <span className="text-gray-700">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {comps.length > 25 && (
                <p className="text-[10px] text-gray-600 mt-1">+{comps.length - 25} more truncated</p>
              )}
            </div>
          )}
        </div>
      )}
      {error && <p className="text-[10px] text-red-400">{error}</p>}
    </div>
  );
}
