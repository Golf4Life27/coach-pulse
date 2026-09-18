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

import { useCallback, useEffect, useRef, useState } from "react";
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
  const sendBtnRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  // MAVERICK SAYS (2026-09-18): tapping a recommended option loads its
  // message into the SAME editable draft box every queued/held draft
  // already uses, then focuses the SAME Send button — no new send path.
  const pickOption = useCallback((dealId: string, message: string) => {
    setEditing(dealId);
    setEditText(message);
    setTimeout(() => sendBtnRefs.current[dealId]?.focus(), 0);
  }, []);

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

              {/* MAVERICK SAYS + RECOMMENDED REPLY — a counter-decision
                  recommendation (2026-09-18), a queued draft (Send/Edit/
                  Dismiss), and/or a guardrail HOLD (reason + open-deal).
                  Thumb-sized taps. */}
              {(d.draft || d.counterDecision) && (
                <div className="border-t border-[#21262d] px-4 py-3 space-y-2">
                  {/* MAVERICK SAYS — facts + a bounded menu of ready-to-edit
                      reply options (lib/counter-decision). Tapping an option
                      loads its message into the SAME editable box and Send
                      button below — never a second send path. */}
                  {d.counterDecision && (
                    <div className="rounded-lg border border-fuchsia-500/30 bg-fuchsia-950/20 p-3 space-y-2">
                      <span className="block text-fuchsia-300 text-[9px] font-bold uppercase tracking-wide">Maverick says</span>
                      <div className="text-sm font-semibold text-gray-100">{d.counterDecision.headline}</div>
                      {d.counterDecision.facts.length > 0 && (
                        <ul className="space-y-0.5">
                          {d.counterDecision.facts.map((fact, idx) => (
                            <li key={idx} className="text-[11px] text-gray-400 leading-snug">
                              {fact}
                            </li>
                          ))}
                        </ul>
                      )}
                      <div className="flex flex-wrap gap-2 pt-1">
                        {d.counterDecision.options.map((o) => (
                          <button
                            key={o.key}
                            type="button"
                            disabled={isBusy}
                            onClick={() => pickOption(d.id, o.message)}
                            className="min-h-[36px] px-3 rounded-lg border border-fuchsia-500/40 bg-fuchsia-950/30 text-fuchsia-200 text-xs font-semibold hover:bg-fuchsia-900/40 disabled:opacity-50 transition-colors"
                          >
                            {o.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {(() => {
                    // A HELD draft with a Maverick recommendation is never
                    // left at a dead-end "Open deal to reply" — the operator
                    // has facts and options right here, so the editable box
                    // + Send render immediately, pre-loaded with the
                    // recommendation's lead option (never the "stall"
                    // question) until the operator types or taps a
                    // different option. This is what closes the HELD gap on
                    // the card itself: app/api/proposals/route.ts now
                    // accepts a hold_review proposal's Send when the
                    // operator supplies a non-empty edited body (the
                    // operator-override dispatch path).
                    const isHeldWithRecommendation = Boolean(d.draft) && d.draft?.state !== "queued" && d.counterDecision != null;
                    const defaultHeldMessage =
                      d.counterDecision?.options.find((o) => o.key !== "stall")?.message ??
                      d.counterDecision?.options[0]?.message ??
                      "";
                    const showEditableBox =
                      Boolean(d.draft) && ((d.draft!.state === "queued" && Boolean(d.draft!.text)) || isEditing || isHeldWithRecommendation);
                    const boxValue = isEditing ? editText : isHeldWithRecommendation ? defaultHeldMessage : (d.draft?.text ?? "");

                    if (showEditableBox && d.draft) {
                      return (
                        <>
                          {!isEditing && !isHeldWithRecommendation && (
                            <div className="flex items-center gap-2 text-[10px] text-gray-500">
                              <span className="font-bold text-emerald-400 uppercase tracking-wide">Reply ready</span>
                              <span>{d.draft.channel === "email" ? "✉️ email" : "💬 text"} · {d.draft.classification.replace(/_/g, " ")}</span>
                            </div>
                          )}
                          {isHeldWithRecommendation && (
                            <div className="flex items-center gap-2 text-[10px] text-amber-300">
                              <span className="font-bold uppercase tracking-wide">Held — pick an option or write your own</span>
                            </div>
                          )}
                          {/* The inbound this reply answers — operator 2026-07-14: show
                              the message we're replying to so context is on the card,
                              no need to open the full deal room. */}
                          {d.draft.inboundExcerpt && (
                            <blockquote className="border-l-2 border-sky-500/40 bg-sky-950/20 pl-3 pr-2 py-1.5 rounded-r text-[12px] text-sky-200/90 italic">
                              <span className="not-italic text-sky-400/70 text-[9px] font-bold uppercase tracking-wide mr-1">They said</span>
                              “{d.draft.inboundExcerpt}”
                            </blockquote>
                          )}
                          <textarea
                            value={boxValue}
                            onChange={(e) => {
                              if (editing !== d.id) setEditing(d.id);
                              setEditText(e.target.value);
                            }}
                            rows={4}
                            className="w-full rounded-lg border border-[#30363d] bg-[#161b22] p-3 text-sm text-gray-200 focus:border-emerald-500 focus:outline-none"
                          />
                          <div className="flex items-center gap-2">
                            <button
                              ref={(el) => {
                                sendBtnRefs.current[d.id] = el;
                              }}
                              type="button"
                              disabled={isBusy || !d.draft.proposalId}
                              onClick={() => draftAction(d, "send", isHeldWithRecommendation ? boxValue : isEditing ? editText : undefined)}
                              title={!d.draft.proposalId ? "No proposal on record for this deal — open it to send" : undefined}
                              className="flex-1 min-h-[44px] rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-sm font-bold transition-colors"
                            >
                              {isBusy ? "Sending…" : "Send"}
                            </button>
                            {!isHeldWithRecommendation && (
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
                            )}
                            <button
                              type="button"
                              disabled={isBusy || !d.draft.proposalId}
                              onClick={() => draftAction(d, "dismiss")}
                              className="min-h-[44px] px-3 rounded-lg border border-[#30363d] text-gray-500 text-sm hover:bg-[#161b22] hover:text-red-400 transition-colors disabled:opacity-50"
                              title="Dismiss this draft (kills the proposal; nothing sends)"
                            >
                              ✕
                            </button>
                            {isHeldWithRecommendation && (
                              <Link
                                href={d.href}
                                className="min-h-[44px] px-3 rounded-lg border border-[#30363d] text-gray-300 text-sm hover:bg-[#161b22] transition-colors flex items-center"
                                title="Open the full deal room"
                              >
                                Open
                              </Link>
                            )}
                          </div>
                        </>
                      );
                    }

                    // A HELD draft with NO Maverick recommendation — the
                    // machine has nothing concrete to propose, so this stays
                    // the collapsed "your judgment" summary + open-deal link.
                    if (d.draft) {
                      return (
                        <div className="rounded-lg border border-amber-500/40 bg-amber-950/30 p-3 space-y-2">
                          {d.draft.inboundExcerpt && (
                            <div className="text-xs text-gray-300">
                              <span className="text-amber-400 font-bold text-[10px] uppercase tracking-wide mr-2">They said</span>
                              &ldquo;{d.draft.inboundExcerpt}&rdquo;
                            </div>
                          )}
                          <div className="flex items-center gap-2 text-xs">
                            <span className="font-bold text-amber-400 uppercase tracking-wide text-[10px]">Held — your judgment</span>
                            <span className="text-amber-200/80">
                              {(d.draft.holdReason ?? "needs your judgment").replace(/_/g, " ")}
                            </span>
                          </div>
                          <Link
                            href={d.href}
                            className="block w-full min-h-[44px] rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-sm font-bold transition-colors text-center leading-[44px]"
                          >
                            Open deal to reply
                          </Link>
                        </div>
                      );
                    }

                    return null;
                  })()}

                  {/* No proposal exists on this deal at all (counter-decision
                      only, e.g. a raw status flip with no drafted reply yet) —
                      still let the operator pick and edit a message, but
                      sending needs the deal room since there is no proposal
                      to dispatch here. */}
                  {!d.draft && d.counterDecision && isEditing && (
                    <div className="space-y-2">
                      <textarea
                        value={editText}
                        onChange={(e) => setEditText(e.target.value)}
                        rows={4}
                        className="w-full rounded-lg border border-[#30363d] bg-[#161b22] p-3 text-sm text-gray-200 focus:border-emerald-500 focus:outline-none"
                      />
                      <div className="flex items-center gap-2">
                        <Link
                          href={d.href}
                          ref={(el) => {
                            sendBtnRefs.current[d.id] = el as unknown as HTMLButtonElement | null;
                          }}
                          className="flex-1 min-h-[44px] rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-bold transition-colors text-center leading-[44px]"
                        >
                          Open deal to send
                        </Link>
                        <button
                          type="button"
                          onClick={() => setEditing(null)}
                          className="min-h-[44px] px-4 rounded-lg border border-[#30363d] text-gray-300 text-sm hover:bg-[#161b22] transition-colors"
                        >
                          Cancel
                        </button>
                      </div>
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
