import { Listing, Deal } from "./types";
import {
  latestMessageDirection,
  lastInboundLine,
  lastOutboundLine,
} from "./notes";

export type CardKind = "deal" | "response" | "dd" | "stale";
export type CardState = "Open" | "Held" | "Cleared";
export type CardTable = "listings" | "deals";

interface CardBase {
  id: string;
  recordId: string;
  table: CardTable;
  cardState: CardState;
  holdUntil: string | null;
  address: string;
}

export interface ResponseCard extends CardBase {
  kind: "response";
  table: "listings";
  agentName: string | null;
  agentPhone: string | null;
  listPrice: number | null;
  mao: number | null;
  dom: number | null;
  inboundMessage: string | null;
  outboundMessage: string | null;
}

export interface DealCard extends CardBase {
  kind: "deal";
  table: "deals";
  contractPrice: number | null;
  assignmentPrice: number | null;
  spread: number | null;
  closingStatus: string | null;
  status: string | null;
}

export interface StaleCard extends CardBase {
  kind: "stale";
  table: "listings";
  agentName: string | null;
  agentPhone: string | null;
  listPrice: number | null;
  mao: number | null;
  lastOutreachDate: string | null;
  daysSilent: number;
}

export interface DDCard extends CardBase {
  kind: "dd";
  table: "listings";
  agentName: string | null;
  agentPhone: string | null;
  missingItems: string[];
}

export type ActionCard = ResponseCard | DealCard | StaleCard | DDCard;

// All six DD checklist choices on Listings_V1.DD_Checklist (multipleSelects).
// Source of truth: get_table_schema on fldZVZT98A6cEmJB3.
export const ALL_DD_ITEMS = [
  "Bed/Bath Verified",
  "Vacancy Status Known",
  "Roof Age Asked",
  "HVAC Age Asked",
  "Water Heater Age Asked",
  "Showing Access Confirmed",
] as const;

const TERMINAL_DEAL_STATUS = new Set(["Closed", "Failed"]);
const TERMINAL_CLOSING_STATUS = new Set(["Closed", "Failed"]);

const KIND_RANK: Record<CardKind, number> = {
  deal: 0,
  response: 1,
  dd: 2,
  stale: 3,
};

const STALE_THRESHOLDS: Record<string, number> = {
  Negotiating: 2,
  "Response Received": 3,
};
const DEFAULT_STALE_DAYS = 7;

function daysBetween(iso: string | null, now: Date): number | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return Math.floor((now.getTime() - d.getTime()) / 86_400_000);
}

// Shared by listing and deal classifiers. Held cards resurface as Open once
// holdUntil has passed.
function effectiveCardState(
  stored: CardState | null | undefined,
  holdUntil: string | null,
  now: Date,
): CardState {
  const state: CardState = stored ?? "Open";
  if (state !== "Held") return state;
  if (!holdUntil) return "Open";
  const until = new Date(holdUntil);
  if (Number.isNaN(until.getTime())) return "Open";
  return until.getTime() <= now.getTime() ? "Open" : "Held";
}

const ACTIVE_MARKETS = new Set(["TX", "MI"]);

function isActiveMarket(state: string | null): boolean {
  if (!state) return true;
  return ACTIVE_MARKETS.has(state.trim().toUpperCase());
}

function classifyListing(listing: Listing, now: Date): ActionCard | null {
  const ACTIONABLE_STATUSES = new Set(["Negotiating", "Response Received"]);
  if (!ACTIONABLE_STATUSES.has(listing.outreachStatus ?? "")) return null;
  if (listing.doNotText) return null;

  const cardState = effectiveCardState(
    listing.actionCardState,
    listing.actionHoldUntil,
    now,
  );
  if (cardState === "Cleared") return null;

  let dir: "inbound" | "outbound" | null = null;
  if (listing.lastInboundAt || listing.lastOutboundAt) {
    const inbound = listing.lastInboundAt ? new Date(listing.lastInboundAt).getTime() : 0;
    const outbound = listing.lastOutboundAt ? new Date(listing.lastOutboundAt).getTime() : 0;
    dir = inbound > outbound ? "inbound" : "outbound";
  } else {
    dir = latestMessageDirection(listing.notes);
  }
  const checked = new Set(listing.ddChecklist ?? []);
  const missing = ALL_DD_ITEMS.filter((item) => !checked.has(item));
  const days = daysBetween(listing.lastOutreachDate, now);

  // Priority within a single listing: response > dd > stale.
  // Each listing emits at most one card.
  if (dir === "inbound") {
    return {
      id: `response:${listing.id}`,
      kind: "response",
      recordId: listing.id,
      table: "listings",
      cardState,
      holdUntil: listing.actionHoldUntil,
      address: listing.address,
      agentName: listing.agentName,
      agentPhone: listing.agentPhone,
      listPrice: listing.listPrice,
      mao: listing.mao,
      dom: listing.dom,
      inboundMessage: lastInboundLine(listing.notes),
      outboundMessage: lastOutboundLine(listing.notes),
    };
  }

  if (missing.length > 0) {
    return {
      id: `dd:${listing.id}`,
      kind: "dd",
      recordId: listing.id,
      table: "listings",
      cardState,
      holdUntil: listing.actionHoldUntil,
      address: listing.address,
      agentName: listing.agentName,
      agentPhone: listing.agentPhone,
      missingItems: missing,
    };
  }

  const staleThreshold = STALE_THRESHOLDS[listing.outreachStatus ?? ""] ?? DEFAULT_STALE_DAYS;
  if (days !== null && days >= staleThreshold) {
    return {
      id: `stale:${listing.id}`,
      kind: "stale",
      recordId: listing.id,
      table: "listings",
      cardState,
      holdUntil: listing.actionHoldUntil,
      address: listing.address,
      agentName: listing.agentName,
      agentPhone: listing.agentPhone,
      listPrice: listing.listPrice,
      mao: listing.mao,
      lastOutreachDate: listing.lastOutreachDate,
      daysSilent: days,
    };
  }

  return null;
}

function classifyDeal(deal: Deal, now: Date): ActionCard | null {
  // Terminal-status backstop — keeps old closed/failed deals out of the queue
  // even if Action_Card_State was never populated on them.
  if (deal.status && TERMINAL_DEAL_STATUS.has(deal.status)) return null;
  if (deal.closingStatus && TERMINAL_CLOSING_STATUS.has(deal.closingStatus)) {
    return null;
  }

  const cardState = effectiveCardState(
    deal.actionCardState,
    deal.actionHoldUntil,
    now,
  );
  if (cardState === "Cleared") return null;

  const contract = deal.contractPrice;
  const fee = deal.assignmentFee;
  const assignmentPrice =
    contract != null && fee != null ? contract + fee : null;

  return {
    id: `deal:${deal.id}`,
    kind: "deal",
    recordId: deal.id,
    table: "deals",
    cardState,
    holdUntil: deal.actionHoldUntil,
    address: deal.propertyAddress,
    contractPrice: contract,
    assignmentPrice,
    spread: fee,
    closingStatus: deal.closingStatus,
    status: deal.status,
  };
}

function compareCards(a: ActionCard, b: ActionCard): number {
  const r = KIND_RANK[a.kind] - KIND_RANK[b.kind];
  if (r !== 0) return r;
  // Within a kind, fall back to alphabetical address for a stable order.
  return a.address.localeCompare(b.address);
}

export interface ActionQueueResult {
  open: ActionCard[];
  held: ActionCard[];
}

// Pure function — testable in isolation.
// State filter: only active-market listings produce cards (TX, MI). Deals are
// not state-filtered because they represent already-acquired contracts.
export function buildActionQueue(
  listings: Listing[],
  deals: Deal[],
  now: Date = new Date(),
): ActionQueueResult {
  const open: ActionCard[] = [];
  const held: ActionCard[] = [];

  for (const listing of listings) {
    if (!isActiveMarket(listing.state)) continue;
    const card = classifyListing(listing, now);
    if (!card) continue;
    if (card.cardState === "Held") held.push(card);
    else open.push(card);
  }

  for (const deal of deals) {
    const card = classifyDeal(deal, now);
    if (!card) continue;
    if (card.cardState === "Held") held.push(card);
    else open.push(card);
  }

  open.sort(compareCards);
  held.sort(compareCards);

  return { open, held };
}
