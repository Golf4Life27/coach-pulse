"use client";

// DECISION CARD (decision-math build, 2026-07-13) — the 15-second go/no-go
// glance on every deal room. Leads with the verdict badge (icon AND label,
// never color alone), then the stat row, the price waterfall, the all-in
// meter against the 70% line, and the flags line (exit lane, sources, DOM,
// lien/estate signals — the class that nearly broke Cheyenne).
//
// The math renders LIVE from the same pure module the server persists with
// (lib/decision-math) — one formula, two surfaces, no drift. The stored
// Decision_* fields are the queryable copy; the card trusts the module.
//
// NEEDS_DATA / HOLD_LOW_CONF states say exactly what's missing and offer a
// one-click "Underwrite now" (ARV → rehab via the existing appraiser routes,
// dashboard-session auth). Type 1 throughout: compute + display only.
//
// Mark colors validated for the dark surface (dataviz six-checks on
// #1c2128): value bars #3987e5, our-offer bar #199e70; deduction bars are
// muted gray and always carry direct −$ labels (identity never color-alone).

import { useMemo, useState } from "react";
import type { Listing } from "@/lib/types";
import {
  computeDecisionMath,
  decisionInputsFromListing,
  ALL_IN_MAX,
  type DecisionVerdict,
} from "@/lib/decision-math";
import { showToast } from "@/components/Toast";

const VERDICT_STYLE: Record<DecisionVerdict, { chip: string; icon: string; label: string }> = {
  GO: { chip: "bg-emerald-950/60 text-emerald-300 border-emerald-500/40", icon: "✓", label: "GO" },
  TIGHT: { chip: "bg-amber-950/60 text-amber-300 border-amber-500/40", icon: "▲", label: "TIGHT" },
  PASS: { chip: "bg-red-950/60 text-red-300 border-red-500/40", icon: "✕", label: "PASS" },
  NEEDS_DATA: { chip: "bg-[#30363d] text-gray-300 border-gray-500/40", icon: "◌", label: "NEEDS DATA" },
  HOLD_LOW_CONF: { chip: "bg-[#30363d] text-gray-300 border-gray-500/40", icon: "⏸", label: "HOLD — LOW CONF" },
};

const BAR_VALUE = "#3987e5"; // validated blue — value milestones
const BAR_OFFER = "#199e70"; // validated aqua — our price
const BAR_DEDUCT = "#4b5563"; // muted gray — deductions (direct-labeled)

function usd(n: number | null | undefined): string {
  return n == null || !Number.isFinite(n) ? "—" : `$${Math.round(n).toLocaleString("en-US")}`;
}

/** Deal-risk signals from the notes ledger (estate/lien/probate — what
 *  nearly broke Cheyenne). Mirrors lib/recommended-reply.flagsFromNotes,
 *  reimplemented here because that module is server-only. */
function riskFlags(notes: string | null | undefined): string[] {
  const s = (notes ?? "").toLowerCase();
  const out: string[] = [];
  if (/\blien(?:s|holder)?\b/.test(s)) out.push("lien on record");
  if (/\bestate\b|\bexecut(?:or|rix)\b|\bheir(?:s)?\b/.test(s)) out.push("estate sale");
  if (/\bprobate\b|\bletters\s+testamentary\b/.test(s)) out.push("probate");
  if (/\bback\s+tax(?:es)?\b|\b(?:water|utility|sewer)\s+bill\b/.test(s)) out.push("bills/taxes owed");
  return out;
}

function WaterfallRow(props: {
  label: string;
  value: number | null;
  maxAbs: number;
  color: string;
  deduction?: boolean;
  emphasize?: boolean;
}) {
  const { label, value, maxAbs, color, deduction, emphasize } = props;
  const width = value == null || maxAbs <= 0 ? 0 : Math.max(2, Math.min(100, (Math.abs(value) / maxAbs) * 100));
  return (
    <div className="flex items-center gap-2" title={`${label}: ${deduction ? "−" : ""}${usd(value)}`}>
      <span className="w-28 shrink-0 text-[10px] text-gray-500 truncate">{label}</span>
      <div className="flex-1 h-[10px] rounded-r-[4px] overflow-hidden bg-transparent">
        <div
          className="h-full rounded-r-[4px]"
          style={{ width: `${width}%`, backgroundColor: color, opacity: deduction ? 0.75 : 1 }}
        />
      </div>
      <span className={`w-20 shrink-0 text-right text-[11px] tabular-nums ${emphasize ? "font-bold text-gray-100" : "text-gray-300"}`}>
        {deduction && value != null ? "−" : ""}
        {usd(value)}
      </span>
    </div>
  );
}

export default function DecisionCard({
  listing,
  onRefresh,
}: {
  listing: Listing;
  onRefresh?: () => void;
}) {
  const [underwriting, setUnderwriting] = useState(false);

  const d = useMemo(() => computeDecisionMath(decisionInputsFromListing(listing)), [listing]);
  const v = VERDICT_STYLE[d.verdict];
  const flags = useMemo(() => riskFlags(listing.notes), [listing.notes]);
  const w = d.waterfall;
  const maxAbs = Math.max(w.arv ?? 0, d.currentPrice ?? 0, 1);

  // All-in meter: track spans 0→100% of ARV; threshold tick at the 70% line.
  const allInPct = d.allInPctArv != null ? d.allInPctArv * 100 : null;
  const allInOk = d.allInPctArv != null && d.allInPctArv <= ALL_IN_MAX;

  const runUnderwrite = async () => {
    if (underwriting) return;
    setUnderwriting(true);
    try {
      showToast("Underwriting — comps first, then rehab (1-3 min)…", "success");
      const arvRes = await fetch(`/api/agents/appraiser/arv/${listing.id}`, { cache: "no-store" });
      if (!arvRes.ok) {
        const b = await arvRes.json().catch(() => ({}));
        showToast(`ARV failed: ${b.error ?? arvRes.status}`);
        return;
      }
      const rehabRes = await fetch(`/api/agents/appraiser/rehab/${listing.id}`, { cache: "no-store" });
      if (!rehabRes.ok) showToast("ARV done; rehab vision failed — card shows partial math");
      else showToast("Underwrite complete ✓", "success");
      onRefresh?.();
    } catch {
      showToast("Underwrite failed");
    } finally {
      setUnderwriting(false);
    }
  };

  return (
    <div className="bg-[#1c2128] rounded-lg border border-[#30363d] p-4 space-y-3">
      {/* Verdict header */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <h3 className="text-[10px] font-bold text-gray-500 uppercase tracking-wider">Decision</h3>
          <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-xs font-bold ${v.chip}`}>
            <span aria-hidden>{v.icon}</span>
            {v.label}
          </span>
          {/* Exit auto-sort (2026-07-16): the machine's suggested close lane —
              which game this deal is. The record's persisted Suggested_Exit
              (e.g. a seller-debt disclosure) wins over the live compute when
              the compute can't say (unknown). */}
          {(() => {
            const lane =
              d.suggestedExit !== "unknown"
                ? d.suggestedExit
                : ((listing.suggestedExit as string | null) ?? "unknown");
            if (lane === "unknown") return null;
            const style: Record<string, string> = {
              wholesale: "bg-emerald-950/60 text-emerald-300 border-emerald-500/40",
              rental: "bg-sky-950/60 text-sky-300 border-sky-500/40",
              creative_candidate: "bg-purple-950/60 text-purple-300 border-purple-500/40",
              dead: "bg-red-950/60 text-red-300 border-red-500/40",
            };
            const label: Record<string, string> = {
              wholesale: "🏷 wholesale",
              rental: "🏠 rental",
              creative_candidate: "🔄 creative / takeover",
              dead: "☠ no exit",
            };
            return (
              <span
                className={`inline-flex items-center px-2 py-0.5 rounded-full border text-[10px] font-bold ${style[lane] ?? ""}`}
                title="Machine-suggested exit lane (auto-sort). Your Exit_Strategy ruling on the pre-contract gate is the final call."
              >
                {label[lane] ?? lane}
              </span>
            );
          })()}
          <span className="text-[10px] text-gray-500">
            conf {d.confidence}
            {d.ceilingLane ? ` · ${d.ceilingLane === "flip" ? "flip exit" : "landlord exit"}` : ""}
          </span>
        </div>
        {listing.decisionComputedAt && (
          <span className="text-[10px] text-gray-600">
            stored {new Date(listing.decisionComputedAt).toLocaleString()}
          </span>
        )}
      </div>

      {/* Reason line — always show WHY, in plain words */}
      <p className="text-[11px] text-gray-400 leading-relaxed">{d.reason}</p>

      {/* Stat row */}
      <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
        {[
          { label: "List", value: usd(listing.listPrice), sub: null as string | null },
          { label: `Our ${d.priceSource === "none" ? "price" : d.priceSource}`, value: usd(d.currentPrice), sub: null },
          { label: "ARV", value: usd(w.arv), sub: listing.arvConfidence ?? null },
          {
            label: "Rehab",
            value: usd(w.rehab),
            sub: listing.rehabConfidenceScore != null ? `vision ${Math.round(listing.rehabConfidenceScore)}` : w.rehab != null ? "manual" : null,
          },
          { label: "MAO", value: usd(d.yourMao), sub: null },
          { label: "Your fee", value: usd(d.dealSpread), sub: null },
        ].map((s) => (
          <div key={s.label} className="bg-[#0d1117] border border-[#30363d] rounded p-2">
            <div className="text-[9px] text-gray-500 uppercase tracking-wider truncate">{s.label}</div>
            <div className="text-sm font-bold text-gray-100 tabular-nums">{s.value}</div>
            {s.sub && <div className="text-[9px] text-gray-500">{s.sub}</div>}
          </div>
        ))}
      </div>

      {/* Waterfall — ARV → ×70% → −rehab −closing = ceiling → −fee = MAO,
          then our price vs the ceiling. Deductions muted + minus-labeled. */}
      {w.arv != null ? (
        <div className="space-y-[2px]">
          <WaterfallRow label="ARV (comps)" value={w.arv} maxAbs={maxAbs} color={BAR_VALUE} />
          <WaterfallRow label="× 70% rule" value={w.basis} maxAbs={maxAbs} color={BAR_VALUE} />
          <WaterfallRow label="− rehab" value={w.rehab} maxAbs={maxAbs} color={BAR_DEDUCT} deduction />
          <WaterfallRow label="− closing 1.5%" value={w.closing} maxAbs={maxAbs} color={BAR_DEDUCT} deduction />
          <WaterfallRow label="= buyer ceiling" value={w.buyerCeilingFlip} maxAbs={maxAbs} color={BAR_VALUE} emphasize />
          <WaterfallRow label={`− fee`} value={w.fee} maxAbs={maxAbs} color={BAR_DEDUCT} deduction />
          <WaterfallRow label="= your MAO" value={w.yourMaoFlip} maxAbs={maxAbs} color={BAR_VALUE} emphasize />
          {d.currentPrice != null && (
            <div className="pt-1.5 mt-1.5 border-t border-[#30363d] space-y-[2px]">
              <WaterfallRow label={`our ${d.priceSource}`} value={d.currentPrice} maxAbs={maxAbs} color={BAR_OFFER} emphasize />
              <WaterfallRow label="buyer ceiling" value={d.buyerCeiling} maxAbs={maxAbs} color={BAR_VALUE} />
            </div>
          )}
        </div>
      ) : (
        <p className="text-[11px] text-gray-600 italic">No ARV on record — the waterfall renders once comps land.</p>
      )}

      {/* All-in meter vs the 70% line */}
      {allInPct != null && (
        <div title={`All-in (price + rehab) = ${allInPct.toFixed(1)}% of ARV; target ≤ ${ALL_IN_MAX * 100}%`}>
          <div className="flex items-center justify-between text-[10px] mb-1">
            <span className="text-gray-500 uppercase tracking-wider">All-in % of ARV</span>
            <span className={allInOk ? "text-emerald-300" : "text-red-300"}>
              {allInOk ? "✓" : "✕"} {allInPct.toFixed(1)}% {allInOk ? "≤" : ">"} {ALL_IN_MAX * 100}%
            </span>
          </div>
          <div className="relative h-[10px] bg-[#0d1117] border border-[#30363d] rounded overflow-hidden">
            <div
              className="h-full rounded-r-[4px]"
              style={{
                width: `${Math.min(100, allInPct)}%`,
                backgroundColor: allInOk ? "#10b981" : "#ef4444",
              }}
            />
            <div
              className="absolute top-0 bottom-0 w-[2px] bg-gray-300"
              style={{ left: `${ALL_IN_MAX * 100}%` }}
              title="70% line"
            />
          </div>
        </div>
      )}

      {/* Flags line — exit/source/DOM + the deal-risk signals */}
      <div className="flex flex-wrap gap-1.5 text-[10px]">
        {listing.openerBasis && (
          <span className="px-2 py-0.5 rounded bg-[#0d1117] border border-[#30363d] text-gray-400">
            opener: {listing.openerBasis}
          </span>
        )}
        {typeof listing.dom === "number" && (
          <span className="px-2 py-0.5 rounded bg-[#0d1117] border border-[#30363d] text-gray-400">DOM {listing.dom}</span>
        )}
        {flags.map((f) => (
          <span key={f} className="px-2 py-0.5 rounded bg-amber-950/40 border border-amber-500/30 text-amber-300">
            ⚠ {f} — title verifies payoffs
          </span>
        ))}
      </div>

      {/* Missing-data action */}
      {(d.verdict === "NEEDS_DATA" || d.verdict === "HOLD_LOW_CONF") && (
        <button
          type="button"
          disabled={underwriting}
          onClick={runUnderwrite}
          className="w-full bg-[#30363d] hover:bg-[#3d444d] text-gray-200 text-xs font-semibold py-2 rounded min-h-[44px] disabled:opacity-50"
        >
          {underwriting ? "Underwriting… (comps, then vision — 1-3 min)" : "Underwrite now (ARV + rehab)"}
        </button>
      )}
    </div>
  );
}
