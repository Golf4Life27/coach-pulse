"use client";

// AGENT CRM — agents are the channel, not metadata on a listing.
// Built live from /api/listings grouped by normalized agent phone:
// listings held, last contact both directions, response history, ZIP
// concentration. Stall-release timer state stays internal to the H2
// engine until ops ships the agent-CRM read (request #5) — shown as an
// explicit awaiting state, never guessed.

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { ListingDetail } from "../_lib/types";
import { ago, money } from "../_lib/format";

function normPhone(p: string | null): string | null {
  if (!p) return null;
  const d = p.replace(/[^0-9]/g, "");
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  return d ? `+${d}` : null;
}

interface AgentRow {
  key: string;
  name: string;
  phone: string | null;
  email: string | null;
  listings: ListingDetail[];
  zips: Map<string, number>;
  lastInbound: string | null;
  lastOutbound: string | null;
  everReplied: number; // listings with any inbound
  texted: number; // listings with an outreach send on record
  negotiating: number;
}

function buildAgents(listings: ListingDetail[]): AgentRow[] {
  const byKey = new Map<string, AgentRow>();
  for (const l of listings) {
    const phone = normPhone(l.agentPhone);
    const key = phone ?? (l.agentName ? `name:${l.agentName.toLowerCase().trim()}` : null) ?? "";
    if (!key) continue; // no agent identity at all — lives in Pipeline, not here
    let row = byKey.get(key);
    if (!row) {
      row = {
        key,
        name: l.agentName ?? "(name unknown)",
        phone,
        email: l.agentEmail,
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
    if (l.agentEmail && !row.email) row.email = l.agentEmail;
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

export default function AgentsPage() {
  const [listings, setListings] = useState<ListingDetail[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zipFilter, setZipFilter] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch("/api/listings", { cache: "no-store" });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        setListings((await r.json()) as ListingDetail[]);
      } catch (e) {
        setError(String(e));
      }
    })();
  }, []);

  const agents = useMemo(() => (listings ? buildAgents(listings) : []), [listings]);

  const zipCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of agents) for (const [z, n] of a.zips) m.set(z, (m.get(z) ?? 0) + n);
    return [...m.entries()].sort((x, y) => y[1] - x[1]).slice(0, 8);
  }, [agents]);

  const visible = zipFilter ? agents.filter((a) => a.zips.has(zipFilter)) : agents;
  const multiHolders = visible.filter((a) => a.listings.length > 1).length;

  return (
    <div className="space-y-4">
      <section>
        <h1 className="mb-1 text-xs font-black tracking-[0.2em] text-zinc-400">
          AGENTS — THE CHANNEL
          <span className="ml-2 font-normal tracking-normal text-zinc-600">
            {listings
              ? `${visible.length} agents · ${visible.reduce((n, a) => n + a.listings.length, 0)} listings held · ${multiHolders} hold 2+ (live, /api/listings)`
              : "loading…"}
          </span>
        </h1>
        {zipCounts.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            <button
              onClick={() => setZipFilter(null)}
              className={`rounded-full border px-2.5 py-1 text-[10px] font-bold ${!zipFilter ? "border-cyan-700 text-cyan-300" : "border-zinc-800 text-zinc-500 hover:text-zinc-300"}`}
            >
              ALL
            </button>
            {zipCounts.map(([z, n]) => (
              <button
                key={z}
                onClick={() => setZipFilter(zipFilter === z ? null : z)}
                className={`rounded-full border px-2.5 py-1 font-mono text-[10px] font-bold ${zipFilter === z ? "border-cyan-700 text-cyan-300" : "border-zinc-800 text-zinc-500 hover:text-zinc-300"}`}
              >
                {z} <span className="text-zinc-600">{n}</span>
              </button>
            ))}
          </div>
        )}
      </section>

      {error && (
        <p className="rounded-lg border border-red-900/60 bg-red-950/30 px-3 py-2 text-xs text-red-300">
          listings unreachable — {error}
        </p>
      )}
      {!listings && !error && <div className="h-40 animate-pulse rounded-xl border border-zinc-800 bg-zinc-900/40" />}

      <div className="space-y-2">
        {visible.map((a) => (
          <AgentCard key={a.key} a={a} expanded={open === a.key} onToggle={() => setOpen(open === a.key ? null : a.key)} />
        ))}
      </div>
    </div>
  );
}

function AgentCard({ a, expanded, onToggle }: { a: AgentRow; expanded: boolean; onToggle: () => void }) {
  const ballInOurCourt =
    a.lastInbound && (!a.lastOutbound || a.lastInbound > a.lastOutbound);
  const zipChips = [...a.zips.entries()].sort((x, y) => y[1] - x[1]).slice(0, 3);

  return (
    <article className="rounded-xl border border-zinc-800 bg-[#0b0e13]">
      <button onClick={onToggle} className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-3.5 py-2.5 text-left">
        <span className="font-mono text-lg font-bold text-zinc-100">{a.listings.length}</span>
        <span className="min-w-0">
          <span className="block truncate text-sm font-bold text-zinc-100">{a.name}</span>
          <span className="block text-[10px] text-zinc-600">
            {a.phone ?? "no phone"}
            {zipChips.length > 0 && <> · {zipChips.map(([z, n]) => `${z}×${n}`).join(" ")}</>}
          </span>
        </span>
        <span className="ml-auto flex items-center gap-2 text-[10px]">
          {ballInOurCourt && (
            <span className="rounded border border-amber-700/70 px-1.5 py-px font-bold text-amber-300">
              REPLY WAITING {ago(a.lastInbound)}
            </span>
          )}
          {a.negotiating > 0 && (
            <span className="rounded border border-emerald-800/70 px-1.5 py-px font-bold text-emerald-300">
              {a.negotiating} NEGOTIATING
            </span>
          )}
          <span className="text-zinc-600">
            {a.everReplied}/{a.texted} replied
          </span>
          <span className="text-zinc-700">{expanded ? "▾" : "▸"}</span>
        </span>
      </button>

      {expanded && (
        <div className="border-t border-zinc-800/70 px-3.5 py-2.5">
          <div className="mb-2 grid grid-cols-2 gap-2 text-[10px] text-zinc-500 sm:grid-cols-4">
            <span>last inbound: <span className="text-zinc-300">{ago(a.lastInbound)}</span></span>
            <span>last outbound: <span className="text-zinc-300">{ago(a.lastOutbound)}</span></span>
            <span>replied on: <span className="text-zinc-300">{a.everReplied} of {a.texted} texted</span></span>
            <span title="same-agent stall windows live inside the H2 engine; surfacing them is ops request #5">
              stall timers: <span className="text-zinc-600">awaiting ops read</span>
            </span>
          </div>
          <div className="space-y-1">
            {a.listings
              .slice()
              .sort((x, y) => (y.listPrice ?? 0) - (x.listPrice ?? 0))
              .map((l) => (
                <Link
                  key={l.id}
                  href={`/v2/deal/${l.id}`}
                  className="flex flex-wrap items-baseline gap-x-2 rounded border border-zinc-800/70 px-2.5 py-2 text-sm hover:border-cyan-800"
                >
                  <span className="font-bold text-zinc-200">{l.address}</span>
                  <span className="text-zinc-600">{l.zip}</span>
                  <span className="font-mono text-zinc-500">{money(l.listPrice)}</span>
                  {l.outreachStatus && <span className="text-zinc-500">{l.outreachStatus}</span>}
                  {l.lastInboundAt && (
                    <span className="ml-auto text-[10px] text-amber-400/80">in {ago(l.lastInboundAt)}</span>
                  )}
                </Link>
              ))}
          </div>
        </div>
      )}
    </article>
  );
}
