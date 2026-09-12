// Page the operator with a Decision Card — the FIRST PRODUCER shared helper.
// @agent: maverick
//
// The Decision Card channel (lib/maverick/decision-card.ts, app/api/maverick/
// card, app/api/maverick/act, app/a/[token]) shipped with ZERO producers: no
// `decision_card_created` audit row had ever fired, so the one-tap surface
// existed and nothing ever pointed at it. Every operator-facing text this
// system sends still ended at a dashboard link behind a password — a laptop
// trip, which is the exact round trip the card channel exists to delete.
//
// This is the one place that closes that loop: mint a card in KV, put its URL
// in a GSM-7 SMS, send it FROM the Maverick line, audit both halves. Producers
// (reply alerts, the accepted-offer silence watchdog, anything next) call this
// and describe WHAT the decision is; they never touch KV, Quo, or the SMS
// budget themselves.
//
// THREE DOCTRINES ARE PHYSICAL HERE, not commentary:
//
//  1. FAIL CLOSED. Every option's action.type must pass isAllowedCardAction
//     BEFORE anything is minted. A card whose option cannot execute is worse
//     than no card: the operator taps, nothing happens, and he stops trusting
//     the channel. Refusal is audited and returns a reason; it never throws.
//  2. CHANNEL SEPARATION (operator 2026-06-10). Operator sends go FROM the
//     dedicated Maverick line (ALERT_FROM). When ALERT_FROM is unset we REFUSE
//     rather than fall back to the agent-facing outreach line — the hard rule
//     beats delivery, and we don't even mint the card, because a card nobody
//     will be told about is just KV litter.
//  3. ANTI-STALENESS. Cards carry a TTL (default 24h, clamped 1..168). A card
//     that outlives its relevance is worse than no card.
//
// NEVER THROWS. A producer is usually a cron loop over records; one bad
// candidate must not stop the rest. Every failure comes back as
// { sent:false, reason }.

import { audit } from "@/lib/audit-log";
import { sendMessage } from "@/lib/quo";
import { generateOpaqueToken } from "@/lib/maverick/oauth/crypto";
import { kvConfigured, kvProd, type KvClient } from "@/lib/maverick/oauth/kv";
import {
  cardUrl,
  isAllowedCardAction,
  putCard,
  resolveBaseUrl,
  type BaseUrlEnv,
  type CardOption,
  type DecisionCard,
} from "@/lib/maverick/decision-card";
import { normalizeForGsm7 } from "@/lib/sms/gsm7";
import { trimAtWord } from "@/lib/maverick/sms-escalation";

// ───────────────────── constants ─────────────────────

const DEFAULT_TTL_HOURS = 24;
const MIN_TTL_HOURS = 1;
const MAX_TTL_HOURS = 168; // 7 days — same clamp as app/api/maverick/card

/** Same budget as formatStage4Message: ~2 GSM-7 segments of headroom. */
const SMS_MAX_LEN = 300;
/** A card link is only worth carrying if the message can still say WHY it was
 *  sent. Below this many characters of headline the alert reads as a bare link
 *  — i.e. phishing, on a phone — so the link is DROPPED instead. */
const MIN_HEADLINE_CHARS = 40;

/** Alex's personal cell (operator-confirmed 2026-06-30, see
 *  lib/maverick/sms-escalation.ts). NOT a Quo number. Last-resort default so
 *  an env drift cannot silently swallow a deal-actionable page. */
const DEFAULT_OPERATOR_PHONE = "+16302172539";

// ───────────────────── types ─────────────────────

export interface OperatorPageInput {
  /** Card headline — what happened, with the money in it. */
  title: string;
  /** Evidence lines rendered on the card page. */
  context: string[];
  /** 1-3 PRE-DECLARED options. Every action.type must be allowlisted. */
  options: CardOption[];
  /** Card life in hours. Default 24, clamped to [1, 168]. */
  ttlHours?: number;
  /** The text that reaches the phone. The card URL is appended by us. */
  sms: { headline: string; reason?: string };
  /** Audit attribution: the producer's agent + event name. */
  audit: { agent: string; event: string; recordId?: string };
  /** Used as the SMS link when no card could be minted (KV unconfigured or a
   *  KV write failure). Typically the password-gated pipeline link — worse
   *  than a card, far better than no link at all. */
  fallbackLink?: string | null;
}

export interface OperatorPageDeps {
  /** Omit for the real client (kvProd when configured). Pass null to force
   *  the no-KV path. */
  kv?: KvClient | null;
  send?: (to: string, body: string, opts?: { from?: string }) => Promise<unknown>;
  env?: Record<string, string | undefined>;
  now?: Date;
}

export interface OperatorPageResult {
  sent: boolean;
  /** Null on success; otherwise why nothing (or nothing useful) happened. */
  reason: string | null;
  /** The minted card token, or null when no card exists. */
  token: string | null;
  /** The absolute card URL, or null (no card / no base URL configured). */
  cardUrl: string | null;
  /** Exactly what was (or would have been) sent. */
  body: string;
}

// ───────────────────── pure composition ─────────────────────

/**
 * Compose the operator page SMS. Pure.
 *
 * Budgeting order is deliberate and matches formatStage4Message: the URL is
 * budgeted FIRST and kept only if it fits WHOLE and still leaves
 * MIN_HEADLINE_CHARS of headline. A trimmed sentence still informs; a trimmed
 * URL is garbage that costs a laptop trip. Everything is normalized for GSM-7
 * — one em-dash or curly quote flips the whole message to UCS-2, halving the
 * per-segment budget and doubling the bill (lib/sms/gsm7).
 */
export function composeOperatorPageSms(
  headline: string,
  reason?: string | null,
  url?: string | null,
): string {
  const link = url ? normalizeForGsm7(url.trim()) : "";
  const urlOverhead =
    link && link.length + 1 + MIN_HEADLINE_CHARS <= SMS_MAX_LEN ? link.length + 1 : 0;

  const head = trimAtWord(normalizeForGsm7(headline ?? ""), SMS_MAX_LEN - urlOverhead);
  const room = SMS_MAX_LEN - urlOverhead - head.length - 1; // -1 for the reason's newline
  const why = reason ? trimAtWord(normalizeForGsm7(reason), room) : "";

  const lines: string[] = [head];
  if (why) lines.push(why);
  if (urlOverhead > 0) lines.push(link);
  return lines.join("\n");
}

export function clampTtlHours(raw: number | undefined): number {
  const n = typeof raw === "number" && Number.isFinite(raw) ? raw : DEFAULT_TTL_HOURS;
  return Math.min(Math.max(n, MIN_TTL_HOURS), MAX_TTL_HOURS);
}

/** Recipient waterfall. ALERT_PHONE is the operator-owned alert destination;
 *  the personal-phone and Stage-4 vars are the other two places the operator's
 *  number is already configured; the cell is the operator-confirmed default. */
export function resolveOperatorPhone(env: Record<string, string | undefined>): string {
  const candidates = [
    env.ALERT_PHONE,
    env.OPERATOR_PERSONAL_PHONE,
    env.MAVERICK_STAGE4_SMS_TARGET,
    DEFAULT_OPERATOR_PHONE,
  ];
  for (const c of candidates) {
    const v = (c ?? "").trim();
    if (v) return v;
  }
  return DEFAULT_OPERATOR_PHONE;
}

function mask(phone: string): string {
  return phone.length <= 8 ? "***" : `${phone.slice(0, 4)}...${phone.slice(-4)}`;
}

// ───────────────────── the producer entry point ─────────────────────

/**
 * Mint a Decision Card and text the operator a link to it. Never throws.
 *
 * Sequence (order matters — each step fails closed before the next spends
 * anything): validate the options → resolve the sender (refuse if the Maverick
 * line is unset) → mint the card → build the URL → compose the SMS → send →
 * audit `decision_card_created` + the producer's own event.
 */
export async function pageOperatorWithCard(
  input: OperatorPageInput,
  deps: OperatorPageDeps = {},
): Promise<OperatorPageResult> {
  const env = deps.env ?? (process.env as Record<string, string | undefined>);
  const now = deps.now ?? new Date();
  const send = deps.send ?? sendMessage;
  const headline = input.sms.headline;
  const reason = input.sms.reason ?? null;

  const producerAudit = async (
    status: "confirmed_success" | "confirmed_failure" | "uncertain",
    outputSummary: Record<string, unknown>,
    extra: { error?: string } = {},
  ) => {
    await audit({
      agent: input.audit.agent,
      event: input.audit.event,
      status,
      recordId: input.audit.recordId,
      inputSummary: { producer: input.audit.event, headline_len: headline.length },
      outputSummary,
      ...extra,
    }).catch(() => {});
  };

  // ── 1. FAIL CLOSED on the options. Never mint a card whose tap is a no-op.
  const bad = input.options.filter((o) => !isAllowedCardAction(o.action?.type ?? ""));
  const countBad = input.options.length < 1 || input.options.length > 3;
  if (countBad || bad.length > 0) {
    const refusal = bad.length > 0 ? "disallowed_action" : "invalid_option_count";
    const body = composeOperatorPageSms(headline, reason, input.fallbackLink ?? null);
    await producerAudit("uncertain", {
      sent: false,
      reason: refusal,
      rejected: bad.map((o) => o.action?.type ?? "(missing)"),
      option_count: input.options.length,
      card_url_present: false,
    });
    return { sent: false, reason: refusal, token: null, cardUrl: null, body };
  }

  // ── 2. CHANNEL SEPARATION. The Maverick line or nothing — and no card,
  // because a card the operator is never told about is KV litter.
  const from = (env.ALERT_FROM ?? "").trim();
  if (!from) {
    const body = composeOperatorPageSms(headline, reason, input.fallbackLink ?? null);
    await producerAudit("uncertain", {
      sent: false,
      reason: "alert_from_not_set",
      detail:
        "ALERT_FROM not set - refusing to send from the agent-facing outreach line (channel separation)",
      card_url_present: false,
    });
    return { sent: false, reason: "alert_from_not_set", token: null, cardUrl: null, body };
  }

  // ── 3. Mint the card (when KV is available). No KV → no card, and the SMS
  // falls back to whatever link the producer supplied.
  const kv = deps.kv === undefined ? (kvConfigured() ? kvProd : null) : deps.kv;
  const ttlHours = clampTtlHours(input.ttlHours);
  let token: string | null = null;
  if (kv) {
    const nowIso = now.toISOString();
    const candidate = generateOpaqueToken("");
    const card: DecisionCard = {
      token: candidate,
      title: input.title,
      context: input.context,
      options: input.options,
      createdAt: nowIso,
      expiresAt: new Date(now.getTime() + ttlHours * 3_600_000).toISOString(),
    };
    try {
      await putCard(kv, card, nowIso);
      token = candidate;
    } catch (err) {
      // A card we could not store must never be linked — the tap would 404.
      console.error("[operator-page] card write failed, sending without a card link:", err);
      token = null;
    }
  }

  // ── 4. URL. No base URL configured → omit the link rather than send a
  // broken one (resolveBaseUrl returns null and says so).
  const base = resolveBaseUrl(env as BaseUrlEnv);
  const url = token && base ? cardUrl(token, base) : null;
  const link = url ?? input.fallbackLink ?? null;
  const body = composeOperatorPageSms(headline, reason, link);

  if (token) {
    // Mirrors app/api/maverick/card/route.ts so the two producers of this
    // event row are indistinguishable downstream.
    await audit({
      agent: "maverick",
      event: "decision_card_created",
      status: "confirmed_success",
      recordId: input.audit.recordId,
      inputSummary: {
        producer: input.audit.event,
        options: input.options.map((o) => o.action.type),
        ttl_hours: ttlHours,
      },
      outputSummary: { token, has_url: url !== null },
      decision: "decision_card_created",
    }).catch(() => {});
  }

  // ── 5. Send.
  const to = resolveOperatorPhone(env);
  try {
    await send(to, body, { from });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await producerAudit(
      "confirmed_failure",
      { sent: false, card_url_present: url !== null, to_masked: mask(to) },
      { error: msg.slice(0, 300) },
    );
    return { sent: false, reason: msg.slice(0, 200), token, cardUrl: url, body };
  }

  await producerAudit("confirmed_success", {
    sent: true,
    card_url_present: url !== null,
    to_masked: mask(to),
  });
  return { sent: true, reason: null, token, cardUrl: url, body };
}
