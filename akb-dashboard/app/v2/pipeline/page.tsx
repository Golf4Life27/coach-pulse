"use client";

// PIPELINE — the conveyor. Two lanes:
//   1. STOCK (live): every active listing grouped by pipeline stage, from
//      /api/listings. Click a stage → records + why they sit there.
//   2. LAST BATCH FUNNEL (adapter): the outreach-batch funnel-audit buckets.
//      Live once ops ships /api/admin/funnel-snapshot (request #2); until
//      then a loudly-labeled simulated fixture proves the lane.

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { ListingDetail } from "../_lib/types";
import { ago, money } from "../_lib/format";
import {
  BUCKET_META,
  fetchFunnelSnapshot,
  type Disposition,
  type FunnelSnapshotResult,
} from "../_lib/funnel";

// Stage order mirrors the loop: find → verify → price → offer → negotiate.
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
  // Stage-less rows fall back to outreach status so nothing hides.
  const o = (l.outreachStatus ?? "").toLowerCase().trim();
  if (o === "negotiating") return "negotiating";
  if (o === "response received") return "responded";
  if (o === "texted" || o === "emailed") return "texted";
  return "(no stage)";
}

export default function PipelinePage() {
  const [listings, setListings] = useState<ListingDetail[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [funnel, setFunnel] = useState<FunnelSnapshotResult | null>(null);
  const [stageOpen, setStageOpen] = useState<string | null>(null);
  const [bucketOpen, setBucketOpen] = useState<Disposition | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch("/api/listings", { cache: "no-store" });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        setListings((await r.json()) as ListingDetail[]);
      } catch (e) {
        setError(String(e));
      }
      setFunnel(await fetchFunnelSnapshot());
    })();
  }, []);

  const stages = useMemo(() => {
    const m = new Map<string, ListingDetail[]>();
    for (const l of listings ?? []) {
      const s = stageOf(l);
      if (!m.has(s)) m.set(s, []);
      m.get(s)!.push(l);
    }
    const known = STAGE_ORDER.filter((s) => m.has(s));
    const rest = [...m.keys()].filter((s) => !STAGE_ORDER.includes(s)).sort();
    return [...known, ...rest].map((s) => ({ stage: s, items: m.get(s)! }));
  }, [listings]);

  return (
    <div className="space-y-6">
      {/* Lane 1 — live stock by stage */}
      <section>
        <h1 className="mb-2 text-xs font-black tracking-[0.2em] text-zinc-400">
          STOCK BY STAGE
          <span className="ml-2 font-normal tracking-normal text-zinc-600">
            {listings ? `${listings.length} active records (live, /api/listings — dead excluded)` : "loading…"}
          </span>
        </h1>
        {error && (
          <p className="rounded-lg border border-red-900/60 bg-red-950/30 px-3 py-2 text-xs text-red-300">
            listings unreachable — {error}
          </p>
        )}
        {!listings && !error && (
          <div className="h-24 animate-pulse rounded-xl border border-zinc-800 bg-zinc-900/40" />
        )}
        {listings && (
          <div className="flex gap-1.5 overflow-x-auto pb-1 no-scrollbar">
            {stages.map(({ stage, items }) => (
              <button
                key={stage}
                onClick={() => setStageOpen(stageOpen === stage ? null : stage)}
                className={`min-w-[6.5rem] shrink-0 rounded-lg border px-3 py-2 text-left transition-colors ${
                  stageOpen === stage
                    ? "border-cyan-700 bg-cyan-950/30"
                    : "border-zinc-800 bg-[#0b0e13] hover:border-zinc-600"
                }`}
              >
                <p className="font-mono text-lg font-bold text-zinc-100">{items.length}</p>
                <p className="truncate text-[9px] font-bold uppercase tracking-wider text-zinc-500">{stage}</p>
              </button>
            ))}
          </div>
        )}
        {stageOpen && listings && (
          <StageDrill
            stage={stageOpen}
            items={stages.find((s) => s.stage === stageOpen)?.items ?? []}
          />
        )}
      </section>

      {/* Lane 2 — last batch funnel audit */}
      <section>
        <h2 className="mb-2 text-xs font-black tracking-[0.2em] text-zinc-400">
          LAST BATCH FUNNEL
          {funnel && (
            <span className="ml-2 font-normal tracking-normal text-zinc-600">
              {funnel.source === "live"
                ? `${funnel.snapshot.mode} run, ${ago(funnel.snapshot.generated_at)}${funnel.snapshot.params.zips ? ` · zips ${funnel.snapshot.params.zips.join(",")}` : ""}`
                : "awaiting ops snapshot route"}
            </span>
          )}
        </h2>

        {funnel?.source === "simulated" && (
          <div className="mb-2 rounded-lg border border-amber-700/70 bg-amber-950/30 px-3 py-2 text-[11px] font-bold tracking-wide text-amber-300">
            ⚠ SIMULATED DATA — shape-true fixture. Goes live when ops ships{" "}
            <code className="rounded bg-zinc-800 px-1 font-mono text-[10px]">/api/admin/funnel-snapshot</code>{" "}
            (request #2, queued). No real records below.
          </div>
        )}

        {!funnel ? (
          <div className="h-24 animate-pulse rounded-xl border border-zinc-800 bg-zinc-900/40" />
        ) : (
          <>
            <FunnelInvariant funnel={funnel} />
            <div className="mt-2 grid grid-cols-3 gap-1.5 sm:grid-cols-5 lg:grid-cols-9">
              {(Object.keys(BUCKET_META) as Disposition[]).map((d) => {
                const n = funnel.snapshot.funnel_audit.bucket_counts[d] ?? 0;
                const meta = BUCKET_META[d];
                const tone =
                  meta.tone === "go"
                    ? "text-emerald-300"
                    : meta.tone === "hold"
                      ? "text-amber-300"
                      : "text-zinc-400";
                return (
                  <button
                    key={d}
                    onClick={() => setBucketOpen(bucketOpen === d ? null : d)}
                    className={`rounded-lg border px-2 py-2 text-left transition-colors ${
                      bucketOpen === d
                        ? "border-cyan-700 bg-cyan-950/30"
                        : n > 0
                          ? "border-zinc-800 bg-[#0b0e13] hover:border-zinc-600"
                          : "border-zinc-900 bg-transparent opacity-50"
                    }`}
                  >
                    <p className={`font-mono text-base font-bold ${n > 0 ? tone : "text-zinc-700"}`}>{n}</p>
                    <p className="text-[8px] font-bold tracking-wider text-zinc-500">{meta.label}</p>
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
      className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-[11px] ${
        holds ? "border-emerald-900/50 bg-emerald-950/15 text-emerald-300" : "border-red-900/60 bg-red-950/30 text-red-300"
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
    <div className="mt-2 rounded-xl border border-zinc-800 bg-[#0b0e13] p-3">
      <p className="mb-1 text-[10px] font-bold tracking-wider text-zinc-300">
        {meta.label} <span className="font-normal text-zinc-500">— {meta.desc}</span>
      </p>
      {rows.length === 0 ? (
        <p className="text-[11px] text-zinc-600">
          {sim ? "fixture carries no sample rows for this bucket" : "snapshot carries no rows for this bucket"}
        </p>
      ) : (
        <div className="space-y-1">
          {rows.map((r) => (
            <div key={r.recordId} className="flex flex-wrap items-baseline gap-x-2 rounded border border-zinc-800/70 px-2.5 py-2 text-sm">
              {sim ? (
                <span className="text-zinc-400">{r.address ?? r.recordId}</span>
              ) : (
                <Link href={`/v2/deal/${r.recordId}`} className="font-bold text-cyan-300 hover:underline">
                  {r.address ?? r.recordId}
                </Link>
              )}
              {r.zip && <span className="text-zinc-600">{r.zip}</span>}
              {r.reason && <span className="text-zinc-500">{r.reason}</span>}
              {r.prior && <span className="text-amber-400/80">prior: {r.prior.address} ({r.prior.status})</span>}
              {sim && <span className="ml-auto text-[9px] font-bold text-amber-400">SIM</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function StageDrill({ stage, items }: { stage: string; items: ListingDetail[] }) {
  const sorted = [...items].sort((a, b) => (b.dom ?? 0) - (a.dom ?? 0));
  return (
    <div className="mt-2 rounded-xl border border-zinc-800 bg-[#0b0e13] p-3">
      <p className="mb-1.5 text-[10px] font-bold uppercase tracking-wider text-zinc-300">
        {stage} — {items.length} records
      </p>
      <div className="max-h-80 space-y-1 overflow-y-auto">
        {sorted.slice(0, 100).map((l) => (
          <Link
            key={l.id}
            href={`/v2/deal/${l.id}`}
            className="flex flex-wrap items-baseline gap-x-2 rounded border border-zinc-800/70 px-2.5 py-2 text-sm hover:border-cyan-800"
          >
            <span className="font-bold text-zinc-200">{l.address}</span>
            <span className="text-zinc-600">{l.zip}</span>
            <span className="font-mono text-zinc-500">{money(l.listPrice)}</span>
            {l.outreachStatus && <span className="text-zinc-500">{l.outreachStatus}</span>}
            {l.dom != null && <span className="ml-auto font-mono text-[10px] text-zinc-600">DOM {l.dom}</span>}
          </Link>
        ))}
        {sorted.length > 100 && (
          <p className="px-2 text-[10px] text-zinc-600">+{sorted.length - 100} more — narrow in v1 Pipeline for now</p>
        )}
      </div>
    </div>
  );
}
