// Maverick Decision Cards — the "text is the control surface" channel.
// @agent: maverick
//
// Layer 1 (SMS escalation) gets a Tier-1/2/3 alert into Alex's pocket. But a
// text is a dead end: to act on it he has to find a laptop, log into the
// dashboard, find the record, and click. That round trip is why work stalls
// for days. This module makes the text itself actionable: the alert carries
// a short link (cardUrl); the link opens a one-screen card with 2-3 buttons
// Maverick already picked; one tap executes and the page confirms.
//
// THE SECURITY PROPERTY THAT MAKES THIS SAFE: the URL token is a bearer
// credential (same model as a password-reset link) — anyone who has it can
// redeem the card. That is only acceptable because the token does NOT
// authorize an arbitrary action. It authorizes CHOOSING AMONG OPTIONS
// MAVERICK ALREADY DECLARED when it created the card. The redeem route
// (app/api/maverick/act/route.ts) takes a token and an option KEY off the
// request; it looks the option up in the STORED card and executes the
// action that was baked in at creation time. Nothing the URL visitor
// supplies — not the action type, not the record id, not a note — reaches
// the action executor. If it isn't already sitting in the card's options
// array, it doesn't happen.
//
// Storage: one KV key per card, TTL'd to expiresAt (anti-staleness doctrine
// — CLAUDE.md — a card that outlives its relevance is worse than no card).
// Pure model + ranking-free helpers here; IO takes KvClient as a parameter
// (never a singleton) so it stays testable without touching real KV.

import type { KvClient } from "@/lib/maverick/oauth/kv";

export interface CardOption {
  /** Stable key, e.g. "accept" | "counter" | "dead". Matched EXACTLY on redeem. */
  key: string;
  /** Button label the operator reads, e.g. "Mark dead". */
  label: string;
  /** Visual weight. "primary" = the recommended move, "danger" = destructive. */
  style: "primary" | "secondary" | "danger";
  /** The PRE-DECLARED action. Executed verbatim; never merged with request input. */
  action: {
    /** Must be a key of HANDLERS in app/api/actions/[type]/route.ts. */
    type: string;
    recordId: string;
    table?: "listings" | "deals";
    until?: string;
    note?: string;
  };
  /** Plain-English confirmation shown after the tap, e.g. "Marked dead. Nothing more will go to this agent." */
  confirmation: string;
}

export interface DecisionCard {
  /** The URL token — 43 base64url chars from generateOpaqueToken. */
  token: string;
  /** Headline: what happened, with the money in it. */
  title: string;
  /** Evidence lines rendered as a list — comps, the thread tail, the numbers. */
  context: string[];
  options: CardOption[];
  createdAt: string; // ISO
  expiresAt: string; // ISO — REQUIRED, see anti-staleness doctrine in CLAUDE.md
  /** Set when redeemed. A card is single-use. */
  redeemedAt?: string;
  redeemedOptionKey?: string;
}

export const CARD_KV_PREFIX = "maverick:card:";
const CLAIM_KV_SUFFIX = ":claim";

function cardKey(token: string): string {
  return `${CARD_KV_PREFIX}${token}`;
}

function claimKey(token: string): string {
  return `${cardKey(token)}${CLAIM_KV_SUFFIX}`;
}

/** The allowlisted card action types — kept here so both the create route
 *  (validation) and its test share one source of truth. `sign_contract` and
 *  `walk_away` are deliberately excluded: they move money or kill a deal and
 *  stay laptop-only for now. */
const ALLOWED_CARD_ACTION_TYPES = new Set([
  "mark_dead",
  "hold",
  "clear",
  "append_note",
  "send_buyer_blast",
]);

export function isAllowedCardAction(type: string): boolean {
  return ALLOWED_CARD_ACTION_TYPES.has(type);
}

// ── Pure model ───────────────────────────────────────────────────────

/** Can this card still be redeemed, right now? Pure — takes "now" as an ISO
 *  string so tests don't fight the clock. */
export function isRedeemable(
  card: DecisionCard,
  nowIso: string,
): { ok: true } | { ok: false; reason: "expired" | "already_used" } {
  if (card.redeemedAt) return { ok: false, reason: "already_used" };
  const exp = new Date(card.expiresAt).getTime();
  if (!Number.isFinite(exp) || exp <= new Date(nowIso).getTime()) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true };
}

/** Exact match only — never fuzzy, never prefix, never case-insensitive.
 *  The option key is the entire trust boundary between "what the URL
 *  visitor tapped" and "what gets executed"; a loose match here is a
 *  privilege-escalation bug waiting to happen. */
export function findOption(card: DecisionCard, key: string): CardOption | null {
  return card.options.find((o) => o.key === key) ?? null;
}

/** The short link Maverick puts in the SMS. */
export function cardUrl(token: string, baseUrl: string): string {
  return `${baseUrl}/a/${token}`;
}

/** Null when no origin is configured — callers must then OMIT the link
 *  rather than send a broken one. Order: an explicit DASHBOARD_BASE_URL
 *  wins (trimmed, trailing slash stripped); otherwise fall back to
 *  whichever Vercel-provided host is live for this deployment. */
export interface BaseUrlEnv {
  DASHBOARD_BASE_URL?: string;
  VERCEL_PROJECT_PRODUCTION_URL?: string;
  VERCEL_URL?: string;
  [key: string]: string | undefined;
}

export function resolveBaseUrl(env: BaseUrlEnv = process.env): string | null {
  const explicit = env.DASHBOARD_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const prodHost = env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (prodHost) return `https://${prodHost}`;
  const previewHost = env.VERCEL_URL?.trim();
  if (previewHost) return `https://${previewHost}`;
  return null;
}

// ── IO (KV) ──────────────────────────────────────────────────────────

const MIN_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 7 * 24 * 3600;

/** TTL derived from expiresAt, clamped to [60s, 7 days] so a mistyped or
 *  already-past expiresAt can't produce a KV write with a zero/negative or
 *  absurdly long TTL. `nowIso` defaults to the real clock; redeemCard passes
 *  its own `nowIso` through so a single redeem sees one consistent "now". */
function ttlSecondsFor(expiresAt: string, nowIso: string = new Date().toISOString()): number {
  const ms = new Date(expiresAt).getTime() - new Date(nowIso).getTime();
  const raw = Math.round(ms / 1000);
  return Math.min(Math.max(raw, MIN_TTL_SECONDS), MAX_TTL_SECONDS);
}

export async function putCard(kv: KvClient, card: DecisionCard, nowIso?: string): Promise<void> {
  const ttl = ttlSecondsFor(card.expiresAt, nowIso);
  await kv.setEx(cardKey(card.token), JSON.stringify(card), ttl);
}

/** Returns null on missing OR unparseable JSON — never throws. A corrupt
 *  card should read as "not found", not crash the redeem/view path. */
export async function getCard(kv: KvClient, token: string): Promise<DecisionCard | null> {
  const raw = await kv.get(cardKey(token));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed as DecisionCard;
  } catch {
    return null;
  }
}

export type RedeemResult =
  | { ok: true; card: DecisionCard; option: CardOption }
  | { ok: false; reason: "not_found" | "expired" | "already_used" | "unknown_option" };

/**
 * Redeem a card: validate, claim single-use, execute nothing itself (the
 * caller executes option.action) — this just marks the card spent and
 * hands back which option won.
 *
 * Single-use is enforced with kv.setNx on a SEPARATE claim key rather than
 * a read-then-write on the card itself, because the realistic failure here
 * is a double-tap on a flaky mobile connection racing two requests, not an
 * attacker — setNx makes exactly one of them win atomically. The loser
 * reports "already_used", which is also the truthful state a split second
 * later regardless.
 */
export async function redeemCard(
  kv: KvClient,
  token: string,
  optionKey: string,
  nowIso: string,
): Promise<RedeemResult> {
  const card = await getCard(kv, token);
  if (!card) return { ok: false, reason: "not_found" };

  const redeemable = isRedeemable(card, nowIso);
  if (!redeemable.ok) return { ok: false, reason: redeemable.reason };

  const option = findOption(card, optionKey);
  if (!option) return { ok: false, reason: "unknown_option" };

  // Win the race before touching anything else. TTL matches the card's own
  // remaining life — the claim never needs to outlive the card it guards.
  const claimTtl = ttlSecondsFor(card.expiresAt, nowIso);
  const won = await kv.setNx(claimKey(token), nowIso, claimTtl);
  if (!won) return { ok: false, reason: "already_used" };

  const redeemed: DecisionCard = { ...card, redeemedAt: nowIso, redeemedOptionKey: optionKey };
  await putCard(kv, redeemed, nowIso);

  return { ok: true, card: redeemed, option };
}
