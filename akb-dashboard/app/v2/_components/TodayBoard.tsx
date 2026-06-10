"use client";

// TODAY — the decision queue, AKBdash-styled V1 tab.
// Round-2 portfolio rules applied:
//   1. Stranger test on every button — plain labels, consequence subtext
//      wherever the effect isn't obvious ("Let it go — marks the lead dead").
//   2. One merged queue sorted importance → recency: ACT NOW > HIGH > MEDIUM
//      > LOW, with today's live items pinned above stale cold-sweep items.
//   3. Maverick's recommended option is lit (subtle pulse + label) with the
//      reasoning directly adjacent; other options render secondary.

import Link from "next/link";
import { useMemo, useState } from "react";
import { useV2Data } from "../_lib/data";
import type { AuditEntry, OperatorItem, QueueCard } from "../_lib/types";
import { ago, money, timeStamp } from "../_lib/format";
import { deriveDecisions, type DecisionOption } from "../_lib/decisions";
import { humanizeEvent, translateSystemText } from "../_lib/translate";
import { mergeAndSort } from "../_lib/policy";
import glow from "./glow.module.css";

export default function TodayBoard() {
  const {
    openCards,
    suppressedCards,
    actionableItems,
    suppressedItems,
    queue,
    listingsById,
    activityToday,
    loading,
    lastFetched,
    errors,
    refresh,
  } = useV2Data();

  const merged = useMemo(
    () => mergeAndSort(actionableItems, openCards, listingsById),
    [actionableItems, openCards, listingsById],
  );
  const total = merged.length;
  const heldCards = queue?.held ?? [];
  const suppressedTotal = suppressedItems.length + suppressedCards.length;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-white">TODAY</h1>
          <p className="text-[10px] text-gray-600">
            {activityToday.sends == null ? "sends today: no signal" : `${activityToday.sends} texted today`}
            {" · "}
            {activityToday.replies == null ? "replies: no signal" : `${activityToday.replies} replies today`}
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

      {errors.length > 0 && (
        <div className="bg-red-500/10 border border-red-500/40 rounded px-3 py-2 text-xs text-red-300 space-y-0.5">
          {errors.map((e) => (
            <div key={e}>source unavailable — {e}</div>
          ))}
        </div>
      )}

      <section className="bg-[#161b22] rounded-lg border border-[#30363d] p-4 space-y-4">
        <h2 className="text-sm font-bold uppercase tracking-widest text-gray-400">
          Needs You
          {!loading && <span className="ml-2 text-amber-300 font-mono">{total}</span>}
        </h2>

        {loading && <Skeletons />}

        {!loading && total === 0 && (
          <div className="text-center py-6">
            <p className="text-sm font-bold text-emerald-300">Queue is clear.</p>
            <p className="mt-1 text-xs text-gray-500">Nothing needs a decision. The machine keeps running.</p>
          </div>
        )}

        <div className="space-y-3">
          {merged.map((entry) =>
            entry.type === "item" ? (
              <OperatorItemCard key={entry.item.id} item={entry.item} live={entry.liveToday} />
            ) : (
              <QueueCardView key={entry.card.id} card={entry.card} live={entry.liveToday} />
            ),
          )}
        </div>

        {suppressedTotal > 0 && <AlreadyDecided items={suppressedItems} cards={suppressedCards} />}
        {heldCards.length > 0 && <HeldSection cards={heldCards} />}
      </section>

      <OvernightDigest />
    </div>
  );
}

function Skeletons() {
  return (
    <div className="space-y-3">
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-28 animate-pulse rounded-lg border border-[#30363d] bg-[#1c2128]" />
      ))}
    </div>
  );
}

// ── Decision buttons — stranger-test labels, consequence subtext, the
// recommended option lit with the reasoning adjacent. ────────────────────

function DecisionButton({
  option,
  busy,
  onChoose,
}: {
  option: DecisionOption;
  busy: boolean;
  onChoose: () => void;
}) {
  const base =
    "flex flex-col items-start text-left px-4 py-2 rounded min-h-[36px] disabled:opacity-50 transition-colors";
  const tone = option.recommended
    ? `bg-emerald-700 hover:bg-emerald-600 text-white ${glow.recommend}`
    : option.kind === "later"
      ? "bg-[#30363d] hover:bg-[#3d444d] text-gray-300"
      : "bg-[#1c2128] hover:bg-[#30363d] text-gray-200 border border-[#30363d]";
  return (
    <button type="button" onClick={onChoose} disabled={busy} className={`${base} ${tone}`}>
      <span className="text-xs font-semibold leading-tight">{option.label}</span>
      {option.consequence && (
        <span className={`text-[9px] leading-tight ${option.recommended ? "text-emerald-200/80" : "text-gray-500"}`}>
          {option.consequence}
        </span>
      )}
    </button>
  );
}

function RecommendsTag() {
  return (
    <span className="text-[9px] font-bold tracking-widest text-emerald-400 uppercase">
      Maverick recommends
    </span>
  );
}

const PRIORITY_BORDER: Record<string, string> = {
  high: "border-red-500/40",
  medium: "border-amber-500/40",
  low: "border-[#30363d]",
};
const PRIORITY_BADGE: Record<string, string> = {
  high: "bg-red-500/15 text-red-300 border-red-500/30",
  medium: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  low: "bg-gray-500/15 text-gray-300 border-gray-500/30",
};

function LiveBadge() {
  return (
    <span className="px-2 py-0.5 rounded text-[10px] font-medium border bg-emerald-500/15 text-emerald-300 border-emerald-500/30">
      TODAY
    </span>
  );
}

// ── Operator action items ────────────────────────────────────────────────

function OperatorItemCard({ item, live }: { item: OperatorItem; live: boolean }) {
  const { setOperatorItemStatus } = useV2Data();
  const [acting, setActing] = useState<string | null>(null);
  const [recorded, setRecorded] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  const options = deriveDecisions(item);
  const recommendedOpt = options.find((o) => o.recommended);
  const context = item.context ? translateSystemText(item.context) : null;

  async function choose(o: DecisionOption) {
    if (o.kind === "open") return;
    setActing(o.label);
    setFailed(false);
    const ok = await setOperatorItemStatus(item.id, o.kind === "later" ? "deferred" : "resolved");
    if (!ok) setFailed(true);
    else if (o.kind === "record") setRecorded(o.label);
    setActing(null);
  }

  return (
    <div className={`bg-[#1c2128] rounded-lg border ${PRIORITY_BORDER[item.priority] ?? PRIORITY_BORDER.low} p-4 space-y-3`}>
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1.5 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            {live && <LiveBadge />}
            <span className={`px-2 py-0.5 rounded text-[10px] font-medium border uppercase tracking-wider ${PRIORITY_BADGE[item.priority] ?? PRIORITY_BADGE.low}`}>
              {item.priority}
            </span>
            <span className="text-[10px] text-gray-600">{ago(item.createdAt)}</span>
          </div>
          <h3 className="text-base font-bold text-white leading-tight">{item.title}</h3>
        </div>
      </div>

      {item.verbatimReply && (
        <div className="bg-amber-500/10 border border-amber-500/40 rounded px-3 py-2 text-sm text-amber-200 italic leading-relaxed">
          &ldquo;{item.verbatimReply}&rdquo;
        </div>
      )}

      {/* Reasoning sits directly above the lit button (round-2 rule 3). */}
      {item.actionRequired && (
        <div className="space-y-0.5">
          {recommendedOpt && <RecommendsTag />}
          <p className="text-sm text-gray-300 leading-relaxed">{item.actionRequired}</p>
        </div>
      )}

      {context && (
        <SystemText summary={context.summary} raw={item.context!} collapsed={context.machineVoice} />
      )}

      <div className="flex flex-wrap items-center gap-2">
        {recorded ? (
          <span className="text-xs font-semibold text-emerald-300 bg-emerald-500/10 border border-emerald-500/30 rounded px-3 py-2">
            ✓ Recorded: {recorded} — execute on the deal page
          </span>
        ) : (
          options.map((o) =>
            o.kind === "open" ? (
              item.sourceRecordId && (
                <Link
                  key={o.label}
                  href={`/pipeline/${item.sourceRecordId}`}
                  className="flex flex-col items-start text-left px-4 py-2 rounded min-h-[36px] bg-[#1c2128] hover:bg-[#30363d] text-gray-200 border border-[#30363d] transition-colors"
                >
                  <span className="text-xs font-semibold leading-tight">{o.label}</span>
                  {o.consequence && <span className="text-[9px] leading-tight text-gray-500">{o.consequence}</span>}
                </Link>
              )
            ) : (
              <DecisionButton key={o.label} option={o} busy={acting !== null} onChoose={() => choose(o)} />
            ),
          )
        )}
        {!recorded && item.sourceRecordId && (
          <Link href={`/pipeline/${item.sourceRecordId}`} className="text-xs text-blue-400 hover:underline ml-auto">
            deal page ↗
          </Link>
        )}
        {failed && <span className="text-[10px] text-red-400">update failed — try again</span>}
      </div>
    </div>
  );
}

// ── Queue cards ──────────────────────────────────────────────────────────

const KIND_META: Record<string, { label: string; border: string; badge: string }> = {
  response: { label: "AGENT REPLIED", border: "border-amber-500/40", badge: "bg-amber-500/15 text-amber-300 border-amber-500/30" },
  dd: { label: "ANSWERS MISSING", border: "border-purple-500/40", badge: "bg-purple-500/15 text-purple-300 border-purple-500/30" },
  stale: { label: "GONE QUIET", border: "border-[#30363d]", badge: "bg-gray-500/15 text-gray-300 border-gray-500/30" },
  deal: { label: "DEAL IN FLIGHT", border: "border-emerald-500/40", badge: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30" },
};

// Primary (recommended) action per card kind — plain label + consequence.
const CARD_PRIMARY: Record<string, { label: string; consequence: string }> = {
  response: { label: "Reply", consequence: "opens the deal page to answer them" },
  dd: { label: "Finish the checklist", consequence: "opens the deal page" },
  stale: { label: "Follow up", consequence: "opens the deal page to send it" },
};

function recommendation(card: QueueCard): { rec: string; why: string } {
  switch (card.kind) {
    case "response":
      return {
        rec: `Reply to ${card.agentName ?? "the agent"} — cap ${money(card.mao)}.`,
        why: `Cap is 65% of the ${money(card.listPrice)} list price. Their message is newer than ours — the ball is in our court.`,
      };
    case "dd":
      return {
        rec: `Hold the offer — ${card.missingItems?.length ?? 0} of 12 property answers still missing.`,
        why: "The checklist must be complete before contract numbers move.",
      };
    case "stale":
      return {
        rec: `${card.daysSilent} days of silence — follow up or let it go.`,
        why: `Our ${money(card.mao)} offer stays on record either way.`,
      };
    case "deal":
      return {
        rec: `Advance the contract — ${card.status ?? "?"}${card.closingStatus ? `, closing ${card.closingStatus}` : ""}.`,
        why: `Contract ${money(card.contractPrice)}, spread ${money(card.spread)}.`,
      };
    default:
      return { rec: "Review.", why: "" };
  }
}

function QueueCardView({ card, live }: { card: QueueCard; live: boolean }) {
  const [confirmRelease, setConfirmRelease] = useState(false);
  const [released, setReleased] = useState(false);
  const [releaseError, setReleaseError] = useState(false);
  const meta = KIND_META[card.kind] ?? KIND_META.stale;
  const primary = CARD_PRIMARY[card.kind];
  const { rec, why } = recommendation(card);
  const place = [card.city, card.state].filter(Boolean).join(", ");

  async function release() {
    setReleaseError(false);
    try {
      const r = await fetch("/api/mark-dead", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recordId: card.recordId }),
      });
      if (!r.ok) throw new Error();
      setReleased(true);
    } catch {
      setReleaseError(true);
    }
    setConfirmRelease(false);
  }

  if (released) {
    return (
      <div className="bg-[#1c2128] rounded-lg border border-[#30363d] p-4">
        <p className="text-sm text-gray-400">
          ✓ {card.address} — let go and marked dead. Our offer stays on record if they come back.
        </p>
      </div>
    );
  }

  return (
    <div className={`bg-[#1c2128] rounded-lg border ${meta.border} p-4 space-y-3`}>
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            {live && <LiveBadge />}
            <span className={`px-2 py-0.5 rounded text-[10px] font-medium border uppercase tracking-wider ${meta.badge}`}>
              {meta.label}
            </span>
          </div>
          <h3 className="text-base font-bold text-white leading-tight">{card.address}</h3>
          <p className="text-xs text-gray-500">
            {place}
            {card.agentName ? ` · ${card.agentName}` : ""}
          </p>
        </div>
      </div>

      {card.kind === "response" && card.inboundMessage && (
        <div className="bg-amber-500/10 border border-amber-500/40 rounded px-3 py-2 text-sm text-amber-200 italic leading-relaxed">
          &ldquo;{card.inboundMessage}&rdquo;
        </div>
      )}
      {card.kind === "dd" && card.missingItems && card.missingItems.length > 0 && (
        <p className="text-xs text-gray-500">
          Missing: {card.missingItems.slice(0, 4).join(" · ")}
          {card.missingItems.length > 4 ? ` · +${card.missingItems.length - 4} more` : ""}
        </p>
      )}

      {/* Reasoning directly above the lit button. */}
      <div className="space-y-0.5">
        {primary && <RecommendsTag />}
        <p className="text-sm text-gray-300 leading-relaxed">{rec}</p>
        {why && <p className="text-xs text-gray-500 italic">{why}</p>}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {card.table === "listings" && primary ? (
          <>
            <Link
              href={`/pipeline/${card.recordId}`}
              className={`flex flex-col items-start text-left px-4 py-2 rounded min-h-[36px] bg-emerald-700 hover:bg-emerald-600 text-white transition-colors ${glow.recommend}`}
            >
              <span className="text-xs font-semibold leading-tight">{primary.label}</span>
              <span className="text-[9px] leading-tight text-emerald-200/80">{primary.consequence}</span>
            </Link>
            {card.kind === "stale" &&
              (confirmRelease ? (
                <>
                  <button
                    type="button"
                    onClick={release}
                    className="flex flex-col items-start text-left px-4 py-2 rounded min-h-[36px] bg-red-700 hover:bg-red-600 text-white"
                  >
                    <span className="text-xs font-semibold leading-tight">Yes — mark it dead</span>
                    <span className="text-[9px] leading-tight text-red-200/80">can&apos;t be undone from here</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmRelease(false)}
                    className="text-xs font-semibold bg-[#30363d] hover:bg-[#3d444d] text-gray-300 px-3 py-2 rounded min-h-[36px]"
                  >
                    Keep it
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmRelease(true)}
                  className="flex flex-col items-start text-left px-4 py-2 rounded min-h-[36px] bg-[#1c2128] hover:bg-[#30363d] text-gray-200 border border-[#30363d]"
                >
                  <span className="text-xs font-semibold leading-tight">Let it go</span>
                  <span className="text-[9px] leading-tight text-gray-500">marks the lead dead</span>
                </button>
              ))}
          </>
        ) : (
          <Link
            href="/deals"
            className="flex flex-col items-start text-left px-4 py-2 rounded min-h-[36px] bg-[#30363d] hover:bg-[#3d444d] text-gray-200"
          >
            <span className="text-xs font-semibold leading-tight">Open the deal</span>
            <span className="text-[9px] leading-tight text-gray-500">opens the Deals list</span>
          </Link>
        )}
        {releaseError && <span className="text-[10px] text-red-400">that didn&apos;t save — try again</span>}
        {card.table === "listings" && (
          <Link href={`/pipeline/${card.recordId}`} className="text-xs text-blue-400 hover:underline ml-auto">
            deal page ↗
          </Link>
        )}
      </div>
    </div>
  );
}

// ── Already decided / held ───────────────────────────────────────────────

function AlreadyDecided({
  items,
  cards,
}: {
  items: Array<{ item: OperatorItem; reference: string }>;
  cards: Array<{ card: QueueCard; reference: string }>;
}) {
  const { setOperatorItemStatus } = useV2Data();
  const n = items.length + cards.length;
  return (
    <details className="group">
      <summary className="text-xs text-gray-500 cursor-pointer hover:text-gray-300 select-none">
        Already decided ({n}) — the system settled these; no action needed
      </summary>
      <div className="mt-2 space-y-1.5">
        {items.map(({ item, reference }) => (
          <div
            key={item.id}
            className="flex flex-wrap items-center gap-x-3 gap-y-1 bg-[#0d1117] border border-[#30363d] rounded px-3 py-2"
          >
            <span className="text-xs text-gray-400">{item.title}</span>
            <span className="text-[10px] text-gray-600">{reference}</span>
            <button
              type="button"
              onClick={() => setOperatorItemStatus(item.id, "resolved")}
              className="ml-auto text-[10px] font-semibold text-gray-500 hover:text-gray-200 border border-[#30363d] rounded px-2 py-1"
              title="marks it handled and removes it from this list"
            >
              Clear it
            </button>
          </div>
        ))}
        {cards.map(({ card, reference }) => (
          <div
            key={card.id}
            className="flex flex-wrap items-center gap-x-3 gap-y-1 bg-[#0d1117] border border-[#30363d] rounded px-3 py-2"
          >
            <span className="text-xs text-gray-400">{card.address}</span>
            <span className="text-[10px] text-gray-600">{reference}</span>
          </div>
        ))}
      </div>
    </details>
  );
}

function HeldSection({ cards }: { cards: QueueCard[] }) {
  return (
    <details className="group">
      <summary className="text-xs text-gray-500 cursor-pointer hover:text-gray-300 select-none">
        Held ({cards.length}) — come back when the hold expires
      </summary>
      <div className="mt-2 space-y-1.5">
        {cards.map((c) => (
          <div
            key={c.id}
            className="flex items-center justify-between bg-[#0d1117] border border-[#30363d] rounded px-3 py-2 text-xs text-gray-500"
          >
            <span>
              {c.address} <span className="text-gray-700">· {KIND_META[c.kind]?.label}</span>
            </span>
            <span className="font-mono text-[10px]">until {timeStamp(c.holdUntil)}</span>
          </div>
        ))}
      </div>
    </details>
  );
}

// ── Overnight digest ─────────────────────────────────────────────────────

function OvernightDigest() {
  const { audit, auditWindow } = useV2Data();
  if (!audit) return null;

  const dayAgo = Date.now() - 24 * 3_600_000;
  const recent = audit.filter((e) => new Date(e.ts).getTime() >= dayAgo);

  const byAgent = new Map<string, { ok: number; fail: number; uncertain: number }>();
  for (const e of recent) {
    const g = byAgent.get(e.agent) ?? { ok: 0, fail: 0, uncertain: 0 };
    if (e.status === "confirmed_success") g.ok++;
    else if (e.status === "confirmed_failure") g.fail++;
    else g.uncertain++;
    byAgent.set(e.agent, g);
  }
  const failures = recent.filter((e) => e.status === "confirmed_failure");

  return (
    <section className="bg-[#161b22] rounded-lg border border-[#30363d] p-4 space-y-3">
      <h2 className="text-sm font-bold uppercase tracking-widest text-gray-400">
        Last 24h — The Machine
        <span className="ml-2 font-normal normal-case tracking-normal text-[10px] text-gray-600">
          {recent.length} confirmed events
          {auditWindow.oldest ? ` · log reaches back to ${timeStamp(auditWindow.oldest)}` : ""}
        </span>
      </h2>

      {recent.length === 0 ? (
        <p className="text-xs text-gray-500">
          No events in the last 24h inside the log window — either a quiet day, or high-frequency
          events pushed the window forward. Not the same as &ldquo;nothing ran&rdquo;.
        </p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {[...byAgent.entries()]
            .sort((a, b) => b[1].ok + b[1].fail + b[1].uncertain - (a[1].ok + a[1].fail + a[1].uncertain))
            .map(([agent, g]) => (
              <div key={agent} className="bg-[#1c2128] rounded border border-[#30363d] px-3 py-2">
                <p className="text-[10px] font-bold uppercase tracking-wider text-gray-400">{agent}</p>
                <p className="font-mono text-xs">
                  <span className="text-emerald-400">{g.ok}✓</span>
                  {g.fail > 0 && <span className="ml-2 text-red-400">{g.fail}✗</span>}
                  {g.uncertain > 0 && <span className="ml-2 text-amber-400">{g.uncertain}?</span>}
                </p>
              </div>
            ))}
        </div>
      )}

      {failures.length > 0 && (
        <details className="group">
          <summary className="text-xs font-semibold text-red-400 cursor-pointer hover:text-red-300 select-none">
            {failures.length} confirmed failures
          </summary>
          <div className="mt-2 space-y-1.5">
            {failures.slice(0, 20).map((e, i) => (
              <FailureRow key={i} e={e} />
            ))}
          </div>
        </details>
      )}
    </section>
  );
}

function FailureRow({ e }: { e: AuditEntry }) {
  const [raw, setRaw] = useState(false);
  return (
    <div className="bg-red-500/10 border border-red-500/40 rounded px-3 py-2">
      <p className="text-xs text-red-300">
        <span className="font-bold capitalize">{e.agent}</span> — {humanizeEvent(e.event)} failed,{" "}
        {timeStamp(e.ts)}
      </p>
      <div className="mt-1 flex items-center gap-3">
        {e.recordId && (
          <Link href={`/pipeline/${e.recordId}`} className="text-[10px] font-semibold text-blue-400 hover:underline">
            open record ↗
          </Link>
        )}
        {e.error && (
          <button type="button" onClick={() => setRaw(!raw)} className="text-[10px] font-semibold text-gray-500 hover:text-gray-300">
            {raw ? "hide" : "system log"}
          </button>
        )}
      </div>
      {raw && e.error && (
        <p className="mt-1 break-all bg-[#0d1117] border border-[#30363d] rounded px-2 py-1.5 font-mono text-[10px] text-gray-500">
          {e.error.slice(0, 300)}
        </p>
      )}
    </div>
  );
}

function SystemText({ summary, raw, collapsed }: { summary: string; raw: string; collapsed: boolean }) {
  const [open, setOpen] = useState(false);
  if (!collapsed) return <p className="text-xs text-gray-500 italic">{summary}</p>;
  return (
    <div>
      <p className="text-xs text-gray-500 italic">
        {summary}{" "}
        <button type="button" onClick={() => setOpen(!open)} className="not-italic font-semibold text-gray-600 hover:text-gray-400">
          {open ? "hide log" : "system log"}
        </button>
      </p>
      {open && (
        <p className="mt-1 break-words bg-[#0d1117] border border-[#30363d] rounded px-2 py-1.5 font-mono text-[10px] text-gray-500 leading-relaxed">
          {raw}
        </p>
      )}
    </div>
  );
}
