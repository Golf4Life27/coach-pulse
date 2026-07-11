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
  | { kind: "action_item_resolve"; itemId: string }
  | { kind: "action_item_defer"; itemId: string }
  | { kind: "priority_done"; priorityId: string }
  | { kind: "open"; href: string; label?: string };

export interface ConveyorItem {
  /** Unique key: `${source}:${id}`. */
  key: string;
  source: "proposal" | "action_item" | "priority" | "brocard";
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
//   h2_opener_hold  — price-guard HOLD needing a sourcing/skip ruling (2C)
//   frontier_retire — coverage-reduction ruling (2C)
// Age gates on top (a stale "decision" is not a decision): jarvis_reply
// older than 10 days is a cold thread (the 7/08 staleness doctrine — the
// re-engagement lane owns it); other decision types cap at 14 days.
export const DECISION_PROPOSAL_TYPES: ReadonlySet<string> = new Set([
  "jarvis_reply",
  "h2_opener_hold",
  "frontier_retire",
]);
export const REPLY_PROPOSAL_MAX_AGE_DAYS = 10;
export const DECISION_PROPOSAL_MAX_AGE_DAYS = 14;

export interface ProposalGateResult {
  kept: ProposalRow[];
  /** Housekeeping proposals hidden as machine-work — the proof counter. */
  machineWorkHidden: number;
  /** Decision-grade proposals hidden as stale (cold threads / dead holds). */
  staleHidden: number;
}

export function filterDecisionProposals(rows: ProposalRow[], nowIso: string): ProposalGateResult {
  const now = Date.parse(nowIso);
  const kept: ProposalRow[] = [];
  let machineWorkHidden = 0;
  let staleHidden = 0;
  for (const p of rows) {
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
  return { kept, machineWorkHidden, staleHidden };
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
    if (p.action !== "send_sms") return null;
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
  const deadlineAt =
    type === "2A"
      ? impliedDeadline(posted, isReply ? REPLY_IMPLIED_DEADLINE_H : FOLLOWUP_IMPLIED_DEADLINE_H)
      : null;
  const actions: ConveyorAction[] = sms
    ? [
        { kind: "proposal_send", proposalId: p.id, to: sms.to, draftBody: sms.draftBody, inboundBody: sms.inboundBody },
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
  return {
    key: `proposal:${p.id}`,
    source: "proposal",
    type,
    title: p.recordAddress || p.recordId,
    reasoning: firstSentence(p.reasoning),
    recordId: p.recordId || null,
    href: p.recordId && p.recordId.startsWith("rec") ? `/pipeline/${p.recordId}` : null,
    dollars: firstDollarAmount(sms?.draftBody, p.reasoning),
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

/** Dedupe: a synthesized brief card duplicates the actionable proposal for
 *  the same record — the proposal (with its dispatch rail) wins. */
export function dedupeConveyor(items: ConveyorItem[]): ConveyorItem[] {
  const proposalRecords = new Set(
    items.filter((i) => i.source === "proposal" && i.recordId).map((i) => i.recordId as string),
  );
  return items.filter((i) => !(i.source === "brocard" && i.recordId && proposalRecords.has(i.recordId)));
}

export interface ConveyorBuildResult {
  items: ConveyorItem[];
  /** Proof of the machine-work gate — what did NOT render, and why. */
  hidden: { machineWork: number; stale: number };
}

export function buildConveyor(
  input: {
    proposals: ProposalRow[];
    actionItems: ActionItemRow[];
    priorities: PriorityRow[];
    broCards: BroCardRow[];
  },
  nowIso: string,
): ConveyorBuildResult {
  const gate = filterDecisionProposals(input.proposals, nowIso);
  const items = [
    ...gate.kept.map(fromProposal),
    ...input.actionItems.map(fromActionItem),
    ...input.priorities.map(fromPriority),
    ...input.broCards.map(fromBroCard),
  ];
  return {
    items: rankConveyor(dedupeConveyor(items), nowIso),
    hidden: { machineWork: gate.machineWorkHidden, stale: gate.staleHidden },
  };
}
