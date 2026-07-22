// Live Deals — the operator's active money, made visible (operator
// 2026-07-12: "the common sense thing that gives me the best and most
// accurate tools and data to make money"). @agent: maverick
//
// THE GAP THIS CLOSES: the decision conveyor is proposal-driven, and the
// 🎯 counter is a month-to-date pace number. Neither SHOWS the operator his
// live pipeline. An email-worked legacy deal heading to contract (the 3123
// Sunbeam class — a v1_legacy record revived by hand) counts in the number
// but appears on NO surface. This module enumerates every record currently
// in a negotiation status — REGARDLESS of source version — because an active
// negotiation is current-era activity by definition. The forward ruling
// governs top-of-funnel discovery; it must never hide live money.
//
// PURE. No I/O — the route supplies rows; the component supplies motion.
// Sourced numbers only: a dollar figure renders only when its field is set.

import { NEGOTIATION_STATUSES } from "@/lib/maverick/heartbeat";

/** Canonical status list for the route's filterByFormula. */
export const NEGOTIATION_STATUS_LIST: readonly string[] = [...NEGOTIATION_STATUSES];

export interface LiveDealRow {
  id: string;
  address: string | null;
  status: string | null;
  /** Contract_Offer_Price (the live negotiated number) if set, else the
   *  Outreach_Offer_Price door-opener. */
  contractPrice: number | null;
  listPrice: number | null;
  /** Underwritten_MAO (or property MAO) — the doctrine ceiling. */
  ceiling: number | null;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  sourceVersion: string | null;
  /** RECOMMENDED REPLIES: current draft + meta (Draft_Reply_Text/Meta). */
  draftReplyText: string | null;
  draftReplyMeta: string | null;
}

/** A queued/held recommended reply attached to a deal card. */
export interface DealDraft {
  state: "queued" | "hold";
  text: string | null;
  classification: string;
  channel: string;
  holdReason: string | null;
  generatedAt: string | null;
  proposalId: string | null;
  /** The seller/agent inbound this reply answers — operator 2026-07-14:
   *  "it should show the message we are replying to, otherwise I need to open
   *  the deal card fully to see the context." Sourced from Draft_Reply_Meta's
   *  inbound_excerpt; null when the mirror predates the field. */
  inboundExcerpt: string | null;
}

export interface RankedLiveDeal {
  id: string;
  /** Street line only — the deal room carries the full address. */
  street: string;
  status: string;
  contractPrice: number | null;
  listPrice: number | null;
  ceiling: number | null;
  /** ceiling − contractPrice when both are present (negative = over ceiling). */
  headroom: number | null;
  /** Ball in our court: they replied more recently than we did (or we have
   *  never replied). This is the actionable set. */
  needsYou: boolean;
  /** max(lastInboundAt, lastOutboundAt) — drives recency ordering. */
  lastActivityAt: string | null;
  /** True for pre-v2 records — surfaced as a quiet "legacy" tag, never hidden. */
  legacy: boolean;
  href: string;
  /** RECOMMENDED REPLIES: a queued draft (one-tap approve/edit/send) or a
   *  guardrail HOLD (reason surfaced). Null when nothing is pending. */
  draft: DealDraft | null;
}

const SOURCE_VERSION_V2 = "v2_post_2026-05-26";

function street(address: string | null): string {
  return (address ?? "").split(",")[0].trim() || "(address pending)";
}

function laterIso(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return new Date(a).getTime() >= new Date(b).getTime() ? a : b;
}

/** Ball-in-our-court: an inbound with no later outbound answer. */
export function ballInOurCourt(lastInboundAt: string | null, lastOutboundAt: string | null): boolean {
  if (!lastInboundAt) return false;
  const inbound = new Date(lastInboundAt).getTime();
  if (!Number.isFinite(inbound)) return false;
  if (!lastOutboundAt) return true;
  const outbound = new Date(lastOutboundAt).getTime();
  if (!Number.isFinite(outbound)) return true;
  return inbound > outbound;
}

/** Parse the listing's draft mirror into a card-ready DealDraft. Only
 *  queued/hold states render — sent/dismissed drafts are history. */
export function dealDraftFromFields(text: string | null, metaRaw: string | null): DealDraft | null {
  if (!metaRaw || !metaRaw.trim()) return null;
  try {
    const meta = JSON.parse(metaRaw) as Record<string, unknown>;
    const state = meta.state;
    if (state !== "queued" && state !== "hold") return null;
    const inboundExcerpt =
      typeof meta.inbound_excerpt === "string" && meta.inbound_excerpt.trim()
        ? meta.inbound_excerpt.trim()
        : null;
    return {
      state,
      text: state === "queued" ? ((text ?? "").trim() || null) : null,
      classification: typeof meta.classification === "string" ? meta.classification : "unknown",
      channel: typeof meta.channel === "string" ? meta.channel : "sms",
      holdReason: typeof meta.hold_reason === "string" ? meta.hold_reason : null,
      generatedAt: typeof meta.generated_at === "string" ? meta.generated_at : null,
      proposalId: typeof meta.proposal_id === "string" ? meta.proposal_id : null,
      inboundExcerpt,
    };
  } catch {
    return null;
  }
}

/** Deal heat — operator 2026-07-12: drafts (and deals) order by how close
 *  the money is. Lower = hotter. */
const STATUS_HEAT: Record<string, number> = {
  "Offer Accepted": 0,
  "Counter Received": 1,
  Negotiating: 2,
  "Response Received": 3,
};

/** Draft classifications that carry negotiation content — a seller number,
 *  interest, a process step — vs courtesy/unknown chatter. */
const ACTIONABLE_CLASSIFICATIONS = new Set(["counter", "interest", "seller_costs", "offer_format"]);

/** Decision weight — operator 2026-07-20 ("why aren't my critical decisions
 *  at the top of Act Now?"): a $27k counter the guardrails HELD was ranked
 *  below a courtesy "Thanks!" closer because both were needs-you at the
 *  same status heat and the closer's inbound was a day fresher. Recency is
 *  a tiebreaker, not a ranking. Lower = heavier:
 *    0 — money-critical: Offer Accepted / Counter Received states, and any
 *        HELD draft (the machine refusing to auto-answer IS the strongest
 *        "operator judgment required" signal — ceiling-exceeded counters
 *        live here regardless of their status label).
 *    1 — queued draft carrying negotiation content (counter/interest/
 *        seller_costs/offer_format).
 *    2 — courtesy/unknown queued drafts and everything else. */
export function decisionWeight(
  status: string,
  draft: { state: string; classification: string } | null,
): 0 | 1 | 2 {
  if (status === "Offer Accepted" || status === "Counter Received") return 0;
  if (draft?.state === "hold") return 0;
  if (draft?.state === "queued" && ACTIONABLE_CLASSIFICATIONS.has(draft.classification)) return 1;
  return 2;
}

/** Pure: shape + rank the live-deal set. Ordering:
 *   1. ball in your court first (needs a reply — a queued draft counts),
 *   2. then deal heat (Offer Accepted > Counter > Negotiating > Response),
 *   3. then most-recent activity (newest first),
 *   4. id as a stable final tiebreak.
 *  Every negotiation-status record is included, any era — that is the point. */
export function rankLiveDeals(rows: LiveDealRow[]): RankedLiveDeal[] {
  const deals: RankedLiveDeal[] = rows
    .filter((r) => NEGOTIATION_STATUSES.has(r.status ?? ""))
    .map((r) => {
      const headroom =
        r.ceiling != null && r.contractPrice != null ? r.ceiling - r.contractPrice : null;
      let draft = dealDraftFromFields(r.draftReplyText, r.draftReplyMeta);
      // SUPERSEDED-DRAFT GUARD (operator 2026-07-22): once we've sent an
      // outbound AFTER the draft was generated, that draft is answered — the
      // operator replied (in the deal room or via the card). The mirror should
      // be cleared at the send site, but a read-layer guard makes the card
      // graduate regardless of which send path fired (the deal-room reply via
      // /api/jarvis-send used to stamp Last_Outbound_At without clearing the
      // mirror, so the HELD alert lingered after a reply). A later outbound
      // than the draft's generated_at ⇒ stale ⇒ drop it.
      if (draft?.generatedAt && r.lastOutboundAt) {
        const gen = Date.parse(draft.generatedAt);
        const out = Date.parse(r.lastOutboundAt);
        if (Number.isFinite(gen) && Number.isFinite(out) && out > gen) draft = null;
      }
      return {
        id: r.id,
        street: street(r.address),
        status: r.status as string,
        contractPrice: r.contractPrice,
        listPrice: r.listPrice,
        ceiling: r.ceiling,
        headroom,
        // A queued draft IS a ball-in-your-court state: the machine answered,
        // the operator's tap is the only thing between it and the seller.
        needsYou: ballInOurCourt(r.lastInboundAt, r.lastOutboundAt) || draft != null,
        lastActivityAt: laterIso(r.lastInboundAt, r.lastOutboundAt),
        legacy: (r.sourceVersion ?? "") !== SOURCE_VERSION_V2,
        href: `/pipeline/${r.id}`,
        draft,
      };
    });

  return deals.sort((a, b) => {
    if (a.needsYou !== b.needsYou) return a.needsYou ? -1 : 1;
    const wa = decisionWeight(a.status, a.draft);
    const wb = decisionWeight(b.status, b.draft);
    if (wa !== wb) return wa - wb;
    const ha = STATUS_HEAT[a.status] ?? 9;
    const hb = STATUS_HEAT[b.status] ?? 9;
    if (ha !== hb) return ha - hb;
    const at = a.lastActivityAt ? new Date(a.lastActivityAt).getTime() : 0;
    const bt = b.lastActivityAt ? new Date(b.lastActivityAt).getTime() : 0;
    if (bt !== at) return bt - at;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** Count of deals where the ball is in the operator's court — the header badge. */
export function needsYouCount(deals: RankedLiveDeal[]): number {
  return deals.reduce((n, d) => n + (d.needsYou ? 1 : 0), 0);
}
