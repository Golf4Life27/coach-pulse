// Per-VENDOR health detector (operator 2026-08-04, the silent-403 incident).
//
// WHY THIS EXISTS. Every RentCast call 403'd for ~2 days (8/1-8/3). Every
// failure was faithfully written to audit_log. NOTHING paged the operator —
// he found it by feel, and the intake belt sat dead the whole time.
//
// The existing endpoint-error-rate detector could not have caught it: it
// tallies by EVENT name, and every paid vendor call shares the single event
// "paid_api_call". RentCast at 100% failure gets averaged against ATTOM at
// 100% success under one bucket, so a total outage of one vendor reads as a
// ~50% blended rate on an event name that names no vendor. Vendor health is
// a per-SOURCE question, so it needs a per-source tally.
//
// Covers the three vendors the business actually stands on:
//   - rentcast / attom — the paid_api_call rows (agent = vendor).
//   - quo             — outbound SMS rows (agent "crier"; see the note in
//                       readQuoTally about why it is NOT "quo").
//   - firecrawl       — deliberately NOT re-implemented here. The dedicated
//                       firecrawl_payment_required detector already covers
//                       the wallet-empty case off the intake summary row;
//                       Firecrawl emits no per-call audit rows to rate, so a
//                       second detector would have nothing extra to read.
//                       This detector's job for Firecrawl is to make sure it
//                       PAGES — handled by the runner's SMS bridge.
//
// Also carries the RentCast monthly-cap warning: RENTCAST_MONTHLY_CAP trips
// SILENTLY at 100% with no 80% heads-up, so the plan can exhaust mid-month
// with no warning. Cap usage arrives via input.rentcast_month_spend (the
// scan route reads the KV meter) — null when unreadable, and the check goes
// silent rather than guessing (INVARIANTS §1).

import type { AuditEntry } from "@/lib/audit-log";
import type { PulseDetection } from "../types";
import type { PulseDetectorInput } from "../detector-input";

const DEFAULT_WINDOW_HOURS = 6;
const DEFAULT_MIN_SAMPLES = 5;
const DEFAULT_WARNING_RATE = 0.5;
const DEFAULT_CRITICAL_RATE = 0.9;
const DEFAULT_CAP_WARN_PCT = 0.8;

/** Vendors rated off per-call audit rows. */
export type RatedVendor = "rentcast" | "attom" | "quo";

export interface VendorTally {
  success: number;
  failure: number;
  /** HTTP codes seen on failures, most-common first. Drives the "auth" vs
   *  "flaky" read in the page text — a wall of 403 is a dead key, a spray
   *  of 500s is a vendor wobble. */
  failureCodes: number[];
}

function readNum(
  env: Record<string, string | undefined>,
  key: string,
  fallback: number,
  { min = 0, max = Number.POSITIVE_INFINITY }: { min?: number; max?: number } = {},
): number {
  const raw = env[key];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) return fallback;
  return n;
}

function within(e: AuditEntry, cutoffMs: number): boolean {
  const t = new Date(e.ts).getTime();
  return Number.isFinite(t) && t >= cutoffMs;
}

function httpOf(e: AuditEntry): number | null {
  const out = e.outputSummary as Record<string, unknown> | undefined;
  const http = out?.http;
  return typeof http === "number" ? http : null;
}

function bump(tallies: Map<RatedVendor, VendorTally>, v: RatedVendor): VendorTally {
  const t = tallies.get(v) ?? { success: 0, failure: 0, failureCodes: [] };
  tallies.set(v, t);
  return t;
}

/** Pure: per-vendor success/failure tally over the rolling window.
 *
 *  Quo has no `paid_api_call` row — its sends are audited by the CALLER, and
 *  every live writer stamps agent "crier", never "quo" (jarvis-send,
 *  reply-alert, sms-escalation all do). The pre-existing quo-quota-burn
 *  detector filters on agent === "quo" and therefore matches nothing in
 *  production; do not copy that filter. */
export function tallyVendorHealth(
  audit: AuditEntry[],
  windowHours: number,
  now: Date,
): Map<RatedVendor, VendorTally> {
  const cutoff = now.getTime() - windowHours * 3_600_000;
  const tallies = new Map<RatedVendor, VendorTally>();
  const codes = new Map<RatedVendor, Map<number, number>>();

  for (const e of audit) {
    if (!within(e, cutoff)) continue;

    let vendor: RatedVendor | null = null;
    if (e.event === "paid_api_call" && (e.agent === "rentcast" || e.agent === "attom")) {
      vendor = e.agent;
    } else if (
      e.agent === "crier" &&
      (e.event === "send_attempt" ||
        e.event === "reply_alert_failed" ||
        e.event === "sms_escalation_failed")
    ) {
      vendor = "quo";
    }
    if (!vendor) continue;

    const t = bump(tallies, vendor);
    // `uncertain` (a send with no terminal carrier status yet) is counted as
    // neither — it is an open question, not a failure. Rating it either way
    // would make an in-flight send look like vendor health.
    if (e.status === "confirmed_success") {
      t.success++;
    } else if (e.status === "confirmed_failure") {
      t.failure++;
      const http = httpOf(e);
      if (http != null) {
        const m = codes.get(vendor) ?? new Map<number, number>();
        codes.set(vendor, m);
        m.set(http, (m.get(http) ?? 0) + 1);
      }
    }
  }

  for (const [vendor, m] of codes) {
    const t = tallies.get(vendor);
    if (!t) continue;
    t.failureCodes = [...m.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
  }
  return tallies;
}

/** Pure: is this failure mix an auth/credential problem? A 401/403 majority
 *  means the key is dead or descoped — a different operator action (rotate
 *  the key) than a flaky vendor (wait it out). */
export function looksLikeAuthFailure(codes: number[]): boolean {
  return codes.length > 0 && (codes[0] === 401 || codes[0] === 403);
}

export function detectVendorHealth(input: PulseDetectorInput): PulseDetection[] {
  const env = input.env;
  const windowHours = readNum(env, "PULSE_VENDOR_WINDOW_HOURS", DEFAULT_WINDOW_HOURS, { min: 0.25 });
  const minSamples = Math.floor(readNum(env, "PULSE_VENDOR_MIN_SAMPLES", DEFAULT_MIN_SAMPLES, { min: 1 }));
  const warnRate = readNum(env, "PULSE_VENDOR_WARNING_RATE", DEFAULT_WARNING_RATE, { min: 0.01, max: 1 });
  const critRate = readNum(env, "PULSE_VENDOR_CRITICAL_RATE", DEFAULT_CRITICAL_RATE, { min: 0.01, max: 1 });

  const now = input.now();
  const fires: PulseDetection[] = [];

  for (const [vendor, t] of tallyVendorHealth(input.audit_log, windowHours, now)) {
    const total = t.success + t.failure;
    if (total < minSamples) continue;
    const rate = t.failure / total;
    if (rate < warnRate) continue;

    const auth = looksLikeAuthFailure(t.failureCodes);
    const severity: PulseDetection["severity"] = rate >= critRate ? "critical" : "warning";
    const pct = Math.round(rate * 100);
    const codeStr = t.failureCodes.length > 0 ? t.failureCodes.slice(0, 3).join("/") : "no HTTP code";

    fires.push({
      id: `vendor_health:${vendor}`,
      detector_id: "vendor_health",
      severity,
      title: `${vendor.toUpperCase()} failing ${pct}% (${t.failure}/${total} in ${windowHours}h, ${codeStr})`,
      description:
        `${vendor} returned ${t.failure} failures out of ${total} calls in the last ${windowHours}h ` +
        `(${pct}%). Most common status: ${codeStr}. ` +
        (auth
          ? `A 401/403 majority means the CREDENTIAL is dead or descoped, not that the vendor is down — ` +
            `this is the shape that ran for ~2 days unnoticed on 2026-08-01.`
          : `Mixed/5xx failures usually mean a vendor-side wobble; the loop breaker will back off and retry.`),
      suggested_action: auth
        ? `Rotate/refresh the ${vendor} API key and redeploy. The failure-loop breaker cools 401/403 for 30 min, so a fixed key clears itself within one cron slot — no manual re-trigger needed.`
        : `Check the ${vendor} status page. If failures persist past an hour with no vendor incident, treat it as ours and inspect the calling route.`,
      detected_at: now.toISOString(),
      source_data: {
        vendor,
        failures: t.failure,
        successes: t.success,
        total,
        rate: Math.round(rate * 1000) / 1000,
        failure_codes: t.failureCodes.slice(0, 5),
        auth_shaped: auth,
        window_hours: windowHours,
        min_samples: minSamples,
      },
    });
  }

  // RentCast monthly plan burn-down. Silent at 100% today; this is the
  // heads-up before the belt stops. Null meter → silent (never guess).
  const spend = input.rentcast_month_spend;
  if (spend && spend.cap > 0 && spend.used != null) {
    const warnPct = readNum(env, "PULSE_RENTCAST_CAP_WARN_PCT", DEFAULT_CAP_WARN_PCT, { min: 0.1, max: 1 });
    const usedPct = spend.used / spend.cap;
    if (usedPct >= warnPct) {
      const atCap = usedPct >= 1;
      fires.push({
        id: "vendor_health:rentcast_monthly_cap",
        detector_id: "vendor_health",
        severity: atCap ? "critical" : "warning",
        title: `RentCast monthly cap ${Math.round(usedPct * 100)}% used (${spend.used}/${spend.cap})`,
        description:
          `RentCast has consumed ${spend.used} of its ${spend.cap} monthly calls (${Math.round(usedPct * 100)}%). ` +
          (atCap
            ? `The cap is REACHED — every further call is refused locally (HTTP 598) and intake plus rehab backfill are stalled until the month rolls or the cap is raised.`
            : `At the current burn the cap will trip before the month rolls, and it trips SILENTLY: calls just start getting refused.`) +
          ` Note both env names must move together if the plan is upgraded — RENTCAST_MONTHLY_CAP (spend-ceiling) and RENTCAST_MONTHLY_PLAN (frontier governor) are read by different modules.`,
        suggested_action: atCap
          ? `Raise RENTCAST_MONTHLY_CAP *and* RENTCAST_MONTHLY_PLAN together (Growth = $199/5,000 calls), or wait for the month to roll.`
          : `Decide on the Growth upgrade ($199/5,000) or throttle the sweep lanes. Changing the plan means changing BOTH env vars.`,
        detected_at: now.toISOString(),
        source_data: {
          vendor: "rentcast",
          used: spend.used,
          cap: spend.cap,
          used_pct: Math.round(usedPct * 1000) / 1000,
          warn_pct: warnPct,
        },
      });
    }
  }

  fires.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "critical" ? -1 : 1));
  return fires;
}
