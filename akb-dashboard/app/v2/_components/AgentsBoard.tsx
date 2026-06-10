"use client";

// AGENTS — agents are the channel, not metadata on a listing. AKBdash-styled
// V1 tab. Listings come from the shared V2DataProvider (include_dead=true for
// queue hygiene), filtered here to the active surface; grouped by normalized
// agent phone. Stall-release timers stay "awaiting ops read" (request #5).

import Link from "next/link";
import { useMemo, useState } from "react";
import { useV2Data } from "../_lib/data";
import type { ListingDetail } from "../_lib/types";
import { ago, money } from "../_lib/format";

function normPhone(p: string | null): string | null {
  if (!p) return null;
  const d = p.replace(/[^0-9]/g, "");
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  return d ? `+${d}` : null;
}

function isActive(l: ListingDetail): boolean {
  const stage = (l.pipelineStage ?? "").toLowerCase();
  const status = (l.outreachStatus ?? "").toLowerCase();
  return stage !== "dead" && status !== "dead";
}

interface AgentRow {
  key: string;
  name: string;
  phone: string | null;
  listings: ListingDetail[];
  zips: Map<string, number>;
  lastInbound: string | null;
  lastOutbound: string | null;
  everReplied: number;
  texted: number;
  negotiating: number;
}

function buildAgents(listings: ListingDetail[]): AgentRow[] {
  const byKey = new Map<string, AgentRow>();
  for (const l of listings) {
    if (!isActive(l)) continue;
    const phone = normPhone(l.agentPhone);
    const key = phone ?? (l.agentName ? `name:${l.agentName.toLowerCase().trim()}` : null) ?? "";
    if (!key) continue;
    let row = byKey.get(key);
    if (!row) {
      row = {
        key,
        name: l.agentName ?? "(name unknown)",
        phone,
        listings: [],
        zips: new Map(),
        lastInbound: null,
        lastOutbound: null,
        everReplied: 0,
        texted: 0,
        negotiating: 0,
      };
      byKey.set(key, row);
    }
    row.listings.push(l);
    if (l.zip) row.zips.set(l.zip, (row.zips.get(l.zip) ?? 0) + 1);
    if (l.lastInboundAt && (!row.lastInbound || l.lastInboundAt > row.lastInbound)) row.lastInbound = l.lastInboundAt;
    const out = [l.lastOutboundAt, l.lastOutreachDate].filter(Boolean).sort().pop() ?? null;
    if (out && (!row.lastOutbound || out > row.lastOutbound)) row.lastOutbound = out;
    if (l.lastInboundAt) row.everReplied++;
    if (l.lastOutreachDate || l.lastOutboundAt) row.texted++;
    if (l.outreachStatus === "Negotiating") row.negotiating++;
  }
  return [...byKey.values()].sort(
    (a, b) => b.listings.length - a.listings.length || (b.lastInbound ?? "").localeCompare(a.lastInbound ?? ""),
  );
}

export default function AgentsBoard() {
  const { listings, loading, refresh, lastFetched } = useV2Data();
  const [zipFilter, setZipFilter] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const agents = useMemo(() => (listings ? buildAgents(listings) : []), [listings]);

  const zipCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of agents) for (const [z, n] of a.zips) m.set(z, (m.get(z) ?? 0) + n);
    return [...m.entries()].sort((x, y) => y[1] - x[1]).slice(0, 8);
  }, [agents]);

  const visible = zipFilter ? agents.filter((a) => a.zips.has(zipFilter)) : agents;
  const multiHolders = visible.filter((a) => a.listings.length > 1).length;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-white">AGENTS</h1>
          <p className="text-[10px] text-gray-600">
            {listings
              ? `${visible.length} agents · ${visible.reduce((n, a) => n + a.listings.length, 0)} listings held · ${multiHolders} hold 2+`
              : "loading…"}
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

      <section className="bg-[#161b22] rounded-lg border border-[#30363d] p-4 space-y-4">
        {zipCounts.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => setZipFilter(null)}
              className={`text-[11px] px-2.5 py-1 rounded border transition-colors ${
                !zipFilter
                  ? "bg-emerald-700 border-emerald-500 text-white"
                  : "bg-[#0d1117] border-[#30363d] text-gray-400 hover:text-gray-200"
              }`}
            >
              All
            </button>
            {zipCounts.map(([z, n]) => (
              <button
                key={z}
                type="button"
                onClick={() => setZipFilter(zipFilter === z ? null : z)}
                className={`text-[11px] px-2.5 py-1 rounded border font-mono transition-colors ${
                  zipFilter === z
                    ? "bg-emerald-700 border-emerald-500 text-white"
                    : "bg-[#0d1117] border-[#30363d] text-gray-400 hover:text-gray-200"
                }`}
              >
                {z} <span className="opacity-60">{n}</span>
              </button>
            ))}
          </div>
        )}

        {!listings && (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-14 animate-pulse rounded-lg border border-[#30363d] bg-[#1c2128]" />
            ))}
          </div>
        )}

        <div className="space-y-2">
          {visible.map((a) => (
            <AgentCard key={a.key} a={a} expanded={open === a.key} onToggle={() => setOpen(open === a.key ? null : a.key)} />
          ))}
        </div>
      </section>
    </div>
  );
}

function AgentCard({ a, expanded, onToggle }: { a: AgentRow; expanded: boolean; onToggle: () => void }) {
  const ballInOurCourt = a.lastInbound && (!a.lastOutbound || a.lastInbound > a.lastOutbound);
  const zipChips = [...a.zips.entries()].sort((x, y) => y[1] - x[1]).slice(0, 3);

  return (
    <div className="bg-[#1c2128] rounded-lg border border-[#30363d]">
      <button type="button" onClick={onToggle} className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-left">
        <span className="font-mono text-lg font-bold text-white">{a.listings.length}</span>
        <span className="min-w-0">
          <span className="block truncate text-sm font-bold text-white">{a.name}</span>
          <span className="block text-[10px] text-gray-600">
            {a.phone ?? "no phone"}
            {zipChips.length > 0 && <> · {zipChips.map(([z, n]) => `${z}×${n}`).join(" ")}</>}
          </span>
        </span>
        <span className="ml-auto flex items-center gap-2 text-[10px]">
          {ballInOurCourt && (
            <span className="px-2 py-0.5 rounded border font-medium bg-amber-500/15 text-amber-300 border-amber-500/30">
              REPLY WAITING {ago(a.lastInbound)}
            </span>
          )}
          {a.negotiating > 0 && (
            <span className="px-2 py-0.5 rounded border font-medium bg-emerald-500/15 text-emerald-300 border-emerald-500/30">
              {a.negotiating} NEGOTIATING
            </span>
          )}
          <span className="text-gray-600">
            {a.everReplied}/{a.texted} replied
          </span>
          <span className="text-gray-700">{expanded ? "▾" : "▸"}</span>
        </span>
      </button>

      {expanded && (
        <div className="border-t border-[#30363d] px-4 py-3 space-y-2">
          <div className="grid grid-cols-2 gap-2 text-[10px] text-gray-500 sm:grid-cols-4">
            <span>
              last inbound: <span className="text-gray-300">{ago(a.lastInbound)}</span>
            </span>
            <span>
              last outbound: <span className="text-gray-300">{ago(a.lastOutbound)}</span>
            </span>
            <span>
              replied on: <span className="text-gray-300">{a.everReplied} of {a.texted} texted</span>
            </span>
            <span title="the auto-release countdowns live inside the sending engine; a read for them is queued with ops (request #5)">
              auto-release timers: <span className="text-gray-600">not wired up yet</span>
            </span>
          </div>
          <div className="space-y-1">
            {a.listings
              .slice()
              .sort((x, y) => (y.listPrice ?? 0) - (x.listPrice ?? 0))
              .map((l) => (
                <Link
                  key={l.id}
                  href={`/pipeline/${l.id}`}
                  className="flex flex-wrap items-baseline gap-x-2 bg-[#0d1117] border border-[#30363d] rounded px-3 py-2 text-xs hover:border-gray-600 transition-colors"
                >
                  <span className="font-semibold text-gray-200">{l.address}</span>
                  <span className="text-gray-600">{l.zip}</span>
                  <span className="font-mono text-gray-500">{money(l.listPrice)}</span>
                  {l.outreachStatus && <span className="text-gray-500">{l.outreachStatus}</span>}
                  {l.lastInboundAt && (
                    <span className="ml-auto text-[10px] text-amber-400/80">in {ago(l.lastInboundAt)}</span>
                  )}
                </Link>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}
