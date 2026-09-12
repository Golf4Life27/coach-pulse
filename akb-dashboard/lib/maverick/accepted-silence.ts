// Accepted-offer silence watchdog — pure detection + card composition.
// @agent: maverick
//
// THE INCIDENT THIS EXISTS FOR (1102 Montrose Ave): the record went
// Offer Accepted on 9/1 at $55,750. The agent chased on 9/3. Maverick sent a
// holding reply. Then nothing — nine days of silence on an ACCEPTED offer, no
// executed contract, and not one text ever reached the operator's phone. Every
// existing alert lane is event-driven: an inbound arrives, a deadline lands, a
// tripwire trips. Silence is not an event, so silence paged nobody. The most
// valuable state in the funnel — a yes, unexecuted — was the one state with no
// watchdog on it.
//
// This module is the watchdog, and it is pure: it takes listings and a clock
// and says which accepted offers have gone quiet. The route (app/api/cron/
// accepted-silence) does the I/O and the paging.
//
// HONEST BY CONSTRUCTION:
//  - A record with NO contact timestamps at all is NOT "silent"; it is
//    UNMEASURABLE. Counting it as silent would page the operator about a clock
//    that was never started. It is reported separately so the gap is visible
//    instead of laundered into a number.
//  - A record the operator already tapped "Pause" on (Action_Card_State=Held
//    with a live Action_Hold_Until) is skipped. The card channel is worthless
//    if a tap does not stop the paging.
//  - No date is invented. "Offer accepted Nd ago" is only claimed when the
//    record actually carries the stamp for it (Reply_Classified_At on an
//    acceptance); otherwise the sentence simply omits it.

import type { Listing } from "@/lib/types";
import type { CardOption } from "@/lib/maverick/decision-card";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

/** Short address for the SMS/title: "1102 Montrose Ave" from the comma form. */
function shortAddress(address: string | null): string {
  if (!address) return "unknown address";
  return address.split(",")[0].trim() || address;
}

function parseIso(value: string | null | undefined): number | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

function dateOnly(value: string | null | undefined): string | null {
  const t = parseIso(value);
  return t === null ? null : new Date(t).toISOString().slice(0, 10);
}

export interface SilentAcceptedOffer {
  recordId: string;
  address: string;
  agentName: string | null;
  /** contractOfferPrice ?? outreachOfferPrice ?? null — never computed here. */
  acceptedPrice: number | null;
  /** max(lastOutboundAt, lastInboundAt) — the last time ANYONE spoke. */
  lastTouchIso: string;
  silentHours: number;
  lastOutboundAt: string | null;
  lastInboundAt: string | null;
  /** When the acceptance was recorded, IF the record carries that stamp
   *  (Reply_Classified_At on an acceptance). Null otherwise — there is no
   *  status-change date field to fall back on, and inventing one would put a
   *  fabricated date on the operator's phone. */
  acceptedAtIso: string | null;
}

export interface AcceptedSilenceScan {
  /** Due for a page, OLDEST SILENCE FIRST (the cap per run bites the tail). */
  due: SilentAcceptedOffer[];
  /** Accepted + unexecuted but with no contact timestamps at all. */
  unmeasurable: Array<{ recordId: string; address: string }>;
  /** Skipped because the operator already tapped Pause. */
  held: Array<{ recordId: string; address: string; holdUntil: string | null }>;
}

export interface AcceptedSilenceOpts {
  silenceHours: number;
}

/**
 * Pure. Which accepted offers have gone quiet?
 *
 * Included when ALL of: Outreach_Status is exactly "Offer Accepted";
 * Contract_Executed_At is empty; the newest of Last_Outbound_At /
 * Last_Inbound_At is a real date STRICTLY older than silenceHours.
 */
export function findSilentAcceptedOffers(
  listings: Listing[],
  now: Date,
  opts: AcceptedSilenceOpts = { silenceHours: 48 },
): AcceptedSilenceScan {
  const nowMs = now.getTime();
  const todayUtc = new Date(nowMs).toISOString().slice(0, 10);
  const thresholdHours =
    Number.isFinite(opts.silenceHours) && opts.silenceHours > 0 ? opts.silenceHours : 48;

  const due: SilentAcceptedOffer[] = [];
  const unmeasurable: AcceptedSilenceScan["unmeasurable"] = [];
  const held: AcceptedSilenceScan["held"] = [];

  for (const l of listings) {
    if ((l.outreachStatus ?? "").trim() !== "Offer Accepted") continue;
    // An executed contract means the deal moved on — the back-half deadline
    // watchers (option-tripwire, contract-watch) own it from there.
    if ((l.contractExecutedAt ?? "").trim() !== "") continue;

    const address = l.address || l.id;

    // A Pause tap must actually pause. Today counts as still held.
    const holdUntil = (l.actionHoldUntil ?? "").trim() || null;
    if (l.actionCardState === "Held" && holdUntil && holdUntil.slice(0, 10) >= todayUtc) {
      held.push({ recordId: l.id, address, holdUntil });
      continue;
    }

    const outMs = parseIso(l.lastOutboundAt);
    const inMs = parseIso(l.lastInboundAt);
    if (outMs === null && inMs === null) {
      unmeasurable.push({ recordId: l.id, address });
      continue;
    }

    const lastTouchMs = Math.max(outMs ?? -Infinity, inMs ?? -Infinity);
    const silentHours = (nowMs - lastTouchMs) / HOUR_MS;
    // STRICTLY older: at exactly the threshold the deal is not yet late.
    if (!(silentHours > thresholdHours)) continue;

    due.push({
      recordId: l.id,
      address,
      agentName: l.agentName ?? null,
      acceptedPrice: l.contractOfferPrice ?? l.outreachOfferPrice ?? null,
      lastTouchIso: new Date(lastTouchMs).toISOString(),
      silentHours: Math.round(silentHours),
      lastOutboundAt: l.lastOutboundAt ?? null,
      lastInboundAt: l.lastInboundAt ?? null,
      acceptedAtIso:
        (l.replyClassification ?? "") === "acceptance" ? (l.replyClassifiedAt ?? null) : null,
    });
  }

  // Oldest silence first: the run cap should spend its two pages on the two
  // deals that have been rotting longest, not on whatever Airtable returned first.
  due.sort((a, b) => b.silentHours - a.silentHours);
  return { due, unmeasurable, held };
}

/** The literal prefix the hourly triage routine treats as the operator's own
 *  word (see lib/reply-alert.ts for the full rationale). Do not reword. */
const RULING_PREFIX = "OPERATOR RULING via card";

/** EMD doctrine, quoted on the card so a re-negotiation tap cannot be read as
 *  permission to raise the deposit (INVARIANTS: $1,000 per contract, $3,000 cap
 *  across executed contracts). */
const EMD_CAP_LINE = "Executed EMD cap is $3,000 across executed contracts.";

export interface AcceptedSilenceCard {
  title: string;
  context: string[];
  options: CardOption[];
}

/** Pure: the card an operator sees after tapping the STALLED text. Three taps —
 *  nudge, re-open terms, walk — all inside the card action allowlist, none of
 *  which sends anything by itself. */
export function composeAcceptedSilenceCard(
  item: SilentAcceptedOffer,
  todayIso: string,
): AcceptedSilenceCard {
  const date = todayIso.slice(0, 10);
  const addr = shortAddress(item.address);
  const days = Math.round(item.silentHours / 24);
  const recordId = item.recordId;
  const table = "listings" as const;

  const context: string[] = [];
  if (item.acceptedPrice != null) context.push(`Accepted at ${usd(item.acceptedPrice)}.`);
  context.push(item.agentName ? `Agent: ${item.agentName}.` : "Agent: not on the record.");
  context.push(`Last outbound: ${dateOnly(item.lastOutboundAt) ?? "none recorded"}.`);
  context.push(`Last inbound: ${dateOnly(item.lastInboundAt) ?? "none recorded"}.`);
  context.push(EMD_CAP_LINE);

  return {
    title: `${addr}: offer accepted, silent ${days}d, no executed contract`,
    context,
    options: [
      {
        key: "nudge",
        label: "Nudge: status check",
        style: "primary",
        action: {
          type: "append_note",
          recordId,
          table,
          note: `${RULING_PREFIX} ${date}: NUDGE - send the agent a one-line status check on the accepted offer. Tier C cleared by operator tap.`,
        },
        confirmation: "Ruling recorded. Maverick sends a one-line status check on the accepted offer.",
      },
      {
        key: "reopen",
        label: "Re-open terms",
        style: "secondary",
        action: {
          type: "append_note",
          recordId,
          table,
          note: `${RULING_PREFIX} ${date}: RENEGOTIATE - Maverick drafts revised terms (EMD inside the $3,000 executed cap, inspection period) for operator review before anything is sent.`,
        },
        confirmation: "Ruling recorded. Maverick drafts revised terms for your review before anything is sent.",
      },
      {
        key: "walk",
        label: "Walk away",
        style: "danger",
        action: { type: "mark_dead", recordId, table },
        confirmation: "Marked dead. Nothing more goes to this agent.",
      },
    ],
  };
}

/** Pure: the SMS headline. The days-since-acceptance clause appears ONLY when
 *  the record carries a real acceptance stamp, and the price ONLY when the
 *  record carries a number — no clause is worth a fabricated fact. */
export function composeAcceptedSilenceHeadline(item: SilentAcceptedOffer, now: Date): string {
  const addr = shortAddress(item.address);
  const acceptedMs = parseIso(item.acceptedAtIso);
  const agoDays = acceptedMs === null ? null : Math.round((now.getTime() - acceptedMs) / DAY_MS);
  const accepted = [
    "Offer accepted",
    agoDays !== null ? `${agoDays}d ago` : null,
    item.acceptedPrice != null ? `at ${usd(item.acceptedPrice)}` : null,
  ]
    .filter(Boolean)
    .join(" ");
  return `STALLED: ${addr}. ${accepted}, silent ${item.silentHours}h, no executed contract.`;
}

/** KV dedupe key: one page per record per UTC day. */
export function acceptedSilenceKey(dayBucket: string, recordId: string): string {
  return `accepted-silence:${dayBucket}:${recordId}`;
}
