"use client";

// TODAY — the home surface is a decision queue, not charts.
// Every item: what happened → what Maverick recommends + why → 1-3 decisions.
// Sources (all existing routes): /api/operator-actions, /api/queue,
// /api/briefing, /api/admin/audit-tail.

import Link from "next/link";
import { useState } from "react";
import { useV2Data, useMaverickPanel } from "./_lib/data";
import type { AuditEntry, OperatorItem, QueueCard } from "./_lib/types";
import { ago, money, timeStamp } from "./_lib/format";

export default function TodayPage() {
  const { queue, operatorItems, briefing, loading, errors } = useV2Data();

  const openItems = (operatorItems ?? []).filter((i) => i.status !== "resolved");
  const openCards = queue?.open ?? [];
  const heldCards = queue?.held ?? [];
  const total = openItems.length + openCards.length;

  return (
    <div className="space-y-6">
      {errors.length > 0 && (
        <div className="rounded-lg border border-red-900/60 bg-red-950/30 px-3 py-2 text-xs text-red-300">
          {errors.map((e) => (
            <div key={e}>source unavailable — {e}</div>
          ))}
        </div>
      )}

      <section>
        <div className="mb-2 flex items-baseline justify-between">
          <h1 className="text-[11px] font-black tracking-[0.2em] text-zinc-400">
            NEEDS YOU
            {!loading && (
              <span className="ml-2 rounded bg-amber-500/15 px-1.5 py-px font-mono text-amber-300">
                {total}
              </span>
            )}
          </h1>
          {briefing && (
            <span className="text-[10px] text-zinc-600">
              {briefing.activeNegotiations} negotiating · {briefing.textsToday} texts today
              <span title="counts from /api/briefing (cached listings + deals)"> ⓘ</span>
            </span>
          )}
        </div>

        {loading && <Skeletons />}

        {!loading && total === 0 && (
          <div className="rounded-xl border border-emerald-900/50 bg-emerald-950/20 px-4 py-6 text-center">
            <p className="text-sm font-bold text-emerald-300">Queue is clear.</p>
            <p className="mt-1 text-xs text-zinc-500">
              Nothing needs a decision. The machine keeps running — check the strip above for vitals.
            </p>
          </div>
        )}

        <div className="space-y-3">
          {openItems.map((item) => (
            <OperatorItemCard key={item.id} item={item} />
          ))}
          {openCards.map((card) => (
            <QueueCardView key={card.id} card={card} />
          ))}
        </div>

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
        <div key={i} className="h-28 animate-pulse rounded-xl border border-zinc-800 bg-zinc-900/40" />
      ))}
    </div>
  );
}

// ── Operator action items (Operator_Action_Items — cold counters etc.) ──

const PRIORITY_TONE: Record<string, string> = {
  high: "border-red-800/70 text-red-300",
  medium: "border-amber-800/70 text-amber-300",
  low: "border-zinc-700 text-zinc-400",
};

function OperatorItemCard({ item }: { item: OperatorItem }) {
  const { setOperatorItemStatus } = useV2Data();
  const { openWithQuery } = useMaverickPanel();
  const [acting, setActing] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  async function act(status: "resolved" | "deferred") {
    setActing(status);
    setFailed(false);
    const ok = await setOperatorItemStatus(item.id, status);
    if (!ok) setFailed(true);
    setActing(null);
  }

  return (
    <article className="rounded-xl border border-zinc-800 bg-[#0b0e13] p-3.5">
      <header className="mb-2 flex items-start justify-between gap-2">
        <h2 className="text-sm font-bold leading-snug text-zinc-100">{item.title}</h2>
        <span
          className={`shrink-0 rounded border px-1.5 py-px text-[9px] font-bold uppercase tracking-wider ${PRIORITY_TONE[item.priority] ?? PRIORITY_TONE.medium}`}
        >
          {item.priority}
        </span>
      </header>

      {item.verbatimReply && (
        <p className="mb-2 rounded-lg border-l-2 border-amber-500/70 bg-amber-950/20 px-3 py-2 text-xs italic leading-relaxed text-amber-100">
          &ldquo;{item.verbatimReply}&rdquo;
        </p>
      )}
      {item.context && <p className="mb-2 text-xs leading-relaxed text-zinc-400">{item.context}</p>}

      {item.actionRequired && (
        <p className="mb-3 text-xs leading-relaxed text-zinc-300">
          <span className="font-bold tracking-wider text-cyan-400">MAVERICK → </span>
          {item.actionRequired}
        </p>
      )}

      <footer className="flex flex-wrap items-center gap-2">
        {item.sourceRecordId && (
          <Link
            href={`/v2/deal/${item.sourceRecordId}`}
            className="rounded-md bg-cyan-700 px-3 py-1.5 text-xs font-bold text-white hover:bg-cyan-600"
          >
            Open Deal Room
          </Link>
        )}
        <button
          onClick={() => act("resolved")}
          disabled={acting !== null}
          className="rounded-md border border-emerald-800 px-3 py-1.5 text-xs font-bold text-emerald-300 hover:bg-emerald-950/40 disabled:opacity-40"
        >
          {acting === "resolved" ? "…" : "Resolve"}
        </button>
        <button
          onClick={() => act("deferred")}
          disabled={acting !== null}
          className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs font-bold text-zinc-400 hover:bg-zinc-900 disabled:opacity-40"
        >
          {acting === "deferred" ? "…" : "Defer"}
        </button>
        <button
          onClick={() => openWithQuery(item.title)}
          className="ml-auto text-[10px] font-bold tracking-wider text-zinc-600 hover:text-cyan-300"
        >
          RECALL CONTEXT
        </button>
        {failed && <span className="text-[10px] text-red-400">update failed — try again</span>}
        <span className="text-[10px] text-zinc-700">{ago(item.createdAt)}</span>
      </footer>
    </article>
  );
}

// ── Queue cards (response / dd / stale / deal from /api/queue) ──────────

const KIND_META: Record<
  string,
  { label: string; tone: string }
> = {
  response: { label: "AGENT REPLIED", tone: "border-amber-700/70 text-amber-300" },
  dd: { label: "DD GATE OPEN", tone: "border-violet-800/70 text-violet-300" },
  stale: { label: "GONE QUIET", tone: "border-zinc-700 text-zinc-400" },
  deal: { label: "DEAL IN FLIGHT", tone: "border-emerald-800/70 text-emerald-300" },
};

function recommendation(card: QueueCard): { rec: string; why: string } {
  switch (card.kind) {
    case "response":
      return {
        rec: `Reply to ${card.agentName ?? "the agent"}. Negotiation cap ${money(card.mao)}.`,
        why: `Cap = MAO_V1 (65% of ${money(card.listPrice)} list). DOM ${card.dom ?? "—"}. Inbound is newer than our last outbound — the ball is in our court.`,
      };
    case "dd":
      return {
        rec: `Hold the offer — DD gate is missing ${card.missingItems?.length ?? 0} of 12 items.`,
        why: "DD V3 checklist must be complete before contract-stage numbers move. Open the Deal Room to see exactly what's missing.",
      };
    case "stale":
      return {
        rec: `Re-touch or release — ${card.daysSilent} days silent.`,
        why: `Last outreach ${card.lastOutreachDate ?? "unknown"}; threshold for this stage passed. Sticky offer ${money(card.mao)} remains the floor on record.`,
      };
    case "deal":
      return {
        rec: `Advance the contract — status ${card.status ?? "?"}${card.closingStatus ? `, closing ${card.closingStatus}` : ""}.`,
        why: `Contract ${money(card.contractPrice)} · assignment ${money(card.assignmentPrice)} · spread ${money(card.spread)} (Deals table).`,
      };
    default:
      return { rec: "Review.", why: "" };
  }
}

function QueueCardView({ card }: { card: QueueCard }) {
  const { openWithQuery } = useMaverickPanel();
  const meta = KIND_META[card.kind];
  const { rec, why } = recommendation(card);
  const place = [card.city, card.state].filter(Boolean).join(", ");

  return (
    <article className="rounded-xl border border-zinc-800 bg-[#0b0e13] p-3.5">
      <header className="mb-2 flex items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-bold leading-snug text-zinc-100">{card.address}</h2>
          <p className="text-[10px] text-zinc-600">
            {place}
            {card.agentName ? ` · ${card.agentName}` : ""}
          </p>
        </div>
        <span className={`shrink-0 rounded border px-1.5 py-px text-[9px] font-bold tracking-wider ${meta.tone}`}>
          {meta.label}
        </span>
      </header>

      {card.kind === "response" && card.inboundMessage && (
        <p className="mb-2 rounded-lg border-l-2 border-amber-500/70 bg-amber-950/20 px-3 py-2 text-xs italic leading-relaxed text-amber-100">
          &ldquo;{card.inboundMessage}&rdquo;
        </p>
      )}
      {card.kind === "dd" && card.missingItems && card.missingItems.length > 0 && (
        <p className="mb-2 text-[11px] leading-relaxed text-zinc-500">
          Missing: {card.missingItems.slice(0, 4).join(" · ")}
          {card.missingItems.length > 4 ? ` · +${card.missingItems.length - 4} more` : ""}
        </p>
      )}

      <p className="mb-1 text-xs leading-relaxed text-zinc-300">
        <span className="font-bold tracking-wider text-cyan-400">MAVERICK → </span>
        {rec}
      </p>
      {why && <p className="mb-3 text-[11px] leading-relaxed text-zinc-500">{why}</p>}

      <footer className="flex flex-wrap items-center gap-2">
        {card.table === "listings" ? (
          <Link
            href={`/v2/deal/${card.recordId}`}
            className="rounded-md bg-cyan-700 px-3 py-1.5 text-xs font-bold text-white hover:bg-cyan-600"
          >
            Open Deal Room
          </Link>
        ) : (
          <a
            href={`/deals`}
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs font-bold text-zinc-300 hover:bg-zinc-900"
            title="Deals-table records render in v1 until the v2 Deal Room covers the Deals table"
          >
            View in v1 Deals
          </a>
        )}
        <button
          onClick={() => openWithQuery(card.address)}
          className="ml-auto text-[10px] font-bold tracking-wider text-zinc-600 hover:text-cyan-300"
        >
          RECALL CONTEXT
        </button>
      </footer>
    </article>
  );
}

function HeldSection({ cards }: { cards: QueueCard[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-3">
      <button
        onClick={() => setOpen(!open)}
        className="text-[10px] font-bold tracking-[0.15em] text-zinc-600 hover:text-zinc-300"
      >
        {open ? "▾" : "▸"} HELD ({cards.length}) — resurface when hold expires
      </button>
      {open && (
        <div className="mt-2 space-y-1.5">
          {cards.map((c) => (
            <div
              key={c.id}
              className="flex items-center justify-between rounded-lg border border-zinc-800/70 bg-zinc-900/30 px-3 py-2 text-xs text-zinc-500"
            >
              <span>
                {c.address} <span className="text-zinc-700">· {KIND_META[c.kind]?.label}</span>
              </span>
              <span className="font-mono text-[10px]">until {timeStamp(c.holdUntil)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Overnight digest — what the machine did while you slept, straight from
// the KV audit_log (positive-confirmation events, last 24h). ──────────────

function OvernightDigest() {
  const { audit, auditWindow } = useV2Data();
  const [showFails, setShowFails] = useState(false);
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
    <section>
      <h2 className="mb-2 text-[11px] font-black tracking-[0.2em] text-zinc-400">
        LAST 24H — THE MACHINE
        <span className="ml-2 font-normal normal-case tracking-normal text-zinc-600">
          {recent.length} confirmed events (KV audit_log
          {auditWindow.oldest ? `, window back to ${timeStamp(auditWindow.oldest)}` : ""})
        </span>
      </h2>

      {recent.length === 0 ? (
        <p className="rounded-lg border border-zinc-800 px-3 py-2 text-xs text-zinc-600">
          No audit events in the last 24h inside the KV window — either quiet, or high-frequency
          events aged the window out.
        </p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {[...byAgent.entries()]
            .sort((a, b) => b[1].ok + b[1].fail + b[1].uncertain - (a[1].ok + a[1].fail + a[1].uncertain))
            .map(([agent, g]) => (
              <div
                key={agent}
                className="rounded-lg border border-zinc-800 bg-[#0b0e13] px-3 py-2"
              >
                <p className="text-[10px] font-bold uppercase tracking-wider text-zinc-400">{agent}</p>
                <p className="font-mono text-xs">
                  <span className="text-emerald-400">{g.ok}✓</span>
                  {g.fail > 0 && <span className="ml-1.5 text-red-400">{g.fail}✗</span>}
                  {g.uncertain > 0 && <span className="ml-1.5 text-amber-400">{g.uncertain}?</span>}
                </p>
              </div>
            ))}
        </div>
      )}

      {failures.length > 0 && (
        <div className="mt-3">
          <button
            onClick={() => setShowFails(!showFails)}
            className="text-[10px] font-bold tracking-wider text-red-400 hover:text-red-300"
          >
            {showFails ? "▾" : "▸"} {failures.length} CONFIRMED FAILURES
          </button>
          {showFails && (
            <div className="mt-2 space-y-1.5">
              {failures.slice(0, 20).map((e, i) => (
                <FailureRow key={i} e={e} />
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function FailureRow({ e }: { e: AuditEntry }) {
  return (
    <div className="rounded-lg border border-red-900/40 bg-red-950/20 px-3 py-2 text-xs">
      <p className="text-red-300">
        <span className="font-bold">{e.agent}</span> · {e.event} · {timeStamp(e.ts)}
      </p>
      {e.error && <p className="mt-0.5 break-all text-[11px] text-zinc-500">{e.error.slice(0, 200)}</p>}
      {e.recordId && (
        <Link href={`/v2/deal/${e.recordId}`} className="text-[10px] font-bold text-cyan-400 hover:underline">
          open record →
        </Link>
      )}
    </div>
  );
}
