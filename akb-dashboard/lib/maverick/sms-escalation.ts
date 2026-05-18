// Maverick Stage 4 SMS escalation (Phase 9.7).
// @agent: maverick
//
// Daily UX Spec §8 + §5.4 — when the priority surface produces a Tier 3
// signal, fire an SMS to Alex's personal escalation number so he's
// reached when he's not at the dashboard.
//
// Trigger surface (per Phase 9.7 spec):
//   - Synchronous side effect on every authorized `maverick_load_state`
//     call (dashboard session + MCP OAuth). NOT cron-fired — same
//     burn-prevention discipline as Phase 11.6/11.7.
//   - Dedup per signal key for 30 min (env-configurable). Same signal
//     across consecutive briefings = same key = at most one SMS.
//   - Hard cap 5 SMS per rolling 24h (env-configurable). Excess
//     suppressed + logged as Pulse breadcrumb.
//
// Quo API failures never bubble — audit logged, next briefing retries.
// A2P 10DLC pending state: Quo returns success while carrier holds
// delivery; the audit trail captures every send_attempt so Pulse can
// later verify delivery once A2P clears.

import { audit } from "@/lib/audit-log";
import { sendMessageWithId, type QuoSendResult } from "@/lib/quo";
import type { KvClient } from "./oauth/kv";
import type { PrioritySignal } from "./severity";
import { inferPrioritySignals } from "./severity";
import type { StructuredBriefing, SourceHealth } from "./briefing";
import type { SourceName } from "./types";

// ───────────────────── env / constants ─────────────────────

const DEFAULT_TARGET = "+16302505865";
const DEFAULT_COOLDOWN_MIN = 30;
const DEFAULT_DAILY_CAP = 5;
const ROLLING_WINDOW_MS = 24 * 60 * 60 * 1000;
const KV_DAILY_KEY = "mav:sms:daily:sends";
const KV_DAILY_TTL_S = 24 * 60 * 60; // GC after 24h of inactivity

function signalKvKey(signalKey: string): string {
  return `mav:sms:signal:${signalKey}`;
}

export interface Stage4Env {
  target: string;
  cooldownMin: number;
  dailyCap: number;
}

export function readStage4Env(): Stage4Env {
  const cooldown = parseInt(
    process.env.MAVERICK_SMS_PER_SIGNAL_COOLDOWN_MIN ?? "",
    10,
  );
  const cap = parseInt(process.env.MAVERICK_SMS_DAILY_CAP ?? "", 10);
  return {
    target: process.env.MAVERICK_STAGE4_SMS_TARGET ?? DEFAULT_TARGET,
    cooldownMin: Number.isFinite(cooldown) && cooldown > 0 ? cooldown : DEFAULT_COOLDOWN_MIN,
    dailyCap: Number.isFinite(cap) && cap > 0 ? cap : DEFAULT_DAILY_CAP,
  };
}

// ───────────────────── pure helpers ─────────────────────

/**
 * Stable per-signal key for dedup. Uses the signal's `id` directly
 * (already a stable string) so the same signal across briefings maps
 * to the same KV entry. Falls back to a content hash when id is
 * absent. Pure.
 */
export function deriveSignalKey(signal: PrioritySignal): string {
  if (signal.id) return signal.id.replace(/[^a-zA-Z0-9_:.-]/g, "_").slice(0, 80);
  const parts = [signal.tier, signal.agent ?? "_", signal.title].join("|");
  return simpleHash(parts);
}

/**
 * Concise SMS body. Aims under 160 chars but accepts multi-segment
 * when the content warrants. Pure.
 */
export function formatStage4Message(signal: PrioritySignal): string {
  const lines: string[] = ["🐕 Maverick — TIER 3", signal.title];
  if (signal.reason) {
    lines.push(signal.reason.slice(0, 120));
  }
  if (signal.agent) {
    lines.push(`@${signal.agent.toUpperCase()}`);
  }
  return lines.join("\n");
}

/**
 * Parse the JSON-encoded list of recent send timestamps. Pure;
 * tolerates malformed input by returning [].
 */
export function parseDailySends(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string");
  } catch {
    return [];
  }
}

/**
 * Filter timestamps to those within the rolling window ending at `now`.
 * Returns the active list (newest first) so callers can write it back
 * to KV with stale entries dropped. Pure.
 */
export function pruneRecentSends(
  sends: string[],
  now: Date,
  windowMs: number = ROLLING_WINDOW_MS,
): string[] {
  const cutoffMs = now.getTime() - windowMs;
  const active = sends
    .filter((iso) => {
      const t = new Date(iso).getTime();
      return !isNaN(t) && t >= cutoffMs;
    })
    .sort((a, b) => b.localeCompare(a));
  return active;
}

/**
 * Pull tier-3 signals from a briefing. Tier 3 is the only escalation
 * threshold per Daily UX Spec §5.4. Pure.
 */
export function tierThreeSignalsFrom(
  briefing: Pick<StructuredBriefing, "audit_summary" | "active_deals" | "open_decisions" | "recent_key_decisions" | "external_signals" | "staleness_warnings">,
  source_health: Record<SourceName, SourceHealth>,
): PrioritySignal[] {
  return inferPrioritySignals({
    structured: briefing,
    source_health,
  }).filter((s) => s.tier === 3);
}

// ───────────────────── orchestrator ─────────────────────

export interface EvaluateStage4Opts {
  briefing: Pick<StructuredBriefing, "audit_summary" | "active_deals" | "open_decisions" | "recent_key_decisions" | "external_signals" | "staleness_warnings">;
  source_health: Record<SourceName, SourceHealth>;
  authKind: "dashboard_session" | "oauth" | "cron" | "bearer_dev" | "none";
  kv: KvClient;
  env: Stage4Env;
  now?: Date;
  /** Sender override for tests — default uses lib/quo's sendMessageWithId. */
  send?: (to: string, content: string) => Promise<QuoSendResult>;
  /** Audit override for tests — default uses lib/audit-log's audit(). */
  recordAudit?: (entry: Parameters<typeof audit>[0]) => Promise<void>;
}

export interface EvaluateStage4Result {
  attempted: number;
  sent: number;
  suppressed_cooldown: number;
  suppressed_daily_cap: number;
  failed: number;
  /** Convenience for tests — empty when no signals or non-authorized auth. */
  details: Array<{
    signal_key: string;
    outcome: "sent" | "cooldown" | "daily_cap" | "failed";
    error?: string;
    quo_message_id?: string | null;
  }>;
}

const AUTHORIZED_KINDS = new Set(["dashboard_session", "oauth"]);

/**
 * Phase 9.7 evaluation. Authorized callers (dashboard session + MCP
 * OAuth) trigger this after every successful briefing. Tier 3 signals
 * are deduped + rate-limited via KV; survivors are SMS'd to the
 * escalation number; every outcome is audit-logged.
 *
 * Quo API failures are caught + audited; never bubble to the caller.
 * Returns a tally so test callers can assert behavior without
 * inspecting KV state.
 */
export async function evaluateStage4Escalation(
  opts: EvaluateStage4Opts,
): Promise<EvaluateStage4Result> {
  const tally: EvaluateStage4Result = {
    attempted: 0,
    sent: 0,
    suppressed_cooldown: 0,
    suppressed_daily_cap: 0,
    failed: 0,
    details: [],
  };

  if (!AUTHORIZED_KINDS.has(opts.authKind)) {
    return tally;
  }

  const now = opts.now ?? new Date();
  const signals = tierThreeSignalsFrom(opts.briefing, opts.source_health);
  if (signals.length === 0) return tally;

  const sendFn = opts.send ?? sendMessageWithId;
  const auditFn = opts.recordAudit ?? audit;

  // Pull the rolling-24h send log once; mutate locally as we send.
  const dailyRaw = await safeKvGet(opts.kv, KV_DAILY_KEY);
  let activeSends = pruneRecentSends(parseDailySends(dailyRaw), now);

  for (const signal of signals) {
    tally.attempted++;
    const key = deriveSignalKey(signal);

    // Per-signal cooldown gate.
    const cooldownKey = signalKvKey(key);
    const existing = await safeKvGet(opts.kv, cooldownKey);
    if (existing) {
      tally.suppressed_cooldown++;
      tally.details.push({ signal_key: key, outcome: "cooldown" });
      await safeAudit(auditFn, {
        agent: "maverick",
        event: "sms_rate_limited",
        status: "confirmed_success",
        inputSummary: { signal_key: key, reason: "cooldown" },
        outputSummary: { last_sent_at: existing, cooldown_min: opts.env.cooldownMin },
      });
      continue;
    }

    // Daily rolling-window cap gate.
    if (activeSends.length >= opts.env.dailyCap) {
      tally.suppressed_daily_cap++;
      tally.details.push({ signal_key: key, outcome: "daily_cap" });
      await safeAudit(auditFn, {
        agent: "maverick",
        event: "sms_rate_limited",
        status: "confirmed_success",
        inputSummary: { signal_key: key, reason: "daily_cap" },
        outputSummary: {
          window_count: activeSends.length,
          cap: opts.env.dailyCap,
        },
      });
      continue;
    }

    // Send.
    const content = formatStage4Message(signal);
    try {
      const result = await sendFn(opts.env.target, content);
      const sendIso = now.toISOString();
      activeSends = [sendIso, ...activeSends].slice(0, opts.env.dailyCap * 2);

      await safeKvSetEx(
        opts.kv,
        cooldownKey,
        sendIso,
        opts.env.cooldownMin * 60,
      );
      await safeKvSetEx(
        opts.kv,
        KV_DAILY_KEY,
        JSON.stringify(activeSends),
        KV_DAILY_TTL_S,
      );

      tally.sent++;
      tally.details.push({
        signal_key: key,
        outcome: "sent",
        quo_message_id: result.id,
      });
      await safeAudit(auditFn, {
        agent: "crier",
        event: "sms_escalation_sent",
        status: "confirmed_success",
        inputSummary: {
          signal_key: key,
          tier: signal.tier,
          target: opts.env.target,
        },
        outputSummary: {
          quo_message_id: result.id,
          quo_status: result.status,
          http_status: result.httpStatus,
        },
        externalId: result.id ?? undefined,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      tally.failed++;
      tally.details.push({ signal_key: key, outcome: "failed", error: msg });
      await safeAudit(auditFn, {
        agent: "crier",
        event: "sms_escalation_failed",
        status: "confirmed_failure",
        inputSummary: {
          signal_key: key,
          tier: signal.tier,
          target: opts.env.target,
        },
        outputSummary: { content_preview: content.slice(0, 80) },
        error: msg,
      });
    }
  }

  return tally;
}

// ───────────────────── private helpers ─────────────────────

async function safeKvGet(kv: KvClient, key: string): Promise<string | null> {
  try {
    return await kv.get(key);
  } catch {
    return null;
  }
}

async function safeKvSetEx(
  kv: KvClient,
  key: string,
  value: string,
  ttlSeconds: number,
): Promise<void> {
  try {
    await kv.setEx(key, value, ttlSeconds);
  } catch {
    // KV write failures are non-fatal — we still sent the SMS. Next
    // briefing's dedup may double-fire, but the daily cap remains
    // intact because we'll re-read & re-prune.
  }
}

async function safeAudit(
  fn: (entry: Parameters<typeof audit>[0]) => Promise<void>,
  entry: Parameters<typeof audit>[0],
): Promise<void> {
  try {
    await fn(entry);
  } catch {
    // Audit failures must never block escalation.
  }
}

function simpleHash(s: string): string {
  // djb2-ish; non-cryptographic, just needs collision resistance for
  // the small set of signal keys we'll ever generate.
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) ^ s.charCodeAt(i);
  }
  return `h${(h >>> 0).toString(36)}`;
}
