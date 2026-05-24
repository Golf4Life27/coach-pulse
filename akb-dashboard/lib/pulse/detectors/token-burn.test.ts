// Phase 14 / O.4 — token-burn detector tests.

import { describe, it, expect } from "vitest";
import {
  countAnthropicEventsLast24h,
  detectTokenBurn,
  estimateTokenBurnUsd24h,
} from "./token-burn";
import type { AuditEntry } from "@/lib/audit-log";

function mkAudit(event: string, ageMinutes: number, status: "confirmed_success" | "confirmed_failure" = "confirmed_success"): AuditEntry {
  return {
    ts: new Date(Date.now() - ageMinutes * 60_000).toISOString(),
    agent: "sentinel",
    event,
    status,
  };
}

const NOW = new Date("2026-05-18T20:00:00Z");
function mkAuditAt(event: string, hoursBefore: number): AuditEntry {
  return {
    ts: new Date(NOW.getTime() - hoursBefore * 3_600_000).toISOString(),
    agent: "sentinel",
    event,
    status: "confirmed_success",
  };
}

describe("countAnthropicEventsLast24h", () => {
  it("counts Anthropic-calling events within the last 24h", () => {
    const audit = [
      mkAuditAt("sentinel_drafted", 1),
      mkAuditAt("sentinel_classified", 5),
      mkAuditAt("photo_analyzed", 10),
      mkAuditAt("rehab_calibrated", 20),
    ];
    const counts = countAnthropicEventsLast24h(audit, NOW);
    expect(counts).toEqual({
      sentinel_drafted: 1,
      sentinel_classified: 1,
      photo_analyzed: 1,
      rehab_calibrated: 1,
    });
  });

  it("excludes events older than 24h", () => {
    const audit = [
      mkAuditAt("sentinel_drafted", 1),
      mkAuditAt("sentinel_drafted", 25),
    ];
    const counts = countAnthropicEventsLast24h(audit, NOW);
    expect(counts.sentinel_drafted).toBe(1);
  });

  it("ignores non-Anthropic events", () => {
    const audit = [
      mkAuditAt("quo_send_attempt", 1),
      mkAuditAt("write_state.build_event", 2),
    ];
    expect(countAnthropicEventsLast24h(audit, NOW)).toEqual({});
  });
});

describe("estimateTokenBurnUsd24h", () => {
  it("multiplies counts by per-event cost estimates", () => {
    // synthesizer $0.08 + classifier $0.02 + draft $0.04 + photo $0.05 + rehab $0.05 = $0.24
    const total = estimateTokenBurnUsd24h({
      jarvis_brief_synthesized: 1,
      sentinel_classified: 1,
      sentinel_drafted: 1,
      photo_analyzed: 1,
      rehab_calibrated: 1,
    });
    expect(total).toBeCloseTo(0.24, 2);
  });

  it("returns 0 when no Anthropic events", () => {
    expect(estimateTokenBurnUsd24h({})).toBe(0);
  });
});

describe("detectTokenBurn", () => {
  const baseInput = {
    audit_log: [],
    listings: [],
    test_count: null,
    previous_test_count: null,
    env: {},
    now: () => NOW,
  };

  it("doesn't fire below warning threshold", () => {
    const dets = detectTokenBurn({
      ...baseInput,
      audit_log: [mkAudit("sentinel_classified", 30)], // 1 call × $0.02 = $0.02
    });
    expect(dets).toEqual([]);
  });

  it("fires warning when 24h estimate exceeds warning threshold", () => {
    const audit = Array.from({ length: 200 }, () => mkAudit("sentinel_drafted", 60));
    // 200 × $0.04 = $8.00, default warning $8.00 → fires at boundary
    const dets = detectTokenBurn({ ...baseInput, audit_log: audit });
    expect(dets).toHaveLength(1);
    expect(dets[0].severity).toBe("warning");
    expect(dets[0].detector_id).toBe("token_burn_24h");
  });

  it("fires critical when 24h estimate exceeds critical threshold", () => {
    const audit = Array.from({ length: 100 }, () => mkAudit("photo_analyzed", 60));
    // 100 × $0.05 = $5.00 — need more to cross critical $20
    const heavy = Array.from({ length: 500 }, () => mkAudit("photo_analyzed", 60));
    // 500 × $0.05 = $25 ≥ critical $20
    const dets = detectTokenBurn({ ...baseInput, audit_log: heavy });
    expect(dets[0].severity).toBe("critical");
  });

  it("respects env-overridable thresholds (PULSE_TOKEN_BURN_*)", () => {
    const audit = Array.from({ length: 10 }, () => mkAudit("sentinel_classified", 60));
    // 10 × $0.02 = $0.20 — normally silent
    const dets = detectTokenBurn({
      ...baseInput,
      audit_log: audit,
      env: { PULSE_TOKEN_BURN_WARNING_USD: "0.10" },
    });
    expect(dets).toHaveLength(1);
    expect(dets[0].severity).toBe("warning");
  });

  it("uses ?value? in audit-event source_data", () => {
    const audit = Array.from({ length: 50 }, () => mkAudit("sentinel_drafted", 60));
    const dets = detectTokenBurn({
      ...baseInput,
      audit_log: audit,
      env: { PULSE_TOKEN_BURN_WARNING_USD: "1.00" },
    });
    expect(dets[0].source_data?.estimate_usd).toBeCloseTo(2.0, 2);
    expect(dets[0].source_data?.event_counts).toEqual({ sentinel_drafted: 50 });
  });
});
