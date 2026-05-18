// Phase 14 / O.4 — cron-cycle-silent detector tests.

import { describe, it, expect } from "vitest";
import {
  detectCronCycleSilent,
  hoursSinceMostRecentAuditEvent,
} from "./cron-cycle";
import type { AuditEntry } from "@/lib/audit-log";

const NOW = new Date("2026-05-18T20:00:00Z");

function audit(hoursBefore: number, event = "x"): AuditEntry {
  return {
    ts: new Date(NOW.getTime() - hoursBefore * 3_600_000).toISOString(),
    agent: "maverick",
    event,
    status: "confirmed_success",
  };
}

const baseInput = {
  audit_log: [],
  listings: [],
  test_count: null,
  previous_test_count: null,
  env: {},
  now: () => NOW,
};

describe("hoursSinceMostRecentAuditEvent", () => {
  it("returns null for empty audit log", () => {
    expect(hoursSinceMostRecentAuditEvent([], NOW)).toBeNull();
  });

  it("returns hours since the most-recent entry regardless of order", () => {
    const out = hoursSinceMostRecentAuditEvent(
      [audit(10), audit(2), audit(48)],
      NOW,
    );
    expect(out).toBeCloseTo(2, 0);
  });
});

describe("detectCronCycleSilent", () => {
  it("fires info when audit log is empty (KV unwired / dev mode)", () => {
    const dets = detectCronCycleSilent(baseInput);
    expect(dets).toHaveLength(1);
    expect(dets[0].severity).toBe("info");
    expect(dets[0].detector_id).toBe("cron_cycle_silent");
  });

  it("doesn't fire when activity is recent", () => {
    const dets = detectCronCycleSilent({
      ...baseInput,
      audit_log: [audit(2)],
    });
    expect(dets).toEqual([]);
  });

  it("fires warning when silence exceeds warning window", () => {
    const dets = detectCronCycleSilent({
      ...baseInput,
      audit_log: [audit(40)], // 40h silence, default warning 36h
    });
    expect(dets[0].severity).toBe("warning");
  });

  it("fires critical when silence exceeds critical window", () => {
    const dets = detectCronCycleSilent({
      ...baseInput,
      audit_log: [audit(80)], // 80h silence, default critical 72h
    });
    expect(dets[0].severity).toBe("critical");
  });

  it("respects env-overridable thresholds", () => {
    const dets = detectCronCycleSilent({
      ...baseInput,
      audit_log: [audit(10)],
      env: {
        PULSE_CRON_SILENCE_WARNING_HOURS: "5",
        PULSE_CRON_SILENCE_CRITICAL_HOURS: "20",
      },
    });
    expect(dets[0].severity).toBe("warning");
  });
});
