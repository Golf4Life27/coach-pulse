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
import { detectQuoQuotaBurn } from "./detectors/quo-quota-burn";
import { detectIntakeSignal } from "./detectors/intake-signal";
import { detectZipSaturation } from "./detectors/zip-saturation";

import { audit } from "@/lib/audit-log";
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
    ...detectQuoQuotaBurn(input),
    ...detectIntakeSignal(input),
    ...detectZipSaturation(input),
  ];
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
    elapsed_ms: Date.now() - t0,
  };
}
