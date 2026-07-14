"use client";

// Maverick — the proactive right-hand man (operator 2026-07-14: "I want
// Maverick to be my business partner, my orchestrator… feeds me action items
// constantly… staying one step ahead of me and compiling all the data,
// sorting and feeding me things to do in order, not just a massive to-do list
// I have to sort through").
//
// The dock no longer only ANSWERS — it SPEAKS FIRST. The 🎯 button carries a
// live badge (pulsing red when something's urgent). When there's an urgent
// move and the dock is closed, a one-line peek whispers it above the button.
// Open the dock and the default view is NEXT MOVE: the same ranked conveyor
// the Act Now page shows, narrated in Maverick's voice one move at a time —
// headline, the seller's message, the clock, and a one-tap Send / Open. Chat
// (context-aware of the on-screen deal) is one tap away as the "Ask" tab.
//
// Single source of truth: the moves come from buildConveyor()+narrateConveyor()
// over the shared source fetch, so the dock and the landing feed can never
// disagree on what matters most.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { showToast } from "@/components/Toast";
import {
  buildConveyor,
  type ActionItemRow,
  type BroCardRow,
  type PriorityRow,
  type ProposalRow,
} from "@/lib/conveyor/model";
import { fetchFastSources, fetchBriefCards } from "@/lib/conveyor/sources";
import { compactUsd, narrateConveyor, type NextMove } from "@/lib/maverick/next-moves";

interface Msg {
  role: "user" | "assistant";
  content: string;
}

const TYPE_CHIP: Record<NextMove["type"], string> = {
  "2A": "bg-emerald-950/60 text-emerald-300 border-emerald-500/40",
  "2B": "bg-amber-950/60 text-amber-300 border-amber-500/40",
  "2C": "bg-violet-950/60 text-violet-300 border-violet-500/40",
};
const TONE_CHIP: Record<NextMove["tone"], string> = {
  overdue: "bg-red-950/60 text-red-300 border border-red-500/50",
  soon: "bg-amber-950/50 text-amber-300 border border-amber-500/40",
  calm: "bg-[#161b22] text-gray-400 border border-[#30363d]",
};
const ACCENT: Record<NextMove["type"], string> = {
  "2A": "border-l-emerald-500/70",
  "2B": "border-l-amber-500/70",
  "2C": "border-l-violet-500/70",
};

export default function MaverickDock() {
  const pathname = usePathname() ?? "/";
  const recordMatch = /^\/pipeline\/(rec[A-Za-z0-9]{14})/.exec(pathname);
  const recordId = recordMatch ? recordMatch[1] : null;

  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"moves" | "chat">("moves");

  // ── Proactive feed state ────────────────────────────────────────────────
  const [proposals, setProposals] = useState<ProposalRow[]>([]);
  const [actionItems, setActionItems] = useState<ActionItemRow[]>([]);
  const [priorities, setPriorities] = useState<PriorityRow[]>([]);
  const [broCards, setBroCards] = useState<BroCardRow[]>([]);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [peekDismissed, setPeekDismissed] = useState<Set<string>>(new Set());
  const alive = useRef(true);

  // ── Chat state ──────────────────────────────────────────────────────────
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contextRef = useRef<string | null>(null);

  const loadFast = useCallback(async () => {
    const s = await fetchFastSources();
    if (!alive.current) return;
    if (s.proposals) setProposals(s.proposals);
    if (s.actionItems) setActionItems(s.actionItems);
    if (s.priorities) setPriorities(s.priorities);
    setNowMs(Date.now());
  }, []);

  const loadBrief = useCallback(async () => {
    const cards = await fetchBriefCards();
    if (!alive.current || !cards) return;
    setBroCards(cards);
  }, []);

  useEffect(() => {
    alive.current = true;
    loadFast();
    loadBrief();
    const poll = setInterval(loadFast, 120_000);
    const clock = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => {
      alive.current = false;
      clearInterval(poll);
      clearInterval(clock);
    };
  }, [loadFast, loadBrief]);

  const moves = useMemo(() => {
    const { items } = buildConveyor({ proposals, actionItems, priorities, broCards }, new Date(nowMs).toISOString());
    return narrateConveyor(items, new Date(nowMs).toISOString());
  }, [proposals, actionItems, priorities, broCards, nowMs]);

  const urgentCount = moves.filter((m) => m.urgency >= 3).length;
  const top = moves[0] ?? null;
  const showPeek =
    !open && top != null && top.urgency >= 3 && !peekDismissed.has(top.key);

  // A navigation to a different record starts a fresh chat thread.
  useEffect(() => {
    if (contextRef.current !== recordId) {
      contextRef.current = recordId;
      setMessages([]);
    }
  }, [recordId]);

  useEffect(() => {
    if (open && tab === "chat") scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, thinking, open, tab]);

  // ── Move actions (dispatch on the same /api/proposals rail as the feed) ──
  const dropProposal = useCallback((proposalId: string) => {
    setProposals((prev) => prev.filter((p) => p.id !== proposalId));
  }, []);

  const moveAction = useCallback(
    async (move: NextMove, mode: "send" | "approve" | "dismiss", edited?: string) => {
      const pid =
        move.primary.kind === "send" || move.primary.kind === "approve" ? move.primary.proposalId : null;
      if (!pid) return;
      if (mode === "dismiss" && !window.confirm("Dismiss this? The draft is killed — nothing sends.")) return;
      setBusy((prev) => new Set(prev).add(move.key));
      try {
        const body =
          mode === "send"
            ? { proposalId: pid, action: "approve", dispatch: true, editedBody: edited }
            : mode === "approve"
              ? { proposalId: pid, action: "approve" }
              : { proposalId: pid, action: "reject", reason: "dismissed from Maverick dock" };
        const res = await fetch("/api/proposals", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const out = await res.json().catch(() => ({}));
        if (res.ok) {
          showToast(mode === "send" ? "Reply sent ✓" : mode === "approve" ? "Approved ✓" : "Dismissed", "success");
          setEditingKey(null);
          dropProposal(pid);
        } else {
          showToast(out.skipReason || out.error || "Failed");
        }
      } catch {
        showToast("Failed");
      } finally {
        setBusy((prev) => {
          const next = new Set(prev);
          next.delete(move.key);
          return next;
        });
      }
    },
    [dropProposal],
  );

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || thinking) return;
      const next: Msg[] = [...messages, { role: "user", content: trimmed }];
      setMessages(next);
      setInput("");
      setThinking(true);
      try {
        const res = await fetch("/api/jarvis-chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: next, recordId: recordId ?? undefined }),
        });
        const data = await res.json().catch(() => ({}));
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: res.ok ? (data.answer ?? "[no answer]") : `Maverick error: ${data.error ?? res.status}` },
        ]);
      } catch {
        setMessages((prev) => [...prev, { role: "assistant", content: "Maverick is unreachable right now." }]);
      } finally {
        setThinking(false);
      }
    },
    [messages, recordId, thinking],
  );

  const openTo = useCallback((t: "moves" | "chat") => {
    setTab(t);
    setOpen(true);
  }, []);

  return (
    <>
      {/* Peek — the proactive whisper. Only when closed AND something's urgent. */}
      {showPeek && top && (
        <button
          type="button"
          onClick={() => openTo("moves")}
          className="fixed z-50 right-4 bottom-36 lg:bottom-24 max-w-[calc(100vw-2rem)] lg:max-w-[340px] flex items-start gap-2 bg-[#161b22] border border-emerald-500/40 rounded-2xl px-3 py-2.5 shadow-xl shadow-black/50 text-left animate-[pulse_2.5s_ease-in-out_infinite]"
        >
          <span className="text-base leading-none mt-0.5">🎯</span>
          <span className="min-w-0 flex-1">
            <span className="block text-[10px] font-bold uppercase tracking-wide text-emerald-400">
              {top.street}
            </span>
            <span className="block text-[12px] text-gray-200 leading-snug line-clamp-2">{top.headline}</span>
          </span>
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              setPeekDismissed((prev) => new Set(prev).add(top.key));
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.stopPropagation();
                setPeekDismissed((prev) => new Set(prev).add(top.key));
              }
            }}
            className="text-gray-600 hover:text-gray-300 text-xs leading-none mt-0.5 px-1"
            aria-label="Dismiss"
          >
            ✕
          </span>
        </button>
      )}

      {/* Dock button — clear of the mobile tab bar, with a live badge. */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={moves.length > 0 ? `Maverick — ${moves.length} moves` : "Ask Maverick"}
        className={`fixed z-50 right-4 bottom-20 lg:bottom-6 w-14 h-14 rounded-full bg-[#238636] hover:bg-[#2ea043] text-white shadow-lg shadow-black/40 border flex items-center justify-center text-xl transition-colors ${
          urgentCount > 0 && !open
            ? "border-red-400/60 animate-[pulse_2s_ease-in-out_infinite]"
            : "border-emerald-400/30"
        }`}
      >
        {open ? "✕" : "🎯"}
        {!open && moves.length > 0 && (
          <span
            className={`absolute -top-1 -right-1 min-w-[20px] h-5 px-1 rounded-full text-[11px] font-bold flex items-center justify-center border border-[#0d1117] ${
              urgentCount > 0 ? "bg-red-500 text-white" : "bg-emerald-500 text-black"
            }`}
          >
            {moves.length}
          </span>
        )}
      </button>

      {open && (
        <div className="fixed z-50 inset-x-0 bottom-0 lg:inset-auto lg:right-4 lg:bottom-24 lg:w-[420px] max-h-[80vh] flex flex-col bg-[#161b22] border border-[#30363d] lg:rounded-2xl rounded-t-2xl shadow-2xl shadow-black/60">
          {/* Header + tabs */}
          <div className="px-4 pt-3 border-b border-[#30363d]">
            <div className="flex items-center justify-between">
              <div className="text-sm font-bold text-white">Maverick</div>
              <button type="button" onClick={() => setOpen(false)} className="text-gray-500 hover:text-gray-300 min-h-[36px] min-w-[36px]" aria-label="Close">
                ✕
              </button>
            </div>
            <div className="mt-2 flex gap-1">
              <button
                type="button"
                onClick={() => setTab("moves")}
                className={`px-3 py-2 text-[13px] font-semibold rounded-t-lg border-b-2 transition-colors ${
                  tab === "moves" ? "text-white border-emerald-500" : "text-gray-500 border-transparent hover:text-gray-300"
                }`}
              >
                Next move{moves.length > 0 ? ` (${moves.length})` : ""}
              </button>
              <button
                type="button"
                onClick={() => setTab("chat")}
                className={`px-3 py-2 text-[13px] font-semibold rounded-t-lg border-b-2 transition-colors ${
                  tab === "chat" ? "text-white border-emerald-500" : "text-gray-500 border-transparent hover:text-gray-300"
                }`}
              >
                Ask
              </button>
            </div>
          </div>

          {/* ── NEXT MOVE feed ── */}
          {tab === "moves" && (
            <div className="flex-1 overflow-y-auto px-3 py-3 space-y-2.5 min-h-[200px]" style={{ paddingBottom: "max(12px, env(safe-area-inset-bottom))" }}>
              {moves.length === 0 ? (
                <div className="px-3 py-12 text-center">
                  <div className="text-2xl mb-2">🟢</div>
                  <p className="text-sm text-gray-300 font-medium">You&apos;re clear.</p>
                  <p className="text-xs text-gray-500 mt-1">I&apos;m working — I&apos;ll ping you the second something moves.</p>
                </div>
              ) : (
                <>
                  <div className="flex items-center justify-between px-1">
                    <p className="text-[11px] text-gray-500">
                      In order — most urgent × biggest first. Work top-down.
                    </p>
                    <button
                      type="button"
                      onClick={() => {
                        loadFast();
                        loadBrief();
                      }}
                      className="text-[11px] text-gray-500 hover:text-gray-300 px-1"
                    >
                      refresh
                    </button>
                  </div>
                  {moves.map((m, idx) => {
                    const isBusy = busy.has(m.key);
                    const isEditing = editingKey === m.key;
                    const canDispatch = m.primary.kind === "send" || m.primary.kind === "approve";
                    return (
                      <div
                        key={m.key}
                        className={`bg-[#1c2128] border border-[#30363d] border-l-4 ${ACCENT[m.type]} rounded-xl p-3 ${
                          idx === 0 ? "ring-1 ring-emerald-500/20" : ""
                        }`}
                      >
                        {/* chips */}
                        <div className="flex items-center flex-wrap gap-1.5">
                          <span className={`text-[9px] font-bold tracking-wider px-1.5 py-0.5 rounded-full border ${TYPE_CHIP[m.type]}`}>
                            {m.type}
                          </span>
                          {m.dollars != null && (
                            <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-emerald-950/50 text-emerald-300 border border-emerald-500/30">
                              {compactUsd(m.dollars)}
                            </span>
                          )}
                          {m.clock && (
                            <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${TONE_CHIP[m.tone]}`}>
                              {m.clock}
                            </span>
                          )}
                        </div>

                        {/* street */}
                        <div className="mt-1.5">
                          {m.href ? (
                            <Link href={m.href} className="text-white font-semibold text-[14px] leading-snug hover:text-emerald-300 transition-colors">
                              {m.street}
                            </Link>
                          ) : (
                            <span className="text-white font-semibold text-[14px] leading-snug">{m.street}</span>
                          )}
                        </div>

                        {/* Maverick voice */}
                        <p className="mt-1 text-[13px] text-gray-200 leading-snug font-medium">{m.headline}</p>

                        {/* the message we're replying to */}
                        {m.inbound && (
                          <blockquote className="mt-1.5 border-l-2 border-sky-500/40 bg-sky-950/20 pl-2.5 pr-2 py-1.5 rounded-r text-[11.5px] text-sky-200/90 italic leading-snug">
                            <span className="not-italic text-sky-400/70 text-[9px] font-bold uppercase tracking-wide mr-1">They said</span>
                            “{m.inbound}”
                          </blockquote>
                        )}

                        {/* the why */}
                        {m.why && <p className="mt-1.5 text-[11px] text-gray-500 leading-snug">{m.why}</p>}

                        {/* inline edit for a send */}
                        {m.primary.kind === "send" && isEditing && (
                          <textarea
                            value={editText}
                            onChange={(e) => setEditText(e.target.value)}
                            rows={4}
                            maxLength={640}
                            className="mt-2 w-full text-[13px] bg-[#0d1117] border border-[#30363d] rounded-lg p-2.5 text-gray-200 leading-relaxed focus:outline-none focus:border-emerald-500"
                          />
                        )}

                        {/* actions */}
                        <div className="mt-2 flex items-center gap-2">
                          {m.primary.kind === "send" ? (
                            <>
                              <button
                                type="button"
                                disabled={isBusy || (isEditing && !editText.trim())}
                                onClick={() => moveAction(m, "send", isEditing ? editText : undefined)}
                                className="flex-1 min-h-[44px] rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-[13px] font-bold transition-colors"
                              >
                                {isBusy ? "Sending…" : isEditing ? "Send edited" : "Send"}
                              </button>
                              <button
                                type="button"
                                disabled={isBusy}
                                onClick={() => {
                                  if (isEditing) setEditingKey(null);
                                  else {
                                    setEditingKey(m.key);
                                    setEditText(m.primary.kind === "send" ? m.primary.draftBody : "");
                                  }
                                }}
                                className="min-h-[44px] px-3 rounded-lg border border-[#30363d] text-gray-300 text-[13px] hover:bg-[#0d1117] transition-colors"
                              >
                                {isEditing ? "Cancel" : "Edit"}
                              </button>
                            </>
                          ) : m.primary.kind === "approve" ? (
                            <button
                              type="button"
                              disabled={isBusy}
                              onClick={() => moveAction(m, "approve")}
                              className="flex-1 min-h-[44px] rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-[13px] font-bold transition-colors"
                            >
                              {isBusy ? "Working…" : m.primary.label}
                            </button>
                          ) : m.primary.kind === "open" ? (
                            <Link
                              href={m.primary.href}
                              onClick={() => setOpen(false)}
                              className="flex-1 min-h-[44px] rounded-lg bg-[#238636] hover:bg-[#2ea043] text-white text-[13px] font-semibold transition-colors inline-flex items-center justify-center"
                            >
                              {m.primary.label} →
                            </Link>
                          ) : (
                            m.href && (
                              <Link
                                href={m.href}
                                onClick={() => setOpen(false)}
                                className="flex-1 min-h-[44px] rounded-lg bg-[#238636] hover:bg-[#2ea043] text-white text-[13px] font-semibold transition-colors inline-flex items-center justify-center"
                              >
                                Open →
                              </Link>
                            )
                          )}
                          {canDispatch && (
                            <button
                              type="button"
                              disabled={isBusy}
                              onClick={() => moveAction(m, "dismiss")}
                              title="Dismiss (kills the proposal; nothing sends)"
                              className="min-h-[44px] min-w-[44px] rounded-lg border border-[#30363d] text-gray-500 text-sm hover:bg-[#0d1117] hover:text-red-400 transition-colors"
                            >
                              ✕
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </>
              )}
            </div>
          )}

          {/* ── Chat ── */}
          {tab === "chat" && (
            <>
              <div className="px-4 pt-2 text-[10px] text-gray-500">
                {recordId ? "answering about the deal on your screen" : "pipeline-wide"} · doctrine numbers only
              </div>
              <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3 min-h-[160px]">
                {messages.length === 0 && !thinking && (
                  <div className="space-y-2">
                    <p className="text-xs text-gray-500">
                      {recordId
                        ? "Ask about this deal — stamped offer, ceiling, next move. Maverick cites the record's numbers; it never invents one."
                        : "Ask what needs you, where the belt stands, or about any deal."}
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {(recordId
                        ? ["What's my ceiling here?", "Draft my next move", "Is the math good on this one?"]
                        : ["What should I focus on right now?", "How's the belt running today?"]
                      ).map((q) => (
                        <button
                          key={q}
                          type="button"
                          onClick={() => send(q)}
                          className="text-[11px] bg-[#0d1117] border border-[#30363d] hover:border-emerald-500/50 text-gray-300 px-3 py-2 rounded-full min-h-[40px]"
                        >
                          {q}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {messages.map((m, i) => (
                  <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                    <div
                      className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap leading-relaxed ${
                        m.role === "user" ? "bg-blue-600 text-white rounded-br-sm" : "bg-[#0d1117] border border-[#30363d] text-gray-200 rounded-bl-sm"
                      }`}
                    >
                      {m.content}
                    </div>
                  </div>
                ))}
                {thinking && <div className="text-xs text-gray-500 animate-pulse">Maverick is thinking…</div>}
              </div>

              <div className="p-3 border-t border-[#30363d] flex gap-2" style={{ paddingBottom: "max(12px, env(safe-area-inset-bottom))" }}>
                <input
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") send(input);
                  }}
                  placeholder={recordId ? "Ask about this deal…" : "Ask Maverick…"}
                  className="flex-1 bg-[#0d1117] border border-[#30363d] rounded-xl px-3 py-2.5 text-sm text-white focus:outline-none focus:border-emerald-500 placeholder-gray-600 min-h-[44px]"
                />
                <button
                  type="button"
                  onClick={() => send(input)}
                  disabled={thinking || !input.trim()}
                  className="bg-emerald-700 hover:bg-emerald-600 text-white text-sm font-semibold px-4 rounded-xl min-h-[44px] disabled:opacity-50"
                >
                  Send
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}
