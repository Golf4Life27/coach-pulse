// The decision conveyor model (silver-platter cockpit, operator 2026-07-11).
//
// ONE ranked feed replaces the three decision surfaces (Top Priorities strip,
// Act Now, /queue). Every item is typed by what the operator's tap means:
//   2A — send approval  (a drafted outbound waiting for a thumb)
//   2B — money/signature (wires, EMD, POF, contracts, DocuSign, letters)
//   2C — ruling          (doctrine/market/disposition decisions)
//
// THE UX LAW: if it renders, it is live and needs the operator. Freshness is
// enforced by the SOURCE APIs (priorities expire, proposals are Pending-only,
// brief cards carry the 10-day inbound gate) — this module only merges, types,
// ranks, and dedupes. It never invents data:
//   - dollars are SOURCED (a $ amount present in the underlying record/draft
//     or the curated revenueUsd field) or null — never estimated here
//     (INVARIANTS §1: no fabricated numbers).
//   - deadlines are real when the source carries one; 2A items get an
//     IMPLIED same-day clock (volume doctrine: sendable supply exhausts
//     same-day) and are flagged deadlineImplied so the UI renders "waiting
//     Nh", never a fake countdown.
//
// PURE. No I/O — the feed component supplies the source payloads.

export type ConveyorType = "2A" | "2B" | "2C";

export const TYPE_LABEL: Record<ConveyorType, string> = {
  "2A": "SEND APPROVAL",
  "2B": "MONEY / SIGNATURE",
  "2C": "RULING",
};

export type ConveyorAction =
  | { kind: "proposal_send"; proposalId: string; to: string; draftBody: string; inboundBody: string | null }
  | { kind: "proposal_approve"; proposalId: string; label?: string }
  | { kind: "proposal_snooze"; proposalId: string }
  | { kind: "proposal_reject"; proposalId: string }
  /** One ruling over many proposals of the same shape (frontier batching,
   *  2026-07-31). Its own kind rather than a proposalId array on the singular
   *  actions, so no existing handler can silently half-apply a batch. */
  | { kind: "proposal_batch"; proposalIds: string[]; decision: "approve" | "reject"; label: string }
  | { kind: "action_item_resolve"; itemId: string }
  | { kind: "action_item_defer"; itemId: string }
  | { kind: "priority_done"; priorityId: string }
  | { kind: "vision_rerun"; recordId: string; label: string }
  /** Decision Queue (operator 2026-09-01, directive §5): Approve records the
   *  operator's word on the record — it texts nobody; the live-tail send
   *  discipline in a session does that. Kill marks the record Dead. */
  | { kind: "listing_approve"; recordId: string; label?: string; note: string }
  | { kind: "listing_kill"; recordId: string }
  | { kind: "open"; href: string; label?: string };

export interface ConveyorItem {
  /** Unique key: `${source}:${id}`. */
  key: string;
  source: "proposal" | "action_item" | "priority" | "brocard" | "contract" | "vision" | "listing";
  type: ConveyorType;
  title: string;
  /** One-sentence reasoning — the card never renders more than this. */
  reasoning: string;
  recordId: string | null;
  href: string | null;
  /** SOURCED dollar amount in play, or null (renders as "$—"). */
  dollars: number | null;
  deadlineAt: string | null;
  deadlineImplied: boolean;
  postedAt: string | null;
  /** Verbatim inbound quote when the decision is about a reply. */
  verbatim: string | null;
  actions: ConveyorAction[];
}

// ── Sourced-dollar extraction ────────────────────────────────────────────

const DOLLAR_RE = /\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?/;

/** First $ amount found across the given texts, in priority order. Null when
 *  none — the caller renders "$—", never a guess. */
export function firstDollarAmount(...texts: Array<string | null | undefined>): number | null {
  for (const t of texts) {
    if (!t) continue;
    const m = DOLLAR_RE.exec(t);
    if (m) {
      const n = Number(m[1].replace(/,/g, ""));
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return null;
}

// ── Typing heuristics ────────────────────────────────────────────────────

const MONEY_RE =
  /\b(sign|signature|signing|wire|emd|pof|proof of funds|cogo|contract|docusign|escrow|earnest|deposit|letter|notariz)\w*/i;

const SEND_PROPOSAL_TYPES = new Set(["jarvis_reply", "follow_up"]);

export function typeForProposal(proposalType: string): ConveyorType {
  return SEND_PROPOSAL_TYPES.has(proposalType) ? "2A" : "2C";
}

export function typeForText(...texts: Array<string | null | undefined>): ConveyorType {
  return texts.some((t) => t && MONEY_RE.test(t)) ? "2B" : "2C";
}

// ── Implied clocks (2A same-day doctrine) ────────────────────────────────

const HOUR_MS = 3_600_000;
/** A drafted reply to a live seller should fire same-day. */
export const REPLY_IMPLIED_DEADLINE_H = 24;
/** Housekeeping sends get a softer clock. */
export const FOLLOWUP_IMPLIED_DEADLINE_H = 72;

function impliedDeadline(postedAt: string | null, hours: number): string | null {
  if (!postedAt) return null;
  const t = Date.parse(postedAt);
  if (!Number.isFinite(t)) return null;
  return new Date(t + hours * HOUR_MS).toISOString();
}

// ── Source payload shapes (mirrors of the source APIs' responses) ────────

export interface ProposalRow {
  id: string;
  proposalType: string;
  recordId: string;
  recordAddress: string;
  reasoning: string;
  actionPayload: string;
  createdTime?: string | null;
  /** Agent_Proposals.Proposal_ID — matched against the record's
   *  Draft_Reply_Meta.proposal_id by the live-draft gate (a jarvis_reply
   *  row the record no longer points at is history, never a card). */
  proposalKey?: string | null;
}

// ── Machine-work gate (operator 2026-07-11, on seeing 116 Act Now items:
// "I assume 95% of them are noise") ──────────────────────────────────────
//
// The propose-actions cron mints housekeeping proposals daily (follow_up /
// kill_dead_deal / surface_stale / flag_price_drop / suggest_dispo_price)
// with no consumer — the exact pile the 7/08 purge cleared once and that
// re-accumulated since. Under the UX LAW those are MACHINE-WORK: the bump
// lane does the re-touching, the d3 lanes do the disposing. They never
// render. Only decision-grade proposal types reach the conveyor:
//   jarvis_reply    — a live seller waiting on a drafted reply (2A)
//   frontier_retire — coverage-reduction ruling (2C)
// (h2_opener_hold was in this set until 2026-07-31; see BACKLOG_PROPOSAL_TYPES.)
// Age gates on top (a stale "decision" is not a decision): jarvis_reply
// older than 10 days is a cold thread (the 7/08 staleness doctrine — the
// re-engagement lane owns it); other decision types cap at 14 days.
/** BACKLOG, not decisions (operator 2026-07-31). A price-guard HOLD is
 *  maintenance: the record needs sourcing work or a pricing input, not a
 *  ruling the operator owes an answer to. There were 533 pending against 72
 *  live seller threads — an 8:1 burial of the only lane with a human in it.
 *  These are counted and surfaced as a backlog badge (→ /system), never as
 *  conveyor cards. Distinct from machine work: machine work is handled
 *  autonomously and forgotten; backlog is real work nobody is doing yet. */
export const BACKLOG_PROPOSAL_TYPES: ReadonlySet<string> = new Set([
  "h2_opener_hold",
]);

export const DECISION_PROPOSAL_TYPES: ReadonlySet<string> = new Set([
  "jarvis_reply",
  "frontier_retire",
  // Post-vision park (2026-07-16): a sent-opener deal went underwater when the
  // real rehab landed — the operator rules it (pass / re-verify / creative).
  "underwater_review",
]);
export const REPLY_PROPOSAL_MAX_AGE_DAYS = 10;
export const DECISION_PROPOSAL_MAX_AGE_DAYS = 14;

export interface ProposalGateResult {
  kept: ProposalRow[];
  /** Housekeeping proposals hidden as machine-work — the proof counter. */
  machineWorkHidden: number;
  /** Decision-grade proposals hidden as stale (cold threads / dead holds). */
  staleHidden: number;
  /** Price-guard HOLDs held off the belt as a BACKLOG. Reported separately
   *  from machineWorkHidden because the two mean different things: machine
   *  work is done and forgotten, backlog is real work still waiting. Surfaced
   *  as a count badge, never as cards. */
  backlogHidden: number;
}

export function filterDecisionProposals(rows: ProposalRow[], nowIso: string): ProposalGateResult {
  const now = Date.parse(nowIso);
  const kept: ProposalRow[] = [];
  let machineWorkHidden = 0;
  let staleHidden = 0;
  let backlogHidden = 0;
  for (const p of rows) {
    // Backlog checked BEFORE machine work: an opener hold is neither a
    // decision nor something the machine already handled, and collapsing it
    // into machineWorkHidden would report 533 records as "handled".
    if (BACKLOG_PROPOSAL_TYPES.has(p.proposalType)) {
      backlogHidden++;
      continue;
    }
    if (!DECISION_PROPOSAL_TYPES.has(p.proposalType)) {
      machineWorkHidden++;
      continue;
    }
    const created = p.createdTime ? Date.parse(p.createdTime) : NaN;
    const maxDays = p.proposalType === "jarvis_reply" ? REPLY_PROPOSAL_MAX_AGE_DAYS : DECISION_PROPOSAL_MAX_AGE_DAYS;
    if (Number.isFinite(created) && now - created > maxDays * 24 * HOUR_MS) {
      staleHidden++;
      continue;
    }
    kept.push(p);
  }
  return { kept, machineWorkHidden, staleHidden, backlogHidden };
}

export interface ActionItemRow {
  id: string;
  title: string;
  sourceRecordId: string | null;
  actionRequired: string | null;
  context: string | null;
  verbatimReply: string | null;
  priority: string;
  createdAt: string | null;
}

export interface PriorityRow {
  id: string;
  title: string;
  why: string;
  instructions: string | null;
  href: string | null;
  revenueUsd: number | null;
  deadlineAt: string | null;
  postedAt: string;
}

export interface BroCardRow {
  recordId: string;
  address: string;
  headline: string;
  why_this_matters: string;
}

// ── Mappers ──────────────────────────────────────────────────────────────

function parseSendSms(actionPayload: string): { to: string; draftBody: string; inboundBody: string | null } | null {
  try {
    const p = JSON.parse(actionPayload) as Record<string, unknown>;
    // send_email (recommended-replies lane, 2026-07-12) renders through the
    // same card shape — the dispatch rail branches by payload server-side.
    if (p.action !== "send_sms" && p.action !== "send_email") return null;
    const to = typeof p.to === "string" ? p.to.trim() : "";
    const draftBody = typeof p.draftBody === "string" ? p.draftBody.trim() : "";
    if (!to || !draftBody) return null;
    return { to, draftBody, inboundBody: typeof p.inboundBody === "string" ? p.inboundBody : null };
  } catch {
    return null;
  }
}

export function fromProposal(p: ProposalRow): ConveyorItem {
  const type = typeForProposal(p.proposalType);
  const sms = parseSendSms(p.actionPayload);
  const posted = p.createdTime ?? null;
  const isReply = p.proposalType === "jarvis_reply";
  // Rulings that need the deal room (an "Approve" would dispatch nothing and
  // lie): pricer holds AND post-vision underwater reviews.
  const isHold = p.proposalType === "h2_opener_hold" || p.proposalType === "underwater_review";
  const href = p.recordId && p.recordId.startsWith("rec") ? `/pipeline/${p.recordId}` : null;
  const deadlineAt =
    type === "2A"
      ? impliedDeadline(posted, isReply ? REPLY_IMPLIED_DEADLINE_H : FOLLOWUP_IMPLIED_DEADLINE_H)
      : null;
  // A HOLD's "Approve" would only flip a status — nothing dispatches, which
  // reads as "send it" and lies. The ruling needs the deal room: primary =
  // Open; ✕ kills (skip the record), ⏰ snoozes. (Operator 2026-07-11, the
  // 817 Regal card.)
  const actions: ConveyorAction[] = sms
    ? [
        { kind: "proposal_send", proposalId: p.id, to: sms.to, draftBody: sms.draftBody, inboundBody: sms.inboundBody },
        { kind: "proposal_snooze", proposalId: p.id },
        { kind: "proposal_reject", proposalId: p.id },
      ]
    : // Pricer holds AND guardrail-held reply drafts (jarvis_reply with no
      // dispatchable draft — the refuse-and-surface lane): "Approve" would
      // dispatch nothing and lie. Primary = Open the deal room.
      (isHold || isReply) && href
      ? [
          { kind: "open", href, label: "Open deal" },
          { kind: "proposal_snooze", proposalId: p.id },
          { kind: "proposal_reject", proposalId: p.id },
        ]
      : [
          {
            kind: "proposal_approve",
            proposalId: p.id,
            label: p.proposalType === "frontier_retire" ? "Approve — pause ZIP" : "Approve",
          },
          { kind: "proposal_snooze", proposalId: p.id },
          { kind: "proposal_reject", proposalId: p.id },
        ];
  // Holds get a plain-English preface — the raw reasoning is pricer
  // internals ("rough ceiling null (hold_no_value_basis) × anchor ?").
  // Underwater reviews carry their own crafted sentence from the park.
  const reasoning =
    p.proposalType === "h2_opener_hold"
      ? `Pricer HOLD — no autonomous text will fire on this record. Rule it: re-source and re-run, route to the creative lane, or kill. (${firstSentence(p.reasoning)})`
      : firstSentence(p.reasoning);
  return {
    key: `proposal:${p.id}`,
    source: "proposal",
    type,
    title: p.recordAddress || p.recordId,
    reasoning,
    recordId: p.recordId || null,
    href,
    // Dollars-in-play come from the DRAFT BODY only (the number that would
    // actually be sent). A hold's reasoning cites the LIST price — that is
    // not money in play, and ranking by it put a $355k ask above real
    // revenue (operator 2026-07-11). No draft → "$—".
    dollars: firstDollarAmount(sms?.draftBody),
    deadlineAt,
    deadlineImplied: deadlineAt != null,
    postedAt: posted,
    verbatim: sms?.inboundBody ?? null,
    actions,
  };
}

export function fromActionItem(a: ActionItemRow): ConveyorItem {
  return {
    key: `action_item:${a.id}`,
    source: "action_item",
    type: typeForText(a.title, a.actionRequired, a.context),
    title: a.title,
    reasoning: firstSentence(a.actionRequired ?? a.context ?? ""),
    recordId: a.sourceRecordId,
    href: a.sourceRecordId ? `/pipeline/${a.sourceRecordId}` : null,
    dollars: firstDollarAmount(a.title, a.actionRequired, a.context, a.verbatimReply),
    deadlineAt: null,
    deadlineImplied: false,
    postedAt: a.createdAt,
    verbatim: a.verbatimReply,
    actions: [
      { kind: "action_item_resolve", itemId: a.id },
      { kind: "action_item_defer", itemId: a.id },
    ],
  };
}

export function fromPriority(p: PriorityRow): ConveyorItem {
  const type = p.revenueUsd != null || MONEY_RE.test(`${p.title} ${p.why}`) ? "2B" : typeForText(p.instructions);
  const actions: ConveyorAction[] = [];
  if (p.href) actions.push({ kind: "open", href: p.href, label: "Open" });
  actions.push({ kind: "priority_done", priorityId: p.id });
  return {
    key: `priority:${p.id}`,
    source: "priority",
    type,
    title: p.title,
    reasoning: firstSentence(p.why),
    recordId: p.href?.startsWith("/pipeline/") ? p.href.split("/")[2] ?? null : null,
    href: p.href,
    dollars: p.revenueUsd,
    deadlineAt: p.deadlineAt,
    deadlineImplied: false,
    postedAt: p.postedAt,
    verbatim: null,
    actions,
  };
}

export function fromBroCard(b: BroCardRow): ConveyorItem {
  return {
    key: `brocard:${b.recordId}`,
    source: "brocard",
    type: "2A",
    title: b.address,
    reasoning: firstSentence(b.headline || b.why_this_matters),
    recordId: b.recordId,
    href: `/pipeline/${b.recordId}`,
    dollars: firstDollarAmount(b.headline, b.why_this_matters),
    deadlineAt: null,
    deadlineImplied: false,
    postedAt: null,
    verbatim: null,
    actions: [{ kind: "open", href: `/pipeline/${b.recordId}`, label: "Open deal" }],
  };
}

function firstSentence(text: string): string {
  const t = (text ?? "").trim();
  if (!t) return "";
  const m = /^[^.!?\n]{10,}?[.!?](\s|$)/.exec(t);
  const s = m ? m[0].trim() : t;
  return s.length > 180 ? `${s.slice(0, 177)}…` : s;
}

// ── Ranking ──────────────────────────────────────────────────────────────

export type UrgencyRank = 0 | 1 | 2 | 3 | 4;

export function urgencyRank(item: ConveyorItem, nowIso: string): UrgencyRank {
  if (!item.deadlineAt) return 0;
  const now = Date.parse(nowIso);
  const t = Date.parse(item.deadlineAt);
  if (!Number.isFinite(t)) return 0;
  const h = (t - now) / HOUR_MS;
  if (h <= 0) return 4; // overdue
  if (h <= 24) return 3;
  if (h <= 72) return 2;
  return 1;
}

const TYPE_RANK: Record<ConveyorType, number> = { "2B": 3, "2A": 2, "2C": 1 };

/** Deterministic conveyor order: urgency ↓, dollars ↓ (null last), type
 *  (money/signature > sends > rulings), then oldest first. */
export function rankConveyor(items: ConveyorItem[], nowIso: string): ConveyorItem[] {
  return [...items].sort((a, b) => {
    const u = urgencyRank(b, nowIso) - urgencyRank(a, nowIso);
    if (u !== 0) return u;
    const da = a.dollars ?? -1;
    const db = b.dollars ?? -1;
    if (db !== da) return db - da;
    const t = TYPE_RANK[b.type] - TYPE_RANK[a.type];
    if (t !== 0) return t;
    const pa = a.postedAt ? Date.parse(a.postedAt) : Number.POSITIVE_INFINITY;
    const pb = b.postedAt ? Date.parse(b.postedAt) : Number.POSITIVE_INFINITY;
    return pa - pb; // oldest waiting first
  });
}

/** Dedupe: a synthesized brief card or a Decision Queue card duplicates the
 *  actionable proposal for the same record — the proposal (with its dispatch
 *  rail) wins. */
export function dedupeConveyor(items: ConveyorItem[]): ConveyorItem[] {
  const proposalRecords = new Set(
    items.filter((i) => i.source === "proposal" && i.recordId).map((i) => i.recordId as string),
  );
  return items.filter(
    (i) => !((i.source === "brocard" || i.source === "listing") && i.recordId && proposalRecords.has(i.recordId)),
  );
}

// ── Vision holds (operator 2026-07-31) ───────────────────────────────────
// The 256 Westchester lane. An opener HELD because its rehab would have been
// a 30%-of-ARV guess routes to Vision_Queue_State; the drain cron runs vision
// twice a day and releases most of them with nobody looking.
//
// ONLY `vision_failed` reaches this feed. `needs_vision` is machine work and
// must never render — that is the surface's own law ("if it renders, it needs
// you"), and violating it here would recreate the pile this lane exists to
// prevent. A vision_failed record is the narrow case where the machine tried
// and could not see the house: no photos, or the vision call threw.

export interface VisionHoldRow {
  recordId: string;
  address: string | null;
  listPrice: number | null;
  /** Why vision could not resolve it — "no_photos_available", an error tail. */
  failureReason: string | null;
  heldAt: string | null;
}

/** Pure: a vision failure as a conveyor card. Two real actions — look at the
 *  pictures yourself, or make the machine try again. */
export function fromVisionHold(v: VisionHoldRow): ConveyorItem {
  const noPhotos = (v.failureReason ?? "").includes("no_photos");
  return {
    key: `vision:${v.recordId}`,
    source: "vision",
    type: "2C",
    title: v.address ?? "Listing needs a condition read",
    reasoning: noPhotos
      ? "Held before sending — no photos to read, so any rehab number would be invented."
      : "Held before sending — vision could not resolve the condition, so any rehab number would be invented.",
    recordId: v.recordId,
    href: `/pipeline/${v.recordId}`,
    // The list price is NOT money in play — nothing is offered yet. Rendering
    // it as dollars would misreport a held record as a live deal.
    dollars: null,
    deadlineAt: null,
    deadlineImplied: false,
    postedAt: v.heldAt,
    verbatim: v.listPrice != null ? `List $${v.listPrice.toLocaleString()}` : null,
    // Run rehab first: it is the ONE-TAP machine attempt and costs the
    // operator nothing. Spot-checking images is the fallback for when the
    // machine has already failed on this record.
    actions: [
      { kind: "vision_rerun", recordId: v.recordId, label: "Run rehab" },
      { kind: "open", href: `/pipeline/${v.recordId}`, label: "Spot-check images" },
    ],
  };
}

// ── Frontier batching (operator 2026-07-31) ──────────────────────────────
// 42 pending frontier_retire proposals, every one carrying identical
// reasoning ("crawled within 30d, 0 records ingested, 0% accept"). That is
// ONE coverage ruling, not 42 — and rendering it 42 times pushed the lanes
// with a human in them off the screen.
//
// Batching also makes a second problem visible. Those 42 were written by the
// OLD governor, which retired on a single empty crawl; the rule changed
// 2026-07-29 (RETIRE_MIN_ZERO_YIELD_STREAK = 3 consecutive empty runs, and
// REVIVAL_COOLDOWN_DAYS = 30 — "pause is a rest, not an exit"). Their reason
// string, `zero_yield_latest_snapshot`, no longer exists anywhere in the
// codebase. One card can say that once. Forty-two cards say it never.

/** Below this count the proposals render individually — batching two cards
 *  into one costs more clarity than it saves. */
export const FRONTIER_BATCH_MIN = 3;

/** Pure: collapse a run of frontier_retire proposals into a single card.
 *  Returns the batch item (null when under the threshold) plus the rows that
 *  should still render individually. */
export function batchFrontierRetire(
  rows: ProposalRow[],
): { batch: ConveyorItem | null; rest: ProposalRow[] } {
  const frontier = rows.filter((p) => p.proposalType === "frontier_retire");
  const rest = rows.filter((p) => p.proposalType !== "frontier_retire");
  if (frontier.length < FRONTIER_BATCH_MIN) return { batch: null, rest: rows };

  // ZIPs read off the reasoning text — the payload shape varies by governor
  // version, the prose has carried the ZIP throughout.
  const zips: string[] = [];
  for (const p of frontier) {
    const m = (p.reasoning ?? "").match(/ZIP\s+(\d{5})/);
    if (m) zips.push(m[1]);
  }
  const shown = zips.slice(0, 5).join(" · ");
  const more = zips.length > 5 ? ` · +${zips.length - 5}` : "";
  // A single empty-crawl snapshot is the retired rule. If ANY row still
  // carries it, the batch is stale evidence and the honest action is to
  // archive and let the next rotation re-derive under the streak rule.
  const stale = frontier.some((p) => (p.reasoning ?? "").includes("zero_yield_latest_snapshot"));

  const oldest = frontier
    .map((p) => p.createdTime)
    .filter((t): t is string => Boolean(t))
    .sort()[0] ?? null;

  return {
    batch: {
      key: `proposal:frontier-batch-${frontier.length}`,
      source: "proposal",
      type: "2C",
      title: stale
        ? `${frontier.length} ZIP retirements written by the old rule`
        : `Retire ${frontier.length} zero-yield ZIPs`,
      reasoning: stale
        ? `These fired on a single empty crawl. The rule changed 29 Jul — retirement now needs ${3} consecutive empty runs, and a paused ZIP rests 30 days then revives itself to staged and re-tests. Approving these would retire ZIPs that only had a slow week.`
        : `Sustained zero-yield streak across ${frontier.length} ZIPs. Pausing is a 30-day rest — each one revives to staged and re-tests for ripe inventory.`,
      recordId: null,
      href: "/system",
      dollars: null,
      deadlineAt: null,
      deadlineImplied: false,
      postedAt: oldest,
      verbatim: shown ? `${shown}${more}` : null,
      actions: [
        {
          kind: "proposal_batch",
          proposalIds: frontier.map((p) => p.id),
          decision: stale ? "reject" : "approve",
          label: stale ? `Archive all ${frontier.length}` : `Retire all ${frontier.length}`,
        },
        { kind: "open", href: "/system", label: "Review the list" },
      ],
    },
    rest,
  };
}

export interface ConveyorBuildResult {
  items: ConveyorItem[];
  /** Proof of the machine-work gate — what did NOT render, and why. */
  hidden: { machineWork: number; stale: number; backlog: number };
}

export function buildConveyor(
  input: {
    proposals: ProposalRow[];
    actionItems: ActionItemRow[];
    priorities: PriorityRow[];
    broCards: BroCardRow[];
    /** Back-half contract-lifecycle items — already ConveyorItem-shaped by the
     *  pure lib/contract-lifecycle model (they carry their own type/dollars/
     *  deadline/actions). Optional so existing callers/tests are unaffected. */
    contractItems?: ConveyorItem[];
    /** Vision_Queue_State=vision_failed records (2026-07-31). Optional so
     *  existing callers/tests are unaffected. */
    visionHolds?: VisionHoldRow[];
    /** Decision Queue — pending Tier C listing decisions (acceptances and
     *  counters), already ConveyorItem-shaped by lib/conveyor/decision-queue
     *  (operator 2026-09-01, directive §5). Optional. */
    listingDecisions?: ConveyorItem[];
  },
  nowIso: string,
): ConveyorBuildResult {
  const gate = filterDecisionProposals(input.proposals, nowIso);
  // Batch AFTER the age gate: a stale frontier proposal should drop out on
  // age like any other, and only what survives gets collapsed into the card.
  const { batch, rest } = batchFrontierRetire(gate.kept);
  const items = [
    ...rest.map(fromProposal),
    ...(batch ? [batch] : []),
    ...input.actionItems.map(fromActionItem),
    ...input.priorities.map(fromPriority),
    ...input.broCards.map(fromBroCard),
    ...(input.visionHolds ?? []).map(fromVisionHold),
    ...(input.contractItems ?? []),
    ...(input.listingDecisions ?? []),
  ];
  return {
    items: rankConveyor(dedupeConveyor(items), nowIso),
    hidden: { machineWork: gate.machineWorkHidden, stale: gate.staleHidden, backlog: gate.backlogHidden },
  };
}
