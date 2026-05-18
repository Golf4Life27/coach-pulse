"use client";

/**
 * Related-deals recall panel (Phase 9.8).
 *
 * Daily UX Spec §7.1: "Related-deal recall — when Maverick remembers
 * context across deals (same agent on a prior deal, same brokerage
 * line, prior buyer interest), show that connection here as a
 * 'Related' panel."
 *
 * Wires the `maverick_recall` MCP tool via the dashboard-friendly
 * HTTP wrapper at `/api/maverick/recall`. **User-triggered only** —
 * the panel mounts in a collapsed state and only fetches when Alex
 * clicks "Recall related." This is a deliberate Phase 11.6/11.7
 * posture: no auto-polling of a synthesis-class endpoint.
 *
 * Default query: agent name (finds other deals worked with the same
 * listing agent). When agentName is null, falls back to the address.
 * Either can be overridden by Alex typing a custom query.
 *
 * Empty state ("No related deals surfaced") is the spec-mandated
 * accurate rendering — never fakes content.
 */

import { useState } from "react";
import Link from "next/link";
import type {
  RecallResponse,
  RecallResult,
} from "@/lib/maverick/recall";

export interface RelatedDealsRecallProps {
  /** Listing agent's name — default query subject. */
  agentName: string | null;
  /** Property address — fallback query when agentName is null. */
  address: string;
  /** Current record id — filtered out of the result list. */
  excludeRecordId: string;
}

const SOURCE_LABEL: Record<RecallResult["source"], string> = {
  spine: "Decision log",
  audit: "Activity",
  listings: "Listing",
  deals: "Deal",
};

export default function RelatedDealsRecall({
  agentName,
  address,
  excludeRecordId,
}: RelatedDealsRecallProps) {
  const defaultQuery = agentName ?? address;
  const [query, setQuery] = useState(defaultQuery);
  const [response, setResponse] = useState<RecallResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasRun, setHasRun] = useState(false);

  const runRecall = async () => {
    if (!query.trim() || loading) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/maverick/recall", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: query.trim(),
          sources: ["spine", "audit", "listings"],
        }),
      });
      if (!res.ok) {
        throw new Error(`recall ${res.status}`);
      }
      const body = (await res.json()) as RecallResponse;
      setResponse(body);
      setHasRun(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const results = (response?.results ?? []).filter(
    (r) => r.record_id !== excludeRecordId,
  );

  return (
    <div className="bg-[#1c2128] rounded-lg border border-[#30363d] p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-bold text-gray-300 uppercase tracking-wider">
          Related
        </h3>
        <button
          type="button"
          onClick={runRecall}
          disabled={loading || !query.trim()}
          className="text-[10px] bg-emerald-700 hover:bg-emerald-600 text-white px-2 py-1 rounded disabled:opacity-50"
        >
          {loading ? "Recalling…" : hasRun ? "Recall again" : "Recall related"}
        </button>
      </div>
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={`Search query (default: ${defaultQuery})`}
        className="w-full bg-[#0d1117] border border-[#30363d] rounded px-2 py-1.5 text-xs text-white focus:outline-none focus:border-emerald-500 placeholder-gray-600"
        onKeyDown={(e) => {
          if (e.key === "Enter") runRecall();
        }}
      />

      {error && (
        <p className="text-[11px] text-red-400">Recall failed: {error}</p>
      )}

      {!hasRun && !error && (
        <p className="text-[11px] text-gray-500 italic">
          Click "Recall related" to search the spine + activity log + listings for related context.
        </p>
      )}

      {hasRun && !error && results.length === 0 && (
        <p className="text-[11px] text-gray-500 italic">
          No related deals surfaced.
        </p>
      )}

      {results.length > 0 && (
        <ul className="space-y-1.5">
          {results.slice(0, 8).map((r) => {
            const href = isClickableListing(r) ? `/pipeline/${r.record_id}` : null;
            const body = (
              <div className="flex items-start gap-2 text-[11px]">
                <span className="text-[9px] uppercase tracking-wider text-gray-600 flex-shrink-0 w-16">
                  {SOURCE_LABEL[r.source]}
                </span>
                <span className="text-gray-300 truncate flex-1">{r.summary}</span>
              </div>
            );
            return (
              <li key={`${r.source}_${r.record_id}`}>
                {href ? (
                  <Link
                    href={href}
                    className="block px-2 py-1 rounded hover:bg-[#30363d] transition-colors"
                  >
                    {body}
                  </Link>
                ) : (
                  <div className="px-2 py-1">{body}</div>
                )}
              </li>
            );
          })}
          {response && response.truncated_to_n > 0 && (
            <li className="text-[10px] text-gray-600 px-2">
              +{response.truncated_to_n} more truncated
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

function isClickableListing(r: RecallResult): boolean {
  // Only listings/deals records map cleanly to /pipeline/[id]. Spine
  // and audit results are informational only.
  return r.source === "listings" || r.source === "deals";
}
