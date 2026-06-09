// Firecrawl wallet-empty (402) CRITICAL detector (operator 2026-06-08).
//
// Before this, a drained Firecrawl wallet was INVISIBLE: the intake run
// reported credits_used:0 / budget_hit:false (the internal counter never
// reflects the real balance), so the cron silently no-op'd every run.
// This makes an empty wallet SCREAM.
//
// Fires CRITICAL when the most recent intake run hit a 402, OR when the
// real balance probe reports credits below a floor. Reads the intake
// audit's firecrawl telemetry (firecrawl_payment_required /
// firecrawl_balance_remaining) — both surfaced by the cron.

import type { PulseDetection } from "../types";
import type { PulseDetectorInput } from "../detector-input";

const DEFAULT_LOW_BALANCE_FLOOR = 50;

function readIntThreshold(
  env: Record<string, string | undefined>,
  key: string,
  fallback: number,
): number {
  const raw = env[key];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

export function detectFirecrawlPaymentRequired(
  input: PulseDetectorInput,
): PulseDetection[] {
  // Most-recent intake run (live or dry) carrying firecrawl telemetry.
  const run = input.audit_log.find(
    (e) =>
      (e.event === "listings_intake_live" || e.event === "listings_intake_dry_run") &&
      e.outputSummary != null &&
      "firecrawl_payment_required" in (e.outputSummary as Record<string, unknown>),
  );
  if (!run) return [];

  const out = run.outputSummary as Record<string, unknown>;
  const paymentRequired = out.firecrawl_payment_required === true;
  const count = typeof out.firecrawl_payment_required_count === "number" ? out.firecrawl_payment_required_count : 0;
  const balance = typeof out.firecrawl_balance_remaining === "number" ? out.firecrawl_balance_remaining : null;
  const keptDue = typeof out.zips_kept_due_blocked === "number" ? out.zips_kept_due_blocked : null;

  const lowFloor = readIntThreshold(input.env, "PULSE_FIRECRAWL_LOW_BALANCE_FLOOR", DEFAULT_LOW_BALANCE_FLOOR);
  const lowBalance = balance != null && balance <= lowFloor;

  // 402 → CRITICAL (the wallet is empty NOW, verify is blocked). Low balance
  // (but no 402 yet) → WARNING (refill before it stops).
  if (!paymentRequired && !lowBalance) return [];

  const severity: PulseDetection["severity"] = paymentRequired ? "critical" : "warning";
  const title = paymentRequired
    ? `Firecrawl WALLET EMPTY — ${count} × 402 on the last intake run`
    : `Firecrawl balance low — ${balance} credits remaining`;
  const description = paymentRequired
    ? `The last listings-intake run hit Firecrawl 402 Payment Required ${count}×. Every verify is failing for lack of ` +
      `credits, so intake is effectively HALTED. ${keptDue != null ? `${keptDue} ZIP(s) were kept DUE (not stamped fresh) ` : ""}` +
      `so the cron resumes the moment the wallet is refilled — it will NOT idle for 24h. ` +
      `Real balance probe: ${balance == null ? "unavailable" : `${balance} credits`}.`
    : `Real Firecrawl balance is ${balance} credits (≤ ${lowFloor} floor). Refill before it hits 0 and 402s start blocking ` +
      `verify. No 402 yet — intake is still running.`;

  return [
    {
      id: "firecrawl_payment_required",
      detector_id: "firecrawl_payment_required",
      severity,
      title,
      description,
      suggested_action:
        "Refill the Firecrawl wallet (FIRECRAWL account billing). The intake freshness cursor keeps the un-verified ZIPs DUE, so coverage self-heals on the next */10 run once credits are back — no manual re-trigger needed.",
      detected_at: input.now().toISOString(),
      source_data: {
        payment_required: paymentRequired,
        payment_required_count: count,
        balance_remaining: balance,
        low_balance_floor: lowFloor,
        zips_kept_due_blocked: keptDue,
      },
    },
  ];
}
