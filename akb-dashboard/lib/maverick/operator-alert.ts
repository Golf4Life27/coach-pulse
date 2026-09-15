// Operator alert - the CRON_SECRET-gated, credential-proof sibling of
// jarvis-send, but for operator-facing pages.
//
// WHY THIS EXISTS. Routine Claude sessions (hourly triage, Engine Driver)
// text the operator through the claude.ai Quo connector, whose credential
// dies after roughly 4 hours; on 2026-09-14 five alerts failed to reach the
// operator's phone because of exactly that. The app's own Quo key (Vercel
// env) never dies. POST /api/jarvis-send already solved this for
// agent-facing sends; this is the operator-facing sibling: a short
// plain-text alert sent FROM the Maverick line (ALERT_FROM) TO the
// operator's cell, dispatchable from a GitHub Actions workflow so a
// session needs only GitHub, never Quo.
//
// CHANNEL SEPARATION still applies (operator 2026-06-10): this refuses to
// send when ALERT_FROM is unset rather than falling back to the
// agent-facing outreach line. See lib/maverick/operator-page.ts, the
// original operator-paging helper this mirrors.
//
// NEVER THROWS. Every failure mode returns a reason instead of raising, so
// a workflow dispatch (or a session reading the response) can act on the
// outcome instead of catching an exception.

import { audit } from "@/lib/audit-log";
import { sendMessageWithId } from "@/lib/quo";
import { kvConfigured, kvProd, type KvClient } from "@/lib/maverick/oauth/kv";
import { normalizeForGsm7, findNonGsm7Chars } from "@/lib/sms/gsm7";
import { trimAtWord, simpleHash } from "@/lib/maverick/sms-escalation";
import { insideChicagoWindow, readEscalationConfig } from "@/lib/escalation";
import { resolveOperatorPhone } from "@/lib/maverick/operator-page";

// ───────────────────── constants ─────────────────────

export const ALERT_MAX_LEN = 300;

/** Dedupe window: the same composed body (or explicit key) fires at most
 *  once per this window. Default 6h, env override MAVERICK_ALERT_DEDUPE_S. */
const DEDUPE_TTL_S_DEFAULT = 6 * 3600;

/** Daily page budget so a stuck loop cannot page the operator into the
 *  ground. Default 20/day, env override MAVERICK_ALERT_DAILY_CAP. */
const DAILY_CAP_DEFAULT = 20;

// ───────────────────── types ─────────────────────

export interface OperatorAlertInput {
  /** Free-text alert body. Composed (GSM-7-safe, trimmed) before sending. */
  message: string;
  /** Explicit dedupe key. Falls back to a hash of the composed body. */
  key?: string | null;
  /** Record id for the audit trail, when the alert is about one record. */
  recordId?: string | null;
  /** Who asked for this page (e.g. "hourly_triage", "engine_driver"). */
  source?: string | null;
  /** true bypasses the Chicago send window - a signed contract at 10pm
   *  still pages the operator. */
  urgent?: boolean;
}

export interface OperatorAlertDeps {
  /** Omit for the real client (kvProd when configured). Pass null to force
   *  the no-KV path: dedupe and the daily cap are both skipped. */
  kv?: KvClient | null;
  send?: typeof sendMessageWithId;
  env?: Record<string, string | undefined>;
  now?: Date;
}

export interface OperatorAlertResult {
  sent: boolean;
  /** Null on success; otherwise why nothing happened. */
  reason: string | null;
  /** The composed body actually sent (or that would have been sent). */
  body: string;
  /** The dedupe key used (explicit or derived). */
  key: string;
  /** The operator phone number, MASKED to its last four digits. The full
   *  number never leaves this module: the route echoes this result and the
   *  workflow prints it into a job log on a public repository. */
  to: string;
  quoMessageId: string | null;
  quoStatus: string | null;
}

// ───────────────────── pure helpers ─────────────────────

/**
 * Compose the operator alert body. Pure. Normalizes smart characters for
 * GSM-7, collapses runs of spaces/tabs (newlines are preserved), trims,
 * then hard-replaces any character GSM-7 still cannot represent with "?" -
 * the phone must bill as plain GSM-7 ASCII, never UCS-2 - and finally trims
 * at a word boundary to ALERT_MAX_LEN.
 */
export function composeOperatorAlert(raw: string): string {
  let text = normalizeForGsm7(raw ?? "");
  text = text.replace(/[ \t]+/g, " ").trim();

  const offenders = findNonGsm7Chars(text);
  if (offenders.length > 0) {
    const bad = new Set(offenders);
    text = Array.from(text)
      .map((ch) => (bad.has(ch) ? "?" : ch))
      .join("");
  }

  return trimAtWord(text, ALERT_MAX_LEN);
}

/**
 * Stable dedupe key. An explicit key is sanitized to a safe KV-key
 * fragment and capped at 80 chars; otherwise a short stable hash of the
 * composed body stands in. Pure.
 */
export function deriveAlertKey(body: string, explicit?: string | null): string {
  const trimmed = (explicit ?? "").trim();
  if (trimmed) {
    const sanitized = trimmed.replace(/[^a-zA-Z0-9_:.-]/g, "_").slice(0, 80);
    if (sanitized) return sanitized;
  }
  return simpleHash(body);
}

/** YYYY-MM-DD in America/Chicago - the daily-cap bucket key. Pure. */
export function chicagoDateKey(now: Date): string {
  return now.toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
}

function positiveIntEnv(raw: string | undefined, dflt: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && Number.isInteger(n) && n > 0 ? n : dflt;
}

function maskPhone(p: string): string {
  const digits = p.replace(/\D/g, "");
  if (digits.length < 4) return "***";
  return `***${digits.slice(-4)}`;
}

// ───────────────────── the entry point ─────────────────────

/**
 * Page the operator with a short plain-text alert. NEVER throws.
 *
 * Sequence - each step fails closed before the next spends anything:
 *   1. compose the body (empty after compose -> "empty_body")
 *   2. resolve the sender (ALERT_FROM unset -> "alert_from_not_set", refuse
 *      rather than fall back to the agent-facing outreach line)
 *   3. Chicago send window, bypassed by urgent: true
 *   4. dedupe (KV setNx on the alert key)
 *   5. daily cap (KV incrBy on the Chicago date bucket)
 *   6. send via Quo, FROM the Maverick line
 *
 * Every outcome is audited as agent "maverick", event "operator_alert".
 * Never logs the full phone number or the message body to console.
 */
export async function sendOperatorAlert(
  input: OperatorAlertInput,
  deps: OperatorAlertDeps = {},
): Promise<OperatorAlertResult> {
  const t0 = Date.now();
  const env = deps.env ?? (process.env as Record<string, string | undefined>);
  const now = deps.now ?? new Date();
  const send = deps.send ?? sendMessageWithId;
  const toFull = resolveOperatorPhone(env);
  const to = maskPhone(toFull);

  const body = composeOperatorAlert(input.message ?? "");
  const key = deriveAlertKey(body, input.key);

  const record = (
    status: "confirmed_success" | "confirmed_failure" | "uncertain",
    reason: string | null,
    extra: { quoMessageId?: string | null; quoStatus?: string | null; error?: string } = {},
  ): Promise<void> =>
    audit({
      agent: "maverick",
      event: "operator_alert",
      status,
      recordId: input.recordId ?? undefined,
      inputSummary: {
        source: input.source ?? null,
        key,
        msg_len: (input.message ?? "").length,
        urgent: Boolean(input.urgent),
        to,
      },
      outputSummary: {
        sent: reason === null,
        reason,
        quo_message_id: extra.quoMessageId ?? null,
        quo_status: extra.quoStatus ?? null,
      },
      error: extra.error,
      ms: Date.now() - t0,
    }).catch(() => {});

  // ── 1. Empty body - nothing to send.
  if (!body) {
    await record("uncertain", "empty_body");
    return { sent: false, reason: "empty_body", body, key, to, quoMessageId: null, quoStatus: null };
  }

  // ── 2. CHANNEL SEPARATION. The Maverick line or nothing.
  const from = (env.ALERT_FROM ?? "").trim();
  if (!from) {
    await record("confirmed_failure", "alert_from_not_set");
    return { sent: false, reason: "alert_from_not_set", body, key, to, quoMessageId: null, quoStatus: null };
  }

  // ── 3. Chicago decency window - urgent bypasses it.
  if (!input.urgent && !insideChicagoWindow(now, readEscalationConfig(env))) {
    await record("uncertain", "outside_window");
    return { sent: false, reason: "outside_window", body, key, to, quoMessageId: null, quoStatus: null };
  }

  const kv = deps.kv === undefined ? (kvConfigured() ? kvProd : null) : deps.kv;

  if (kv) {
    // ── 4. Dedupe.
    const dedupeTtl = positiveIntEnv(env.MAVERICK_ALERT_DEDUPE_S, DEDUPE_TTL_S_DEFAULT);
    let acquired: boolean;
    try {
      acquired = await kv.setNx(`mav:alert:${key}`, "1", dedupeTtl);
    } catch {
      // A KV outage must never block a page - proceed as if not a duplicate.
      acquired = true;
    }
    if (!acquired) {
      await record("uncertain", "duplicate");
      return { sent: false, reason: "duplicate", body, key, to, quoMessageId: null, quoStatus: null };
    }

    // ── 5. Daily cap.
    const cap = positiveIntEnv(env.MAVERICK_ALERT_DAILY_CAP, DAILY_CAP_DEFAULT);
    const dateKey = chicagoDateKey(now);
    let n = 0;
    try {
      n = await kv.incrBy(`mav:alert:daily:${dateKey}`, 1);
      if (n === 1) {
        await kv.expire(`mav:alert:daily:${dateKey}`, 36 * 3600).catch(() => {});
      }
    } catch {
      // A KV outage must never block a page - treat as under the cap.
      n = 0;
    }
    if (n > cap) {
      await record("uncertain", "daily_cap");
      return { sent: false, reason: "daily_cap", body, key, to, quoMessageId: null, quoStatus: null };
    }
  }

  // ── 6. Send.
  try {
    const result = await send(toFull, body, { from });
    const isSuccess = result.status === "sent" || result.status === "delivered";
    await record(isSuccess ? "confirmed_success" : "uncertain", null, {
      quoMessageId: result.id,
      quoStatus: result.status,
    });
    return { sent: true, reason: null, body, key, to, quoMessageId: result.id, quoStatus: result.status };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Release the dedupe claim: a page that never reached Quo must not block
    // the retry on the next firing as a "duplicate" for the next six hours.
    if (kv) await kv.del(`mav:alert:${key}`).catch(() => {});
    await record("confirmed_failure", "quo_error", { error: msg.slice(0, 300) });
    return { sent: false, reason: "quo_error", body, key, to, quoMessageId: null, quoStatus: null };
  }
}
