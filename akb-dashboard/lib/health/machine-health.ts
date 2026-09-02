// Pure shaping for the Machine Health screen (2026-09-02). Reads the raw
// audit rows the existing /api/admin/audit-tail route returns and the Pulse
// detections, and produces what the operator needs to read in five seconds.
// No I/O — tested in lib/health/machine-health.test.ts.

import type { PulseDetection } from "@/lib/pulse/types";

export interface AuditRow {
  ts: string;
  agent?: string;
  event: string;
  status?: string;
  inputSummary?: Record<string, unknown>;
  outputSummary?: Record<string, unknown>;
}

export interface LaneRun {
  ts: string;
  lane: "outreach" | "bump";
  processed: number;
  sent: number;
  errors: number;
  probeCredits: number;
  blank: boolean;
  note: string;
}

export interface LaneRunSummary {
  runs: LaneRun[];
  runsToday: number;
  sentToday: number;
  blankRunsToday: number;
  probeCreditsToday: number;
  dailyCap: number | null;
  lastSentAt: string | null;
}

const DAY_MS = 24 * 3_600_000;

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export function parseLaneRun(row: AuditRow): LaneRun | null {
  const o = row.outputSummary ?? {};
  if (row.event === "h2_outreach_live") {
    const processed = num(o.processed);
    const sent = num(o.first_touch_sent);
    const errors = num(o.errors);
    const probe = (o.presend_probe as { credits_used?: unknown } | undefined)?.credits_used;
    const breaker = o.quo_breaker as { tripped?: boolean } | undefined;
    const blank = processed > 0 && sent === 0 && errors > 0;
    return {
      ts: row.ts,
      lane: "outreach",
      processed,
      sent,
      errors,
      probeCredits: num(probe),
      blank,
      note: breaker?.tripped ? "402 breaker tripped" : blank ? "blank run" : "",
    };
  }
  if (row.event === "h2_bump_live") {
    const processed = num(o.processed);
    const sent = num(o.bumped);
    const errors = num(o.errors);
    const breaker = o.quo_breaker as { tripped?: boolean } | undefined;
    const blank = processed > 0 && sent === 0 && errors > 0;
    return { ts: row.ts, lane: "bump", processed, sent, errors, probeCredits: 0, blank, note: breaker?.tripped ? "402 breaker tripped" : blank ? "blank run" : "" };
  }
  return null;
}

export function summarizeLaneRuns(rows: AuditRow[], nowMs: number): LaneRunSummary {
  const runs = rows
    .map(parseLaneRun)
    .filter((r): r is LaneRun => r !== null)
    .filter((r) => nowMs - Date.parse(r.ts) <= DAY_MS)
    .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
  let dailyCap: number | null = null;
  for (const row of rows) {
    const cap = (row.outputSummary?.send_cap as { daily?: { cap?: unknown } } | undefined)?.daily?.cap;
    if (typeof cap === "number") {
      dailyCap = cap;
      break;
    }
  }
  const lastSent = runs.find((r) => r.sent > 0);
  return {
    runs,
    runsToday: runs.length,
    sentToday: runs.reduce((a, r) => a + r.sent, 0),
    blankRunsToday: runs.filter((r) => r.blank).length,
    probeCreditsToday: runs.reduce((a, r) => a + r.probeCredits, 0),
    dailyCap,
    lastSentAt: lastSent?.ts ?? null,
  };
}

export interface VendorRow {
  name: string;
  ok: boolean;
  detail: string;
}

export interface VendorSummary {
  rows: VendorRow[];
  quoCredits: { ok: boolean; label: string; detail: string };
}

/** Connector status from what the detectors already know. A vendor with no
 *  detection against it is reported OK — the detectors are the source of
 *  truth, this screen only renders them. */
export function summarizeVendors(detections: PulseDetection[], trips: AuditRow[], nowMs: number): VendorSummary {
  const bad = (needle: RegExp) => detections.find((d) => needle.test(`${d.detector_id} ${d.title}`));
  const lastTrip = trips
    .filter((t) => t.event === "quo_credits_exhausted")
    .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))[0];
  const tripRecent = lastTrip ? nowMs - Date.parse(lastTrip.ts) < 6 * 3_600_000 : false;
  const quoAuth = bad(/vendor_health.*quo|quo.*(auth|403|401)/i);
  const fc = bad(/firecrawl_payment_required/i);
  const rc = bad(/vendor_health.*rentcast|rentcast.*(auth|403|401|cap)/i);
  const cron = bad(/cron_cycle_silent|send slot/i);
  const rows: VendorRow[] = [
    { name: "Quo (send)", ok: !quoAuth && !tripRecent, detail: tripRecent ? `402 at ${lastTrip!.ts.slice(11, 16)}Z — add credits` : quoAuth ? quoAuth.title : "key + credits OK" },
    { name: "Firecrawl", ok: !fc, detail: fc ? fc.title : "probes paying" },
    { name: "RentCast / ATTOM", ok: !rc, detail: rc ? rc.title : "comps paying" },
    { name: "Cron slots", ok: !cron, detail: cron ? cron.title : "all slots ran" },
  ];
  return {
    rows,
    quoCredits: tripRecent
      ? { ok: false, label: "EMPTY", detail: `402 at ${lastTrip!.ts.slice(11, 16)}Z · lane tripped` }
      : { ok: true, label: "OK", detail: lastTrip ? `last 402 ${lastTrip.ts.slice(0, 10)}` : "no 402 on record" },
  };
}
