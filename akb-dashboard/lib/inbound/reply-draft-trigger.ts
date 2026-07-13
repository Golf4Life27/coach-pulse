// RECOMMENDED-REPLIES draft trigger — shared by the SYNC-INGESTION crons
// (quo-sync SMS + gmail-sync email). @agent: forge/crier
//
// P2.1 (2026-07-13): RECOMMENDED REPLIES (#103) produced ZERO drafts because
// the trigger was wired only to gmail-sync (dark behind INBOUND_CAPTURE_LIVE)
// and to scan-comms' separate Quo re-fetch — NOT to quo-sync, the canonical
// SMS ingestion path. So every SMS inbound landed in Verification_Notes as
// "L3 INBOUND: <CLASS>" with no draft. This module is the single place both
// sync crons call the moment they append a new inbound, so every classified
// inbound drafts-or-HOLDs on the same idempotent ingestion path the message
// itself lands on (the P1.2 lesson: hang behavior off canonical ingestion,
// not a narrow parallel trigger).
//
// PURE except the injected generate (defaults to the guardrailed
// generateRecommendedReply; tests inject a stub and never hit the API). It
// returns the mirror fields + a proposal SPEC; the caller performs the two
// Airtable writes (create proposal, then update listing) so this stays
// unit-testable and the callers keep their existing write plumbing.

import { triageSellerReply } from "@/lib/reply-triage";
import {
  conversationTail,
  flagsFromNotes,
  generateRecommendedReply,
  parseDraftMeta,
  stickyOfferFromNotes,
  validateReplyDraft,
  type DraftMeta,
  type GeneratedReply,
  type ReplyDraftContext,
} from "@/lib/recommended-reply";
import { extractEmailAddress } from "@/lib/inbound/match";
import { normalizeSubject } from "@/lib/inbound/gmail-thread-link";
import {
  decideDDAction,
  ddAnswerStampLine,
  parseVolleyState,
  pendingSlot,
  serializeVolleyState,
} from "@/lib/dd-volley-machine";

/** B2 DD-volley wiring is watched-first: dormant until the operator creates
 *  the DD_Volley_State field (done) AND sets DD_VOLLEY_LIVE=true. Off ⇒ the
 *  trigger behaves exactly as the #103 recommended-reply path. */
export function isDDVolleyLive(): boolean {
  return process.env.DD_VOLLEY_LIVE === "true";
}

export interface DraftTriggerListing {
  id: string;
  address: string | null;
  outreachStatus: string | null;
  underwrittenMao: number | null;
  mao: number | null;
  listPrice: number | null;
  agentName: string | null;
  agentEmail: string | null;
  /** Prior Draft_Reply_Meta JSON — for inbound-msg-id idempotency. */
  draftReplyMeta: string | null;
  /** Prior DD_Volley_State JSON (B2). Null until a volley opens / DD off. */
  ddVolleyState?: string | null;
}

export interface DraftTriggerInbound {
  /** Carrier/Gmail message id — the idempotency key. */
  msgId: string;
  body: string;
  /** Email: the sender header (reply-to is parsed from it). */
  from?: string | null;
  /** Email: the inbound subject (Re: is built from it). */
  subject?: string | null;
  /** SMS: E.164 reply-to (the agent phone). */
  toPhoneE164?: string | null;
}

/** The 2A queue row to create. The caller owns the Airtable write. */
export interface ProposalSpec {
  proposalId: string;
  recordId: string;
  address: string | null;
  priority: string;
  reasoning: string;
  actionPayload: string;
}

export type DraftSkipReason =
  | "already_drafted"
  | "pending_proposal"
  | "tier0_auto_close";

export interface DraftTriggerResult {
  drafted: boolean;
  skipped: DraftSkipReason | null;
  classification: string;
  holdReason: string | null;
  /** Draft_Reply_Text mirror ("" on hold). Empty object semantics: only
   *  meaningful when `proposal` is non-null. */
  draftText: string;
  /** Draft_Reply_Meta object — the caller stamps proposal_id (only on a
   *  successful proposal create) and stringifies. */
  draftMeta: DraftMeta | null;
  /** The proposal to create; null when skipped. */
  proposal: ProposalSpec | null;
  /** Extra listing fields the caller must merge (B2: DD_Volley_State). */
  extraFields?: Record<string, unknown>;
  /** A notes-ledger line to append (B2: a delivery-stamped DD answer). The
   *  caller appends it to the Verification_Notes it is already writing. */
  notesAppend?: string | null;
}

export interface DraftTriggerDeps {
  generate?: (
    ctx: ReplyDraftContext,
    opts?: { matchedPattern?: string | null; inboundMsgId?: string | null },
  ) => Promise<GeneratedReply>;
  /** Injectable clock for the proposal id (tests pin it; scripts can't call
   *  Date.now). */
  nowMs?: number;
  /** Injectable ISO clock for DD-volley stamps/state (tests pin it). */
  nowIso?: string;
  /** Force DD-volley on in tests without touching process.env. */
  ddLive?: boolean;
}

function skip(reason: DraftSkipReason, classification: string): DraftTriggerResult {
  return { drafted: false, skipped: reason, classification, holdReason: null, draftText: "", draftMeta: null, proposal: null };
}

/** Build the 2A action payload for either channel. Shared by the normal
 *  recommended-reply path and the DD-volley path so the row shape can't drift.
 *  An empty `body` means HOLD (hold_review). */
function buildReplyPayload(
  channel: "sms" | "email",
  listing: DraftTriggerListing,
  inbound: DraftTriggerInbound,
  street: string,
  body: string,
  holdReason: string | null,
  classification: string,
  decisionKind: string | null,
  tier: string,
): string {
  if (channel === "email") {
    const replyTo = extractEmailAddress(inbound.from ?? "") || listing.agentEmail || "";
    const subject = `Re: ${normalizeSubject(inbound.subject ?? "") || `Your listing — ${street}`}`;
    return JSON.stringify({
      recordId: listing.id,
      action: body ? "send_email" : "hold_review",
      to: replyTo,
      subject,
      draftBody: body,
      holdReason,
      inboundBody: inbound.body.slice(0, 1000),
      classification,
      decisionKind,
      tier,
    });
  }
  return JSON.stringify({
    recordId: listing.id,
    action: body ? "send_sms" : "hold_review",
    to: inbound.toPhoneE164 ?? "",
    draftBody: body,
    holdReason,
    inboundBody: inbound.body.slice(0, 1000),
    classification,
    decisionKind,
    tier,
  });
}

/** Build a guardrailed recommended-reply draft for a freshly-ingested inbound.
 *  Idempotent by inbound msg id (never re-drafts the same message) and by an
 *  injected `hasPendingProposal` flag (never doubles a proposal another path —
 *  e.g. scan-comms — already queued for this record). Tier-0 rejections ride
 *  the auto-close lane, not this one. NEVER throws on model failure — a failed
 *  generation is a HOLD proposal (refuse-and-surface); an inbound must never
 *  silently drop. */
export async function buildInboundReplyDraft(args: {
  listing: DraftTriggerListing;
  /** The UPDATED notes (post-append) — context/sticky/flags read from here. */
  notes: string;
  inbound: DraftTriggerInbound;
  channel: "sms" | "email";
  /** True when another path already has a pending jarvis_reply for this record. */
  hasPendingProposal?: boolean;
  deps?: DraftTriggerDeps;
}): Promise<DraftTriggerResult> {
  const { listing, notes, inbound, channel } = args;
  const generate = args.deps?.generate ?? generateRecommendedReply;
  const nowMs = args.deps?.nowMs ?? Date.now();
  const nowIso = args.deps?.nowIso ?? new Date().toISOString();

  // Idempotency 1: this exact inbound already produced a draft.
  const priorMeta = parseDraftMeta(listing.draftReplyMeta);
  if (priorMeta?.inbound_msg_id && priorMeta.inbound_msg_id === inbound.msgId) {
    return skip("already_drafted", priorMeta.classification ?? "unknown");
  }

  const street = (listing.address ?? "").split(",")[0].trim();
  const triage = triageSellerReply(inbound.body, listing.outreachStatus ?? null, {
    street: street || null,
  });

  // Tier-0 rejections ride the existing auto-close lane; no draft here.
  if (triage.tier === "tier_0_auto_close") {
    return skip("tier0_auto_close", triage.classification);
  }

  // Idempotency 2: another path already queued a reply for this record.
  // (Checked AFTER tier-0 so a rejection still short-circuits cleanly.)
  if (args.hasPendingProposal) {
    return skip("pending_proposal", triage.classification);
  }

  // ── B2 DD-VOLLEY (watched-first) ───────────────────────────────────────────
  // When live, an engagement runs a bounded DD question volley BEFORE any
  // number move: the DD question BECOMES the draft, each seller answer is
  // delivery-stamped to notes, and the state persists on DD_Volley_State. On
  // completion (facts gathered) or cap, we fall through to the normal reply.
  let ddExtraFields: Record<string, unknown> | undefined;
  let ddNotesAppend: string | null = null;
  const ddLive = args.deps?.ddLive ?? isDDVolleyLive();
  if (ddLive) {
    const prevVolley = parseVolleyState(listing.ddVolleyState);
    const pendingBefore = prevVolley ? pendingSlot(prevVolley) : null;
    const action = decideDDAction(prevVolley, triage.classification, inbound.body, inbound.msgId, nowIso);
    if (pendingBefore) {
      // This inbound answered the pending DD question — stamp it to the ledger.
      ddNotesAppend = ddAnswerStampLine(pendingBefore, inbound.body, nowIso, inbound.msgId);
    }
    if (action.kind === "ask") {
      // The DD question IS the draft. It rides the SAME universal guardrails —
      // validated as "unknown" classification so a cost-volley's timeline
      // question isn't held for lacking proceeds framing (that G2 rule is for
      // cost ANSWERS; the DD templates are authored safe + unit-tested).
      const guardCtx: ReplyDraftContext = {
        recordId: listing.id,
        street,
        channel,
        classification: "unknown",
        inbound: inbound.body,
        conversationTail: conversationTail(notes),
        stickyOfferUsd: null,
        ceilingUsd: listing.underwrittenMao ?? listing.mao ?? null,
        listPriceUsd: listing.listPrice ?? null,
        cappedToList: false,
        flags: flagsFromNotes(notes),
        agentFirstName: (listing.agentName ?? "").split(/\s+/)[0] || null,
      };
      const v = validateReplyDraft(action.question, guardCtx);
      const ddBody = v.ok ? action.question : "";
      const ddHold = v.ok ? null : `dd_question_guardrail: ${v.holdReason}`;
      const proposal: ProposalSpec = {
        proposalId: `jarvis_reply-${nowMs}-${listing.id.slice(-6)}`,
        recordId: listing.id,
        address: listing.address,
        priority: triage.priority,
        reasoning: v.ok
          ? `DD volley [${triage.classification}] — asking ${action.slot}`
          : `HOLD (${ddHold}) — DD volley [${triage.classification}] ${action.slot}`,
        actionPayload: buildReplyPayload(channel, listing, inbound, street, ddBody, ddHold, triage.classification, triage.decisionKind, triage.tier),
      };
      return {
        drafted: v.ok,
        skipped: null,
        classification: triage.classification,
        holdReason: ddHold,
        draftText: ddBody,
        draftMeta: {
          state: v.ok ? "queued" : "hold",
          generated_at: nowIso,
          classification: triage.classification,
          confidence: 0.9,
          channel,
          inbound_msg_id: inbound.msgId,
          hold_reason: ddHold ?? undefined,
        },
        proposal,
        extraFields: { DD_Volley_State: serializeVolleyState(action.state) },
        notesAppend: ddNotesAppend,
      };
    }
    // number_gate_open | capped: persist the updated state and fall through to
    // the normal recommended reply. "none" leaves the state untouched.
    if (action.kind !== "none") {
      ddExtraFields = { DD_Volley_State: serializeVolleyState(action.state) };
    }
  }

  const gen = await generate(
    {
      recordId: listing.id,
      street,
      channel,
      classification: triage.classification,
      inbound: inbound.body,
      conversationTail: conversationTail(notes),
      stickyOfferUsd: stickyOfferFromNotes(notes),
      ceilingUsd: listing.underwrittenMao ?? listing.mao ?? null,
      listPriceUsd: listing.listPrice ?? null,
      cappedToList: /capped[_\s-]?to[_\s-]?list/i.test(notes ?? ""),
      flags: flagsFromNotes(notes),
      agentFirstName: (listing.agentName ?? "").split(/\s+/)[0] || null,
    },
    { matchedPattern: triage.matchedPattern, inboundMsgId: inbound.msgId },
  );

  const channelLabel = channel === "email" ? "Email" : "SMS";
  const proposal: ProposalSpec = {
    proposalId: `jarvis_reply-${nowMs}-${listing.id.slice(-6)}`,
    recordId: listing.id,
    address: listing.address,
    priority: triage.priority,
    reasoning: gen.draft
      ? `${channelLabel} inbound [${triage.classification}${triage.queueStatus ? ` → ${triage.queueStatus}` : ""}]: ${triage.reasoning}`
      : `HOLD (${gen.holdReason}) — ${channelLabel.toLowerCase()} inbound [${triage.classification}]: ${triage.reasoning}`,
    actionPayload: buildReplyPayload(channel, listing, inbound, street, gen.draft ?? "", gen.holdReason, triage.classification, triage.decisionKind, triage.tier),
  };

  return {
    drafted: Boolean(gen.draft),
    skipped: null,
    classification: triage.classification,
    holdReason: gen.holdReason,
    draftText: gen.draft ?? "",
    draftMeta: gen.meta,
    proposal,
    extraFields: ddExtraFields,
    notesAppend: ddNotesAppend,
  };
}

/** Create a jarvis_reply proposal row (the 2A queue item). Single-row create;
 *  false on any failure (the listing mirror still records the draft). Shared
 *  by quo-sync + gmail-sync so the row shape can't drift between channels. */
export async function createReplyProposal(p: ProposalSpec): Promise<boolean> {
  const pat = process.env.AIRTABLE_PAT;
  const tableId = process.env.AGENT_PROPOSALS_TABLE_ID;
  const baseId = process.env.AIRTABLE_BASE_ID || "appp8inLAGTg4qpEZ";
  if (!pat || !tableId) return false;
  const res = await fetch(`https://api.airtable.com/v0/${baseId}/${tableId}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${pat}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      records: [
        {
          fields: {
            Proposal_ID: p.proposalId,
            Proposal_Type: "jarvis_reply",
            Priority: p.priority,
            Record_ID: p.recordId,
            Record_Address: p.address ?? "",
            Reasoning: p.reasoning,
            Suggested_Action_Payload: p.actionPayload,
            Status: "Pending",
          },
        },
      ],
      typecast: true,
    }),
  }).catch(() => null);
  return Boolean(res?.ok);
}

/** Record ids with a PENDING jarvis_reply proposal — the cross-path dedup set
 *  (quo-sync consults it so it never doubles a proposal scan-comms already
 *  queued for the same SMS inbound). Paged; fail-soft to an empty set. */
export async function fetchPendingReplyProposalRecordIds(): Promise<Set<string>> {
  const out = new Set<string>();
  const pat = process.env.AIRTABLE_PAT;
  const tableId = process.env.AGENT_PROPOSALS_TABLE_ID;
  const baseId = process.env.AIRTABLE_BASE_ID || "appp8inLAGTg4qpEZ";
  if (!pat || !tableId) return out;
  let offset: string | undefined;
  try {
    do {
      const params = new URLSearchParams();
      params.set("filterByFormula", 'AND({Status}="Pending",{Proposal_Type}="jarvis_reply")');
      params.set("fields[]", "Record_ID");
      if (offset) params.set("offset", offset);
      const res = await fetch(`https://api.airtable.com/v0/${baseId}/${tableId}?${params.toString()}`, {
        headers: { Authorization: `Bearer ${pat}` },
        cache: "no-store",
      });
      if (!res.ok) break;
      const data = await res.json();
      for (const rec of data.records ?? []) {
        const rid = (rec.fields as Record<string, unknown>)?.Record_ID;
        if (typeof rid === "string" && rid) out.add(rid);
      }
      offset = data.offset;
    } while (offset);
  } catch {
    // fail-soft: an empty set just means no cross-path dedup this run.
  }
  return out;
}
