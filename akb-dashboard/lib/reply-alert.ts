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
    case "disclosure_step": return "Compliance disclosure — needs you personally";
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

/** Pure: compose the alert SMS. NEVER includes the inbound text. */
export function buildReplyAlertBody(input: ReplyAlertInput): { body: string; priceGap: boolean } {
  const addr = shortAddress(input.address);
  const link = `${DASHBOARD_BASE_URL}/pipeline/${encodeURIComponent(input.recordId)}`;
  if (input.tier === "tier_2_urgent") {
    return { body: `ACT NOW: ${addr}. ${alertAction(input.classification)}. ${link}`, priceGap: false };
  }
  const rec = alertRecommendation(input);
  // SCOPE LINE (2175 W 106th, 2026-08-08): when the inbound named a
  // condition, show what that scope does to the ceiling — the hand math the
  // operator otherwise asks for in chat. Computed number, never the inbound
  // text; the number rides the ALERT, never a draft (guardrail G1).
  const s = input.scope;
  const scopeLine =
    s && s.ceiling != null && s.scopeRehab != null
      ? ` Agent scope ~${s.tier}: rehab ${usd(s.scopeRehab)}${s.storedRehab != null ? ` (filed ${usd(s.storedRehab)})` : ""} → ceiling ${usd(s.ceiling)}.`
      : "";
  return {
    body: `DECISION NEEDED: ${addr}. ${alertAction(input.classification)}. Recommend: ${rec.text}.${scopeLine} ${link}`,
    priceGap: rec.priceGap,
  };
}

/** Best-effort SMS via Quo to ALERT_PHONE. Never throws. Tier 0 is a no-op
 *  by contract (the caller shouldn't route it here; double-guarded anyway).
 *
 *  CHANNEL SEPARATION (operator 2026-06-10): operator alerts send FROM the
 *  dedicated Maverick line (ALERT_FROM env — Quo inbox PNMhSUQXFw,
 *  +16302505865), NEVER from the agent-facing outreach line. When
 *  ALERT_FROM is unset the alert REFUSES (audited) rather than fall back
 *  to the outreach line — the hard rule beats delivery. */
export async function sendReplyAlert(input: ReplyAlertInput): Promise<ReplyAlertResult> {
  if (input.tier === "tier_0_auto_close") {
    return { sent: false, reason: "tier_0_no_alert", priceGap: false };
  }
  const to = (process.env.ALERT_PHONE ?? "").trim();
  if (!to) {
    await audit({
      agent: "crier",
      event: "reply_alert_skipped",
      status: "uncertain",
      recordId: input.recordId,
      inputSummary: { reason: "ALERT_PHONE not set", tier: input.tier },
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
      recordId: input.recordId,
      inputSummary: { reason: "ALERT_FROM not set — refusing to send from the agent-facing outreach line (channel separation)", tier: input.tier },
      outputSummary: { sent: false },
    });
    return { sent: false, reason: "alert_from_not_set", priceGap: false };
  }
  const { body, priceGap } = buildReplyAlertBody(input);
  try {
    await sendMessage(to, body, { from });
    await audit({
      agent: "crier",
      event: "reply_alert_sent",
      status: "confirmed_success",
      recordId: input.recordId,
      inputSummary: {
        to_masked: `${to.slice(0, 4)}…${to.slice(-4)}`,
        tier: input.tier,
        classification: input.classification,
        body_len: body.length,
        // Surface the null-price gap per the approved ruling — the SMS said
        // "hold sticky opener" because the record's opener/MAO were missing.
        price_gap: priceGap,
      },
      outputSummary: { sent: true },
    });
    return { sent: true, reason: null, priceGap };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await audit({
      agent: "crier",
      event: "reply_alert_failed",
      status: "confirmed_failure",
      recordId: input.recordId,
      inputSummary: { to_masked: `${to.slice(0, 4)}…${to.slice(-4)}`, tier: input.tier },
      outputSummary: { sent: false, error: reason.slice(0, 200) },
    });
    return { sent: false, reason: reason.slice(0, 200), priceGap };
  }
}
