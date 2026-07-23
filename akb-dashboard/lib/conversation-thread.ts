// Conversation-thread attribution — which listing a phone's inbound belongs to.
// @agent: crier
//
// THE BUG THIS CLOSES (operator 2026-07-22): a listing agent who reps several
// properties has ONE phone number, so SMS is ONE thread across all of them.
// scan-comms matched an inbound to EVERY listing sharing that phone and fanned
// a draft + proposal + Act-Now alert onto each — so Gharian Carver's single
// "are you still interested?" (about 19426 Gilchrist, the deal we last texted)
// spawned a duplicate alert on 17135 Fielding too, whose card then showed the
// Gilchrist conversation. The operator opened the wrong deal.
//
// A reply belongs to the ACTIVE thread: the listing we most recently texted
// this agent about. Number-level actions (opt-out / Do_Not_Text) still fan to
// every listing — that's correct, a STOP is about the number. Only the
// property-specific reply handling (draft, proposal, alert, inbound stamp)
// attributes to the one thread listing.
//
// PURE. No I/O — the caller passes the candidate listings for one phone.

/** The fields the thread selector needs off a listing. */
export interface ThreadCandidate {
  id: string;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  outreachStatus: string | null;
}

/** Deal heat — most-engaged first, mirrors lib/live-deals STATUS_HEAT so a
 *  tie resolves the same way the operator's surfaces rank. */
const STATUS_HEAT: Record<string, number> = {
  "Offer Accepted": 0,
  "Counter Received": 1,
  Negotiating: 2,
  "Response Received": 3,
  Texted: 4,
};

function ms(iso: string | null): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

/** Pure: pick the single listing that owns the active conversation for this
 *  phone. Ordering (each a tiebreak for the last):
 *   1. most-recent OUTBOUND — the deal we last texted the agent about IS the
 *      thread the reply answers (the strongest signal; matches how the seller
 *      is actually replying);
 *   2. most-recent INBOUND;
 *   3. deal heat (most-engaged status);
 *   4. stable id.
 *  Returns null for an empty list; the single-element list returns that one. */
export function selectThreadListing<T extends ThreadCandidate>(listings: readonly T[]): T | null {
  if (listings.length === 0) return null;
  if (listings.length === 1) return listings[0];
  return [...listings].sort((a, b) => {
    const bo = ms(b.lastOutboundAt), ao = ms(a.lastOutboundAt);
    if (bo !== ao) return bo - ao;
    const bi = ms(b.lastInboundAt), ai = ms(a.lastInboundAt);
    if (bi !== ai) return bi - ai;
    const ah = STATUS_HEAT[a.outreachStatus ?? ""] ?? 9;
    const bh = STATUS_HEAT[b.outreachStatus ?? ""] ?? 9;
    if (ah !== bh) return ah - bh;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  })[0];
}

/** Pure: did WE open a conversation about THIS listing on this SMS thread?
 *  True iff one of OUR outbound messages in the thread names the listing's
 *  street. This is the pollution-proof attribution signal: Last_Inbound/Outbound
 *  timestamps get fanned across every listing an agent reps, but our own opener
 *  ("...cash offer of $X on 7545 Holmes St...") names the exact property. A
 *  listing we never texted (Saint Patrick) has NO outbound naming its street,
 *  so a shared-phone inbound must not draft/flip/decision-math against it — the
 *  exact defect that manufactured a sendable counter on a never-offered deal
 *  (operator 2026-07-22). Match is case-insensitive substring on the street
 *  line (address before the first comma), which our openers always contain. */
export function weOpenedThreadForListing(
  outboundBodies: readonly (string | null | undefined)[],
  address: string | null | undefined,
): boolean {
  const street = (address ?? "").split(",")[0].trim().toLowerCase();
  if (!street) return false;
  return outboundBodies.some((b) => (b ?? "").toLowerCase().includes(street));
}
