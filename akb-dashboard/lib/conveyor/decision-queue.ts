// Decision Queue — Tier C listing decisions as conveyor cards.
//
// Operator ruling 2026-09-01 (NEXT_SESSION_DIRECTIVE §5): the home screen is
// the Decision Queue — "each card = deal, staged action, the math in one line,
// APPROVE / EDIT / KILL. Driven from Airtable statuses + escalation flags that
// already exist." Under the 2026-07-11 one-feed law this is NOT a parallel
// surface: it is one more SOURCE on the existing conveyor, mapped here by a
// pure function and rendered by the same ConveyorCard.
//
// What qualifies (the Tier C classes the autonomy ladder reserves for the
// operator — any acceptance, any counter, any terms):
//   - Outreach_Status = Offer Accepted   → 2B (terms/EMD/title are money)
//   - Outreach_Status = Counter Received → 2C (a number needs a ruling)
//   - Outreach_Status = Negotiating AND Latest_Counter_Usd set → 2C
// Gates: a decision needs a live inbound (Last_Inbound_At within
// DECISION_MAX_AGE_DAYS); killed records (Blacklist / Do_Not_Text / dead
// pipeline stage) never render; a card the operator already ruled on
// (Action_Card_State Cleared/Held) stays off the belt until the machine
// re-opens it on the next inbound.
//
// The math line is SOURCED ONLY — every dollar on it is a field the pricing
// lanes wrote (INVARIANTS §1: no fabricated numbers). Missing inputs render as
// "—", never as an estimate.
//
// PURE. No I/O.

import type { ConveyorAction, ConveyorItem } from "@/lib/conveyor/model";

export const DECISION_MAX_AGE_DAYS = 14;
/** An acceptance or counter waits same-day (volume doctrine). */
export const DECISION_IMPLIED_DEADLINE_H = 24;

const HOUR_MS = 3_600_000;

export interface ListingDecisionRow {
  id: string;
  address: string | null;
  agentName: string | null;
  outreachStatus: string | null;
  pipelineStage: string | null;
  listPrice: number | null;
  /** The number we actually sent (Rough_Opener_Amount). */
  roughOpenerAmount: number | null;
  /** The negotiation-stage number when one exists (Contract_Offer_Price). */
  contractOfferPrice: number | null;
  latestCounterUsd: number | null;
  buyerCeiling: number | null;
  dealSpread: number | null;
  decisionVerdict: string | null;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  actionCardState: string | null;
  blacklist: boolean;
  doNotText: boolean;
}

export type DecisionClass = "acceptance" | "counter";

/** Why this record is on the belt, or null when it is not a decision. */
export function decisionClass(row: ListingDecisionRow): DecisionClass | null {
  const status = (row.outreachStatus ?? "").trim();
  if (status === "Offer Accepted") return "acceptance";
  if (status === "Counter Received") return "counter";
  if (status === "Negotiating" && row.latestCounterUsd != null && row.latestCounterUsd > 0) return "counter";
  return null;
}

export function isPendingDecision(row: ListingDecisionRow, nowIso: string): boolean {
  if (!decisionClass(row)) return false;
  if (row.blacklist || row.doNotText) return false;
  if ((row.pipelineStage ?? "").trim() === "dead") return false;
  const state = (row.actionCardState ?? "").trim();
  if (state === "Cleared" || state === "Held") return false;
  if (!row.lastInboundAt) return false;
  const inbound = Date.parse(row.lastInboundAt);
  const now = Date.parse(nowIso);
  if (!Number.isFinite(inbound) || !Number.isFinite(now)) return false;
  return now - inbound <= DECISION_MAX_AGE_DAYS * 24 * HOUR_MS;
}

function usd(n: number | null): string {
  return n == null ? "—" : `$${Math.round(n).toLocaleString("en-US")}`;
}

/** Our number on the table: the negotiation-stage price when set, else the
 *  opener that was actually sent. Null when neither exists. */
export function ourNumber(row: ListingDecisionRow): number | null {
  if (row.contractOfferPrice != null && row.contractOfferPrice > 0) return row.contractOfferPrice;
  if (row.roughOpenerAmount != null && row.roughOpenerAmount > 0) return row.roughOpenerAmount;
  return null;
}

/** The one-line math. Every figure is a sourced field; blanks say so. */
export function mathLine(row: ListingDecisionRow): string {
  const parts = [`List ${usd(row.listPrice)}`, `ours ${usd(ourNumber(row))}`];
  if (row.latestCounterUsd != null) parts.push(`their ${usd(row.latestCounterUsd)}`);
  parts.push(`buyer ceiling ${usd(row.buyerCeiling)}`, `spread ${usd(row.dealSpread)}`);
  const verdict = (row.decisionVerdict ?? "").trim();
  parts.push(`verdict ${verdict || "—"}`);
  return parts.join(" · ");
}

/** The staged action in plain words — what "Approve" records as the
 *  operator's ruling. Sends still go through the live-tail send discipline in
 *  a session; the tap records the word, it does not text anyone. */
export function stagedAction(row: ListingDecisionRow): string {
  const cls = decisionClass(row);
  const ours = ourNumber(row);
  if (cls === "acceptance") {
    return ours != null
      ? `Accept at ${usd(ours)} — paper it with an inspection period`
      : "Acceptance received — confirm the number on the thread before papering";
  }
  if (row.latestCounterUsd != null) {
    return `Rule on the ${usd(row.latestCounterUsd)} counter (accept / counter back / walk)`;
  }
  return "Rule on the counter";
}

export function fromListingDecision(row: ListingDecisionRow): ConveyorItem {
  const cls = decisionClass(row);
  const href = `/pipeline/${row.id}`;
  const posted = row.lastInboundAt ?? null;
  const postedMs = posted ? Date.parse(posted) : NaN;
  const deadlineAt = Number.isFinite(postedMs)
    ? new Date(postedMs + DECISION_IMPLIED_DEADLINE_H * HOUR_MS).toISOString()
    : null;
  const actions: ConveyorAction[] = [
    { kind: "listing_approve", recordId: row.id, label: "Approve", note: stagedAction(row) },
    { kind: "open", href, label: "Edit" },
    { kind: "listing_kill", recordId: row.id },
  ];
  const who = row.agentName ? ` — ${row.agentName.trim()}` : "";
  return {
    key: `listing:${row.id}`,
    source: "listing",
    type: cls === "acceptance" ? "2B" : "2C",
    title: `${row.address ?? row.id}${who}`,
    reasoning: `${stagedAction(row)}. ${mathLine(row)}`,
    recordId: row.id,
    href,
    // Money in play = the number on the table: their counter when one
    // exists, else our number. Never the list price.
    dollars: row.latestCounterUsd ?? ourNumber(row),
    deadlineAt,
    deadlineImplied: deadlineAt != null,
    postedAt: posted,
    verbatim: null,
    actions,
  };
}

/** Pure: the pending Tier C listing decisions as conveyor items. Ranking is
 *  the conveyor's job (buildConveyor) — this only selects and maps. */
export function buildDecisionQueue(rows: ListingDecisionRow[], nowIso: string): ConveyorItem[] {
  return rows.filter((r) => isPendingDecision(r, nowIso)).map(fromListingDecision);
}
