// Phase 14 / Phase 10 P.4 — voice-drift detector tests.

import { describe, it, expect } from "vitest";
import {
  detectVoiceDrift,
  filterSynthesizerEvents,
  findDisabledAgentInvocations,
  findMissingRegistryEntries,
  findModelFallbacks,
} from "./voice-drift";
import type { AuditEntry } from "@/lib/audit-log";

const NOW = new Date("2026-05-19T02:00:00Z");

function audit(
  agent: string,
  event: string,
  status: "confirmed_success" | "confirmed_failure",
  hoursBefore: number,
  inputSummary: Record<string, unknown> = {},
  outputSummary: Record<string, unknown> = {},
): AuditEntry {
  return {
    ts: new Date(NOW.getTime() - hoursBefore * 3_600_000).toISOString(),
    agent,
    event,
    status,
    inputSummary,
    outputSummary,
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

describe("filterSynthesizerEvents", () => {
  it("matches events ending in _synthesized", () => {
    const events = [
      audit("maverick", "maverick_synthesized", "confirmed_success", 1),
      audit("crier", "crier_reply_drafted", "confirmed_success", 1),
      audit("maverick", "some_other_event", "confirmed_success", 1),
    ];
    const filtered = filterSynthesizerEvents(events, 24, NOW);
    expect(filtered.map((e) => e.event).sort()).toEqual([
      "crier_reply_drafted",
      "maverick_synthesized",
    ]);
  });

  it("matches explicit legacy labels (P.2 event_label overrides)", () => {
    const events = [
      audit("maverick", "jarvis_brief_synthesized", "confirmed_success", 1),
      audit("appraiser", "rehab_calibrated", "confirmed_success", 1),
      audit("sentinel", "sentinel_classified", "confirmed_success", 1),
      audit("sentinel", "sentinel_drafted", "confirmed_success", 1),
      audit("scout", "scout_warmup_drafted", "confirmed_success", 1),
      audit("scout", "scout_outreach_drafted", "confirmed_success", 1),
      audit("maverick", "maverick_chat_synthesized", "confirmed_success", 1),
    ];
    const filtered = filterSynthesizerEvents(events, 24, NOW);
    expect(filtered.length).toBe(7);
  });

  it("excludes events outside the window", () => {
    const events = [
      audit("maverick", "maverick_synthesized", "confirmed_success", 1),
      audit("maverick", "maverick_synthesized", "confirmed_success", 50),
    ];
    expect(filterSynthesizerEvents(events, 24, NOW).length).toBe(1);
  });
});

describe("findModelFallbacks", () => {
  it("returns samples when model_matches_registry is false", () => {
    const events = [
      audit(
        "maverick",
        "maverick_synthesized",
        "confirmed_success",
        1,
        { model: "claude-sonnet-4-20250514" },
        { model_matches_registry: false, actual_model: "claude-opus-fallback" },
      ),
      audit(
        "maverick",
        "maverick_synthesized",
        "confirmed_success",
        2,
        { model: "claude-sonnet-4-20250514" },
        { model_matches_registry: true, actual_model: "claude-sonnet-4-20250514" },
      ),
    ];
    const out = findModelFallbacks(events);
    expect(out.length).toBe(1);
    expect(out[0]).toMatchObject({
      agent: "maverick",
      expected_model: "claude-sonnet-4-20250514",
      actual_model: "claude-opus-fallback",
    });
  });

  it("ignores confirmed_failure events (would be tracked separately)", () => {
    const events = [
      audit("maverick", "maverick_synthesized", "confirmed_failure", 1, {}, {
        model_matches_registry: false,
      }),
    ];
    expect(findModelFallbacks(events).length).toBe(0);
  });

  it("ignores events without model strings", () => {
    const events = [
      audit("maverick", "maverick_synthesized", "confirmed_success", 1, {}, {
        model_matches_registry: false,
      }),
    ];
    expect(findModelFallbacks(events).length).toBe(0);
  });
});

describe("findDisabledAgentInvocations", () => {
  it("matches confirmed_failures with 'disabled' in error", () => {
    const events = [
      audit("pulse", "pulse_synthesized", "confirmed_failure", 1, {}, {
        error: 'voice-registry: agent "pulse" is registered but disabled',
      }),
      audit("maverick", "maverick_synthesized", "confirmed_failure", 2, {}, {
        error: "Anthropic 429: rate limited",
      }),
    ];
    const out = findDisabledAgentInvocations(events);
    expect(out.length).toBe(1);
    expect(out[0].agent).toBe("pulse");
  });

  it("returns empty when no disabled-errors present", () => {
    const events = [
      audit("maverick", "maverick_synthesized", "confirmed_success", 1),
    ];
    expect(findDisabledAgentInvocations(events)).toEqual([]);
  });
});

describe("findMissingRegistryEntries", () => {
  it("flags audit events whose agent name has no registry entry", () => {
    const events = [
      audit("nonexistent_agent", "nonexistent_synthesized", "confirmed_success", 1),
      audit("maverick", "maverick_synthesized", "confirmed_success", 2),
    ];
    const out = findMissingRegistryEntries(events);
    expect(out).toEqual([
      { agent: "nonexistent_agent", ts: events[0].ts },
    ]);
  });

  it("dedupes by agent across multiple events", () => {
    const events = [
      audit("nonexistent_agent", "nonexistent_synthesized", "confirmed_success", 1),
      audit("nonexistent_agent", "nonexistent_synthesized", "confirmed_success", 2),
    ];
    expect(findMissingRegistryEntries(events).length).toBe(1);
  });
});

describe("detectVoiceDrift — integration", () => {
  it("returns [] when no synthesizer events in window", () => {
    expect(detectVoiceDrift(baseInput)).toEqual([]);
  });

  it("fires warning on a single model fallback (default threshold 1)", () => {
    const dets = detectVoiceDrift({
      ...baseInput,
      audit_log: [
        audit(
          "maverick",
          "maverick_synthesized",
          "confirmed_success",
          1,
          { model: "claude-sonnet-4-20250514" },
          { model_matches_registry: false, actual_model: "claude-opus-fallback" },
        ),
      ],
    });
    expect(dets.length).toBe(1);
    expect(dets[0].id).toBe("voice_drift_model_fallback");
    expect(dets[0].severity).toBe("warning");
  });

  it("fires critical at ≥5 fallbacks (default critical threshold)", () => {
    const events: AuditEntry[] = [];
    for (let i = 0; i < 6; i++) {
      events.push(
        audit(
          "maverick",
          "maverick_synthesized",
          "confirmed_success",
          1,
          { model: "claude-sonnet-4-20250514" },
          { model_matches_registry: false, actual_model: "fallback" },
        ),
      );
    }
    const dets = detectVoiceDrift({ ...baseInput, audit_log: events });
    expect(dets[0].severity).toBe("critical");
  });

  it("fires critical for disabled-agent invocation (no threshold)", () => {
    const dets = detectVoiceDrift({
      ...baseInput,
      audit_log: [
        audit("pulse", "pulse_synthesized", "confirmed_failure", 1, {}, {
          error: 'voice-registry: agent "pulse" is registered but disabled',
        }),
      ],
    });
    expect(dets[0].id).toBe("voice_drift_disabled_agent");
    expect(dets[0].severity).toBe("critical");
  });

  it("fires critical for missing-registry-entry invocation", () => {
    const dets = detectVoiceDrift({
      ...baseInput,
      audit_log: [
        audit("rogue_agent", "rogue_synthesized", "confirmed_success", 1),
      ],
    });
    expect(dets[0].id).toBe("voice_drift_missing_registry");
    expect(dets[0].severity).toBe("critical");
  });

  it("fires multiple detections when multiple classes are present", () => {
    const dets = detectVoiceDrift({
      ...baseInput,
      audit_log: [
        audit(
          "maverick",
          "maverick_synthesized",
          "confirmed_success",
          1,
          { model: "x" },
          { model_matches_registry: false, actual_model: "y" },
        ),
        audit("pulse", "pulse_synthesized", "confirmed_failure", 1, {}, {
          error: 'voice-registry: agent "pulse" is disabled',
        }),
        audit("rogue", "rogue_synthesized", "confirmed_success", 1),
      ],
    });
    const ids = dets.map((d) => d.id).sort();
    expect(ids).toEqual([
      "voice_drift_disabled_agent",
      "voice_drift_missing_registry",
      "voice_drift_model_fallback",
    ]);
  });

  it("respects env-overridable thresholds", () => {
    const dets = detectVoiceDrift({
      ...baseInput,
      audit_log: [
        audit(
          "maverick",
          "maverick_synthesized",
          "confirmed_success",
          1,
          { model: "x" },
          { model_matches_registry: false, actual_model: "y" },
        ),
      ],
      env: { PULSE_VOICE_DRIFT_FALLBACK_WARNING: "10" },
    });
    expect(dets).toEqual([]); // count 1 < threshold 10
  });
});
