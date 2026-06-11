"use client";

/**
 * Appraiser rehab panel (Phase 4B.1 / Commit J.2; INV-005 manual affordance).
 *
 * State surfaces:
 *
 *   1. Listing has computed rehab (estRehabMid + rehabEstimatedAt) →
 *      render value + BBC tier + market tier + multiplier + vision
 *      confidence + red-flag chips + click-to-expand line-items table
 *      + "Refresh" button + provenance badge (Vision / Manual operator
 *      / Manual partner — INV-005). Drift banner renders when nightly
 *      retry cron flagged a divergence (Notes marker scan).
 *
 *   2. No rehab computed → "Run rehab" button. Hits the GET endpoint;
 *      on success reload the page so values land. On failure (no
 *      photos / vision call failed) the "or set manually" expander
 *      surfaces — Constitution Rule 3, manual is fallback-only.
 *
 *   3. Compute in flight → button shows "Running… (1-3 min — Vision
 *      call, leave this open)". The rehab route has maxDuration=300
 *      (Freeland P0, 2026-06-10) so the fetch is expected to hold for
 *      minutes — that is honest, not hung.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { Listing } from "@/lib/types";
import { isTestArtifact, testArtifactReason } from "@/lib/test-artifact-records";
import { BBC_ANCHOR_PER_SQFT, type BbcTier } from "@/lib/appraiser/rehab-calibration";
import {
  DRIFT_NOTES_MARKER,
  DRIFT_RESOLVED_MARKER,
  hasUnresolvedDriftMarker,
} from "@/lib/maverick/rehab-vision-retry";

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
    | "rehabSource"
    | "buildingSqFt"
    | "notes"
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

// INV-005 — automation-failure error reasons that unlock the manual
// fallback expander. The GET sibling returns these via the `error`
// field on 422/502 responses.
const UNLOCK_MANUAL_REASONS = new Set([
  "no_photos_available",
  "photo_collection_failed",
  "vision_call_failed",
]);

function ProvenanceBadge({ source }: { source: Listing["rehabSource"] | undefined }) {
  if (!source) return null;
  const style =
    source === "vision"
      ? "bg-emerald-500/15 border-emerald-500/30 text-emerald-300"
      : source === "manual_operator"
        ? "bg-amber-500/15 border-amber-500/30 text-amber-300"
        : "bg-orange-500/15 border-orange-500/30 text-orange-300";
  const label =
    source === "vision"
      ? "Vision"
      : source === "manual_operator"
        ? "Manual (operator)"
        : "Manual (partner)";
  return (
    <span
      className={`text-[9px] uppercase tracking-wider px-1 py-0.5 rounded border ${style}`}
      title={`Rehab_Source = ${source} (INV-005)`}
    >
      {label}
    </span>
  );
}

// INV-005 — drift banner parser. Walks Notes for the most recent
// DRIFT_NOTES_MARKER line and surfaces the data inline above the
// rehab panel.
function extractLatestDriftLine(notes: string | null | undefined): string | null {
  if (!notes) return null;
  const lines = notes.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].includes(DRIFT_NOTES_MARKER)) return lines[i];
  }
  return null;
}

function TestArtifactBanner({ reason }: { reason: string | null }) {
  return (
    <div className="bg-amber-950/40 border border-amber-700/60 rounded px-2 py-1.5 space-y-0.5">
      <div className="text-[10px] font-semibold text-amber-300 uppercase tracking-wider">
        ⚠ Test artifact — not production underwriting
      </div>
      <p className="text-[10px] text-amber-200/80 leading-snug">
        {reason ?? "This record's math fields are residue from debug crons. Don't reference these numbers as analysis."}
      </p>
    </div>
  );
}

export default function AppraiserRehabPanel({ recordId, listing }: AppraiserRehabPanelProps) {
  const router = useRouter();
  const [running, setRunning] = useState(false);
  const [showItems, setShowItems] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);

  // Manual form state
  const [showManual, setShowManual] = useState(false);
  const [manualMid, setManualMid] = useState("");
  const [manualLow, setManualLow] = useState("");
  const [manualHigh, setManualHigh] = useState("");
  const [manualSource, setManualSource] =
    useState<"manual_operator" | "manual_partner">("manual_operator");
  const [savingManual, setSavingManual] = useState(false);

  // Drift banner state (cron-detected vision-vs-manual divergence)
  const [resolvingDrift, setResolvingDrift] = useState<null | "accept" | "keep">(
    null,
  );

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

  const driftActive = hasUnresolvedDriftMarker(listing.notes ?? null);
  const driftLine = driftActive ? extractLatestDriftLine(listing.notes) : null;
  const testArtifact = isTestArtifact(recordId);
  const testArtifactNote = testArtifactReason(recordId);

  const runRehab = async () => {
    setError(null);
    setErrorCode(null);
    setRunning(true);
    try {
      const res = await fetch(`/api/agents/appraiser/rehab/${recordId}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setErrorCode(typeof body.error === "string" ? body.error : null);
        throw new Error(body.message ?? body.reason ?? body.error ?? `HTTP ${res.status}`);
      }
      // router.refresh() instead of window.location.reload() — the hard
      // reload was unmounting AuthGate (which then re-fetched the HttpOnly
      // cookie via /api/auth/check). On Vision-call timeouts the SPA state
      // was being lost. See app/api/auth/check/route.ts header for the
      // full AuthGate root-cause history.
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  const submitManual = async () => {
    setSavingManual(true);
    setError(null);
    try {
      const res = await fetch(`/api/agents/appraiser/rehab/${recordId}/manual`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rehab_mid: Number(manualMid),
          rehab_low: manualLow ? Number(manualLow) : undefined,
          rehab_high: manualHigh ? Number(manualHigh) : undefined,
          source: manualSource,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.reason ?? body.message ?? body.error ?? `HTTP ${res.status}`);
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingManual(false);
    }
  };

  const resolveDrift = async (action: "accept_vision" | "keep_manual") => {
    setResolvingDrift(action === "accept_vision" ? "accept" : "keep");
    try {
      const res = await fetch(
        `/api/agents/appraiser/rehab/${recordId}/drift-resolve`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ resolution: action }),
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.reason ?? body.message ?? `HTTP ${res.status}`);
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setResolvingDrift(null);
    }
  };

  const manualFormCanRender =
    error !== null && errorCode !== null && UNLOCK_MANUAL_REASONS.has(errorCode);

  if (!hasRehab) {
    return (
      <div className="bg-[#1c2128] rounded-lg border border-[#30363d] p-3 space-y-2">
        {testArtifact && <TestArtifactBanner reason={testArtifactNote} />}
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
          {running ? "Running… (1-3 min — Vision call, leave this open)" : "Run rehab"}
        </button>
        {error && <p className="text-[10px] text-red-400">{error}</p>}
        {/* INV-005 manual fallback — only renders after a vision/photo
            failure unlocks it. Rule 3 #3 + #4: NO preemptive skip. */}
        {manualFormCanRender && (
          <div className="border-t border-[#30363d] pt-2 mt-2">
            <button
              type="button"
              onClick={() => setShowManual((v) => !v)}
              className="text-[10px] text-amber-400 hover:text-amber-300"
              aria-expanded={showManual}
            >
              {showManual ? "▴ Hide manual entry" : "▾ or set manually (fallback)"}
            </button>
            {showManual && (
              <div className="mt-2 space-y-2 bg-[#161b22] rounded px-2 py-2">
                <div className="grid grid-cols-3 gap-2">
                  <label className="text-[10px] text-gray-400 flex flex-col">
                    Mid *
                    <input
                      type="number"
                      value={manualMid}
                      onChange={(e) => setManualMid(e.target.value)}
                      placeholder="25000"
                      className="bg-[#0d1117] border border-[#30363d] rounded px-1.5 py-1 text-[11px] text-gray-200"
                      min={1}
                    />
                  </label>
                  <label className="text-[10px] text-gray-400 flex flex-col">
                    Low
                    <input
                      type="number"
                      value={manualLow}
                      onChange={(e) => setManualLow(e.target.value)}
                      placeholder="auto"
                      className="bg-[#0d1117] border border-[#30363d] rounded px-1.5 py-1 text-[11px] text-gray-200"
                      min={0}
                    />
                  </label>
                  <label className="text-[10px] text-gray-400 flex flex-col">
                    High
                    <input
                      type="number"
                      value={manualHigh}
                      onChange={(e) => setManualHigh(e.target.value)}
                      placeholder="auto"
                      className="bg-[#0d1117] border border-[#30363d] rounded px-1.5 py-1 text-[11px] text-gray-200"
                      min={0}
                    />
                  </label>
                </div>
                <label className="text-[10px] text-gray-400 flex flex-col">
                  Source
                  <select
                    value={manualSource}
                    onChange={(e) =>
                      setManualSource(e.target.value as typeof manualSource)
                    }
                    className="bg-[#0d1117] border border-[#30363d] rounded px-1.5 py-1 text-[11px] text-gray-200"
                  >
                    <option value="manual_operator">manual_operator</option>
                    <option value="manual_partner">manual_partner</option>
                  </select>
                </label>
                <button
                  type="button"
                  onClick={submitManual}
                  disabled={savingManual || !manualMid}
                  className="bg-amber-700 hover:bg-amber-600 text-white text-[11px] font-semibold px-3 py-1.5 rounded disabled:opacity-50"
                >
                  {savingManual ? "Saving…" : "Save manual rehab"}
                </button>
                <p className="text-[9px] text-gray-500 italic">
                  Nightly retry will re-run vision and flag drift &gt;25% — never silently overwrites.
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={`bg-[#1c2128] rounded-lg border ${testArtifact ? "border-amber-700" : style.border} p-3 space-y-2`}>
      {testArtifact && <TestArtifactBanner reason={testArtifactNote} />}
      {/* INV-005 drift banner — only renders when cron flagged divergence */}
      {driftActive && (
        <div className="bg-amber-950/40 border border-amber-700/60 rounded px-2 py-1.5 space-y-1">
          <div className="text-[10px] font-semibold text-amber-300 uppercase tracking-wider">
            ⚠ Vision vs manual drift detected
          </div>
          {driftLine && (
            <p className="text-[10px] text-amber-200/80 leading-snug">
              {driftLine.replace(DRIFT_NOTES_MARKER, "").replace(/^[^—]+— /, "").trim()}
            </p>
          )}
          <div className="flex gap-2 pt-1">
            <button
              type="button"
              onClick={() => resolveDrift("accept_vision")}
              disabled={resolvingDrift !== null}
              className="bg-emerald-700 hover:bg-emerald-600 text-white text-[10px] font-semibold px-2 py-1 rounded disabled:opacity-50"
            >
              {resolvingDrift === "accept" ? "Accepting…" : "Accept vision update"}
            </button>
            <button
              type="button"
              onClick={() => resolveDrift("keep_manual")}
              disabled={resolvingDrift !== null}
              className="bg-[#21262d] hover:bg-[#30363d] text-gray-200 text-[10px] font-semibold px-2 py-1 rounded disabled:opacity-50"
            >
              {resolvingDrift === "keep" ? "Saving…" : "Keep manual / dismiss"}
            </button>
          </div>
        </div>
      )}
      <div className="flex items-center justify-between">
        <h3 className={`text-[10px] font-bold uppercase tracking-wider ${style.text} flex items-center gap-2`}>
          <span>Appraiser — Rehab {bbcTier ?? ""}</span>
          <ProvenanceBadge source={listing.rehabSource} />
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
void DRIFT_RESOLVED_MARKER;
