// Phase 14 / O.4 — spine-write-rate detector tests.

import { describe, it, expect } from "vitest";
import {
  countSpineWritesWithin,
  detectSpineWriteRate,
} from "./spine-write-rate";
import type { AuditEntry } from "@/lib/audit-log";

const NOW = new Date("2026-05-18T20:00:00Z");

function ws(hoursBefore: number, eventType = "build_event"): AuditEntry {
  return {
    ts: new Date(NOW.getTime() - hoursBefore * 3_600_000).toISOString(),
    agent: "maverick",
    event: `write_state.${eventType}`,
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

describe("countSpineWritesWithin", () => {
  it("counts write_state.* events in the window", () => {
    const audit = [ws(1), ws(5), ws(20), ws(40)];
    expect(countSpineWritesWithin(audit, 24, NOW)).toBe(3);
  });

  it("matches all event_type suffixes", () => {
    const audit = [
      ws(1, "decision"),
      ws(2, "principle_amendment"),
      ws(3, "build_event"),
      ws(4, "deal_state_change"),
    ];
    expect(countSpineWritesWithin(audit, 24, NOW)).toBe(4);
  });

  it("ignores non-write_state events", () => {
    const audit: AuditEntry[] = [
      { ts: new Date(NOW.getTime() - 60_000).toISOString(), agent: "sentinel", event: "sentinel_drafted", status: "confirmed_success" },
    ];
    expect(countSpineWritesWithin(audit, 24, NOW)).toBe(0);
  });
});

describe("detectSpineWriteRate", () => {
  it("doesn't fire when writes meet warning minimum", () => {
    const dets = detectSpineWriteRate({
      ...baseInput,
      audit_log: [ws(1), ws(10), ws(40)],
    });
    expect(dets).toEqual([]);
  });

  it("fires critical when 48h window is empty (Phase 20.7 signature)", () => {
    // No write_state events at all → critical.
    const dets = detectSpineWriteRate(baseInput);
    expect(dets).toHaveLength(1);
    expect(dets[0].severity).toBe("critical");
    expect(dets[0].detector_id).toBe("spine_write_rate_low");
    expect(dets[0].title).toContain("Phase 20.7");
  });

  it("fires warning when 24h window below min but 48h ok", () => {
    // Write at 30h ago — outside 24h but inside 48h. 24h count = 0
    // < warning min 1; 48h count = 1 ≥ critical min 1 → warning only.
    const dets = detectSpineWriteRate({
      ...baseInput,
      audit_log: [ws(30)],
    });
    expect(dets[0].severity).toBe("warning");
  });

  it("respects env-overridable window + min thresholds", () => {
    // Override warning to expect ≥3 writes in 6h.
    const dets = detectSpineWriteRate({
      ...baseInput,
      audit_log: [ws(1), ws(2)],
      env: {
        PULSE_SPINE_WARNING_WINDOW_HOURS: "6",
        PULSE_SPINE_WARNING_MIN: "3",
        PULSE_SPINE_CRITICAL_WINDOW_HOURS: "48",
        PULSE_SPINE_CRITICAL_MIN: "0",
      },
    });
    expect(dets[0].severity).toBe("warning"); // 2 < 3
  });
});
