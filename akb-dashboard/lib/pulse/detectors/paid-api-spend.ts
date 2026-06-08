// Paid-API spend detector — surfaces RentCast + ATTOM daily call
// volume and flags per-deal runaway. Derives entirely from the
// existing agent:audit KV list (one paid_api_call entry per outbound
// vendor call, written by lib/spend/audit-paid-call.ts).
//
// Two severity bumps from the same detector — keeps the active-set
// transition story simple (one detection id, one fire / clear lifecycle):
//
//   info     — there is paid-API activity in the last 24h, no deal
//              over the runaway threshold. Routine telemetry.
//   warning  — at least one deal has crossed PULSE_PAID_API_RUNAWAY
//              calls in 24h. The runaway pattern is the bug-class we
//              actually fear (per-deal credit burn from a sweep loop).
//   critical — the warning case, plus the deal's count is ≥ 2× the
//              threshold. Likely a hot loop, not a bad input.
//
// The "info on any activity" pattern is intentional: operator asked
// for a daily anchor line, not just an alarm. Pulse's "info needs
// eyes" convention is preserved by the source_data — the operator
// expands to see per-source split and the top-3 deals.

import type { PulseDetection } from "../types";
import type { PulseDetectorInput } from "../detector-input";
import {
  countCallsByDeal24h,
  countCallsBySource24h,
  splitRunaway,
} from "@/lib/spend/derive";

const DEFAULT_RUNAWAY_THRESHOLD = 10;

function readPositiveInt(
  env: Record<string, string | undefined>,
  key: string,
  fallback: number,
): number {
  const raw = env[key];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return fallback;
  return n;
}

export function detectPaidApiSpend(input: PulseDetectorInput): PulseDetection[] {
  const now = input.now();
  const bySource = countCallsBySource24h(input.audit_log, now);
  if (bySource.total === 0) return [];

  const threshold = readPositiveInt(
    input.env,
    "PULSE_PAID_API_RUNAWAY",
    DEFAULT_RUNAWAY_THRESHOLD,
  );
  const byDeal = countCallsByDeal24h(input.audit_log, now);
  const { runaway } = splitRunaway(byDeal, threshold);

  const topDeals = byDeal.slice(0, 3).map((r) => ({
    recordId: r.recordId,
    calls: r.calls,
    rentcast: r.bySource.rentcast,
    attom: r.bySource.attom,
  }));

  let severity: PulseDetection["severity"] = "info";
  if (runaway.length > 0) {
    const maxCalls = Math.max(...runaway.map((r) => r.calls));
    severity = maxCalls >= threshold * 2 ? "critical" : "warning";
  }

  const title =
    severity === "info"
      ? `Paid-API calls 24h: ${bySource.total} (rentcast=${bySource.rentcast}, attom=${bySource.attom})`
      : `Paid-API runaway: ${runaway.length} deal(s) over ${threshold} calls in 24h`;

  const description = (() => {
    const base = [
      `Last 24h paid-API call totals: rentcast=${bySource.rentcast}, attom=${bySource.attom}, total=${bySource.total}.`,
      `Runaway threshold: ${threshold} calls per deal in 24h (env PULSE_PAID_API_RUNAWAY).`,
    ];
    if (runaway.length === 0) {
      base.push("No deal has crossed the threshold — routine daily anchor.");
    } else {
      const list = runaway
        .map((r) => `${r.recordId}=${r.calls} (rc=${r.bySource.rentcast},at=${r.bySource.attom})`)
        .join("; ");
      base.push(`Runaway deals: ${list}.`);
    }
    return base.join(" ");
  })();

  const suggested_action =
    severity === "critical"
      ? "A single deal is burning RentCast/ATTOM credits at ≥2× the runaway threshold. Likely a hot loop or retry storm — investigate that deal's recent paid_api_call entries in the audit log and pause the offending sweep."
      : severity === "warning"
        ? "One or more deals have crossed the runaway threshold. Check the per-deal counts in source_data; if a deal genuinely needs more calls (e.g. a CMA backfill), raise PULSE_PAID_API_RUNAWAY temporarily — otherwise pause the responsible cron / route."
        : "Routine daily total. Expand source_data to see top deals if you want a per-deal view.";

  return [
    {
      id: "paid_api_spend_24h",
      detector_id: "paid_api_spend_24h",
      severity,
      title,
      description,
      suggested_action,
      detected_at: now.toISOString(),
      source_data: {
        by_source_24h: bySource,
        runaway_threshold: threshold,
        runaway_deals: runaway,
        top_deals_24h: topDeals,
      },
    },
  ];
}
