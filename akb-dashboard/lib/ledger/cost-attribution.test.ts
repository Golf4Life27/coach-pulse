// Phase 15.2 / Q.4 — Cost attribution tests.

import { describe, it, expect } from "vitest";
import { attributeCost, SYNTHESIZER_EVENT_COSTS } from "./cost-attribution";
import type { AuditEntry } from "@/lib/audit-log";

const NOW = new Date("2026-05-19T03:00:00Z");

function syn(agent: string, event: string, hoursBefore = 1): AuditEntry {
  return {
    ts: new Date(NOW.getTime() - hoursBefore * 3_600_000).toISOString(),
    agent,
    event,
    status: "confirmed_success",
  };
}

describe("attributeCost", () => {
  it("attributes costs per agent + per event", () => {
    const audit = [
      syn("sentinel", "sentinel_classified"),
      syn("sentinel", "sentinel_classified"),
      syn("sentinel", "sentinel_drafted"),
      syn("appraiser", "rehab_calibrated"),
      syn("maverick", "jarvis_brief_synthesized"),
    ];
    const out = attributeCost(audit, 24, NOW);
    expect(out.total_calls).toBe(5);
    // sentinel: 2×0.02 + 0.04 = 0.08
    // appraiser: 0.05
    // maverick: 0.08
    // total: 0.21
    expect(out.total_usd).toBeCloseTo(0.21, 2);
    expect(out.per_agent.length).toBe(3);
    const sentinel = out.per_agent.find((r) => r.agent === "sentinel")!;
    expect(sentinel.calls).toBe(3);
    expect(sentinel.estimate_usd).toBeCloseTo(0.08, 2);
    expect(sentinel.by_event.sentinel_classified).toBe(2);
    expect(sentinel.by_event.sentinel_drafted).toBe(1);
  });

  it("excludes events outside the window", () => {
    const audit = [
      syn("sentinel", "sentinel_classified", 1),
      syn("sentinel", "sentinel_classified", 50),
    ];
    expect(attributeCost(audit, 24, NOW).total_calls).toBe(1);
  });

  it("ignores events not in the synthesizer cost table", () => {
    const audit = [
      syn("crier", "send_attempt"), // not a synth event
      syn("maverick", "load_state"),
    ];
    expect(attributeCost(audit, 24, NOW).total_calls).toBe(0);
  });

  it("ignores uncertain status (only counts confirmed)", () => {
    const audit: AuditEntry[] = [
      {
        ts: syn("sentinel", "sentinel_classified").ts,
        agent: "sentinel",
        event: "sentinel_classified",
        status: "uncertain",
      },
    ];
    expect(attributeCost(audit, 24, NOW).total_calls).toBe(0);
  });

  it("sorts agents by spend desc", () => {
    const audit = [
      syn("low", "sentinel_classified"), // 0.02
      ...Array.from({ length: 5 }, () => syn("hi", "rehab_calibrated")), // 5×0.05 = 0.25
    ];
    const out = attributeCost(audit, 24, NOW);
    expect(out.per_agent[0].agent).toBe("hi");
  });

  it("cost table is non-empty (drift guard)", () => {
    expect(Object.keys(SYNTHESIZER_EVENT_COSTS).length).toBeGreaterThan(5);
  });
});
