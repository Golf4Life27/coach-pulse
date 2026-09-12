// Reply alerting — tiered SMS-via-Quo to the operator. @agent: crier
//
// Operator policy (2026-06-10, supersedes the v1 hook): Alex already gets a
// Quo app notification for EVERY inbound. This channel is reserved for
// decisions and urgency — it carries only what Quo can't: the decision
// needed, the recommendation, the deadline. STANDING RULE: the alert body
// NEVER includes the inbound text.
//
//   tier_0_auto_close — NO ALERT (lib/auto-close.ts handles the thread).
//   tier_1_decision   — "DECISION NEEDED: <address>. <action>.
//                        Recommend: <recommendation>. <queue link>"
//   tier_2_urgent     — "ACT NOW: <address>. <action>. <queue link>"
//
// Numbers in a Tier 1/2 alert are fine (it goes to Alex, not a seller) but
// they are never fabricated: when the sticky opener or the MAO is missing
// on the record, the recommendation falls back to "hold sticky opener" and
// the gap is surfaced in the audit row.
//
// Destination: ALERT_PHONE env var (operator-owned, set in Vercel). When
// unset, the alert is a no-op + an audit row so the gap is observable.

import { sendMessage } from "@/lib/quo";
import { audit } from "@/lib/audit-log";
import type { AlertTier, ReplyClassification } from "@/lib/reply-triage";
import type { CardOption } from "@/lib/maverick/decision-card";
import { pageOperatorWithCard } from "@/lib/maverick/operator-page";

const DASHBOARD_BASE_URL =
  process.env.DASHBOARD_BASE_URL ??
  (process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : "https://coach-pulse-ten.vercel.app");

export interface ReplyAlertInput {
  recordId: string;
  address: string | null;
  tier: AlertTier;
  classification: ReplyClassification;
  /** Sticky opener captured at send time (Outreach_Offer_Price). */
  outreachOfferPrice?: number | null;
  /** Underwritten MAO ceiling on the record. */
  underwrittenMao?: number | null;
  /** SCOPE INTEL (lib/reply/scope-intel): the agent's own condition language,
   *  re-priced. Rides the ALERT only — guardrail G1 bars any recomputed
   *  number from an outbound draft. Null/omitted → no scope line. */
  scope?: {
    tier: string;
    scopeRehab: number | null;
    storedRehab: number | null;
    ceiling: number | null;
  } | null;
}

export interface ReplyAlertResult {
  sent: boolean;
  /** Why no send (e.g. "alert_phone_not_set" / "tier_0_no_alert" / error). */
  reason: string | null;
  /** True when the counter recommendation fell back because the sticky
   *  opener / MAO were missing on the record (gap audited, never invented). */
  priceGap: boolean;
}

/** Short address for SMS: "15864 Tracey St" from the full comma form. */
function shortAddress(address: string | null): string {
  if (!address) return "unknown address";
  return address.split(",")[0].trim() || address;
}

const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

/** Pure: the action line per classification.
 *
 *  EVERY classification the triage can PRODUCE needs a case here. `soft_no`
 *  had none and fell to the default, so a bare "No" — which classifyReply
 *  matches exactly, on a pattern commented "the shortest rejection there is" —
 *  paged the operator as "intent unclear" (2026-08-06, 257 Chalmers Dr NW and
 *  2241 1st St). The classifier was right, had already drafted the
 *  re-engagement, and the alert reported confusion anyway.
 *
 *  That is worse than a wrong label: it makes the operator distrust a
 *  component that is working. An alert must never claim less certainty than
 *  the system actually has. */
export function alertAction(classification: ReplyClassification): string {
  switch (classification) {
    case "acceptance": return "Seller said yes, draft contract";
    case "counter": return "Agent countered";
    case "interest": return "Agent is interested";
    case "rejection": return "Agent declined"; // not alerted (tier 0); label kept for completeness
    case "soft_no": return "Agent declined, re-engagement drafted";
    // The four below were ALSO falling through to "intent unclear" — and they
    // are the highest-intent replies the funnel produces. An agent proposing a
    // showing is the closest thing to a yes that exists before a contract, and
    // it paged as confusion.
    case "offer_format": return "Agent wants the offer in writing";
    case "appointment": return "Agent proposed a showing/call time";
    case "seller_costs": return "Agent asked who pays what";
    case "disclosure_step": return "Compliance disclosure - needs you personally";
    // The silent classes (2026-09-05) never reach an alert — scan-comms
    // `continue`s before the proposal — but the label must exist so a future
    // path that does page carries the truth, not "intent unclear".
    case "hostile": return "Hostile reply, parked silent";
    case "list_anchored": return "Agent anchored to list price, parked silent";
    case "flat_no": return "Agent declined flat, parked silent";
    case "auto_reply": return "Auto-responder, ignored";
    case "identity_question": return "Agent asked who we are (wholesaler/assign)";
    case "agent_redirect": return "Wrong contact, agent named who handles it";
    case "unknown": return "Agent replied, intent unclear";
    default: {
      // Exhaustiveness: a NEW classification added to the union lands here at
      // COMPILE time, not as a mystery SMS at 2pm.
      const _exhaustive: never = classification;
      void _exhaustive;
      return "Agent replied, intent unclear";
    }
  }
}

/** Pure: recommendation line + whether the numbers were missing. Never
 *  fabricates: counter falls back to "hold sticky opener" when the record's
 *  opener/MAO aren't populated. */
export function alertRecommendation(input: ReplyAlertInput): { text: string; priceGap: boolean } {
  if (input.classification === "counter") {
    const opener = input.outreachOfferPrice;
    const mao = input.underwrittenMao;
    if (typeof opener === "number" && opener > 0 && typeof mao === "number" && mao > 0) {
      return { text: `hold at ${usd(opener)} (MAO ${usd(mao)})`, priceGap: false };
    }
    return { text: "hold sticky opener", priceGap: true };
  }
  if (input.classification === "interest") return { text: "advance to offer or DD", priceGap: false };
  return { text: "operator review", priceGap: false };
}

/** The password-gated dashboard link. Kept as the FALLBACK only: it is a
 *  laptop trip, which is the round trip the Decision Card channel exists to
 *  delete (see cardOptionsForReply below). */
export function pipelineLink(recordId: string): string {
  return `${DASHBOARD_BASE_URL}/pipeline/${encodeURIComponent(recordId)}`;
}

/** Pure: compose the alert SMS. NEVER includes the inbound text.
 *
 *  `link` is the trailing link: omitted (undefined) it defaults to the
 *  password-gated pipeline link, which is what this alert carried for its
 *  whole life; `null` composes the body with NO link at all (that is the
 *  "headline" the Decision Card page sends, with the card URL appended by
 *  the pager); an explicit string substitutes that link instead — which is
 *  how the card URL replaces the laptop trip. */
export function buildReplyAlertBody(
  input: ReplyAlertInput,
  link: string | null = pipelineLink(input.recordId),
): { body: string; priceGap: boolean } {
  const addr = shortAddress(input.address);
  if (input.tier === "tier_2_urgent") {
    const head = `ACT NOW: ${addr}. ${alertAction(input.classification)}.`;
    return { body: link ? `${head} ${link}` : head, priceGap: false };
  }
  const rec = alertRecommendation(input);
  // SCOPE LINE (2175 W 106th, 2026-08-08): when the inbound named a
  // condition, show what that scope does to the ceiling — the hand math the
  // operator otherwise asks for in chat. Computed number, never the inbound
  // text; the number rides the ALERT, never a draft (guardrail G1).
  const s = input.scope;
  const scopeLine =
    s && s.ceiling != null && s.scopeRehab != null
      ? ` Agent scope ~${s.tier}: rehab ${usd(s.scopeRehab)}${s.storedRehab != null ? ` (filed ${usd(s.storedRehab)})` : ""} -> ceiling ${usd(s.ceiling)}.`
      : "";
  const head = `DECISION NEEDED: ${addr}. ${alertAction(input.classification)}. Recommend: ${rec.text}.${scopeLine}`;
  return {
    body: link ? `${head} ${link}` : head,
    priceGap: rec.priceGap,
  };
}

// ── DECISION CARD OPTIONS (Build 1, 2026-09-12) ──────────────────────────
//
// The alert used to end at a password-gated pipeline link: Alex reads "Agent
// countered" on his phone, and then has to find a laptop, log in, find the
// record and click. That round trip is why a live negotiation sits for days.
// These are the three taps that delete it — Maverick pre-declares them, the
// card stores them, one tap executes (app/api/maverick/act).
//
// WHY THE NOTE PREFIX IS LITERAL AND LOAD-BEARING: an append_note tap does not
// itself send anything (no allowlisted card action does — see
// ALLOWED_CARD_ACTION_TYPES). It writes the operator's RULING into
// Verification_Notes, and the hourly triage routine is being taught to treat a
// note carrying exactly `OPERATOR RULING via card <YYYY-MM-DD>:` as the
// operator's explicit word — the Tier C authorization that a machine-derived
// number can never self-grant. Change the prefix and the ruling stops counting.
const RULING_PREFIX = "OPERATOR RULING via card";

/** UTC day arithmetic on a YYYY-MM-DD (or full ISO) date string. Pure.
 *  UTC deliberately: the `hold` handler validates `until` as YYYY-MM-DD and a
 *  local-time slip would silently hold for one day less than promised. */
function addDaysUtc(iso: string, days: number): string {
  const base = new Date(`${iso.slice(0, 10)}T00:00:00.000Z`);
  const t = base.getTime();
  if (!Number.isFinite(t)) return iso.slice(0, 10);
  return new Date(t + days * 86_400_000).toISOString().slice(0, 10);
}

/** Pure: the three pre-declared taps for a reply alert, keyed on the triage
 *  classification. Always EXACTLY three — a primary move, a 48-hour pause, and
 *  walk away — because the card renders at most three and an operator staring
 *  at a phone should not have to read a menu. Every action type is inside the
 *  card allowlist (append_note / hold / mark_dead); nothing here can move money
 *  or send a text on its own. */
export function cardOptionsForReply(input: ReplyAlertInput, todayIso: string): CardOption[] {
  const date = todayIso.slice(0, 10);
  const recordId = input.recordId;
  const table = "listings" as const;

  const pause: CardOption = {
    key: "pause",
    label: "Pause 48h",
    style: "secondary",
    action: { type: "hold", recordId, table, until: addDaysUtc(date, 2) },
    confirmation: "Held 48 hours. Nothing goes out until then.",
  };
  const walk: CardOption = {
    key: "walk",
    label: "Walk away",
    style: "danger",
    action: { type: "mark_dead", recordId, table },
    confirmation: "Marked dead. Nothing more goes to this agent.",
  };

  if (input.classification === "acceptance") {
    return [
      {
        key: "proceed",
        label: "Proceed: draft contract",
        style: "primary",
        action: {
          type: "append_note",
          recordId,
          table,
          note: `${RULING_PREFIX} ${date}: PROCEED - draft the contract at the accepted terms. Tier C cleared by operator tap.`,
        },
        confirmation: "Ruling recorded. Maverick drafts the contract at the accepted terms.",
      },
      pause,
      walk,
    ];
  }

  if (input.classification === "counter") {
    // NEVER fabricates a number: when the sticky opener is missing from the
    // record the ruling points at "the sticky opener on record" instead of
    // inventing one — same discipline as alertRecommendation's price gap.
    const opener = input.outreachOfferPrice;
    const known = typeof opener === "number" && Number.isFinite(opener) && opener > 0;
    return [
      {
        key: "hold_price",
        label: known ? `Hold at ${usd(opener as number)}` : "Hold sticky opener",
        style: "primary",
        action: {
          type: "append_note",
          recordId,
          table,
          note: known
            ? `${RULING_PREFIX} ${date}: HOLD at ${usd(opener as number)} - reply that we are firm at ${usd(opener as number)}. Tier C cleared by operator tap.`
            : `${RULING_PREFIX} ${date}: HOLD at the sticky opener on record - reply that we are firm at the number already sent, no new number. Tier C cleared by operator tap.`,
        },
        confirmation: known
          ? `Ruling recorded. Maverick replies firm at ${usd(opener as number)}.`
          : "Ruling recorded. Maverick replies firm at the opener already on record.",
      },
      pause,
      walk,
    ];
  }

  return [
    {
      key: "advance",
      label: "Advance",
      style: "primary",
      action: {
        type: "append_note",
        recordId,
        table,
        note: `${RULING_PREFIX} ${date}: ADVANCE - Maverick proceeds to the next step (written offer, showing, or answer) within doctrine, no new number without comp-level verification.`,
      },
      confirmation: "Ruling recorded. Maverick advances within doctrine, no new number.",
    },
    pause,
    walk,
  ];
}

/** Pure: the card's evidence lines. The full address (the SMS only carries the
 *  short form), what Maverick recommends, the numbers when the record has them,
 *  and the scope re-price when the inbound named a condition. Never the inbound
 *  text — the standing rule holds on the card too. */
function cardContextForReply(input: ReplyAlertInput): string[] {
  const lines: string[] = [];
  if (input.address) lines.push(input.address);
  lines.push(`Recommend: ${alertRecommendation(input).text}.`);
  const opener = input.outreachOfferPrice;
  const mao = input.underwrittenMao;
  if (typeof opener === "number" && opener > 0) {
    lines.push(
      typeof mao === "number" && mao > 0
        ? `Sticky opener ${usd(opener)}; underwritten MAO ${usd(mao)}.`
        : `Sticky opener ${usd(opener)}; no underwritten MAO on the record.`,
    );
  } else if (typeof mao === "number" && mao > 0) {
    lines.push(`Underwritten MAO ${usd(mao)}; no sticky opener on the record.`);
  }
  const s = input.scope;
  if (s && s.ceiling != null && s.scopeRehab != null) {
    lines.push(
      `Agent scope ~${s.tier}: rehab ${usd(s.scopeRehab)}${s.storedRehab != null ? ` (filed ${usd(s.storedRehab)})` : ""} -> ceiling ${usd(s.ceiling)}.`,
    );
  }
  return lines;
}

/** Shared skeleton: ALERT_PHONE/ALERT_FROM checks, the Quo send, and the
 *  audit trail — identical for every alert this module sends regardless of
 *  what built the body. Extracted so a differently-shaped alert (e.g. the
 *  dispo buyer-interest ping, which has no ReplyClassification to hang a
 *  body off) doesn't have to duplicate the channel-separation rule or the
 *  audit contract.
 *
 *  CHANNEL SEPARATION (operator 2026-06-10): operator alerts send FROM the
 *  dedicated Maverick line (ALERT_FROM env — Quo inbox PNMhSUQXFw,
 *  +16302505865), NEVER from the agent-facing outreach line. When
 *  ALERT_FROM is unset the alert REFUSES (audited) rather than fall back
 *  to the outreach line — the hard rule beats delivery. Never throws. */
/** The two channel preconditions, with their audits. Returns a refusal
 *  ReplyAlertResult when the alert must not send, or null when it may.
 *  Shared by the raw-SMS path and the Decision Card path so the
 *  observability of a missing env var is identical either way. */
async function guardAlertChannel(
  recordId: string,
  tier: AlertTier,
): Promise<ReplyAlertResult | null> {
  const to = (process.env.ALERT_PHONE ?? "").trim();
  if (!to) {
    await audit({
      agent: "crier",
      event: "reply_alert_skipped",
      status: "uncertain",
      recordId,
      inputSummary: { reason: "ALERT_PHONE not set", tier },
      outputSummary: { sent: false },
    });
    return { sent: false, reason: "alert_phone_not_set", priceGap: false };
  }
  const from = (process.env.ALERT_FROM ?? "").trim();
  if (!from) {
    await audit({
      agent: "crier",
      event: "reply_alert_skipped",
      status: "uncertain",
      recordId,
      inputSummary: { reason: "ALERT_FROM not set — refusing to send from the agent-facing outreach line (channel separation)", tier },
      outputSummary: { sent: false },
    });
    return { sent: false, reason: "alert_from_not_set", priceGap: false };
  }
  return null;
}

async function sendAlertSms(opts: {
  recordId: string;
  tier: AlertTier;
  classification: string;
  body: string;
  priceGap: boolean;
}): Promise<ReplyAlertResult> {
  const refusal = await guardAlertChannel(opts.recordId, opts.tier);
  if (refusal) return refusal;
  const to = (process.env.ALERT_PHONE ?? "").trim();
  const from = (process.env.ALERT_FROM ?? "").trim();
  try {
    await sendMessage(to, opts.body, { from });
    await audit({
      agent: "crier",
      event: "reply_alert_sent",
      status: "confirmed_success",
      recordId: opts.recordId,
      inputSummary: {
        to_masked: `${to.slice(0, 4)}…${to.slice(-4)}`,
        tier: opts.tier,
        classification: opts.classification,
        body_len: opts.body.length,
        // Surface the null-price gap per the approved ruling — the SMS said
        // "hold sticky opener" because the record's opener/MAO were missing.
        price_gap: opts.priceGap,
      },
      outputSummary: { sent: true },
    });
    return { sent: true, reason: null, priceGap: opts.priceGap };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await audit({
      agent: "crier",
      event: "reply_alert_failed",
      status: "confirmed_failure",
      recordId: opts.recordId,
      inputSummary: { to_masked: `${to.slice(0, 4)}…${to.slice(-4)}`, tier: opts.tier },
      outputSummary: { sent: false, error: reason.slice(0, 200) },
    });
    return { sent: false, reason: reason.slice(0, 200), priceGap: opts.priceGap };
  }
}

/**
 * Tier 1/2 reply alert — now a DECISION CARD page, not a dead-end text.
 *
 * The body is the same decision-first sentence it always was (never the inbound
 * text), minus the password-gated pipeline link: pageOperatorWithCard mints a
 * card carrying the three pre-declared taps and appends ITS url instead. When
 * KV is unavailable the card cannot exist, and the pipeline link rides along as
 * the fallback — the alert always goes out, it just costs a laptop trip again.
 *
 * ReplyAlertResult keeps its shape (sent / reason / priceGap): scan-comms and
 * the admin smoke route read it, and priceGap still comes from
 * buildReplyAlertBody, which is still the only thing that decides whether the
 * recommendation had real numbers behind it.
 */
export async function sendReplyAlert(input: ReplyAlertInput): Promise<ReplyAlertResult> {
  if (input.tier === "tier_0_auto_close") {
    return { sent: false, reason: "tier_0_no_alert", priceGap: false };
  }

  // Same preconditions, same audits as the raw-SMS path — the pager would also
  // refuse on ALERT_FROM, but reply_alert_skipped is the row the operator's
  // observability already watches, so it keeps firing from here.
  const refusal = await guardAlertChannel(input.recordId, input.tier);
  if (refusal) return refusal;

  // priceGap is decided by the body builder, exactly as before.
  const { priceGap } = buildReplyAlertBody(input);
  // The headline is the alert body with NO link; the card URL becomes the link.
  const headline = buildReplyAlertBody(input, null).body;
  const todayIso = new Date().toISOString().slice(0, 10);

  const paged = await pageOperatorWithCard({
    title: `${input.tier === "tier_2_urgent" ? "ACT NOW" : "DECISION NEEDED"}: ${shortAddress(input.address)}. ${alertAction(input.classification)}.`,
    context: cardContextForReply(input),
    options: cardOptionsForReply(input, todayIso),
    ttlHours: 48,
    sms: { headline },
    audit: { agent: "crier", event: "reply_alert_sent", recordId: input.recordId },
    fallbackLink: pipelineLink(input.recordId),
  });

  return { sent: paged.sent, reason: paged.reason, priceGap };
}

/** DISPO BUYER INTEREST alert (2026-09-07) — the buyer-reply twin of
 *  sendReplyAlert. A buyer reply has no ReplyClassification (that union is
 *  seller/agent-shaped) and its body doesn't fit alertAction/
 *  buildReplyAlertBody's decision-recommendation shape, so it composes its
 *  own tier_2_urgent body here instead of forcing a foreign classification
 *  through the seller path — but it goes out through the exact same
 *  ALERT_PHONE/ALERT_FROM/audit skeleton, so channel separation and the
 *  audit contract can't drift between the two lanes. Buyer interest is
 *  always urgent (a 10-day option period, one buyer at a time) — there is
 *  no tier_1 buyer alert. */
export async function sendBuyerReplyAlert(input: {
  recordId: string;
  address: string | null;
  buyerName: string;
  amountUsd: number | null;
  dealUrl: string;
}): Promise<ReplyAlertResult> {
  const addr = shortAddress(input.address);
  const amountPart = input.amountUsd != null ? usd(input.amountUsd) : "wants contract";
  const body = `ACT NOW (buyer): ${addr} - ${input.buyerName} ${amountPart}. ${input.dealUrl}`;
  return sendAlertSms({
    recordId: input.recordId,
    tier: "tier_2_urgent",
    classification: "buyer_interest",
    body,
    priceGap: false,
  });
}
