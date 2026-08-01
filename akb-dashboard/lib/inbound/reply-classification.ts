// Reply-classification PERSISTENCE. @agent: outreach
//
// WHY THIS EXISTS (2026-07-31, the reply-funnel blindness)
//
// lib/reply-triage.triageSellerReply has classified every genuine inbound
// since it shipped. Nothing ever WROTE the answer down. The label went to
// three places, all of them lossy:
//
//   1. scan-replies  — interpolated into a Verification_Notes prose blob
//                      ("... Classified: INTEREST."). Free text, not a field.
//   2. scan-comms    — attached to a jarvis_reply PROPOSAL, which is a queue
//                      ITEM: consumed by the operator, then gone.
//   3. Outreach_Status — a 6-way coarse state that collapses ten distinct
//                      classifications (seller_costs, offer_format,
//                      appointment, disclosure_step … all land on "Response
//                      Received").
//
// The measured cost: of 121 records carrying a Last_Inbound_At, exactly 3
// had a classification recoverable from note prose. 118 replies were
// classified and the label discarded. That made the only question that
// matters — "our reply rate is 11.5% and our contract rate is 0.1%, so
// WHERE do threads die?" — unanswerable without re-reading raw Quo threads
// by hand.
//
// The fix is a FLOOR, not a redesign: every path that already computes a
// triage calls buildReplyClassificationFields() and merges the result into
// the Airtable write it was making anyway. No new I/O, no new classifier,
// no second source of truth — lib/reply-triage stays the only brain.
//
// Pure. No I/O. Tested in lib/inbound/reply-classification.test.ts.

import type { SellerReplyTriage } from "@/lib/reply-triage";

/** Airtable field NAMES (the update path writes by name, as the existing
 *  scan-comms / scan-replies calls do). Field ids live in lib/airtable.ts's
 *  LISTING_FIELDS map for the read path. */
export const REPLY_CLASSIFICATION_FIELD = "Reply_Classification";
export const REPLY_CLASSIFIED_AT_FIELD = "Reply_Classified_At";
export const REPLY_DECISION_KIND_FIELD = "Reply_Decision_Kind";

/** Field IDs, for the writers that key their update payloads by id
 *  (scan-replies) rather than by name (scan-comms). Same three fields. */
export const REPLY_CLASSIFICATION_FIELD_IDS = {
  classification: "fld7vLOMdLthqccoy",
  classifiedAt: "fldoTXHschuUDi2Hx",
  decisionKind: "fld13azWnqSx2YyoJ",
} as const;

export interface ReplyClassificationFields extends Record<string, string> {
  Reply_Classification: string;
  Reply_Classified_At: string;
  Reply_Decision_Kind: string;
}

/** Pure: the three fields that record WHAT this reply was, so the reply
 *  funnel can be computed later without re-reading Quo.
 *
 *  `at` is the inbound's own timestamp when known (so a backfill stamps the
 *  reply's real time, not the time we happened to notice), falling back to
 *  now. Callers pass inbound.createdAt. */
export function buildReplyClassificationFields(
  triage: Pick<SellerReplyTriage, "classification" | "decisionKind">,
  at?: string | null,
): ReplyClassificationFields {
  const stamp = normalizeStamp(at) ?? new Date().toISOString();
  return {
    [REPLY_CLASSIFICATION_FIELD]: triage.classification,
    [REPLY_CLASSIFIED_AT_FIELD]: stamp,
    [REPLY_DECISION_KIND_FIELD]: triage.decisionKind,
  } as ReplyClassificationFields;
}

/** Pure: an ISO timestamp Airtable will accept, or null when unparseable.
 *  A junk `createdAt` must not poison the write — we fall back to now
 *  rather than refusing to record the classification at all. */
function normalizeStamp(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString();
}

/** Pure: same three values, keyed by field ID for id-writing callers. */
export function buildReplyClassificationFieldsById(
  triage: Pick<SellerReplyTriage, "classification" | "decisionKind">,
  at?: string | null,
): Record<string, string> {
  const byName = buildReplyClassificationFields(triage, at);
  return {
    [REPLY_CLASSIFICATION_FIELD_IDS.classification]: byName.Reply_Classification,
    [REPLY_CLASSIFICATION_FIELD_IDS.classifiedAt]: byName.Reply_Classified_At,
    [REPLY_CLASSIFICATION_FIELD_IDS.decisionKind]: byName.Reply_Decision_Kind,
  };
}

/** Pure: does this record carry a reply whose triage was never persisted?
 *  Drives the backfill selector and the coverage meter — a record with an
 *  inbound but no classification stamp is exactly the 2026-07-31 hole. */
export function isClassificationMissing(listing: {
  lastInboundAt?: string | null;
  replyClassification?: string | null;
}): boolean {
  return Boolean(listing.lastInboundAt) && !listing.replyClassification;
}
