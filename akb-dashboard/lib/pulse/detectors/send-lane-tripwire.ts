// Send-lane tripwire — the "firing blanks" detector. @agent: pulse
//
// WHY (operator 2026-08-18, the zero-send day + freeze mandate): the system
// went a full morning at zero sends and only the OPERATOR noticed. Three
// stacked defects (poison claims, quarantines hiding Quo ids, a skipped
// production deploy) each ran silently because nothing compared what the
// lanes PLANNED against what they actually SENT. The pre-existing
// outreach_volume_drop detector counts audit events from a previous
// architecture ("send_attempt", "scout_*") that the modern lanes never
// write — it has been measuring zero forever and therefore never fires
// (needs ≥10 historical events to trust itself).
//
// This detector reads the REAL lane-run entries (h2_outreach_live /
// creative_outreach_live outputSummary) and fires on:
//   A. CRITICAL — a live run tried and delivered nothing: work was
//      available (processed / refused / skipped / errors > 0) but
//      sent == 0. That is the exact signature of every silent failure
//      this system has had: claims wedged, gate refusing everything,
//      Quo auth down. The description carries the run's own counters so
//      the alert names the failure class.
//   B. WARNING — scheduled slots inside the VISIBLE audit window did not
//      run at all (no audit entry): the cron-misfire / skipped-deploy
//      class. Expected-slot tables mirror vercel.json — update together.
//
// HONEST-COVERAGE RULE: the runner hands us a bounded audit window
// (~500 entries; high-volume crons shrink its reach). Slots are only
// counted "expected" when they fall fully inside the window we can
// actually see — the detector never alarms about time it cannot observe.
//
// Pure. No I/O. Thresholds env-tunable (PULSE_SEND_TRIPWIRE_*).

import type { AuditEntry } from "@/lib/audit-log";
import type { PulseDetection } from "../types";
import type { PulseDetectorInput } from "../detector-input";

/** Mirror of vercel.json's live send slots (UTC "HH:MM"). Update together. */
export const H2_LIVE_SLOTS_UTC = [
  "13:00", "14:00", "15:00", "16:00", "16:30", "17:30", "18:30",
  "19:45", "20:30", "21:30", "22:30", "23:45",
] as const;
export const CREATIVE_LIVE_SLOTS_UTC = ["15:35", "17:35", "19:35", "21:35"] as const;

/** Grace between a slot's scheduled minute and when we require its audit
 *  entry to exist (cron dispatch + run duration + audit write). */
const SLOT_GRACE_MS = 10 * 60_000;

const LANE_EVENTS = ["h2_outreach_live", "creative_outreach_live"] as const;
type LaneEvent = (typeof LANE_EVENTS)[number];

interface LaneRun {
  event: LaneEvent;
  ts: number;
  iso: string;
  sent: number;
  attempted: number; // work the run had in hand (processed/refused/skips/errors)
  counters: Record<string, number>;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Pure: normalize a lane-run audit entry to comparable counters. */
export function parseLaneRun(e: AuditEntry): LaneRun | null {
  if (!LANE_EVENTS.includes(e.event as LaneEvent)) return null;
  const t = Date.parse(e.ts);
  if (!Number.isFinite(t)) return null;
  const o = (e.outputSummary ?? {}) as Record<string, unknown>;
  const counters: Record<string, number> = {};
  for (const k of [
    "first_touch_sent", "sent", "planned", "processed", "errors", "refused",
    "idempotent_skipped", "outside_hours", "delivery_quarantined", "skipped", "unconfirmed",
  ]) {
    if (k in o) counters[k] = num(o[k]);
  }
  const sent = e.event === "h2_outreach_live" ? num(o.first_touch_sent) : num(o.sent);
  const attempted =
    e.event === "h2_outreach_live"
      ? num(o.processed) + num(o.errors) + num(o.idempotent_skipped) + num(o.outside_hours)
      : num(o.planned);
  return { event: e.event as LaneEvent, ts: t, iso: e.ts, sent, attempted, counters };
}

/** Pure: slot times (ms) for a UTC day that fall FULLY inside [windowStart,
 *  now - grace] — only slots we can see and that had time to complete. */
export function expectedSlotsInWindow(
  slots: readonly string[],
  windowStartMs: number,
  nowMs: number,
): number[] {
  const out: number[] = [];
  // Cover yesterday + today: the window can cross midnight UTC.
  for (const dayOffset of [-1, 0]) {
    const day = new Date(nowMs + dayOffset * 86_400_000);
    const y = day.getUTCFullYear();
    const m = day.getUTCMonth();
    const d = day.getUTCDate();
    for (const s of slots) {
      const [hh, mm] = s.split(":").map(Number);
      const t = Date.UTC(y, m, d, hh, mm, 0, 0);
      if (t >= windowStartMs && t + SLOT_GRACE_MS <= nowMs) out.push(t);
    }
  }
  return out.sort((a, b) => a - b);
}

export function detectSendLaneTripwire(input: PulseDetectorInput): PulseDetection[] {
  const nowMs = input.now().getTime();
  const runs = input.audit_log.map(parseLaneRun).filter((r): r is LaneRun => r !== null);
  const detections: PulseDetection[] = [];

  // Visible window = oldest audit entry we were handed (honest coverage).
  let windowStartMs = nowMs;
  for (const e of input.audit_log) {
    const t = Date.parse(e.ts);
    if (Number.isFinite(t) && t < windowStartMs) windowStartMs = t;
  }

  // ── Rule A: live runs that tried and delivered nothing.
  const blanks = runs.filter((r) => r.attempted > 0 && r.sent === 0);
  const blanksRecent = blanks.filter((r) => nowMs - r.ts <= 6 * 3_600_000);
  if (blanksRecent.length > 0) {
    const newest = blanksRecent.reduce((a, b) => (a.ts > b.ts ? a : b));
    const totalSentWindow = runs.reduce((s, r) => s + r.sent, 0);
    detections.push({
      id: "send_lane_tripwire_blanks",
      detector_id: "send_lane_tripwire",
      severity: "critical",
      confidence: 1.0,
      title: `Send lane firing blanks: ${blanksRecent.length} live run(s) in 6h had work but sent 0 (latest ${newest.event} at ${newest.iso})`,
      description:
        `A live send run had records in hand and delivered zero texts — the signature of a wedged/refusing lane ` +
        `(poison claims, gate refusals, Quo auth down, carrier failures). Latest blank run counters: ` +
        `${JSON.stringify(newest.counters)}. Total sent across all visible lane runs: ${totalSentWindow}. ` +
        `The run's own audit entries (send_gate_refused / h2_presend_probe_* / send_gate_thread_truth_refused near ` +
        `${newest.iso}) name the exact block.`,
      suggested_action:
        "Read audit-tail (workflow audit-tail.yml) for the blank run's timestamp: filter send_gate_refused and probe events. If reasons say thread_truth_unavailable, check the Quo API key first.",
      detected_at: input.now().toISOString(),
      source_data: {
        blank_runs: blanksRecent.map((r) => ({ event: r.event, ts: r.iso, counters: r.counters })),
        total_sent_in_window: totalSentWindow,
      },
    });
  }

  // ── Rule B: scheduled slots inside the visible window that never ran.
  const laneTable: Array<{ event: LaneEvent; slots: readonly string[] }> = [
    { event: "h2_outreach_live", slots: H2_LIVE_SLOTS_UTC },
    { event: "creative_outreach_live", slots: CREATIVE_LIVE_SLOTS_UTC },
  ];
  const missingByLane: Record<string, { expected: number; observed: number; missing: number }> = {};
  let totalMissing = 0;
  for (const { event, slots } of laneTable) {
    const expected = expectedSlotsInWindow(slots, windowStartMs, nowMs);
    const observed = runs.filter((r) => r.event === event);
    // A slot counts as covered when a run of that lane landed within grace of it.
    let missing = 0;
    for (const slotMs of expected) {
      const hit = observed.some((r) => Math.abs(r.ts - slotMs) <= SLOT_GRACE_MS);
      if (!hit) missing++;
    }
    missingByLane[event] = { expected: expected.length, observed: observed.length, missing };
    totalMissing += missing;
  }
  const missWarn = Number(input.env.PULSE_SEND_TRIPWIRE_MISSED_SLOTS_WARN ?? 2);
  const missCrit = Number(input.env.PULSE_SEND_TRIPWIRE_MISSED_SLOTS_CRIT ?? 4);
  if (totalMissing >= missWarn) {
    detections.push({
      id: "send_lane_tripwire_missed_slots",
      detector_id: "send_lane_tripwire",
      severity: totalMissing >= missCrit ? "critical" : "warning",
      confidence: 1.0,
      title: `${totalMissing} scheduled send slot(s) never ran in the visible window`,
      description:
        `Cron slots inside the observable audit window left no lane-run audit entry — the cron-misfire / ` +
        `skipped-production-deploy class (2026-08-18: Vercel silently skipped the prod build for a main push and ` +
        `the creative slots never registered). Per lane: ${JSON.stringify(missingByLane)}. Window start: ` +
        `${new Date(windowStartMs).toISOString()}.`,
      suggested_action:
        "Verify the latest main commit has a READY *production* deployment on Vercel (branch-only builds don't register crons). If prod is current, check Vercel cron logs for the missing slots.",
      detected_at: input.now().toISOString(),
      source_data: { by_lane: missingByLane, window_start: new Date(windowStartMs).toISOString() },
    });
  }

  return detections;
}
