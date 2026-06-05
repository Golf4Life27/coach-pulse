// Phase 14 / O.4 — endpoint-error-rate detector tests.

import { describe, it, expect } from "vitest";
import {
  detectEndpointErrorRate,
  tallyEventsByName,
} from "./endpoint-error-rate";
import type { AuditEntry } from "@/lib/audit-log";

const NOW = new Date("2026-05-18T20:00:00Z");

function audit(event: string, status: "confirmed_success" | "confirmed_failure" | "uncertain", hoursBefore = 1): AuditEntry {
  return {
    ts: new Date(NOW.getTime() - hoursBefore * 3_600_000).toISOString(),
    agent: "sentinel",
    event,
    status,
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

describe("tallyEventsByName", () => {
  it("groups confirmed_success / confirmed_failure / uncertain per event", () => {
    const out = tallyEventsByName(
      [
        audit("X", "confirmed_success"),
        audit("X", "confirmed_failure"),
        audit("X", "uncertain"),
        audit("Y", "confirmed_success"),
      ],
      24,
      NOW,
    );
    expect(out.X).toEqual({ success: 1, failure: 1, uncertain: 1 });
    expect(out.Y).toEqual({ success: 1, failure: 0, uncertain: 0 });
  });

  it("excludes events outside the window", () => {
    const out = tallyEventsByName(
      [audit("X", "confirmed_success", 1), audit("X", "confirmed_failure", 50)],
      24,
      NOW,
    );
    expect(out.X).toEqual({ success: 1, failure: 0, uncertain: 0 });
  });

  it("respects exclusion set", () => {
    const out = tallyEventsByName(
      [audit("X", "confirmed_failure"), audit("Y", "confirmed_failure")],
      24,
      NOW,
      new Set(["X"]),
    );
    expect(out.X).toBeUndefined();
    expect(out.Y.failure).toBe(1);
  });
});

describe("detectEndpointErrorRate", () => {
  it("doesn't fire when failure rate below threshold", () => {
    const auditLog = [
      ...Array(9).fill(0).map(() => audit("E", "confirmed_success")),
      audit("E", "confirmed_failure"), // 10% — below default warning 25%
    ];
    expect(detectEndpointErrorRate({ ...baseInput, audit_log: auditLog })).toEqual([]);
  });

  it("doesn't fire when samples below min (avoids alarming on 1/2 failure)", () => {
    const auditLog = [
      audit("E", "confirmed_failure"),
      audit("E", "confirmed_success"),
    ]; // 50% but only 2 samples — below default min 5
    expect(detectEndpointErrorRate({ ...baseInput, audit_log: auditLog })).toEqual([]);
  });

  it("fires warning when rate ≥ 25%", () => {
    const auditLog = [
      ...Array(6).fill(0).map(() => audit("E", "confirmed_success")),
      ...Array(2).fill(0).map(() => audit("E", "confirmed_failure")),
    ]; // 2/8 = 25%
    const dets = detectEndpointErrorRate({ ...baseInput, audit_log: auditLog });
    expect(dets).toHaveLength(1);
    expect(dets[0].severity).toBe("warning");
    expect(dets[0].id).toBe("endpoint_error_rate_high:E");
  });

  it("fires critical when rate ≥ 50%", () => {
    const auditLog = [
      ...Array(3).fill(0).map(() => audit("E", "confirmed_success")),
      ...Array(3).fill(0).map(() => audit("E", "confirmed_failure")),
    ]; // 3/6 = 50%
    const dets = detectEndpointErrorRate({ ...baseInput, audit_log: auditLog });
    expect(dets[0].severity).toBe("critical");
  });

  it("returns per-event detections (multiple events can fire simultaneously)", () => {
    const auditLog = [
      ...Array(6).fill(0).map(() => audit("E1", "confirmed_failure")),
      ...Array(6).fill(0).map(() => audit("E2", "confirmed_failure")),
    ];
    const dets = detectEndpointErrorRate({ ...baseInput, audit_log: auditLog });
    expect(dets).toHaveLength(2);
    expect(dets.map((d) => d.id).sort()).toEqual([
      "endpoint_error_rate_high:E1",
      "endpoint_error_rate_high:E2",
    ]);
  });

  it("sorts detections by severity desc + rate desc", () => {
    // E1: 5/10 = 50% (critical); E2: 3/10 = 30% (warning); E3: 9/10 = 90% (critical, higher)
    const auditLog = [
      ...Array(5).fill(0).map(() => audit("E1", "confirmed_failure")),
      ...Array(5).fill(0).map(() => audit("E1", "confirmed_success")),
      ...Array(3).fill(0).map(() => audit("E2", "confirmed_failure")),
      ...Array(7).fill(0).map(() => audit("E2", "confirmed_success")),
      ...Array(9).fill(0).map(() => audit("E3", "confirmed_failure")),
      audit("E3", "confirmed_success"),
    ];
    const dets = detectEndpointErrorRate({ ...baseInput, audit_log: auditLog });
    expect(dets[0].id).toBe("endpoint_error_rate_high:E3"); // critical, highest rate
    expect(dets[1].id).toBe("endpoint_error_rate_high:E1"); // critical
    expect(dets[2].id).toBe("endpoint_error_rate_high:E2"); // warning last
  });

  it("PULSE_ERROR_RATE_EXCLUDE filters events from detection", () => {
    const auditLog = [
      ...Array(5).fill(0).map(() => audit("E", "confirmed_failure")),
      ...Array(5).fill(0).map(() => audit("E", "confirmed_success")),
    ];
    const dets = detectEndpointErrorRate({
      ...baseInput,
      audit_log: auditLog,
      env: { PULSE_ERROR_RATE_EXCLUDE: "E,unrelated" },
    });
    expect(dets).toEqual([]);
  });

  it("excludes failure-only write events (patch_failed) by default — they structurally read 100%", () => {
    // 8 patch_failed, 0 successes (no patch_succeeded counterpart event)
    // → would otherwise fire at a fixed 100%. Default exclusion silences it.
    const auditLog = Array(8).fill(0).map(() => audit("patch_failed", "confirmed_failure"));
    const dets = detectEndpointErrorRate({ ...baseInput, audit_log: auditLog });
    expect(dets.find((d) => d.id === "endpoint_error_rate_high:patch_failed")).toBeUndefined();
  });

  it("default failure-only exclusions cover the known write-failure events", () => {
    for (const ev of ["batch_patch_failed", "formula_field_write_blocked", "proposal_patch_failed"]) {
      const auditLog = Array(6).fill(0).map(() => audit(ev, "confirmed_failure"));
      const dets = detectEndpointErrorRate({ ...baseInput, audit_log: auditLog });
      expect(dets.find((d) => d.id === `endpoint_error_rate_high:${ev}`)).toBeUndefined();
    }
  });
});
