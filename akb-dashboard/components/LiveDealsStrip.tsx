"use client";

// LIVE DEALS — the operator's active money, always visible above the
// conveyor (operator 2026-07-12). Every record in a negotiation status, any
// era, with its sourced numbers and a ball-in-court signal. This is the
// surface that stopped the 3123 Sunbeam class of deal from being invisible:
// an email-worked legacy deal heading to contract now shows here with its
// price, ceiling, and "your move" flag, ranked to the top when it needs you.
//
// RECOMMENDED REPLIES (same day): a deal with a queued draft renders the
// draft inline with one-tap Send / Edit / Dismiss — the operator reviews
// from a phone, so every tap target is thumb-sized. A guardrail HOLD renders
// the reason instead of a Send button (refuse-and-surface). Send/dismiss
// ride the SAME /api/proposals dispatch rail as the conveyor — one rail,
// two surfaces.
//
// Sourced numbers only — a dollar figure renders only when its field is set.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { showToast } from "@/components/Toast";
import type { RankedLiveDeal } from "@/lib/live-deals";

interface Payload {
  total: number;
  needs_you: number;
  deals: RankedLiveDeal[];
}

const STATUS_STYLE: Record<string, string> = {
  "Offer Accepted": "bg-emerald-950/60 text-emerald-300 border-emerald-500/40",
  "Counter Received": "bg-amber-950/60 text-amber-300 border-amber-500/40",
  "Response Received": "bg-sky-950/60 text-sky-300 border-sky-500/40",
  Negotiating: "bg-violet-950/60 text-violet-300 border-violet-500/40",
};

function usd(n: number | null): string | null {
  return n == null ? null : `$${Math.round(n).toLocaleString("en-US")}`;
}

function ago(iso: string | null, nowMs: number): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  const m = Math.max(0, Math.round((nowMs - t) / 60_000));
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export default function LiveDealsStrip() {
  const [data, setData] = useState<Payload | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [editing, setEditing] = useState<string | null>(null); // deal id
  const [editText, setEditText] = useState("");
  const [busy, setBusy] = useState<string | null>(null); // deal id in flight

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/live-deals", { cache: "no-store" });
      if (!res.ok) return;
      setData((await res.json()) as Payload);
      setNowMs(Date.now());
    } catch {
      /* fail silent — the conveyor + header carry the rest */
    }
  }, []);

  const draftAction = useCallback(
    async (deal: RankedLiveDeal, mode: "send" | "dismiss", edited?: string) => {
      if (!deal.draft?.proposalId) return;
      setBusy(deal.id);
      try {
        const res = await fetch("/api/proposals", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            mode === "send"
              ? { proposalId: deal.draft.proposalId, action: "approve", dispatch: true, editedBody: edited }
              : { proposalId: deal.draft.proposalId, action: "reject", reason: "dismissed from Live Deals" },
          ),
        });
        const out = await res.json().catch(() => ({}));
        if (res.ok) {
          showToast(mode === "send" ? "Reply sent ✓" : "Dismissed", "success");
          setEditing(null);
          // Optimistic: clear the draft locally; the next poll reconciles.
          setData((prev) =>
            prev
              ? { ...prev, deals: prev.deals.map((d) => (d.id === deal.id ? { ...d, draft: null } : d)) }
              : prev,
          );
        } else {
          showToast(out.skipReason || out.error || "Failed");
        }
      } catch {
        showToast("Failed");
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  useEffect(() => {
    load();
    const t = setInterval(load, 120_000);
    const clock = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => {
      clearInterval(t);
      clearInterval(clock);
    };
  }, [load]);

  // Nothing live → render nothing. The 🎯 header still carries the count.
  if (!data || data.deals.length === 0) return null;

  return (
    <section className="space-y-2">
      <h2 className="text-sm font-bold text-white tracking-wide">
        LIVE DEALS <span className="text-gray-500 font-normal">({data.total}</span>
        {data.needs_you > 0 && (
          <span className="text-emerald-400 font-normal"> · {data.needs_you} your move</span>
        )}
        <span className="text-gray-500 font-normal">)</span>
      </h2>

      <div className="space-y-2">
        {data.deals.map((d) => {
          const price = usd(d.contractPrice);
          const list = usd(d.listPrice);
          const headroom = d.headroom;
          const isBusy = busy === d.id;
          const isEditing = editing === d.id;
          return (
            <div
              key={d.id}
              className={`rounded-xl border bg-[#0d1117] ${
                d.needsYou ? "border-l-2 border-l-emerald-500 border-y-[#30363d] border-r-[#30363d]" : "border-[#30363d]"
              }`}
            >
              <Link
                href={d.href}
                className="flex items-center gap-3 px-4 py-3 min-h-[56px] transition-colors hover:bg-[#161b22] rounded-t-xl"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span
                      className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${
                        STATUS_STYLE[d.status] ?? "bg-gray-800 text-gray-300 border-gray-600"
                      }`}
                    >
                      {d.status}
                    </span>
                    <span className="text-sm font-semibold text-white truncate">{d.street}</span>
                    {d.legacy && (
                      <span
                        className="text-[9px] text-gray-500 uppercase tracking-wide"
                        title="Pre-v2 record — shown here because an active negotiation is current-era work, never hidden by the forward ruling."
                      >
                        legacy
                      </span>
                    )}
                  </div>
                  <div className="mt-1 flex items-center gap-2 flex-wrap text-[11px]">
                    {price ? (
                      <span className="font-bold text-white tabular-nums">{price}</span>
                    ) : (
                      <span className="text-gray-600">no price on record</span>
                    )}
                    {list && <span className="text-gray-500 tabular-nums">list {list}</span>}
                    {headroom != null &&
                      (headroom >= 0 ? (
                        <span className="text-emerald-400 tabular-nums" title="Contract sits under your underwritten ceiling (MAO).">
                          ${Math.round(headroom / 1000)}k under ceiling
                        </span>
                      ) : (
                        <span className="text-red-400 tabular-nums" title="Contract is ABOVE your underwritten ceiling — review before proceeding.">
                          ⚠ ${Math.abs(Math.round(headroom / 1000))}k over ceiling
                        </span>
                      ))}
                  </div>
                </div>

                <div className="flex flex-col items-end gap-1 flex-shrink-0">
                  <span
                    className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${
                      d.needsYou
                        ? "bg-emerald-950/60 text-emerald-300 border-emerald-500/40"
                        : "bg-gray-900 text-gray-400 border-gray-700"
                    }`}
                  >
                    {d.needsYou ? "Your move" : "Waiting on them"}
                  </span>
                  <span className="text-[10px] text-gray-500">{ago(d.lastActivityAt, nowMs)}</span>
                </div>
              </Link>

              {/* RECOMMENDED REPLY — queued draft (Send/Edit/Dismiss) or
                  guardrail HOLD (reason + open-deal). Thumb-sized taps. */}
              {d.draft && (
                <div className="border-t border-[#21262d] px-4 py-3 space-y-2">
                  {d.draft.state === "queued" && d.draft.text ? (
                    <>
                      <div className="flex items-center gap-2 text-[10px] text-gray-500">
                        <span className="font-bold text-emerald-400 uppercase tracking-wide">Reply ready</span>
                        <span>{d.draft.channel === "email" ? "✉️ email" : "💬 text"} · {d.draft.classification.replace(/_/g, " ")}</span>
                      </div>
                      {isEditing ? (
                        <textarea
                          value={editText}
                          onChange={(e) => setEditText(e.target.value)}
                          rows={4}
                          className="w-full rounded-lg border border-[#30363d] bg-[#161b22] p-3 text-sm text-gray-200 focus:border-emerald-500 focus:outline-none"
                        />
                      ) : (
                        <p className="text-sm text-gray-300 whitespace-pre-wrap">{d.draft.text}</p>
                      )}
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => draftAction(d, "send", isEditing ? editText : undefined)}
                          className="flex-1 min-h-[44px] rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-sm font-bold transition-colors"
                        >
                          {isBusy ? "Sending…" : isEditing ? "Send edited" : "Send"}
                        </button>
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => {
                            if (isEditing) setEditing(null);
                            else {
                              setEditing(d.id);
                              setEditText(d.draft?.text ?? "");
                            }
                          }}
                          className="min-h-[44px] px-4 rounded-lg border border-[#30363d] text-gray-300 text-sm hover:bg-[#161b22] transition-colors"
                        >
                          {isEditing ? "Cancel" : "Edit"}
                        </button>
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => draftAction(d, "dismiss")}
                          className="min-h-[44px] px-3 rounded-lg border border-[#30363d] text-gray-500 text-sm hover:bg-[#161b22] hover:text-red-400 transition-colors"
                          title="Dismiss this draft (kills the proposal; nothing sends)"
                        >
                          ✕
                        </button>
                      </div>
                    </>
                  ) : (
                    <div className="flex items-center gap-2 text-[11px]">
                      <span className="font-bold text-amber-400 uppercase tracking-wide text-[10px]">Held</span>
                      <span className="text-gray-400">
                        No auto-draft — {(d.draft.holdReason ?? "needs your judgment").replace(/_/g, " ")}. Open the deal to reply yourself.
                      </span>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
