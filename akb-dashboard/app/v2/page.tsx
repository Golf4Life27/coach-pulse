"use client";

// TODAY — the home surface is a decision queue, not charts.
// Operator-review laws applied (6/10): readable type hierarchy (title >
// recommendation > context > metadata), buttons ARE the decisions, plain
// English on the surface (raw entries collapse into a system log), honest
// zero (no number renders without a wired source), and queue hygiene
// (already-decided records leave the queue with their standing reference).

import Link from "next/link";
import { useState } from "react";
import { useV2Data, useMaverickPanel } from "./_lib/data";
import type { AuditEntry, OperatorItem, QueueCard } from "./_lib/types";
import { ago, money, timeStamp } from "./_lib/format";
import { deriveDecisions } from "./_lib/decisions";
import { humanizeEvent, translateSystemText } from "./_lib/translate";

export default function TodayPage() {
  const {
    openCards,
    suppressedCards,
    actionableItems,
    suppressedItems,
    queue,
    activityToday,
    loading,
    errors,
  } = useV2Data();

  const total = actionableItems.length + openCards.length;
  const heldCards = queue?.held ?? [];
  const suppressedTotal = suppressedItems.length + suppressedCards.length;

  return (
    <div className="space-y-8">
      {errors.length > 0 && (
        <div className="rounded-lg border border-red-900/60 bg-red-950/30 px-3 py-2 text-sm text-red-300">
          {errors.map((e) => (
            <div key={e}>source unavailable — {e}</div>
          ))}
        </div>
      )}

      <section>
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h1 className="text-xs font-black tracking-[0.2em] text-zinc-400">
            NEEDS YOU
            {!loading && (
              <span className="ml-2 rounded bg-amber-500/15 px-2 py-0.5 font-mono text-sm text-amber-300">
                {total}
              </span>
            )}
          </h1>
          {/* Honest zero: these counts come from wired sources only. */}
          <span className="text-sm text-zinc-500" title={activityToday.sendsSource}>
            {activityToday.sends == null ? "sends today: no signal" : `${activityToday.sends} texted today`}
            {" · "}
            {activityToday.replies == null ? "replies: no signal" : `${activityToday.replies} replies today`}
          </span>
        </div>

        {loading && <Skeletons />}

        {!loading && total === 0 && (
          <div className="rounded-xl border border-emerald-900/50 bg-emerald-950/20 px-4 py-8 text-center">
            <p className="text-base font-bold text-emerald-300">Queue is clear.</p>
            <p className="mt-1 text-sm text-zinc-500">
              Nothing needs a decision. The machine keeps running — the strip above has the vitals.
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

        {suppressedTotal > 0 && (
          <AlreadyDecided items={suppressedItems} cards={suppressedCards} />
        )}
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
        <div key={i} className="h-32 animate-pulse rounded-xl border border-zinc-800 bg-zinc-900/40" />
      ))}
    </div>
  );
}

// ── Operator action items — buttons are the stated options ──────────────

const PRIORITY_TONE: Record<string, string> = {
  high: "border-red-800/70 text-red-300",
  medium: "border-amber-800/70 text-amber-300",
  low: "border-zinc-700 text-zinc-400",
};

function OperatorItemCard({ item }: { item: OperatorItem }) {
  const { setOperatorItemStatus } = useV2Data();
  const { openWithQuery } = useMaverickPanel();
  const [acting, setActing] = useState<string | null>(null);
  const [recorded, setRecorded] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  const options = deriveDecisions(item);

  async function choose(label: string, kind: "record" | "later") {
    setActing(label);
    setFailed(false);
    const ok = await setOperatorItemStatus(item.id, kind === "later" ? "deferred" : "resolved");
    if (!ok) setFailed(true);
    else if (kind === "record") setRecorded(label);
    setActing(null);
  }

  const context = item.context ? translateSystemText(item.context) : null;

  return (
    <article className="rounded-xl border border-zinc-800 bg-[#0b0e13] p-4">
      <header className="mb-2.5 flex items-start justify-between gap-3">
        <h2 className="text-lg font-bold leading-snug text-zinc-50">{item.title}</h2>
        <span
          className={`mt-1 shrink-0 rounded border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${PRIORITY_TONE[item.priority] ?? PRIORITY_TONE.medium}`}
        >
          {item.priority}
        </span>
      </header>

      {item.verbatimReply && (
        <p className="mb-2.5 rounded-lg border-l-2 border-amber-500/70 bg-amber-950/20 px-3 py-2.5 text-base italic leading-relaxed text-amber-100">
          &ldquo;{item.verbatimReply}&rdquo;
        </p>
      )}

      {item.actionRequired && (
        <p className="mb-1.5 text-base leading-relaxed text-zinc-200">
          <span className="font-bold tracking-wide text-cyan-400">MAVERICK → </span>
          {item.actionRequired}
        </p>
      )}

      {context && (
        <CollapsibleSystemText
          summary={context.summary}
          raw={item.context!}
          collapsed={context.machineVoice}
        />
      )}

      <footer className="mt-3 flex flex-wrap items-center gap-2">
        {recorded ? (
          <span className="rounded-md border border-emerald-800 bg-emerald-950/30 px-3 py-2 text-sm font-bold text-emerald-300">
            ✓ Recorded: {recorded} — execute in the Deal Room
          </span>
        ) : (
          options.map((o) =>
            o.kind === "open" ? (
              item.sourceRecordId && (
                <Link
                  key={o.label}
                  href={`/v2/deal/${item.sourceRecordId}`}
                  className="rounded-md border border-cyan-800 px-3.5 py-2 text-sm font-bold text-cyan-300 hover:bg-cyan-950/40"
                >
                  {o.label}
                </Link>
              )
            ) : (
              <button
                key={o.label}
                onClick={() => choose(o.label, o.kind === "later" ? "later" : "record")}
                disabled={acting !== null}
                className={
                  o.kind === "later"
                    ? "rounded-md border border-zinc-700 px-3.5 py-2 text-sm font-bold text-zinc-400 hover:bg-zinc-900 disabled:opacity-40"
                    : o.specific
                      ? "rounded-md bg-cyan-700 px-3.5 py-2 text-sm font-bold text-white hover:bg-cyan-600 disabled:opacity-40"
                      : "rounded-md border border-emerald-800 px-3.5 py-2 text-sm font-bold text-emerald-300 hover:bg-emerald-950/40 disabled:opacity-40"
                }
              >
                {acting === o.label ? "…" : o.label}
              </button>
            ),
          )
        )}
        {!recorded && item.sourceRecordId && !options.some((o) => o.kind === "open") && (
          <Link
            href={`/v2/deal/${item.sourceRecordId}`}
            className="rounded-md border border-zinc-700 px-3.5 py-2 text-sm font-bold text-zinc-400 hover:text-zinc-200"
          >
            Deal Room
          </Link>
        )}
        <button
          onClick={() => openWithQuery(item.title)}
          className="ml-auto text-xs font-bold tracking-wider text-zinc-600 hover:text-cyan-300"
        >
          RECALL
        </button>
        {failed && <span className="text-xs text-red-400">update failed — try again</span>}
        <span className="text-xs text-zinc-600">{ago(item.createdAt)}</span>
      </footer>
    </article>
  );
}

// ── Queue cards — each kind gets its real options ────────────────────────

const KIND_META: Record<string, { label: string; tone: string }> = {
  response: { label: "AGENT REPLIED", tone: "border-amber-700/70 text-amber-300" },
  dd: { label: "DD GATE OPEN", tone: "border-violet-800/70 text-violet-300" },
  stale: { label: "GONE QUIET", tone: "border-zinc-700 text-zinc-400" },
  deal: { label: "DEAL IN FLIGHT", tone: "border-emerald-800/70 text-emerald-300" },
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
  const { openWithQuery } = useMaverickPanel();
  const [confirmRelease, setConfirmRelease] = useState(false);
  const [released, setReleased] = useState(false);
  const [releaseError, setReleaseError] = useState(false);
  const meta = KIND_META[card.kind];
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
      <article className="rounded-xl border border-zinc-800 bg-[#0b0e13] p-4">
        <p className="text-sm font-bold text-zinc-400">
          ✓ {card.address} released — marked dead. Offer stays on record if they come back.
        </p>
      </article>
    );
  }

  return (
    <article className="rounded-xl border border-zinc-800 bg-[#0b0e13] p-4">
      <header className="mb-2.5 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold leading-snug text-zinc-50">{card.address}</h2>
          <p className="text-xs text-zinc-500">
            {place}
            {card.agentName ? ` · ${card.agentName}` : ""}
          </p>
        </div>
        <span className={`mt-1 shrink-0 rounded border px-2 py-0.5 text-[10px] font-bold tracking-wider ${meta.tone}`}>
          {meta.label}
        </span>
      </header>

      {card.kind === "response" && card.inboundMessage && (
        <p className="mb-2.5 rounded-lg border-l-2 border-amber-500/70 bg-amber-950/20 px-3 py-2.5 text-base italic leading-relaxed text-amber-100">
          &ldquo;{card.inboundMessage}&rdquo;
        </p>
      )}
      {card.kind === "dd" && card.missingItems && card.missingItems.length > 0 && (
        <p className="mb-2 text-sm leading-relaxed text-zinc-500">
          Missing: {card.missingItems.slice(0, 4).join(" · ")}
          {card.missingItems.length > 4 ? ` · +${card.missingItems.length - 4} more` : ""}
        </p>
      )}

      <p className="mb-1 text-base leading-relaxed text-zinc-200">
        <span className="font-bold tracking-wide text-cyan-400">MAVERICK → </span>
        {rec}
      </p>
      {why && <p className="mb-3 text-sm leading-relaxed text-zinc-500">{why}</p>}

      <footer className="flex flex-wrap items-center gap-2">
        {card.table === "listings" ? (
          <>
            <Link
              href={`/v2/deal/${card.recordId}`}
              className="rounded-md bg-cyan-700 px-3.5 py-2 text-sm font-bold text-white hover:bg-cyan-600"
            >
              {card.kind === "response" ? "Reply" : card.kind === "dd" ? "Complete DD" : "Re-touch"}
            </Link>
            {card.kind === "stale" &&
              (confirmRelease ? (
                <>
                  <button
                    onClick={release}
                    className="rounded-md bg-red-800 px-3.5 py-2 text-sm font-bold text-white hover:bg-red-700"
                  >
                    Confirm — mark dead
                  </button>
                  <button
                    onClick={() => setConfirmRelease(false)}
                    className="rounded-md border border-zinc-700 px-3.5 py-2 text-sm font-bold text-zinc-400"
                  >
                    Keep
                  </button>
                </>
              ) : (
                <button
                  onClick={() => setConfirmRelease(true)}
                  className="rounded-md border border-zinc-700 px-3.5 py-2 text-sm font-bold text-zinc-400 hover:bg-zinc-900"
                >
                  Release
                </button>
              ))}
          </>
        ) : (
          <a
            href={`/deals`}
            className="rounded-md border border-zinc-700 px-3.5 py-2 text-sm font-bold text-zinc-300 hover:bg-zinc-900"
            title="Deals-table records act in v1 until the v2 Deal Room covers the Deals table"
          >
            View in v1 Deals
          </a>
        )}
        {releaseError && <span className="text-xs text-red-400">release failed — try again</span>}
        <button
          onClick={() => openWithQuery(card.address)}
          className="ml-auto text-xs font-bold tracking-wider text-zinc-600 hover:text-cyan-300"
        >
          RECALL
        </button>
      </footer>
    </article>
  );
}

// ── Already decided — out of the queue, reference shown, one-tap clear ───

function AlreadyDecided({
  items,
  cards,
}: {
  items: Array<{ item: OperatorItem; reference: string }>;
  cards: Array<{ card: QueueCard; reference: string }>;
}) {
  const { setOperatorItemStatus } = useV2Data();
  const [open, setOpen] = useState(false);
  const n = items.length + cards.length;
  return (
    <div className="mt-4">
      <button
        onClick={() => setOpen(!open)}
        className="text-xs font-bold tracking-[0.15em] text-zinc-600 hover:text-zinc-300"
      >
        {open ? "▾" : "▸"} ALREADY DECIDED ({n}) — the spine settled these; no action needed
      </button>
      {open && (
        <div className="mt-2 space-y-1.5">
          {items.map(({ item, reference }) => (
            <div
              key={item.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-zinc-800/70 bg-zinc-900/30 px-3 py-2.5"
            >
              <span className="text-sm text-zinc-400">{item.title}</span>
              <span className="text-xs text-zinc-600">{reference}</span>
              <button
                onClick={() => setOperatorItemStatus(item.id, "resolved")}
                className="ml-auto rounded border border-zinc-700 px-2.5 py-1 text-xs font-bold text-zinc-500 hover:text-zinc-200"
              >
                Clear from queue
              </button>
            </div>
          ))}
          {cards.map(({ card, reference }) => (
            <div
              key={card.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-zinc-800/70 bg-zinc-900/30 px-3 py-2.5"
            >
              <span className="text-sm text-zinc-400">{card.address}</span>
              <span className="text-xs text-zinc-600">{reference}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function HeldSection({ cards }: { cards: QueueCard[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-3">
      <button
        onClick={() => setOpen(!open)}
        className="text-xs font-bold tracking-[0.15em] text-zinc-600 hover:text-zinc-300"
      >
        {open ? "▾" : "▸"} HELD ({cards.length}) — resurface when the hold expires
      </button>
      {open && (
        <div className="mt-2 space-y-1.5">
          {cards.map((c) => (
            <div
              key={c.id}
              className="flex items-center justify-between rounded-lg border border-zinc-800/70 bg-zinc-900/30 px-3 py-2 text-sm text-zinc-500"
            >
              <span>
                {c.address} <span className="text-zinc-700">· {KIND_META[c.kind]?.label}</span>
              </span>
              <span className="font-mono text-xs">until {timeStamp(c.holdUntil)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Overnight digest — plain-English event groups, raw under the fold ────

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
      <h2 className="mb-2 text-xs font-black tracking-[0.2em] text-zinc-400">
        LAST 24H — THE MACHINE
        <span className="ml-2 font-normal normal-case tracking-normal text-zinc-600">
          {recent.length} confirmed events
          {auditWindow.oldest ? ` · log reaches back to ${timeStamp(auditWindow.oldest)}` : ""}
        </span>
      </h2>

      {recent.length === 0 ? (
        <p className="rounded-lg border border-zinc-800 px-3 py-2.5 text-sm text-zinc-600">
          No events in the last 24h inside the log window — either a quiet day, or
          high-frequency events pushed the window forward. Not the same as &ldquo;nothing ran&rdquo;.
        </p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {[...byAgent.entries()]
            .sort((a, b) => b[1].ok + b[1].fail + b[1].uncertain - (a[1].ok + a[1].fail + a[1].uncertain))
            .map(([agent, g]) => (
              <div key={agent} className="rounded-lg border border-zinc-800 bg-[#0b0e13] px-3.5 py-2.5">
                <p className="text-xs font-bold uppercase tracking-wider text-zinc-400">{agent}</p>
                <p className="font-mono text-sm">
                  <span className="text-emerald-400">{g.ok}✓</span>
                  {g.fail > 0 && <span className="ml-2 text-red-400">{g.fail}✗</span>}
                  {g.uncertain > 0 && <span className="ml-2 text-amber-400">{g.uncertain}?</span>}
                </p>
              </div>
            ))}
        </div>
      )}

      {failures.length > 0 && (
        <div className="mt-3">
          <button
            onClick={() => setShowFails(!showFails)}
            className="text-xs font-bold tracking-wider text-red-400 hover:text-red-300"
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
  const [raw, setRaw] = useState(false);
  return (
    <div className="rounded-lg border border-red-900/40 bg-red-950/20 px-3 py-2.5">
      <p className="text-sm text-red-300">
        <span className="font-bold capitalize">{e.agent}</span> — {humanizeEvent(e.event)} failed,{" "}
        {timeStamp(e.ts)}
      </p>
      <div className="mt-1 flex items-center gap-3">
        {e.recordId && (
          <Link href={`/v2/deal/${e.recordId}`} className="text-xs font-bold text-cyan-400 hover:underline">
            open record →
          </Link>
        )}
        {e.error && (
          <button onClick={() => setRaw(!raw)} className="text-xs font-bold text-zinc-600 hover:text-zinc-300">
            {raw ? "hide" : "system log"}
          </button>
        )}
      </div>
      {raw && e.error && (
        <p className="mt-1 break-all rounded bg-black/40 px-2 py-1.5 font-mono text-xs text-zinc-500">
          {e.error.slice(0, 300)}
        </p>
      )}
    </div>
  );
}

// Shared: translated line with the raw entry collapsed underneath.
function CollapsibleSystemText({
  summary,
  raw,
  collapsed,
}: {
  summary: string;
  raw: string;
  collapsed: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (!collapsed) return <p className="text-sm leading-relaxed text-zinc-400">{summary}</p>;
  return (
    <div>
      <p className="text-sm leading-relaxed text-zinc-400">
        {summary}{" "}
        <button onClick={() => setOpen(!open)} className="text-xs font-bold text-zinc-600 hover:text-zinc-300">
          {open ? "hide log" : "system log"}
        </button>
      </p>
      {open && (
        <p className="mt-1 break-words rounded bg-black/40 px-2 py-1.5 font-mono text-xs leading-relaxed text-zinc-500">
          {raw}
        </p>
      )}
    </div>
  );
}
