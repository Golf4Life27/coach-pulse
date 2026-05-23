// INV-005 — rehab-vision-retry pure helper tests.

import { describe, it, expect } from "vitest";
import {
  shouldRetryVision,
  computeDrift,
  buildDriftNotesLine,
  buildRetryStampLine,
  buildDriftResolvedLine,
  lastRetryWithinCooldown,
  extractIsoTimestamp,
  hasUnresolvedDriftMarker,
  DRIFT_NOTES_MARKER,
  DRIFT_RESOLVED_MARKER,
  RETRY_COOLDOWN_NOTES_MARKER,
  RETRY_COOLDOWN_DAYS,
  DRIFT_THRESHOLD_PCT,
  type RehabRetryListing,
} from "./rehab-vision-retry";

function rec(over: Partial<RehabRetryListing> = {}): RehabRetryListing {
  return {
    rehabSource: "manual_operator",
    liveStatus: "Active",
    notes: null,
    ...over,
  };
}

describe("shouldRetryVision — INV-005 retry predicate", () => {
  it("retries an active manual_operator record with no prior retry", () => {
    const d = shouldRetryVision(rec());
    expect(d.action).toBe("retry");
    expect(d.reason).toBe("should_retry");
  });

  it("skips records where rehab came from vision", () => {
    const d = shouldRetryVision(rec({ rehabSource: "vision" }));
    expect(d.action).toBe("skip");
    expect(d.reason).toBe("not_manual");
  });

  it("skips records where rehab came from manual_partner (partner inspection is authoritative)", () => {
    const d = shouldRetryVision(rec({ rehabSource: "manual_partner" }));
    expect(d.action).toBe("skip");
    expect(d.reason).toBe("not_manual");
  });

  it("skips records with no rehab source at all", () => {
    const d = shouldRetryVision(rec({ rehabSource: null }));
    expect(d.action).toBe("skip");
    expect(d.reason).toBe("not_manual");
  });

  it("skips inactive listings", () => {
    const d = shouldRetryVision(rec({ liveStatus: "Sold" }));
    expect(d.action).toBe("skip");
    expect(d.reason).toBe("not_active");
  });

  it("skips records retried within cooldown window", () => {
    const now = new Date("2026-05-23T15:00:00Z");
    const recentStamp = new Date("2026-05-20T15:00:00Z").toISOString();
    const d = shouldRetryVision(
      rec({
        notes: `prior note\n${recentStamp} — ${RETRY_COOLDOWN_NOTES_MARKER} INV-005 cron tick: vision_failed (no_photos).`,
      }),
      now,
    );
    expect(d.action).toBe("skip");
    expect(d.reason).toBe("in_cooldown");
  });

  it("retries records last touched > cooldown days ago", () => {
    const now = new Date("2026-05-23T15:00:00Z");
    const oldStamp = new Date("2026-05-10T15:00:00Z").toISOString(); // 13 days ago
    const d = shouldRetryVision(
      rec({
        notes: `${oldStamp} — ${RETRY_COOLDOWN_NOTES_MARKER} INV-005 cron tick: vision_failed (no_photos).`,
      }),
      now,
    );
    expect(d.action).toBe("retry");
    expect(d.reason).toBe("should_retry");
  });

  it("retry-stamp scanner ignores unrelated Notes lines", () => {
    const d = shouldRetryVision(
      rec({ notes: "5/20 — System: agent contacted seller. Some other note." }),
    );
    expect(d.action).toBe("retry");
  });
});

describe("computeDrift", () => {
  it("reports drift % relative to manual anchor", () => {
    const d = computeDrift(20000, 30000); // vision 50% higher
    expect(d.driftPct).toBeCloseTo(50, 1);
    expect(d.delta).toBe(10000);
    expect(d.exceedsThreshold).toBe(true);
  });

  it("treats vision-lower drift symmetrically", () => {
    const d = computeDrift(40000, 28000); // vision 30% lower
    expect(d.driftPct).toBeCloseTo(30, 1);
    expect(d.delta).toBe(-12000);
    expect(d.exceedsThreshold).toBe(true);
  });

  it("returns no-drift when within threshold", () => {
    const d = computeDrift(25000, 27000); // 8% drift, under 25%
    expect(d.driftPct).toBeCloseTo(8, 1);
    expect(d.exceedsThreshold).toBe(false);
  });

  it("handles drift exactly at threshold (not-exceeding)", () => {
    const d = computeDrift(20000, 25000); // exactly 25%
    expect(d.driftPct).toBeCloseTo(DRIFT_THRESHOLD_PCT, 1);
    expect(d.exceedsThreshold).toBe(false);
  });

  it("gracefully handles zero manual anchor (no drift reported)", () => {
    const d = computeDrift(0, 25000);
    expect(d.exceedsThreshold).toBe(false);
  });
});

describe("buildDriftNotesLine + hasUnresolvedDriftMarker", () => {
  it("emits the DRIFT marker so the UI banner detector finds it", () => {
    const now = new Date("2026-05-23T15:00:00Z");
    const line = buildDriftNotesLine(now, 20000, 30000, computeDrift(20000, 30000));
    expect(line).toContain(DRIFT_NOTES_MARKER);
    expect(line).toContain("INV-005");
    expect(line).toContain("$30,000");
    expect(line).toContain("$20,000");
    expect(hasUnresolvedDriftMarker(line)).toBe(true);
  });

  it("hasUnresolvedDriftMarker returns false for null/empty notes", () => {
    expect(hasUnresolvedDriftMarker(null)).toBe(false);
    expect(hasUnresolvedDriftMarker("")).toBe(false);
    expect(hasUnresolvedDriftMarker("unrelated note text")).toBe(false);
  });

  it("suppresses banner when a RESOLVED line follows the most-recent DRIFT line", () => {
    const driftLine = buildDriftNotesLine(
      new Date("2026-05-20T15:00:00Z"),
      20000,
      30000,
      computeDrift(20000, 30000),
    );
    const resolvedLine = buildDriftResolvedLine(
      new Date("2026-05-21T10:00:00Z"),
      "kept_manual",
    );
    const notes = `${driftLine}\n${resolvedLine}`;
    expect(hasUnresolvedDriftMarker(notes)).toBe(false);
  });

  it("re-arms banner when a new DRIFT line lands after the RESOLVED line", () => {
    const drift1 = buildDriftNotesLine(
      new Date("2026-05-15T15:00:00Z"),
      20000,
      30000,
      computeDrift(20000, 30000),
    );
    const resolved = buildDriftResolvedLine(
      new Date("2026-05-16T15:00:00Z"),
      "kept_manual",
    );
    const drift2 = buildDriftNotesLine(
      new Date("2026-05-22T15:00:00Z"),
      20000,
      32000,
      computeDrift(20000, 32000),
    );
    const notes = `${drift1}\n${resolved}\n${drift2}`;
    expect(hasUnresolvedDriftMarker(notes)).toBe(true);
  });
});

describe("buildRetryStampLine + cooldown roundtrip", () => {
  it("stamp containing the RETRY marker is detected as in-cooldown when fresh", () => {
    const now = new Date("2026-05-23T15:00:00Z");
    const stamp = buildRetryStampLine(now, "vision_failed", "no_photos_available");
    expect(stamp).toContain(RETRY_COOLDOWN_NOTES_MARKER);
    expect(lastRetryWithinCooldown(stamp, now)).toBe(true);
    // Outside cooldown:
    const future = new Date(
      now.getTime() + (RETRY_COOLDOWN_DAYS + 1) * 86_400_000,
    );
    expect(lastRetryWithinCooldown(stamp, future)).toBe(false);
  });

  it("walks newest-first when multiple retry stamps in Notes", () => {
    const old = buildRetryStampLine(
      new Date("2026-04-01T15:00:00Z"),
      "vision_failed",
      "x",
    );
    const recent = buildRetryStampLine(
      new Date("2026-05-22T15:00:00Z"),
      "vision_agrees",
      "y",
    );
    const notes = `${old}\n${recent}`;
    const now = new Date("2026-05-23T15:00:00Z");
    expect(lastRetryWithinCooldown(notes, now)).toBe(true);
  });
});

describe("extractIsoTimestamp", () => {
  it("pulls an ISO 8601 timestamp from a free-text line", () => {
    expect(extractIsoTimestamp("2026-05-23T15:00:00.000Z — some text")).toBe(
      "2026-05-23T15:00:00.000Z",
    );
    expect(extractIsoTimestamp("2026-05-23T15:00:00Z prefix and suffix")).toBe(
      "2026-05-23T15:00:00Z",
    );
  });

  it("returns null when no ISO timestamp present", () => {
    expect(extractIsoTimestamp("plain text with no date")).toBe(null);
    expect(extractIsoTimestamp("5/23/26 — friendly format only")).toBe(null);
  });
});
