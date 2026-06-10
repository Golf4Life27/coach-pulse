// V2 surface — types for the EXISTING read routes this surface consumes.
// Where a route returns a lib-typed object verbatim, we RE-EXPORT the lib
// type instead of hand-copying it (drift-proof: lib field additions flow
// through automatically). Local interfaces remain only for shapes the
// routes construct inline.

import type { Listing } from "@/lib/types";

// ── /api/listings + /api/listings/[id] — lib Listing verbatim ──────────
export type ListingDetail = Listing;

// ── lib/audit-log AuditEntry — served verbatim by /api/admin/audit-tail ─
export type { AuditEntry } from "@/lib/audit-log";

// ── /api/queue (lib/actionQueue.ts builds these). The lib type is a
// discriminated union (ResponseCard | DealCard | StaleCard | DDCard);
// this is the flattened all-optional view the boards render from. Field
// names match the union members 1:1 — see lib/actionQueue.ts. ──────────
export type CardKind = "deal" | "response" | "dd" | "stale";

export interface QueueCard {
  id: string;
  kind: CardKind;
  recordId: string;
  table: "listings" | "deals";
  cardState: "Open" | "Held" | "Cleared";
  holdUntil: string | null;
  address: string;
  city: string | null;
  /** Geographic US state ("TN") — NOT the card's hold status (that's
   *  cardState). The paused-market check reads this. */
  state: string | null;
  // response / stale / dd
  agentName?: string | null;
  agentPhone?: string | null;
  listPrice?: number | null;
  mao?: number | null;
  dom?: number | null;
  inboundMessage?: string | null;
  outboundMessage?: string | null;
  lastOutreachDate?: string | null;
  daysSilent?: number;
  missingItems?: string[];
  // deal
  contractPrice?: number | null;
  assignmentPrice?: number | null;
  spread?: number | null;
  closingStatus?: string | null;
  status?: string | null;
}

export interface QueueResponse {
  open: QueueCard[];
  held: QueueCard[];
}

// ── /api/operator-actions (shape built inline by the route) ────────────
export interface OperatorItem {
  id: string;
  title: string;
  sourceRecordId: string | null;
  actionRequired: string | null;
  context: string | null;
  verbatimReply: string | null;
  status: string;
  priority: string;
  createdAt: string | null;
}

// ── /api/admin/audit-tail envelope ─────────────────────────────────────
import type { AuditEntry as _AuditEntry } from "@/lib/audit-log";

export interface AuditTailResponse {
  ok: boolean;
  scanned: number;
  kv_oldest_ts: string | null;
  kv_newest_ts: string | null;
  matched_count: number;
  entries: _AuditEntry[];
}

// ── /api/maverick/recall ───────────────────────────────────────────────
export interface RecallResult {
  source: "spine" | "audit" | "listings" | "deals";
  record_id: string;
  summary: string;
  full_data: Record<string, unknown>;
}

export interface RecallResponse {
  results: RecallResult[];
  truncated_to_n: number;
  searched_sources: string[];
}
