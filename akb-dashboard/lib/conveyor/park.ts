// Conveyor park / dispose helpers — the operator-facing landing zone
// for the three veto outcomes from the conveyor spec:
//
//   parkDeal      — write a Pending row to the Agent_Proposals table
//                   (the Queue surface) so the deal halts on the belt
//                   with a human-visible reason. Used for:
//                     * ARV not producible → CMA request to operator
//                     * Math fails the sticky floor → watch for price cut
//                     * Listing changed mid-negotiation → review
//
//   disposeDeal   — write a Pending kill_dead_deal Proposal (operator
//                   one-click acks the auto-disposal). Used for:
//                     * Listing off-market AND no offer + no thread
//                       (canAutoDispose() == true)
//
//   canAutoDispose — pure guard. Per the listing-gone-with-an-offer
//                   condition: if a delivered offer exists OR an open
//                   conversation thread exists, we MUST NOT auto-dispose;
//                   we park instead. The guard accepts the minimal shape
//                   the call site can supply (an offer flag + a recent-
//                   inbound flag) so the caller decides what counts as
//                   "delivered" or "open" in its context.
//
// Every action emits one composite audit entry on the `conveyor` agent
// with a `parked:<reason>` / `disposed:<reason>` decision tag, matching
// the audit shape Pulse's other detectors already consume.

import { audit } from "@/lib/audit-log";

const AIRTABLE_PAT = process.env.AIRTABLE_PAT;
const BASE_ID = process.env.AIRTABLE_BASE_ID || "appp8inLAGTg4qpEZ";

export type ParkReason =
  | "no_arv"
  | "math_fails_floor"
  | "listing_changed_mid_negotiation";

export type DisposeReason = "listing_off_market";

export type Priority = "HIGH" | "MEDIUM" | "LOW";

export interface ParkInput {
  recordId: string;
  address: string;
  reason: ParkReason;
  /** Short operator-facing reasoning sentence. Goes into the Reasoning
   *  field on the proposal row. Keep it specific — name the address,
   *  name the metric, name the threshold. */
  reasoning: string;
  /** LOW for "we'll watch this"; MEDIUM for "operator should look this
   *  cycle"; HIGH for "operator should look now." */
  priority?: Priority;
  /** Arbitrary payload for the Suggested_Action_Payload field. Empty
   *  object when omitted. */
  payload?: Record<string, unknown>;
}

export interface DisposeInput {
  recordId: string;
  address: string;
  reason: DisposeReason;
  reasoning: string;
}

export interface OfferOrThreadGuardInput {
  /** True iff at least one offer was actually delivered for this deal.
   *  Implementation detail per caller — for an SMS-only deal this is
   *  the Quo send_confirmed timestamp, for an email-touched deal it's
   *  a Gmail send. */
  hasDeliveredOffer: boolean;
  /** True iff a conversation thread (SMS or email) has been touched
   *  by the counterparty within the open-thread window. The caller
   *  decides the window; a common choice is 30 days. */
  hasOpenThread: boolean;
}

/** Pure: returns true iff a deal that just went off-market is safe to
 *  auto-dispose. Per the conveyor charter: if an offer was delivered or
 *  a conversation is still open, we DO NOT auto-dispose — we park with
 *  a queue item so the operator decides. */
export function canAutoDispose(g: OfferOrThreadGuardInput): boolean {
  return !g.hasDeliveredOffer && !g.hasOpenThread;
}

const PROPOSAL_TYPE_BY_PARK_REASON: Record<ParkReason, string> = {
  no_arv: "surface_stale",
  math_fails_floor: "flag_price_drop",
  listing_changed_mid_negotiation: "surface_stale",
};

const PARK_TITLE_PREFIX: Record<ParkReason, string> = {
  no_arv: "CMA needed",
  math_fails_floor: "Math fails floor — watch for price cut",
  listing_changed_mid_negotiation: "Listing status changed mid-negotiation",
};

function getProposalsTableId(): string | null {
  return process.env.AGENT_PROPOSALS_TABLE_ID ?? null;
}

interface AirtableCreateResult {
  ok: boolean;
  proposalId?: string;
  error?: string;
}

async function createProposalRow(fields: Record<string, unknown>): Promise<AirtableCreateResult> {
  const tableId = getProposalsTableId();
  if (!tableId) return { ok: false, error: "AGENT_PROPOSALS_TABLE_ID not set" };
  if (!AIRTABLE_PAT) return { ok: false, error: "AIRTABLE_PAT not set" };
  try {
    const res = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${tableId}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${AIRTABLE_PAT}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ records: [{ fields }] }),
      cache: "no-store",
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      return { ok: false, error: `Airtable ${res.status}: ${txt.slice(0, 200)}` };
    }
    const data = (await res.json()) as { records?: Array<{ id: string }> };
    return { ok: true, proposalId: data.records?.[0]?.id };
  } catch (err) {
    return { ok: false, error: String(err).slice(0, 300) };
  }
}

export async function parkDeal(input: ParkInput): Promise<AirtableCreateResult> {
  const t0 = Date.now();
  const priority = input.priority ?? (input.reason === "no_arv" ? "LOW" : "MEDIUM");
  const proposalType = PROPOSAL_TYPE_BY_PARK_REASON[input.reason];
  const title = `${PARK_TITLE_PREFIX[input.reason]} — ${input.address}`;

  const result = await createProposalRow({
    Proposal_ID: `park-${input.reason}-${Date.now()}-${input.recordId}`,
    Proposal_Type: proposalType,
    Priority: priority,
    Record_ID: input.recordId,
    Record_Address: input.address,
    Reasoning: `[${priority}] ${title}. ${input.reasoning}`,
    Suggested_Action_Payload: JSON.stringify({
      recordId: input.recordId,
      park_reason: input.reason,
      ...(input.payload ?? {}),
    }),
    Status: "Pending",
  });

  await audit({
    agent: "conveyor",
    event: "deal_parked",
    status: result.ok ? "confirmed_success" : "confirmed_failure",
    recordId: input.recordId,
    ms: Date.now() - t0,
    inputSummary: { reason: input.reason, address: input.address, priority },
    outputSummary: { proposalId: result.proposalId },
    decision: `parked:${input.reason}`,
    error: result.error,
  });

  return result;
}

export async function disposeDeal(input: DisposeInput): Promise<AirtableCreateResult> {
  const t0 = Date.now();
  const result = await createProposalRow({
    Proposal_ID: `dispose-${input.reason}-${Date.now()}-${input.recordId}`,
    Proposal_Type: "kill_dead_deal",
    Priority: "HIGH",
    Record_ID: input.recordId,
    Record_Address: input.address,
    Reasoning: `[HIGH] Auto-dispose: ${input.address}. ${input.reasoning}`,
    Suggested_Action_Payload: JSON.stringify({
      recordId: input.recordId,
      dispose_reason: input.reason,
      action: "set_outreach_status_dead",
    }),
    Status: "Pending",
  });

  await audit({
    agent: "conveyor",
    event: "deal_disposed",
    status: result.ok ? "confirmed_success" : "confirmed_failure",
    recordId: input.recordId,
    ms: Date.now() - t0,
    inputSummary: { reason: input.reason, address: input.address },
    outputSummary: { proposalId: result.proposalId },
    decision: `disposed:${input.reason}`,
    error: result.error,
  });

  return result;
}
