// THE SINGLE OUTBOUND SMS CHOKE POINT. @agent: crier
//
// WHY THIS EXISTS (consolidation, 2026-07-26): every send lane grew its own
// guards, and the bugs came from the seams between them —
//   · a duplicate outbound reply reached the same agent TWICE because two
//     same-phone listings each cleared their own per-RECORD idempotency claim
//     (record-level claims cannot see a number-level duplicate);
//   · the renovated-listing veto had to be added to two lanes separately, so
//     a third lane would have shipped without it;
//   · the sent price wasn't persisted, because the send and the receipt lived
//     in different places.
// The fix is a FLOOR, not a redesign: one guarded function that every outbound
// SMS passes through. Each lane KEEPS its own stricter guards (quiet hours,
// per-record dispatch claims, >85%-of-list economics, hydration, thread truth,
// one-per-thread claims). This gate only adds what must be true EVERYWHERE.
//
// WHAT THE GATE ENFORCES
//   (a) Do_Not_Text            — listing.doNotText === true → REFUSE. Always.
//   (b) Renovated-listing veto — listing.renovatedLanguage === true → REFUSE
//       when purpose is first_touch or bump. A low cash OPENER on a turnkey /
//       renovated house is always wrong. Conversational replies (reply /
//       followup) are ALLOWED — once an agent is talking to us, refusing to
//       answer is its own harm.
//   (c) Duplicate suppression  — NUMBER-LEVEL. The same E.164 must not receive
//       an identical body twice inside 30 minutes, no matter which lane or
//       which record originated it. This is the check no per-record claim
//       could ever make.
//   (d) purpose + recordId     — both MANDATORY. An un-tagged send has no
//       audit trail, and the audit trail is how we ever diagnosed (a)-(c).
//
// FAIL-OPEN / FAIL-CLOSED POSTURE
//   (a), (b) and (d) are PURE — no I/O, no infrastructure, always enforced.
//   (c) needs KV. A KV outage FAILS OPEN for the send (and logs + audits the
//   degradation) because an infra blip must never silently dark ALL outreach —
//   a silent total stop is a worse failure than a rare duplicate, and it is
//   exactly the failure mode nobody notices. The degradation is audited every
//   time, so "the dedupe was down" is never invisible.

import { createHash } from "node:crypto";
import { sendMessageWithId, type QuoSendResult } from "@/lib/quo";
import { kvConfigured, kvProd, type KvClient } from "@/lib/maverick/oauth/kv";
import { audit } from "@/lib/audit-log";

/** Every send must declare WHY it is going out. Opener-class purposes
 *  (first_touch, bump) carry the renovated-listing veto; conversational
 *  purposes (reply, followup) do not. */
export type SendPurpose = "first_touch" | "bump" | "reply" | "followup";

/** Purposes that are an unsolicited OFFER approach and therefore subject to
 *  the renovated-listing veto. */
export const OPENER_PURPOSES: ReadonlySet<SendPurpose> = new Set<SendPurpose>([
  "first_touch",
  "bump",
]);

const ALL_PURPOSES: ReadonlySet<string> = new Set<string>([
  "first_touch",
  "bump",
  "reply",
  "followup",
]);

/** Duplicate-suppression window. 30 minutes: long enough to swallow an
 *  overlapping cron slot / a double-click / two same-phone records planned in
 *  the same batch; short enough that a legitimate re-send after a real
 *  conversation gap is never blocked. */
export const SMS_DEDUPE_TTL_S = 30 * 60;

/** The listing fields the gate reads. Deliberately a NARROW structural type,
 *  not `Listing` — the gate must be callable from lanes that only hold a
 *  partial record, and it must be trivially constructible in tests. */
export interface SendGateListing {
  doNotText?: boolean | null;
  /** Renovated / turnkey listing language (lib/crawler/sources/firecrawl
   *  detectRenovationLanguage). A low cash opener on a renovated house is
   *  always wrong — see the hard-veto tier in the intake filter. */
  renovatedLanguage?: boolean | null;
}

export type SendRefusalReason =
  | "missing_purpose"
  | "invalid_purpose"
  | "missing_record_id"
  | "missing_phone"
  | "empty_body"
  | "do_not_text"
  | "renovated_listing_veto"
  | "duplicate_within_window";

export interface SendGateRequest {
  /** Destination in E.164. */
  to: string;
  body: string;
  /** MANDATORY audit tag. */
  purpose: SendPurpose;
  /** MANDATORY audit tag — the Listings_V1 (or Deals) record this send is about. */
  recordId: string;
  /** The record's guard fields. Omitted/null → (a) and (b) cannot fire; pass
   *  it wherever the lane has the listing in hand (every live lane does). */
  listing?: SendGateListing | null;
  /** Channel override (operator-alert line). Passed straight through. */
  from?: string;
  /** Extra context for the audit row (address, attempt number, …). */
  auditContext?: Record<string, unknown>;
  /** Audit agent attribution. Defaults to "crier". */
  agent?: string;
}

export interface SendGateResult {
  /** True only when the Quo send was actually dispatched. */
  sent: boolean;
  /** True when the gate REFUSED. Mutually exclusive with `sent`. */
  refused: boolean;
  reason: SendRefusalReason | null;
  /** The raw Quo result — present iff `sent`. */
  result: QuoSendResult | null;
  /** Duplicate-suppression telemetry. `degraded` = KV unavailable, the check
   *  could not run, and the send was allowed through (fail-open). */
  dedupe: { key: string | null; enforced: boolean; degraded: boolean };
}

// ── PURE HELPERS (unit-testable with no KV, no network) ────────────────

/** Normalize a body for duplicate comparison: collapse whitespace, trim,
 *  lowercase. Two bodies that differ only in wrapping/case ARE the same text
 *  to the human receiving them. */
export function normalizeDedupeBody(body: string): string {
  return body.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Normalize a phone to bare digits so "+1 205 875 6959" and "+12058756959"
 *  collide in the dedupe namespace (they are the same handset). */
export function normalizeDedupePhone(phone: string): string {
  return phone.replace(/\D/g, "");
}

/** Pure: the KV key for the number-level duplicate claim.
 *  `sms:dedupe:{phone}:{sha1(body).slice(0,16)}` */
export function dedupeKey(phone: string, body: string): string {
  const hash = createHash("sha1").update(normalizeDedupeBody(body)).digest("hex").slice(0, 16);
  return `sms:dedupe:${normalizeDedupePhone(phone)}:${hash}`;
}

/**
 * Pure: every check that needs no I/O — (a) Do_Not_Text, (b) the renovated
 * veto for opener-class purposes, (d) the mandatory purpose + recordId tags,
 * plus the basic payload sanity a send cannot proceed without.
 *
 * Returns the refusal reason, or null when the pure floor is clear and the
 * duplicate check gets its turn. Split out so the gate ORDER is testable
 * without mocking KV or the network.
 */
export function evaluateStaticGate(input: {
  purpose: string | null | undefined;
  recordId: string | null | undefined;
  to: string | null | undefined;
  body: string | null | undefined;
  listing?: SendGateListing | null;
}): SendRefusalReason | null {
  // (d) audit-trail tags first — an un-tagged send is refused before we even
  // look at the payload, so a caller can never "accidentally" send untagged.
  if (!input.purpose || String(input.purpose).trim() === "") return "missing_purpose";
  if (!ALL_PURPOSES.has(String(input.purpose))) return "invalid_purpose";
  if (!input.recordId || String(input.recordId).trim() === "") return "missing_record_id";

  if (!input.to || String(input.to).trim() === "") return "missing_phone";
  if (!input.body || String(input.body).trim() === "") return "empty_body";

  // (a) Do_Not_Text — number-level, no purpose escapes it.
  if (input.listing?.doNotText === true) return "do_not_text";

  // (b) Renovated-listing veto — OPENER/BUMP only. A reply to a live
  // conversation is not an unsolicited lowball approach.
  if (
    input.listing?.renovatedLanguage === true &&
    OPENER_PURPOSES.has(input.purpose as SendPurpose)
  ) {
    return "renovated_listing_veto";
  }

  return null;
}

// ── THE GATE ───────────────────────────────────────────────────────────

export interface SendGateDeps {
  /** KV client for the duplicate claim. null → dedupe unavailable (fail open). */
  kv?: KvClient | null;
  /** Underlying Quo sender. Defaults to lib/quo's sendMessageWithId. */
  send?: typeof sendMessageWithId;
  now?: () => Date;
}

/**
 * THE choke point. Every outbound SMS goes through here.
 *
 * Refusals return `{ sent:false, refused:true, reason }` and are ALWAYS
 * audited — callers route them into their existing skip path.
 *
 * A send that THROWS rethrows (identical to calling sendMessageWithId
 * directly, so lane error handling is unchanged) after releasing the
 * duplicate claim — a failed send is not a send, and must be retryable.
 */
export async function sendGuarded(
  req: SendGateRequest,
  deps: SendGateDeps = {},
): Promise<SendGateResult> {
  const agent = req.agent ?? "crier";
  const now = deps.now ?? (() => new Date());
  const kv = deps.kv !== undefined ? deps.kv : kvConfigured() ? kvProd : null;
  const send = deps.send ?? sendMessageWithId;

  const refuse = async (
    reason: SendRefusalReason,
    dedupe: SendGateResult["dedupe"],
  ): Promise<SendGateResult> => {
    await audit({
      agent,
      event: "send_gate_refused",
      status: "confirmed_failure",
      recordId: req.recordId || undefined,
      inputSummary: {
        purpose: req.purpose ?? null,
        to_masked: maskPhone(req.to ?? ""),
        body_len: (req.body ?? "").length,
        ...(req.auditContext ?? {}),
      },
      outputSummary: { sent: false, reason, dedupe_key: dedupe.key },
      decision: reason,
    });
    return { sent: false, refused: true, reason, result: null, dedupe };
  };

  const noDedupe: SendGateResult["dedupe"] = { key: null, enforced: false, degraded: false };

  // (a)/(b)/(d) — pure, always enforced, even with every piece of infra down.
  const staticReason = evaluateStaticGate({
    purpose: req.purpose,
    recordId: req.recordId,
    to: req.to,
    body: req.body,
    listing: req.listing,
  });
  if (staticReason) return refuse(staticReason, noDedupe);

  // (c) Duplicate suppression — number-level, 30-minute window. setNx is the
  // atomic primitive: `true` = we claimed the (phone, body) pair, nobody sent
  // it in the window; `false` = an identical body already went to this number.
  const key = dedupeKey(req.to, req.body);
  let claimed = true;
  let degraded = false;
  if (kv) {
    try {
      claimed = await kv.setNx(key, now().toISOString(), SMS_DEDUPE_TTL_S);
    } catch (err) {
      // FAIL OPEN — but never silently. An infra outage must not dark all
      // outreach; it must be loud enough that the operator sees it.
      degraded = true;
      claimed = true;
      console.error("[send-gate] dedupe KV unavailable — failing OPEN for this send:", err);
      await audit({
        agent,
        event: "send_gate_dedupe_degraded",
        status: "uncertain",
        recordId: req.recordId,
        inputSummary: { purpose: req.purpose, to_masked: maskPhone(req.to), dedupe_key: key },
        outputSummary: {
          failed_open: true,
          error: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
        },
      });
    }
  } else {
    degraded = true;
    console.warn(
      "[send-gate] KV not configured — duplicate suppression is NOT enforced (failing open).",
    );
  }

  const dedupe: SendGateResult["dedupe"] = { key, enforced: !degraded, degraded };
  if (!claimed) return refuse("duplicate_within_window", dedupe);

  try {
    const result = await send(req.to, req.body, req.from ? { from: req.from } : {});
    return { sent: true, refused: false, reason: null, result, dedupe };
  } catch (err) {
    // A throw means nothing went out. Release the claim so a retry is not
    // locked out for 30 minutes (the lesson from approve-send's stuck claim).
    if (kv && !degraded) {
      try {
        await kv.del(key);
      } catch {
        /* best effort — a lingering claim expires in 30m; a stuck one is the bug */
      }
    }
    throw err;
  }
}

function maskPhone(p: string): string {
  const d = (p ?? "").replace(/\D/g, "");
  return d.length < 4 ? "***" : `…${d.slice(-4)}`;
}
