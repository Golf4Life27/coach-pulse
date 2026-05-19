// Phase 14.2 / Q.2 — outreach-volume-drop tests.

import { describe, it, expect } from "vitest";
import {
  countSendsInWindow,
  detectOutreachVolumeDrop,
} from "./outreach-volume-drop";
import type { AuditEntry } from "@/lib/audit-log";

const NOW = new Date("2026-05-19T03:00:00Z");
const NOW_MS = NOW.getTime();

function send(hoursBefore: number, event = "send_attempt"): AuditEntry {
  return {
    ts: new Date(NOW_MS - hoursBefore * 3_600_000).toISOString(),
    agent: "quo",
    event,
    status: "confirmed_success",
  };
}

const baseInput = {
  audit_log: [] as AuditEntry[],
  listings: [],
  test_count: null,
  previous_test_count: null,
  env: {},
  now: () => NOW,
};

describe("countSendsInWindow", () => {
  it("counts events in [start, end) window only", () => {
    const audit = [send(1), send(30), send(50)];
    const start = NOW_MS - 24 * 3_600_000;
    const end = NOW_MS;
    expect(countSendsInWindow(audit, start, end)).toBe(1);
  });

  it("matches all send event types (gmail + sentinel + scout)", () => {
    const audit: AuditEntry[] = [
      { ts: send(1).ts, agent: "x", event: "send_attempt", status: "confirmed_success" },
      { ts: send(1).ts, agent: "x", event: "crier_reply_drafted", status: "confirmed_success" },
      { ts: send(1).ts, agent: "x", event: "scout_outreach_drafted", status: "confirmed_success" },
      { ts: send(1).ts, agent: "x", event: "scout_warmup_drafted", status: "confirmed_success" },
      { ts: send(1).ts, agent: "x", event: "irrelevant", status: "confirmed_success" },
    ];
    expect(countSendsInWindow(audit, NOW_MS - 24 * 3_600_000, NOW_MS)).toBe(4);
  });
});

describe("detectOutreachVolumeDrop", () => {
  it("doesn't fire when historical baseline below min", () => {
    // Only 5 historical sends — below default min_historical 10 (per 24h).
    // priorPer24h = 5/2 = 2.5 → below min 10 → skip.
    const dets = detectOutreachVolumeDrop({
      ...baseInput,
      audit_log: Array.from({ length: 5 }, (_, i) => send(48 + i)),
    });
    expect(dets).toEqual([]);
  });

  it("doesn't fire when current >= prior (no drop)", () => {
    const dets = detectOutreachVolumeDrop({
      ...baseInput,
      audit_log: [
        ...Array.from({ length: 20 }, (_, i) => send(48 - i)),  // 20 in prior 24h
        ...Array.from({ length: 25 }, (_, i) => send(1 + i * 0.5)), // 25 in current 24h
      ],
    });
    expect(dets).toEqual([]);
  });

  it("fires warning at ≥50% drop", () => {
    const dets = detectOutreachVolumeDrop({
      ...baseInput,
      audit_log: [
        ...Array.from({ length: 40 }, (_, i) => send(48 - (i % 24))), // 40 prior 48h → priorPer24h = 20
        ...Array.from({ length: 10 }, () => send(1)), // 10 current 24h → 50% drop
      ],
    });
    expect(dets[0].severity).toBe("warning");
    expect(dets[0].detector_id).toBe("outreach_volume_drop");
  });

  it("fires critical at ≥80% drop", () => {
    const dets = detectOutreachVolumeDrop({
      ...baseInput,
      audit_log: [
        ...Array.from({ length: 60 }, (_, i) => send(48 - (i % 24))), // priorPer24h = 30
        ...Array.from({ length: 5 }, () => send(1)), // current 5 → ~83% drop
      ],
    });
    expect(dets[0].severity).toBe("critical");
  });

  it("carries confidence reflecting historical sample strength", () => {
    const dets = detectOutreachVolumeDrop({
      ...baseInput,
      audit_log: [
        ...Array.from({ length: 70 }, (_, i) => send(48 - (i % 24))), // priorPer24h = 35
        ...Array.from({ length: 5 }, () => send(1)),
      ],
    });
    expect(dets[0].confidence).toBe(0.9); // priorPer24h >= 30 → confident
  });

  it("respects env override", () => {
    const dets = detectOutreachVolumeDrop({
      ...baseInput,
      audit_log: [
        ...Array.from({ length: 40 }, (_, i) => send(48 - (i % 24))),
        ...Array.from({ length: 18 }, () => send(1)), // ~10% drop only
      ],
      env: { PULSE_OUTREACH_DROP_WARNING_PCT: "0.05" }, // 5%
    });
    expect(dets[0]?.severity).toBe("warning");
  });
});
