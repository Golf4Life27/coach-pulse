// INV-005 — Rehab vision retry + drift-detection pure helpers.
// @agent: appraiser
//
// Backs /api/cron/rehab-vision-retry (daily 15:00 UTC). For every
// active listing whose Est_Rehab was set via the manual fallback
// (Rehab_Source = "manual_operator"), the cron re-runs the vision
// pipeline. If vision now succeeds AND the result drifts more than
// DRIFT_THRESHOLD_PCT from the manual value, the cron appends a Notes
// line with DRIFT_NOTES_MARKER so AppraiserRehabPanel can surface a
// Type 2C banner with [Accept vision update] / [Keep manual].
//
// Critical discipline (Constitution Rule 3 + INV-005 spec point 6):
//   - NEVER silently overwrites manual Est_Rehab values
//   - Cooldown prevents daily burn on records vision will keep failing
//   - Resolution happens only via operator click in the UI, never the cron

export const DRIFT_NOTES_MARKER = "[REHAB_DRIFT_DETECTED]";
export const RETRY_COOLDOWN_NOTES_MARKER = "[REHAB_VISION_RETRY]";
export const RETRY_COOLDOWN_DAYS = 7;
export const DRIFT_THRESHOLD_PCT = 25;

/** Minimal listing shape the retry decision reads. Mirrors the
 *  ReconcileListing pattern from INV-006 — pure helpers stay
 *  decoupled from the full Listing type. */
export interface RehabRetryListing {
  rehabSource: string | null;
  liveStatus: string | null;
  notes: string | null;
}

export interface RehabRetryDecision {
  action: "retry" | "skip";
  reason:
    | "not_manual"
    | "not_active"
    | "in_cooldown"
    | "should_retry";
}

export interface DriftResult {
  driftPct: number;
  exceedsThreshold: boolean;
  /** Signed delta: positive = vision higher than manual, negative = lower. */
  delta: number;
}

/** Pure: decide whether this listing should be retried in the current
 *  cron tick. Skips records whose rehab is vision-sourced, inactive,
 *  or were already retried within RETRY_COOLDOWN_DAYS. */
export function shouldRetryVision(
  listing: RehabRetryListing,
  now: Date = new Date(),
): RehabRetryDecision {
  if (listing.rehabSource !== "manual_operator") {
    return { action: "skip", reason: "not_manual" };
  }
  if (listing.liveStatus !== "Active") {
    return { action: "skip", reason: "not_active" };
  }
  if (lastRetryWithinCooldown(listing.notes, now)) {
    return { action: "skip", reason: "in_cooldown" };
  }
  return { action: "retry", reason: "should_retry" };
}

/** Pure: scan Notes for the most recent RETRY_COOLDOWN_NOTES_MARKER
 *  timestamp and return true if it was written within the cooldown
 *  window. Null/empty notes → false (never retried before). */
export function lastRetryWithinCooldown(
  notes: string | null,
  now: Date,
): boolean {
  if (!notes) return false;
  const lines = notes.split("\n");
  // Walk newest-first; the cron appends each retry stamp, so the last
  // line containing the marker is the most recent.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.includes(RETRY_COOLDOWN_NOTES_MARKER)) continue;
    const iso = extractIsoTimestamp(line);
    if (!iso) continue;
    const t = Date.parse(iso);
    if (Number.isNaN(t)) continue;
    const ageMs = now.getTime() - t;
    return ageMs < RETRY_COOLDOWN_DAYS * 86_400_000;
  }
  return false;
}

/** Pure: extract an ISO 8601 timestamp from a free-text line. Returns
 *  the first match or null. Used by lastRetryWithinCooldown to walk
 *  the Notes audit trail. */
export function extractIsoTimestamp(line: string): string | null {
  const m = line.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/);
  return m ? m[0] : null;
}

/** Pure: compare the manual mid against the freshly-computed vision
 *  mid. Drift % is relative to the manual value (operator's anchor).
 *  Zero or negative manual is treated as ineligible — drift undefined. */
export function computeDrift(
  manualMid: number,
  visionMid: number,
): DriftResult {
  if (manualMid <= 0) {
    return { driftPct: 0, exceedsThreshold: false, delta: 0 };
  }
  const delta = visionMid - manualMid;
  const driftPct = (Math.abs(delta) / manualMid) * 100;
  return {
    driftPct,
    exceedsThreshold: driftPct > DRIFT_THRESHOLD_PCT,
    delta,
  };
}

/** Pure: build the Notes line written when the cron successfully runs
 *  vision and detects significant drift. Contains the DRIFT_NOTES_MARKER
 *  so AppraiserRehabPanel can scan for it. */
export function buildDriftNotesLine(
  now: Date,
  manualMid: number,
  visionMid: number,
  drift: DriftResult,
): string {
  const direction = drift.delta > 0 ? "higher" : "lower";
  return (
    `${now.toISOString()} — ${DRIFT_NOTES_MARKER} INV-005 cron: ` +
    `vision now estimates $${Math.round(visionMid).toLocaleString("en-US")}, ` +
    `manual entry was $${Math.round(manualMid).toLocaleString("en-US")} ` +
    `(vision ${drift.driftPct.toFixed(1)}% ${direction}; threshold ${DRIFT_THRESHOLD_PCT}%). ` +
    `Operator decision required — automated overwrite suppressed per Constitution Rule 3.`
  );
}

/** Pure: build the Notes line for a retry tick that did NOT detect
 *  drift (or could not run vision). Carries the cooldown marker. */
export function buildRetryStampLine(
  now: Date,
  outcome: "vision_failed" | "vision_agrees" | "drift_detected",
  detail: string,
): string {
  return `${now.toISOString()} — ${RETRY_COOLDOWN_NOTES_MARKER} INV-005 cron tick: ${outcome} (${detail}).`;
}

/** Pure: detect whether a listing's Notes contain an unresolved drift
 *  marker. AppraiserRehabPanel uses this to decide whether to render
 *  the Type 2C drift banner. The dismiss action writes a separate
 *  resolution line that suppresses the banner. */
export function hasUnresolvedDriftMarker(notes: string | null): boolean {
  if (!notes) return false;
  if (!notes.includes(DRIFT_NOTES_MARKER)) return false;
  // Walk lines newest-first. If the most-recent DRIFT marker has a
  // matching RESOLVED line after it, banner is suppressed.
  const lines = notes.split("\n");
  let latestDriftIdx = -1;
  let latestResolvedIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(DRIFT_NOTES_MARKER)) latestDriftIdx = i;
    if (lines[i].includes(DRIFT_RESOLVED_MARKER)) latestResolvedIdx = i;
  }
  return latestDriftIdx > latestResolvedIdx;
}

export const DRIFT_RESOLVED_MARKER = "[REHAB_DRIFT_RESOLVED]";

/** Pure: line written when operator resolves the drift via the UI
 *  ([Accept vision update] or [Keep manual]). Suppresses the banner. */
export function buildDriftResolvedLine(
  now: Date,
  resolution: "accepted_vision" | "kept_manual",
): string {
  return `${now.toISOString()} — ${DRIFT_RESOLVED_MARKER} INV-005: operator ${resolution.replace("_", " ")}.`;
}
