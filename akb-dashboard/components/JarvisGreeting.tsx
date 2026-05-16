"use client";

/**
 * @deprecated Legacy depth-aware ACT NOW card greeting. Superseded
 * by the Maverick Shepherd panel (Phase 9.1) which renders a
 * persistent presence on every page with priority surface BroCards.
 * Component retains the `Jarvis` file name for backwards compatibility
 * with existing imports until 9.1 lands and Shepherd panel replaces
 * this. Visible "Jarvis · Act Now" header updated to "Maverick · Act
 * Now" per Phase 9.11 (corrected 5/16 Commit B.1 — was missed in the
 * original 9.11 pass because the grep targeted only the three
 * components' user-facing strings but not their headers).
 */

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import type {
  AgentContext,
  BroCard,
  CardType,
  DepthScore,
  JarvisBrief,
} from "@/types/jarvis";
import { CARD_TYPE_CONFIG, URGENCY_LABEL } from "@/types/jarvis";
import { showToast } from "@/components/Toast";

const DEPTH_LABEL: Record<DepthScore, string> = {
  0: "Cold",
  1: "Greeted",
  2: "Engaged",
  3: "Relationship",
};

const DEPTH_BADGE_CLASS: Record<DepthScore, string> = {
  0: "bg-gray-500/15 text-gray-300 border-gray-500/30",
  1: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  2: "bg-blue-500/15 text-blue-300 border-blue-500/30",
  3: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
};

const URGENCY_BG: Record<string, string> = {
  critical: "border-red-500/50",
  high: "border-red-500/40",
  medium: "border-amber-500/40",
  low: "border-gray-500/30",
};

function describeRelationship(ac: AgentContext): string {
  const parts: string[] = [];
  parts.push(`${ac.totalListings} listing${ac.totalListings === 1 ? "" : "s"}`);
  parts.push(DEPTH_LABEL[ac.depthScore]);
  if (ac.daysSinceLastInteraction === 0) parts.push("last contact today");
  else if (ac.daysSinceLastInteraction !== null) {
    parts.push(`last contact ${ac.daysSinceLastInteraction}d ago`);
  } else parts.push("no prior contact");
  return parts.join(" · ");
}

function AgentBadge({ ac }: { ac: AgentContext }) {
  return (
    <div className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[10px] font-medium border ${DEPTH_BADGE_CLASS[ac.depthScore]}`}>
      <span className="font-semibold">{ac.agentName}</span>
      <span className="opacity-70">· {describeRelationship(ac)}</span>
    </div>
  );
}

function UnansweredStrip({ ac }: { ac: AgentContext }) {
  if (ac.propertiesWithUnansweredInbound.length === 0) return null;
  const list = ac.propertiesWithUnansweredInbound.slice(0, 3);
  return (
    <div className="bg-red-500/10 border border-red-500/40 rounded px-3 py-2 text-xs text-red-300 flex flex-wrap items-center gap-2">
      <span className="font-bold uppercase tracking-wider">Unanswered</span>
      <span className="text-red-400/80">
        {ac.propertiesWithUnansweredInbound.length} message(s) from {ac.agentName} await your reply. Address those first or this outreach may damage the relationship.
      </span>
      {list.map((p) => (
        <Link key={p.recordId} href={`/pipeline/${p.recordId}`} className="underline hover:text-red-200">
          {p.address}
        </Link>
      ))}
    </div>
  );
}

interface OptionState {
  draft: string;
  subject: string;
}

function CardBlock({ card, onAfterSend }: { card: BroCard; onAfterSend: () => void }) {
  const config = CARD_TYPE_CONFIG[card.card_type as CardType] ?? CARD_TYPE_CONFIG.STALE_REENGAGEMENT;
  const urgency = URGENCY_LABEL[config.urgency] ?? "FYI";
  const initialIdx = card.recommendation_index ?? 0;
  const [selectedIdx, setSelectedIdx] = useState(initialIdx);
  const [overrides, setOverrides] = useState<Record<number, OptionState>>({});
  const [sending, setSending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]);

  const opt = card.options[selectedIdx] ?? card.options[0];
  const optDraft = opt?.draft ?? "";
  const optSubject = opt?.subject ?? "";
  const ov = overrides[selectedIdx];
  const draft = ov?.draft ?? optDraft;
  const subject = ov?.subject ?? optSubject;

  const setDraft = (v: string) => {
    setOverrides((prev) => ({ ...prev, [selectedIdx]: { draft: v, subject } }));
  };
  const setSubject = (v: string) => {
    setOverrides((prev) => ({ ...prev, [selectedIdx]: { draft, subject: v } }));
  };

  const send = useCallback(async (force = false) => {
    if (!opt || sending) return;
    setSending(true);
    setWarnings([]);
    try {
      const res = await fetch(`/api/deal-action/${card.recordId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channel: opt.channel,
          body: draft,
          subject: subject || undefined,
          action_type: opt.action_type,
          force,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 422 && !force) {
        setWarnings(data.warnings ?? [data.reason ?? "Safety check failed."]);
        if (data.suggestedDraft) setDraft(data.suggestedDraft);
        setConfirming(true);
        return;
      }
      if (!res.ok) {
        showToast(data.error ?? data.detail ?? "Action failed");
        return;
      }
      showToast("Action sent", "success");
      setConfirming(false);
      setWarnings([]);
      onAfterSend();
    } catch (err) {
      showToast(`Action failed: ${String(err)}`);
    } finally {
      setSending(false);
    }
  }, [card.recordId, draft, subject, opt, sending, onAfterSend]);

  return (
    <div className={`relative bg-[#1c2128] rounded-lg border ${URGENCY_BG[config.urgency] ?? "border-[#30363d]"} p-4 space-y-3`}>
      {/* Card-level click-through. Action buttons sit above this in z-order
          and stop propagation so they don't trigger workspace navigation. */}
      <Link
        href={`/pipeline/${card.recordId}`}
        className="absolute inset-0 z-0 rounded-lg"
        aria-label={`Open workspace for ${card.address}`}
      />

      {/* Header */}
      <div className="relative z-10 flex items-start justify-between gap-3 pointer-events-none">
        <div className="space-y-1.5 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[10px] font-bold tracking-widest text-red-400">{urgency}</span>
            <span className="text-[10px] uppercase tracking-wider text-gray-500">{card.card_type.replace(/_/g, " ")}</span>
            <span className="text-[10px] text-gray-500">score {card.score}</span>
            {card.dealStage && (
              <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-[#0d1117] border border-[#30363d] text-gray-300">
                {card.dealStage.replace(/_/g, " ")}
              </span>
            )}
            {card.agentContext?.isPrincipal && (
              <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-purple-500/15 border border-purple-500/30 text-purple-300">
                principal
              </span>
            )}
          </div>
          <h3 className="text-base font-bold text-white leading-tight">{card.headline}</h3>
          <span className="text-xs text-blue-400">{card.address} ↗</span>
        </div>
        {card.agentContext && <AgentBadge ac={card.agentContext} />}
      </div>

      {/* Unanswered strip */}
      {card.agentContext && (
        <div className="relative z-10">
          <UnansweredStrip ac={card.agentContext} />
        </div>
      )}

      {/* Body — non-interactive, but kept above the click-through layer so
          text selection works without triggering navigation. */}
      <div className="relative z-10 text-sm text-gray-300 space-y-1 pointer-events-none">
        <p className="pointer-events-auto select-text">{card.summary}</p>
        {card.why_this_matters && (
          <p className="pointer-events-auto select-text text-xs text-gray-500 italic">{card.why_this_matters}</p>
        )}
      </div>

      {/* Option tabs */}
      {card.options.length > 0 && (
        <div className="relative z-10 space-y-2">
          <div className="flex gap-1.5 flex-wrap">
            {card.options.map((o, i) => (
              <button
                key={`${o.label}-${i}`}
                type="button"
                onClick={() => { setSelectedIdx(i); setWarnings([]); setConfirming(false); }}
                className={`text-[11px] px-2.5 py-1 rounded border transition-colors ${
                  i === selectedIdx
                    ? "bg-emerald-700 border-emerald-500 text-white"
                    : "bg-[#0d1117] border-[#30363d] text-gray-400 hover:text-gray-200"
                }`}
              >
                {o.label}{i === card.recommendation_index ? " ★" : ""}
              </button>
            ))}
          </div>

          {opt && (opt.channel === "email") && (
            <input
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Email subject"
              className="w-full bg-[#0d1117] border border-[#30363d] rounded px-2 py-1.5 text-xs text-white focus:outline-none focus:border-emerald-500"
            />
          )}

          {opt && (opt.channel === "sms" || opt.channel === "email") && (
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={4}
              placeholder={`Draft ${opt.channel === "sms" ? "text" : "email"}...`}
              className="w-full bg-[#0d1117] border border-[#30363d] rounded p-2 text-sm text-white focus:outline-none focus:border-emerald-500 resize-y"
            />
          )}

          {warnings.length > 0 && (
            <div className="bg-amber-500/10 border border-amber-500/40 rounded px-3 py-2 text-xs text-amber-300 space-y-1">
              <div className="font-bold uppercase tracking-wider">Safety check</div>
              {warnings.map((w, i) => <div key={i}>{w}</div>)}
            </div>
          )}

          <div className="flex gap-2">
            {opt && (opt.channel === "sms" || opt.channel === "email") ? (
              <>
                <button
                  type="button"
                  onClick={() => send(confirming)}
                  disabled={sending || !draft.trim()}
                  className="bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 text-white text-xs font-semibold px-4 py-2 rounded min-h-[36px]"
                >
                  {sending ? "Sending..." : confirming ? "Send anyway" : (opt.channel === "sms" ? "Send via Quo" : "Create email draft")}
                </button>
                {confirming && (
                  <button
                    type="button"
                    onClick={() => { setConfirming(false); setWarnings([]); }}
                    className="bg-[#30363d] hover:bg-[#3d444d] text-gray-300 text-xs px-3 py-2 rounded min-h-[36px]"
                  >
                    Cancel
                  </button>
                )}
              </>
            ) : opt ? (
              <button
                type="button"
                onClick={() => send(false)}
                disabled={sending}
                className="bg-[#30363d] hover:bg-[#3d444d] text-gray-200 text-xs font-semibold px-4 py-2 rounded min-h-[36px]"
              >
                {sending ? "..." : opt.label}
              </button>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}

export default function JarvisGreeting() {
  const [brief, setBrief] = useState<JarvisBrief | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetch("/api/jarvis-brief", { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) {
          const data = await r.json().catch(() => ({}));
          throw new Error(data.error ?? `HTTP ${r.status}`);
        }
        return r.json();
      })
      .then((data: JarvisBrief) => setBrief(data))
      .catch((err) => setError(String(err)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <section className="bg-[#161b22] rounded-lg border border-[#30363d] p-4 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-bold uppercase tracking-widest text-gray-400">Maverick · Act Now</h2>
          {brief?.metadata.generated_at && (
            <p className="text-[10px] text-gray-600">
              {brief.broCards.length} card{brief.broCards.length === 1 ? "" : "s"} · {brief.metadata.total_active_deals} active deals · generated {new Date(brief.metadata.generated_at).toLocaleTimeString()}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="text-xs bg-[#1c2128] border border-[#30363d] text-gray-300 px-3 py-1.5 rounded hover:bg-[#30363d] disabled:opacity-50"
        >
          {loading ? "Loading..." : "Refresh"}
        </button>
      </div>

      {loading && !brief && (
        <div className="text-gray-500 text-sm animate-pulse text-center py-6">
          Building your briefing...
        </div>
      )}

      {error && (
        <div className="bg-red-500/10 border border-red-500/40 rounded px-3 py-2 text-xs text-red-300">
          {error}
        </div>
      )}

      {brief && brief.broCards.length === 0 && !loading && (
        <div className="text-gray-500 text-sm text-center py-6">
          Nothing urgent. Pipeline is quiet.
        </div>
      )}

      <div className="space-y-3">
        {brief?.broCards.map((c) => (
          <CardBlock key={`${c.recordId}-${c.rank}`} card={c} onAfterSend={load} />
        ))}
      </div>

      {brief && brief.ambiguousQueue.length > 0 && (
        <details className="group">
          <summary className="text-xs text-gray-500 cursor-pointer hover:text-gray-300">
            {brief.ambiguousQueue.length} listing(s) with ambiguous messages — review
          </summary>
          <div className="mt-2 space-y-1">
            {brief.ambiguousQueue.map((q) => (
              <Link key={q.recordId} href={`/pipeline/${q.recordId}`} className="block text-xs text-amber-400 hover:underline">
                {q.address} — {q.ambiguousMessages.length} ambiguous
              </Link>
            ))}
          </div>
        </details>
      )}
    </section>
  );
}
