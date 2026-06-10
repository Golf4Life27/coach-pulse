"use client";

// FUNNEL — the conveyor, AKBdash-styled V1 tab. Two lanes:
//   1. Stock by stage (LIVE): the shared provider's listings grouped by
//      pipeline stage; click a stage for records, drill to /pipeline/[id].
//   2. Last batch funnel (adapter): the outreach-batch funnel-audit buckets.
//      Loudly-labeled SIMULATED fixture until ops ships the snapshot route
//      (request #2, first in ops priority) — then flips live, no UI change.
// Named FUNNEL (not PIPELINE) so it doesn't collide with V1's PIPELINE tab.

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useV2Data } from "../_lib/data";
import type { ListingDetail } from "../_lib/types";
import { ago, money } from "../_lib/format";
import { translateReason } from "../_lib/translate";
import {
  BUCKET_META,
  fetchFunnelSnapshot,
  type Disposition,
  type FunnelSnapshotResult,
} from "../_lib/funnel";

const STAGE_ORDER = [
  "intake",
  "enriched",
  "verified",
  "underwritten",
  "outreach_ready",
  "texted",
  "responded",
  "negotiating",
  "dd",
  "contract",
];

function stageOf(l: ListingDetail): string {
  const s = (l.pipelineStage ?? "").toLowerCase().trim();
  if (s) return s;
  const o = (l.outreachStatus ?? "").toLowerCase().trim();
  if (o === "negotiating") return "negotiating";
  if (o === "response received") return "responded";
  if (o === "texted" || o === "emailed") return "texted";
  return "(no stage)";
}

export default function FunnelBoard() {
  const { listings, loading, refresh, lastFetched } = useV2Data();
  const [funnel, setFunnel] = useState<FunnelSnapshotResult | null>(null);
  const [stageOpen, setStageOpen] = useState<string | null>(null);
  const [bucketOpen, setBucketOpen] = useState<Disposition | null>(null);

  useEffect(() => {
    fetchFunnelSnapshot().then(setFunnel);
  }, []);

  // Active surface only (provider fetches include_dead for queue hygiene).
  const active = useMemo(
    () =>
      (listings ?? []).filter((l) => {
        const stage = (l.pipelineStage ?? "").toLowerCase();
        const status = (l.outreachStatus ?? "").toLowerCase();
        return stage !== "dead" && status !== "dead";
      }),
    [listings],
  );

  const stages = useMemo(() => {
    const m = new Map<string, ListingDetail[]>();
    for (const l of active) {
      const s = stageOf(l);
      if (!m.has(s)) m.set(s, []);
      m.get(s)!.push(l);
    }
    const known = STAGE_ORDER.filter((s) => m.has(s));
    const rest = [...m.keys()].filter((s) => !STAGE_ORDER.includes(s)).sort();
    return [...known, ...rest].map((s) => ({ stage: s, items: m.get(s)! }));
  }, [active]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-white">FUNNEL</h1>
          <p className="text-[10px] text-gray-600">
            {listings ? `${active.length} active records` : "loading…"}
            {lastFetched ? ` · updated ${new Date(lastFetched).toLocaleTimeString()}` : ""}
          </p>
        </div>
        <button
          type="button"
          onClick={refresh}
          disabled={loading}
          className="text-xs bg-[#1c2128] border border-[#30363d] text-gray-300 px-3 py-1.5 rounded hover:bg-[#30363d] disabled:opacity-50 transition-colors"
        >
          {loading ? "Loading..." : "Refresh"}
        </button>
      </div>

      {/* Lane 1 — live stock by stage */}
      <section className="bg-[#161b22] rounded-lg border border-[#30363d] p-4 space-y-3">
        <h2 className="text-sm font-bold uppercase tracking-widest text-gray-400">Stock by Stage</h2>
        {!listings ? (
          <div className="h-20 animate-pulse rounded-lg border border-[#30363d] bg-[#1c2128]" />
        ) : (
          <div className="flex gap-1.5 overflow-x-auto pb-1">
            {stages.map(({ stage, items }) => (
              <button
                key={stage}
                type="button"
                onClick={() => setStageOpen(stageOpen === stage ? null : stage)}
                className={`min-w-[6.5rem] shrink-0 rounded-lg border px-3 py-2 text-left transition-colors ${
                  stageOpen === stage
                    ? "bg-emerald-700/20 border-emerald-500"
                    : "bg-[#1c2128] border-[#30363d] hover:border-gray-600"
                }`}
              >
                <p className="font-mono text-lg font-bold text-white">{items.length}</p>
                <p className="truncate text-[9px] font-bold uppercase tracking-wider text-gray-500">{stage}</p>
              </button>
            ))}
          </div>
        )}
        {stageOpen && listings && (
          <StageDrill stage={stageOpen} items={stages.find((s) => s.stage === stageOpen)?.items ?? []} />
        )}
      </section>

      {/* Lane 2 — last batch funnel audit */}
      <section className="bg-[#161b22] rounded-lg border border-[#30363d] p-4 space-y-3">
        <h2 className="text-sm font-bold uppercase tracking-widest text-gray-400">
          Last Batch Funnel
          {funnel && (
            <span className="ml-2 font-normal normal-case tracking-normal text-[10px] text-gray-600">
              {funnel.source === "live"
                ? `${funnel.snapshot.mode} run, ${ago(funnel.snapshot.generated_at)}${funnel.snapshot.params.zips ? ` · zips ${funnel.snapshot.params.zips.join(",")}` : ""}`
                : "awaiting ops snapshot route"}
            </span>
          )}
        </h2>

        {funnel?.source === "simulated" && (
          <div className="bg-amber-500/10 border border-amber-500/40 rounded px-3 py-2 text-xs font-semibold text-amber-300">
            ⚠ SIMULATED DATA — shape-true fixture. Goes live when ops ships{" "}
            <code className="bg-[#0d1117] px-1 rounded font-mono text-[10px]">/api/admin/funnel-snapshot</code>{" "}
            (request #2, first in ops priority). No real records below.
          </div>
        )}

        {!funnel ? (
          <div className="h-20 animate-pulse rounded-lg border border-[#30363d] bg-[#1c2128]" />
        ) : (
          <>
            <FunnelInvariant funnel={funnel} />
            <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-5 lg:grid-cols-9">
              {(Object.keys(BUCKET_META) as Disposition[]).map((d) => {
                const n = funnel.snapshot.funnel_audit.bucket_counts[d] ?? 0;
                const meta = BUCKET_META[d];
                const tone =
                  meta.tone === "go" ? "text-emerald-300" : meta.tone === "hold" ? "text-amber-300" : "text-gray-400";
                return (
                  <button
                    key={d}
                    type="button"
                    onClick={() => setBucketOpen(bucketOpen === d ? null : d)}
                    className={`rounded-lg border px-2 py-2 text-left transition-colors ${
                      bucketOpen === d
                        ? "bg-emerald-700/20 border-emerald-500"
                        : n > 0
                          ? "bg-[#1c2128] border-[#30363d] hover:border-gray-600"
                          : "border-[#30363d]/50 bg-transparent opacity-50"
                    }`}
                  >
                    <p className={`font-mono text-base font-bold ${n > 0 ? tone : "text-gray-700"}`}>{n}</p>
                    <p className="text-[8px] font-bold tracking-wider text-gray-500">{meta.label}</p>
                  </button>
                );
              })}
            </div>
            {bucketOpen && <BucketDrill funnel={funnel} bucket={bucketOpen} />}
          </>
        )}
      </section>
    </div>
  );
}

function FunnelInvariant({ funnel }: { funnel: FunnelSnapshotResult }) {
  const fa = funnel.snapshot.funnel_audit;
  const holds = fa.missing_from_funnel.length === 0 && fa.disposition_total === fa.input_count;
  return (
    <div
      className={`flex items-center gap-2 rounded px-3 py-1.5 text-xs border ${
        holds
          ? "bg-emerald-500/10 border-emerald-500/40 text-emerald-300"
          : "bg-red-500/10 border-red-500/40 text-red-300"
      }`}
    >
      <span>{holds ? "✓" : "✗"}</span>
      <span>
        invariant: {fa.input_count} in-scope leads → {fa.disposition_total} dispositions
        {holds
          ? " — every lead in exactly one bucket"
          : ` — ${fa.missing_from_funnel.length} MISSING FROM FUNNEL (new drop seam)`}
      </span>
    </div>
  );
}

function BucketDrill({ funnel, bucket }: { funnel: FunnelSnapshotResult; bucket: Disposition }) {
  const meta = BUCKET_META[bucket];
  const rows = funnel.snapshot.dispositions.filter((d) => d.disposition === bucket);
  const sim = funnel.source === "simulated";
  return (
    <div className="bg-[#1c2128] rounded-lg border border-[#30363d] p-3 space-y-1">
      <p className="text-xs font-semibold text-gray-300">
        {meta.label} <span className="font-normal text-gray-500">— {meta.desc}</span>
      </p>
      {rows.length === 0 ? (
        <p className="text-xs text-gray-600">
          {sim ? "fixture carries no sample rows for this bucket" : "snapshot carries no rows for this bucket"}
        </p>
      ) : (
        rows.map((r) => (
          <div key={r.recordId} className="flex flex-wrap items-baseline gap-x-2 bg-[#0d1117] border border-[#30363d] rounded px-3 py-2 text-xs">
            {sim ? (
              <span className="text-gray-400">{r.address ?? r.recordId}</span>
            ) : (
              <Link href={`/pipeline/${r.recordId}`} className="font-semibold text-blue-400 hover:underline">
                {r.address ?? r.recordId}
              </Link>
            )}
            {r.zip && <span className="text-gray-600">{r.zip}</span>}
            {r.reason && <span className="text-gray-500">{translateReason(r.reason)}</span>}
            {r.prior && <span className="text-amber-400/80">prior: {r.prior.address} ({r.prior.status})</span>}
            {sim && <span className="ml-auto text-[9px] font-bold text-amber-400">SIM</span>}
          </div>
        ))
      )}
    </div>
  );
}

function StageDrill({ stage, items }: { stage: string; items: ListingDetail[] }) {
  const sorted = useMemo(() => [...items].sort((a, b) => (b.dom ?? 0) - (a.dom ?? 0)), [items]);
  return (
    <div className="bg-[#1c2128] rounded-lg border border-[#30363d] p-3 space-y-1">
      <p className="text-xs font-semibold uppercase tracking-wider text-gray-300">
        {stage} — {items.length} records
      </p>
      <div className="max-h-80 space-y-1 overflow-y-auto">
        {sorted.slice(0, 100).map((l) => (
          <Link
            key={l.id}
            href={`/pipeline/${l.id}`}
            className="flex flex-wrap items-baseline gap-x-2 bg-[#0d1117] border border-[#30363d] rounded px-3 py-2 text-xs hover:border-gray-600 transition-colors"
          >
            <span className="font-semibold text-gray-200">{l.address}</span>
            <span className="text-gray-600">{l.zip}</span>
            <span className="font-mono text-gray-500">{money(l.listPrice)}</span>
            {l.outreachStatus && <span className="text-gray-500">{l.outreachStatus}</span>}
            {l.dom != null && <span className="ml-auto font-mono text-[10px] text-gray-600">DOM {l.dom}</span>}
          </Link>
        ))}
        {sorted.length > 100 && (
          <p className="px-2 text-[10px] text-gray-600">+{sorted.length - 100} more — narrow in PIPELINE</p>
        )}
      </div>
    </div>
  );
}
