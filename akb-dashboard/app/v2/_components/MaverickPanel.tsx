"use client";

// Maverick embedded — persistent conversational panel over the EXISTING
// Maverick surfaces: GET /api/maverick/load-state?format=narrative ("what
// happened overnight") and POST /api/maverick/recall (durable-state search).
// Both accept the dashboard session cookie, so this is pure read wiring.
// Free-form chat + approve-actions routes through the Maverick MCP and is
// a flagged backend request (see docs/v2/V2_ARCHITECTURE.md) — not faked here.

import { useEffect, useRef, useState } from "react";
import { useMaverickPanel } from "../_lib/data";
import type { RecallResponse, RecallResult } from "../_lib/types";

type PanelMsg =
  | { kind: "user"; text: string }
  | { kind: "narrative"; text: string }
  | { kind: "recall"; query: string; results: RecallResult[]; truncated: number }
  | { kind: "error"; text: string };

const SOURCE_TONE: Record<string, string> = {
  spine: "text-violet-300 border-violet-800",
  audit: "text-cyan-300 border-cyan-800",
  listings: "text-emerald-300 border-emerald-800",
  deals: "text-amber-300 border-amber-800",
};

export default function MaverickPanel() {
  const { open, setOpen, consumePrefill, prefill } = useMaverickPanel();
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [feed, setFeed] = useState<PanelMsg[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open && prefill) {
      const q = consumePrefill();
      if (q) runRecall(q);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, prefill]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [feed, busy]);

  async function runOvernight() {
    setBusy(true);
    setFeed((f) => [...f, { kind: "user", text: "What happened overnight?" }]);
    try {
      const r = await fetch("/api/maverick/load-state?format=narrative", { cache: "no-store" });
      const text = await r.text();
      setFeed((f) => [
        ...f,
        r.ok
          ? { kind: "narrative", text }
          : { kind: "error", text: `load-state HTTP ${r.status}: ${text.slice(0, 200)}` },
      ]);
    } catch (e) {
      setFeed((f) => [...f, { kind: "error", text: String(e) }]);
    }
    setBusy(false);
  }

  async function runRecall(q: string) {
    if (!q.trim()) return;
    setBusy(true);
    setInput("");
    setFeed((f) => [...f, { kind: "user", text: `recall: ${q}` }]);
    try {
      const r = await fetch("/api/maverick/recall", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: q, sources: ["spine", "audit", "listings", "deals"] }),
      });
      if (!r.ok) {
        setFeed((f) => [...f, { kind: "error", text: `recall HTTP ${r.status}` }]);
      } else {
        const data = (await r.json()) as RecallResponse;
        setFeed((f) => [
          ...f,
          { kind: "recall", query: q, results: data.results ?? [], truncated: data.truncated_to_n ?? 0 },
        ]);
      }
    } catch (e) {
      setFeed((f) => [...f, { kind: "error", text: String(e) }]);
    }
    setBusy(false);
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-4 right-4 z-[80] flex items-center gap-2 rounded-full border border-cyan-700/60 bg-[#0c1219] px-4 py-2.5 text-xs font-bold tracking-widest text-cyan-300 shadow-[0_0_20px_rgba(8,145,178,0.25)] hover:bg-[#101a24]"
      >
        <span className="h-2 w-2 rounded-full bg-cyan-400 shadow-[0_0_6px_rgba(34,211,238,0.9)]" />
        MAVERICK
      </button>
    );
  }

  return (
    <div className="fixed inset-x-0 bottom-0 z-[80] flex max-h-[75vh] flex-col rounded-t-xl border border-cyan-900/50 bg-[#0a0f14] shadow-[0_-10px_40px_rgba(0,0,0,0.6)] lg:inset-x-auto lg:bottom-4 lg:right-4 lg:h-[34rem] lg:max-h-[80vh] lg:w-[26rem] lg:rounded-xl">
      <div className="flex items-center justify-between border-b border-cyan-900/40 px-4 py-2.5">
        <span className="flex items-center gap-2 text-xs font-bold tracking-widest text-cyan-300">
          <span className="h-2 w-2 rounded-full bg-cyan-400 shadow-[0_0_6px_rgba(34,211,238,0.9)]" />
          MAVERICK
        </span>
        <button onClick={() => setOpen(false)} className="px-2 text-zinc-500 hover:text-zinc-200">
          ✕
        </button>
      </div>

      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {feed.length === 0 && (
          <p className="text-sm leading-relaxed text-zinc-500">
            Wired to the live Maverick state layer (load_state + recall, dashboard-cookie auth).
            Ask for the overnight briefing, or recall anything — an address, an agent, a
            decision (&ldquo;Freeland&rdquo;, &ldquo;circuit breaker&rdquo;, &ldquo;48227&rdquo;).
          </p>
        )}
        {feed.map((m, i) => {
          if (m.kind === "user")
            return (
              <div key={i} className="ml-8 rounded-lg bg-zinc-800/80 px-3 py-2.5 text-sm text-zinc-200">
                {m.text}
              </div>
            );
          if (m.kind === "narrative")
            return (
              <div key={i} className="mr-4 whitespace-pre-wrap rounded-lg border border-cyan-900/40 bg-[#0c141c] px-3 py-2.5 text-sm leading-relaxed text-zinc-300">
                {m.text}
              </div>
            );
          if (m.kind === "error")
            return (
              <div key={i} className="mr-4 rounded-lg border border-red-900/60 bg-red-950/30 px-3 py-2 text-xs text-red-300">
                {m.text}
              </div>
            );
          return (
            <div key={i} className="mr-4 space-y-1.5">
              {m.results.length === 0 && (
                <div className="rounded-lg border border-zinc-800 px-3 py-2 text-xs text-zinc-500">
                  No durable-state matches for &ldquo;{m.query}&rdquo;.
                </div>
              )}
              {m.results.map((r, j) => (
                <div key={j} className="rounded-lg border border-zinc-800 bg-[#0c1117] px-3 py-2">
                  <span className={`mb-1 inline-block rounded border px-1.5 py-px text-[9px] font-bold uppercase tracking-wider ${SOURCE_TONE[r.source] ?? "text-zinc-400 border-zinc-700"}`}>
                    {r.source}
                  </span>
                  <p className="text-sm leading-snug text-zinc-300">{r.summary}</p>
                </div>
              ))}
              {m.truncated > 0 && (
                <p className="px-1 text-[10px] text-zinc-600">+{m.truncated} more matches truncated</p>
              )}
            </div>
          );
        })}
        {busy && <p className="animate-pulse text-xs text-cyan-500">Maverick is reading the spine…</p>}
      </div>

      <div className="border-t border-cyan-900/40 p-3">
        <div className="mb-2 flex gap-2">
          <button
            onClick={runOvernight}
            disabled={busy}
            className="rounded-md border border-cyan-800/70 px-2.5 py-1 text-[10px] font-bold tracking-wider text-cyan-300 hover:bg-cyan-950/40 disabled:opacity-40"
          >
            OVERNIGHT BRIEFING
          </button>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            runRecall(input);
          }}
          className="flex gap-2"
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="recall a deal, agent, decision…"
            className="min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs text-zinc-200 placeholder:text-zinc-600 focus:border-cyan-700 focus:outline-none"
          />
          <button
            type="submit"
            disabled={busy || !input.trim()}
            className="rounded-md bg-cyan-700 px-3 py-2 text-xs font-bold text-white hover:bg-cyan-600 disabled:opacity-40"
          >
            ASK
          </button>
        </form>
      </div>
    </div>
  );
}
