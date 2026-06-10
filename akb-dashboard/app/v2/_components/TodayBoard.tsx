"use client";

// TODAY — the decision queue, restyled into AKBdash (V1's design system) and
// mounted as a tab inside the V1 shell. Carries all four portable libs:
//   decisions.ts   buttons are the stated options, not generic verbs
//   translate.ts   plain English on the surface; raw entry under "system log"
//   data.tsx       honest zero (no number without a wired source)
//   policy.ts      queue hygiene (already-decided items leave the queue)
// Deal links go to /pipeline/[id] — V1's canonical deal page.

import Link from "next/link";
import { useState } from "react";
import { V2DataProvider, useV2Data } from "../_lib/data";
import type { AuditEntry, OperatorItem, QueueCard } from "../_lib/types";
import { ago, money, timeStamp } from "../_lib/format";
import { deriveDecisions } from "../_lib/decisions";
import { humanizeEvent, translateSystemText } from "../_lib/translate";

export default function TodayBoard() {
  return (
    <V2DataProvider>
      <Today />
    </V2DataProvider>
  );
}

function Today() {
  const {
    openCards,
    suppressedCards,
    actionableItems,
    suppressedItems,
    queue,
    activityToday,
    loading,
    lastFetched,
    errors,
    refresh,
  } = useV2Data();

  const total = actionableItems.length + openCards.length;
  const heldCards = queue?.held ?? [];
  const suppressedTotal = suppressedItems.length + suppressedCards.length;

  return (
    <div className="space-y-6">
      {/* Header — matches CommandCenter's title row */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-white">TODAY</h1>
          <p className="text-[10px] text-gray-600">
            {/* Honest zero: wired sources only. */}
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

      {/* Decision queue */}
      <section className="bg-[#161b22] rounded-lg border border-[#30363d] p-4 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-bold uppercase tracking-widest text-gray-400">
            Needs You
            {!loading && (
              <span className="ml-2 text-amber-300 font-mono">{total}</span>
            )}
          </h2>
        </div>

        {loading && <Skeletons />}

        {!loading && total === 0 && (
          <div className="text-center py-6">
            <p className="text-sm font-bold text-emerald-300">Queue is clear.</p>
            <p className="mt-1 text-xs text-gray-500">
              Nothing needs a decision. The machine keeps running.
            </p>
          </div>
        )}

        <div className="space-y-3">
          {actionableItems.map((item) => (
            <OperatorItemCard key={item.id} item={item} />
          ))}
          {openCards.map((card) => (
            <QueueCardView key={card.id} card={card} />
          ))}
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

// Urgency-tinted card border — matches JarvisGreeting's URGENCY_BG.
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

// ── Operator action items — buttons ARE the stated options ──────────────

function OperatorItemCard({ item }: { item: OperatorItem }) {
  const { setOperatorItemStatus } = useV2Data();
  const [acting, setActing] = useState<string | null>(null);
  const [recorded, setRecorded] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  const options = deriveDecisions(item);
  const context = item.context ? translateSystemText(item.context) : null;

  async function choose(label: string, kind: "record" | "later") {
    setActing(label);
    setFailed(false);
    const ok = await setOperatorItemStatus(item.id, kind === "later" ? "deferred" : "resolved");
    if (!ok) setFailed(true);
    else if (kind === "record") setRecorded(label);
    setActing(null);
  }

  return (
    <div className={`bg-[#1c2128] rounded-lg border ${PRIORITY_BORDER[item.priority] ?? PRIORITY_BORDER.low} p-4 space-y-3`}>
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1.5 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
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

      {item.actionRequired && (
        <p className="text-sm text-gray-300 leading-relaxed">
          <span className="font-semibold text-emerald-400">Maverick → </span>
          {item.actionRequired}
        </p>
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
                  className="text-xs font-semibold bg-[#30363d] hover:bg-[#3d444d] text-gray-200 px-4 py-2 rounded min-h-[36px] flex items-center"
                >
                  {o.label}
                </Link>
              )
            ) : (
              <button
                key={o.label}
                type="button"
                onClick={() => choose(o.label, o.kind === "later" ? "later" : "record")}
                disabled={acting !== null}
                className={
                  o.kind === "later"
                    ? "text-xs font-semibold bg-[#30363d] hover:bg-[#3d444d] text-gray-300 px-3 py-2 rounded min-h-[36px] disabled:opacity-50"
                    : o.specific
                      ? "text-xs font-semibold bg-emerald-700 hover:bg-emerald-600 text-white px-4 py-2 rounded min-h-[36px] disabled:opacity-50"
                      : "text-xs font-semibold bg-[#30363d] hover:bg-[#3d444d] text-gray-200 px-4 py-2 rounded min-h-[36px] disabled:opacity-50"
                }
              >
                {acting === o.label ? "…" : o.label}
              </button>
            ),
          )
        )}
        {!recorded && item.sourceRecordId && (
          <Link
            href={`/pipeline/${item.sourceRecordId}`}
            className="text-xs text-blue-400 hover:underline ml-auto"
          >
            deal page ↗
          </Link>
        )}
        {failed && <span className="text-[10px] text-red-400">update failed — try again</span>}
      </div>
    </div>
  );
}

// ── Queue cards — each kind gets its real options ────────────────────────

const KIND_META: Record<string, { label: string; border: string; badge: string }> = {
  response: { label: "AGENT REPLIED", border: "border-amber-500/40", badge: "bg-amber-500/15 text-amber-300 border-amber-500/30" },
  dd: { label: "DD GATE OPEN", border: "border-purple-500/40", badge: "bg-purple-500/15 text-purple-300 border-purple-500/30" },
  stale: { label: "GONE QUIET", border: "border-[#30363d]", badge: "bg-gray-500/15 text-gray-300 border-gray-500/30" },
  deal: { label: "DEAL IN FLIGHT", border: "border-emerald-500/40", badge: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30" },
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
        rec: `Hold the offer — ${card.missingItems?.length ?? 0} of 12 DD answers still missing.`,
        why: "The DD checklist must be complete before contract numbers move.",
      };
    case "stale":
      return {
        rec: `${card.daysSilent} days of silence — re-touch or release.`,
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

function QueueCardView({ card }: { card: QueueCard }) {
  const [confirmRelease, setConfirmRelease] = useState(false);
  const [released, setReleased] = useState(false);
  const [releaseError, setReleaseError] = useState(false);
  const meta = KIND_META[card.kind] ?? KIND_META.stale;
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
          ✓ {card.address} released — marked dead. Offer stays on record if they come back.
        </p>
      </div>
    );
  }

  return (
    <div className={`bg-[#1c2128] rounded-lg border ${meta.border} p-4 space-y-3`}>
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
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

      <div className="text-sm text-gray-300 leading-relaxed space-y-1">
        <p>
          <span className="font-semibold text-emerald-400">Maverick → </span>
          {rec}
        </p>
        {why && <p className="text-xs text-gray-500 italic">{why}</p>}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {card.table === "listings" ? (
          <>
            <Link
              href={`/pipeline/${card.recordId}`}
              className="text-xs font-semibold bg-emerald-700 hover:bg-emerald-600 text-white px-4 py-2 rounded min-h-[36px] flex items-center"
            >
              {card.kind === "response" ? "Reply" : card.kind === "dd" ? "Complete DD" : "Re-touch"}
            </Link>
            {card.kind === "stale" &&
              (confirmRelease ? (
                <>
                  <button
                    type="button"
                    onClick={release}
                    className="text-xs font-semibold bg-red-700 hover:bg-red-600 text-white px-4 py-2 rounded min-h-[36px]"
                  >
                    Confirm — mark dead
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmRelease(false)}
                    className="text-xs font-semibold bg-[#30363d] hover:bg-[#3d444d] text-gray-300 px-3 py-2 rounded min-h-[36px]"
                  >
                    Keep
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmRelease(true)}
                  className="text-xs font-semibold bg-[#30363d] hover:bg-[#3d444d] text-gray-300 px-3 py-2 rounded min-h-[36px]"
                >
                  Release
                </button>
              ))}
          </>
        ) : (
          <Link
            href="/deals"
            className="text-xs font-semibold bg-[#30363d] hover:bg-[#3d444d] text-gray-200 px-4 py-2 rounded min-h-[36px] flex items-center"
          >
            View in Deals
          </Link>
        )}
        {releaseError && <span className="text-[10px] text-red-400">release failed — try again</span>}
        {card.table === "listings" && (
          <Link href={`/pipeline/${card.recordId}`} className="text-xs text-blue-400 hover:underline ml-auto">
            deal page ↗
          </Link>
        )}
      </div>
    </div>
  );
}

// ── Already decided — queue hygiene; out of the queue with the reference ──

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
        Already decided ({n}) — the spine settled these; no action needed
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
            >
              Clear
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
        Held ({cards.length}) — resurface when the hold expires
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

// ── Overnight digest — plain-English event groups, raw under the fold ────

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
          No events in the last 24h inside the log window — either a quiet day, or
          high-frequency events pushed the window forward. Not the same as &ldquo;nothing ran&rdquo;.
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

// Translated line with the raw entry collapsed underneath (plain-English law).
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
