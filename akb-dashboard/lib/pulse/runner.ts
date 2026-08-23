// Phase 14 / O.1 — Pulse scan runner.
//
// Composes the 6 detectors, diffs the current detection set against
// the previously-active set in KV, and writes Spine + audit entries
// for state transitions (new fires and resolutions). Steady-state
// detections don't re-write to Spine — keeps the decision log clean.
//
// The detectors themselves are pure functions over PulseDetectorInput.
// The runner does the I/O: audit-log read, listings read, KV state
// read/write, Spine writes via lib/maverick/write-state.writeState.

import type { PulseDetection } from "./types";
import type { PulseDetectorInput } from "./detector-input";
import {
  type PulseActiveEntry,
  type PulseActiveState,
  readPulseState,
  writePulseState,
} from "./active-store";

import { detectTokenBurn } from "./detectors/token-burn";
import { detectCronCycleSilent } from "./detectors/cron-cycle";
import { detectSpineWriteRate } from "./detectors/spine-write-rate";
import { detectTestCountRegression } from "./detectors/test-count-regression";
import { detectEndpointErrorRate } from "./detectors/endpoint-error-rate";
import { detectStaleDataDrift } from "./detectors/stale-data-drift";
import { detectVoiceDrift } from "./detectors/voice-drift";
import { detectOutreachVolumeDrop } from "./detectors/outreach-volume-drop";
import { detectSendLaneTripwire } from "./detectors/send-lane-tripwire";
import { detectQuoQuotaBurn } from "./detectors/quo-quota-burn";
import { detectIntakeSignal } from "./detectors/intake-signal";
import { detectVerificationUrlCoverage } from "./detectors/verification-url-coverage";
import { detectPaidApiSpend } from "./detectors/paid-api-spend";
import { detectProgressMeterMovement } from "./detectors/progress-meter-movement";
import { detectUnbackedReplyStatus } from "./detectors/unbacked-reply-status";
import { detectIntakeRunDuration } from "./detectors/intake-run-duration";
import { detectFirecrawlPaymentRequired } from "./detectors/firecrawl-payment-required";
import { detectVendorHealth } from "./detectors/vendor-health";

import { audit } from "@/lib/audit-log";
import { sendMessage } from "@/lib/quo";
import { writeState, type WriteStateDeps } from "@/lib/maverick/write-state";

export interface PulseScanResult {
  detections: PulseDetection[];
  /** Detection IDs that fired fresh this scan (transitioned off→on). */
  new_ids: string[];
  /** Detection IDs that resolved this scan (transitioned on→off). */
  resolved_ids: string[];
  /** Detection IDs that fired both this scan and the previous one. */
  steady_ids: string[];
  /** Spine row IDs written (for new + resolved). */
  spine_writes: string[];
  /** Snapshot of the state Pulse just persisted. */
  state: PulseActiveState;
  /** Detection IDs that paged the operator by SMS this scan. */
  paged_ids: string[];
  elapsed_ms: number;
}

/** All detectors, in deterministic order. Output is concatenated and
 *  passed back; the active-set diff handles dedupe / ordering. */
export function runAllDetectors(input: PulseDetectorInput): PulseDetection[] {
  return [
    ...detectTokenBurn(input),
    ...detectCronCycleSilent(input),
    ...detectSpineWriteRate(input),
    ...detectTestCountRegression(input),
    ...detectEndpointErrorRate(input),
    ...detectStaleDataDrift(input),
    ...detectVoiceDrift(input),
    ...detectOutreachVolumeDrop(input),
    ...detectSendLaneTripwire(input),
    ...detectQuoQuotaBurn(input),
    ...detectIntakeSignal(input),
    ...detectVerificationUrlCoverage(input),
    ...detectPaidApiSpend(input),
    ...detectProgressMeterMovement(input),
    ...detectUnbackedReplyStatus(input),
    ...detectIntakeRunDuration(input),
    ...detectFirecrawlPaymentRequired(input),
    ...detectVendorHealth(input),
  ];
}

// ── Operator paging (operator 2026-08-04, the silent-403 incident) ─────────
//
// Pulse has always written Spine + audit and NOTHING else, so a detection was
// only ever as loud as someone choosing to go read it. RentCast 403'd for two
// days, every failure was recorded, and the operator still found it by feel.
// Detections that mean "a vendor the business stands on is down" now page him.
//
// Deliberately NARROW. Pulse runs 17 detectors and most are advisory (test
// count drift, voice drift, meter movement) — paging on all of them trains
// him to ignore the channel, which is how the next real outage gets missed.
// Widen via PULSE_PAGING_DETECTORS (comma-separated detector_ids) rather than
// by loosening this default.
// send_lane_tripwire added 2026-08-23: the tripwire was BUILT to page (its
// whole spec — "the system now notices its own zero-send failures" — assumed
// the operator hears about it), but it was never added here, so the 2026-08-23
// 0-for-10 creative slots fired the detection into the Spine at 16:25Z and the
// operator's phone stayed silent. A watchdog whose bark stops at the filing
// cabinet is the 2026-08-04 silent-403 incident with extra steps.
const DEFAULT_PAGING_DETECTORS = ["vendor_health", "firecrawl_payment_required", "send_lane_tripwire"];

function pagingDetectors(env: Record<string, string | undefined>): Set<string> {
  const raw = env.PULSE_PAGING_DETECTORS;
  if (!raw) return new Set(DEFAULT_PAGING_DETECTORS);
  const ids = raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  return new Set(ids.length > 0 ? ids : DEFAULT_PAGING_DETECTORS);
}

/** Best-effort operator SMS. Never throws — a paging failure must not abort
 *  the scan that produced the detection (the Spine row is the durable record;
 *  the page is the courtesy).
 *
 *  CHANNEL SEPARATION (operator 2026-06-10, mirrored from sendReplyAlert):
 *  operator alerts send FROM the dedicated Maverick line (ALERT_FROM), NEVER
 *  from the agent-facing outreach line. Unset ALERT_FROM REFUSES rather than
 *  falling back — the hard rule beats delivery. This path is deliberately
 *  OUTSIDE sendGuarded per INVARIANTS §7: it carries no listing and no
 *  seller, and the active-set diff is its dedupe. */
async function pageOperator(
  det: PulseDetection,
  env: Record<string, string | undefined>,
  auditFn: typeof audit,
  sendFn: typeof sendMessage,
): Promise<boolean> {
  const to = (env.ALERT_PHONE ?? "").trim();
  const from = (env.ALERT_FROM ?? "").trim();
  if (!to || !from) {
    await auditFn({
      agent: "pulse",
      event: "pulse_page_skipped",
      status: "uncertain",
      inputSummary: {
        detection_id: det.id,
        reason: !to
          ? "ALERT_PHONE not set"
          : "ALERT_FROM not set — refusing to send from the agent-facing outreach line (channel separation)",
      },
      outputSummary: { sent: false },
    });
    return false;
  }
  const body = `${det.severity === "critical" ? "CRITICAL" : "WARNING"}: ${det.title}${
    det.suggested_action ? ` — ${det.suggested_action}` : ""
  }`.slice(0, 480);
  try {
    await sendFn(to, body, { from });
    await auditFn({
      agent: "pulse",
      event: "pulse_page_sent",
      status: "confirmed_success",
      inputSummary: {
        detection_id: det.id,
        to_masked: `${to.slice(0, 4)}…${to.slice(-4)}`,
        body_len: body.length,
      },
      outputSummary: { sent: true },
      decision: det.severity,
    });
    return true;
  } catch (err) {
    await auditFn({
      agent: "pulse",
      event: "pulse_page_failed",
      status: "confirmed_failure",
      inputSummary: { detection_id: det.id, to_masked: `${to.slice(0, 4)}…${to.slice(-4)}` },
      outputSummary: { sent: false, error: String(err).slice(0, 200) },
    });
    return false;
  }
}

/** Pure: split a fresh detection set against a previously-active map
 *  into the three transition buckets the runner writes Spine for. */
export function diffActiveSet(
  current: PulseDetection[],
  previousActive: Record<string, PulseActiveEntry>,
): { new_ids: string[]; resolved_ids: string[]; steady_ids: string[] } {
  const currentIds = new Set(current.map((d) => d.id));
  const previousIds = new Set(Object.keys(previousActive));

  const new_ids: string[] = [];
  for (const id of currentIds) {
    if (!previousIds.has(id)) new_ids.push(id);
  }
  const resolved_ids: string[] = [];
  for (const id of previousIds) {
    if (!currentIds.has(id)) resolved_ids.push(id);
  }
  const steady_ids: string[] = [];
  for (const id of currentIds) {
    if (previousIds.has(id)) steady_ids.push(id);
  }
  return {
    new_ids: new_ids.sort(),
    resolved_ids: resolved_ids.sort(),
    steady_ids: steady_ids.sort(),
  };
}

export interface PulseRunnerDeps {
  /** Spine-write fn — defaults to lib/maverick/write-state.writeState
   *  but can be stubbed in tests to assert on Spine calls without
   *  hitting Airtable. */
  writeStateFn?: typeof writeState;
  writeStateDeps?: WriteStateDeps;
  /** Audit-write fn — same testability seam. */
  auditFn?: typeof audit;
  /** Active-state I/O — same testability seam. */
  readState?: typeof readPulseState;
  writeStateStore?: typeof writePulseState;
  /** Operator-paging SMS sender — same testability seam. */
  sendFn?: typeof sendMessage;
}

const FIRST_SEEN_FALLBACK = (now: Date) => now.toISOString();

/** Compose the runner: read state, run detectors, diff, write
 *  transitions to Spine + audit, persist new state. */
export async function runPulseScan(
  input: PulseDetectorInput,
  deps: PulseRunnerDeps = {},
): Promise<PulseScanResult> {
  const t0 = Date.now();
  const readFn = deps.readState ?? readPulseState;
  const writeFn = deps.writeStateStore ?? writePulseState;
  const writeStateFn = deps.writeStateFn ?? writeState;
  const auditFn = deps.auditFn ?? audit;
  const sendFn = deps.sendFn ?? sendMessage;
  const pageable = pagingDetectors(input.env);
  const pagedIds: string[] = [];

  const previousState = await readFn();
  const detections = runAllDetectors(input);
  const { new_ids, resolved_ids, steady_ids } = diffActiveSet(detections, previousState.active);

  const now = input.now();
  const detectionsById = new Map(detections.map((d) => [d.id, d]));
  const spineWrites: string[] = [];

  // Write Spine + audit for fresh detections.
  for (const id of new_ids) {
    const det = detectionsById.get(id);
    if (!det) continue;
    try {
      const res = await writeStateFn(
        {
          event_type: "build_event",
          title: `Pulse: ${det.title}`,
          description: det.description,
          reasoning: det.suggested_action,
          attribution_agent: "pulse",
        },
        deps.writeStateDeps,
      );
      spineWrites.push(res.spine_record_id);
    } catch (err) {
      console.error(`[pulse-runner] Spine write failed for ${id}:`, err);
    }
    await auditFn({
      agent: "pulse",
      event: "pulse_detection_fired",
      status: "confirmed_success",
      inputSummary: { detection_id: id, detector: det.detector_id },
      outputSummary: {
        severity: det.severity,
        title: det.title,
        source_data: det.source_data,
      },
      decision: det.severity,
    });
    // Edge-triggered by construction: this loop is the off→on transition, so
    // a standing outage pages ONCE, not on every scan.
    if (pageable.has(det.detector_id)) {
      if (await pageOperator(det, input.env, auditFn, sendFn)) pagedIds.push(id);
    }
  }

  // Write Spine + audit for resolutions.
  for (const id of resolved_ids) {
    const firstSeen = previousState.active[id]?.first_seen_at ?? null;
    try {
      const res = await writeStateFn(
        {
          event_type: "build_event",
          title: `Pulse: ${id} resolved`,
          description: `Detection ${id} cleared. First seen at ${firstSeen ?? "(unknown)"}; resolved at ${now.toISOString()}.`,
          reasoning: "Detector no longer fires on the current state.",
          attribution_agent: "pulse",
        },
        deps.writeStateDeps,
      );
      spineWrites.push(res.spine_record_id);
    } catch (err) {
      console.error(`[pulse-runner] Spine resolution write failed for ${id}:`, err);
    }
    await auditFn({
      agent: "pulse",
      event: "pulse_detection_resolved",
      status: "confirmed_success",
      inputSummary: { detection_id: id, first_seen_at: firstSeen },
      outputSummary: { resolved_at: now.toISOString() },
      decision: "resolved",
    });
  }

  // Build next active map. New detections take now's timestamp as
  // first-seen; steady detections keep their previous first-seen
  // but pick up the latest detection payload (so source_data + title
  // stay fresh when the underlying metric shifts).
  const nextActive: Record<string, PulseActiveEntry> = {};
  for (const id of new_ids) {
    const det = detectionsById.get(id);
    if (!det) continue;
    nextActive[id] = { detection: det, first_seen_at: FIRST_SEEN_FALLBACK(now) };
  }
  for (const id of steady_ids) {
    const det = detectionsById.get(id);
    if (!det) continue;
    nextActive[id] = {
      detection: det,
      first_seen_at: previousState.active[id]?.first_seen_at ?? FIRST_SEEN_FALLBACK(now),
    };
  }

  const nextState: PulseActiveState = {
    active: nextActive,
    test_count_anchor: input.test_count ?? previousState.test_count_anchor,
    // Anchor the meter snapshot for the next scan's movement detection.
    // Preserve the previous anchor when the meter wasn't computed this
    // scan (so a transient meter-fetch failure doesn't lose the baseline).
    progress_meter_anchor:
      input.progress_meter ?? previousState.progress_meter_anchor,
    last_scan_at: now.toISOString(),
  };
  await writeFn(nextState);

  return {
    detections,
    new_ids,
    resolved_ids,
    steady_ids,
    spine_writes: spineWrites,
    state: nextState,
    paged_ids: pagedIds,
    elapsed_ms: Date.now() - t0,
  };
}
