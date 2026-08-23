// Phase 14 / O.1 — Pulse runner tests (diff + Spine fan-out).
//
// Locks the active-set diff logic and the runner's Spine + audit
// fan-out across the three transition buckets (new / resolved /
// steady-state). Per-detector tests land in O.4.

import { describe, it, expect, vi } from "vitest";
import { diffActiveSet, runPulseScan } from "./runner";
import type { PulseDetection } from "./types";
import type { PulseActiveState } from "./active-store";

function mkDetection(id: string, severity: "info" | "warning" | "critical" = "warning"): PulseDetection {
  return {
    id,
    detector_id: "token_burn_24h", // arbitrary
    severity,
    title: `t-${id}`,
    description: `d-${id}`,
    detected_at: "2026-05-18T20:00:00Z",
  };
}

function activeMap(ids: string[]): Record<string, { detection: PulseDetection; first_seen_at: string }> {
  return Object.fromEntries(
    ids.map((id) => [id, { detection: mkDetection(id), first_seen_at: "2026-05-18T00:00:00Z" }]),
  );
}

describe("diffActiveSet", () => {
  it("classifies new + resolved + steady correctly", () => {
    const previous = activeMap(["keep", "gone"]);
    const current = [mkDetection("keep"), mkDetection("fresh")];
    const d = diffActiveSet(current, previous);
    expect(d.new_ids).toEqual(["fresh"]);
    expect(d.resolved_ids).toEqual(["gone"]);
    expect(d.steady_ids).toEqual(["keep"]);
  });

  it("handles empty previous (everything is new)", () => {
    const current = [mkDetection("a"), mkDetection("b")];
    const d = diffActiveSet(current, {});
    expect(d.new_ids).toEqual(["a", "b"]);
    expect(d.resolved_ids).toEqual([]);
    expect(d.steady_ids).toEqual([]);
  });

  it("handles empty current (everything resolves)", () => {
    const previous = activeMap(["a", "b"]);
    const d = diffActiveSet([], previous);
    expect(d.new_ids).toEqual([]);
    expect(d.resolved_ids).toEqual(["a", "b"]);
    expect(d.steady_ids).toEqual([]);
  });

  it("returns IDs sorted (deterministic ordering for Spine + audit)", () => {
    const current = [mkDetection("c"), mkDetection("a"), mkDetection("b")];
    const d = diffActiveSet(current, {});
    expect(d.new_ids).toEqual(["a", "b", "c"]);
  });

  it("no-op when previous == current", () => {
    const previous = activeMap(["a", "b"]);
    const current = [mkDetection("a"), mkDetection("b")];
    const d = diffActiveSet(current, previous);
    expect(d.new_ids).toEqual([]);
    expect(d.resolved_ids).toEqual([]);
    expect(d.steady_ids).toEqual(["a", "b"]);
  });
});

describe("runPulseScan", () => {
  // Seed a write_state event so spine-write-rate doesn't fire as a
  // by-product in tests that only care about token-burn. Each test
  // can append more events as needed.
  const baseAudit = [
    {
      ts: new Date("2026-05-18T19:00:00Z").toISOString(),
      agent: "maverick" as const,
      event: "write_state.build_event",
      status: "confirmed_success" as const,
    },
  ];
  const baseInput = {
    audit_log: baseAudit,
    listings: [],
    test_count: null,
    previous_test_count: null,
    env: {
      // Suppress the cron-cycle-silent info-level fire from "audit
      // log has only 1 entry" — these tests aren't about it.
      PULSE_CRON_SILENCE_WARNING_HOURS: "1000",
      PULSE_CRON_SILENCE_CRITICAL_HOURS: "2000",
      // Suppress send-lane-tripwire rule B — these fixtures' audit windows
      // legitimately contain send slots with no lane runs, and these tests
      // aren't about it (the detector has its own suite).
      PULSE_SEND_TRIPWIRE_MISSED_SLOTS_WARN: "999",
      PULSE_SEND_TRIPWIRE_MISSED_SLOTS_CRIT: "999",
    },
    now: () => new Date("2026-05-18T20:00:00Z"),
  };

  it("calls writeStateFn + auditFn for fresh detections only (steady-state silent)", async () => {
    // Stub a single detector by intercepting at the runner level via
    // pre-seeded audit. Token-burn fires when Anthropic events exist.
    const inputWithTokenBurn = {
      ...baseInput,
      audit_log: [
        ...baseAudit,
        ...Array.from({ length: 100 }, () => ({
          ts: new Date(Date.now() - 60_000).toISOString(),
          agent: "sentinel" as const,
          event: "sentinel_drafted",
          status: "confirmed_success" as const,
        })),
      ],
      env: {
        ...baseInput.env,
        PULSE_TOKEN_BURN_WARNING_USD: "1.00", // 100 calls × $0.04 = $4 → fires
        PULSE_TOKEN_BURN_CRITICAL_USD: "100.00",
      },
    };

    const writeStateFn = vi.fn().mockResolvedValue({
      written: true,
      spine_record_id: "recABC",
      audit_event_id: "ts",
    });
    const auditFn = vi.fn().mockResolvedValue(undefined);
    const readState = vi.fn().mockResolvedValue({
      active: {},
      test_count_anchor: null,
      progress_meter_anchor: null,      last_scan_at: null,
    } as PulseActiveState);
    const writeStore = vi.fn().mockResolvedValue(undefined);

    const result = await runPulseScan(inputWithTokenBurn, {
      writeStateFn,
      auditFn,
      readState,
      writeStateStore: writeStore,
    });

    expect(result.new_ids).toContain("token_burn_24h");
    expect(result.resolved_ids).toEqual([]);
    expect(writeStateFn).toHaveBeenCalled();
    expect(writeStateFn.mock.calls[0][0]).toMatchObject({
      attribution_agent: "pulse",
      event_type: "build_event",
    });
    expect(auditFn).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: "pulse",
        event: "pulse_detection_fired",
      }),
    );
    expect(writeStore).toHaveBeenCalledTimes(1);
  });

  it("writes Spine + audit for resolved detections (was active, no longer)", async () => {
    const writeStateFn = vi.fn().mockResolvedValue({
      written: true,
      spine_record_id: "recRES",
      audit_event_id: "ts",
    });
    const auditFn = vi.fn().mockResolvedValue(undefined);
    const readState = vi.fn().mockResolvedValue({
      active: {
        token_burn_24h: {
          detection: mkDetection("token_burn_24h"),
          first_seen_at: "2026-05-18T00:00:00Z",
        },
      },
      test_count_anchor: 700,
      progress_meter_anchor: null,      last_scan_at: "2026-05-18T00:00:00Z",
    } as PulseActiveState);
    const writeStore = vi.fn().mockResolvedValue(undefined);

    // No Anthropic events → token-burn doesn't fire → previously-
    // active detection resolves.
    const result = await runPulseScan(
      baseInput,
      { writeStateFn, auditFn, readState, writeStateStore: writeStore },
    );

    expect(result.resolved_ids).toContain("token_burn_24h");
    expect(auditFn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "pulse_detection_resolved",
      }),
    );
    expect(writeStateFn.mock.calls[0][0]).toMatchObject({
      title: expect.stringContaining("resolved"),
      attribution_agent: "pulse",
    });
  });

  it("preserves first-seen timestamps for steady-state detections", async () => {
    const inputWithTokenBurn = {
      ...baseInput,
      audit_log: [
        ...baseAudit,
        ...Array.from({ length: 100 }, () => ({
          ts: new Date().toISOString(),
          agent: "sentinel" as const,
          event: "sentinel_drafted",
          status: "confirmed_success" as const,
        })),
      ],
      env: {
        ...baseInput.env,
        PULSE_TOKEN_BURN_WARNING_USD: "1.00",
        PULSE_TOKEN_BURN_CRITICAL_USD: "100.00",
      },
    };

    const firstSeen = "2026-05-17T08:00:00Z";
    const writeStateFn = vi.fn().mockResolvedValue({
      written: true,
      spine_record_id: "x",
      audit_event_id: "y",
    });
    const writeStore = vi.fn().mockResolvedValue(undefined);

    const result = await runPulseScan(inputWithTokenBurn, {
      writeStateFn,
      auditFn: async () => {},
      readState: async () => ({
        active: {
          token_burn_24h: {
            detection: mkDetection("token_burn_24h"),
            first_seen_at: firstSeen,
          },
        },
        test_count_anchor: null,
        progress_meter_anchor: null,        last_scan_at: firstSeen,
      }),
      writeStateStore: writeStore,
    });

    // Token-burn was active before AND still firing → steady state.
    expect(result.steady_ids).toContain("token_burn_24h");
    expect(result.new_ids).not.toContain("token_burn_24h");
    // first-seen preserved across steady-state; detection payload
    // refreshed to the latest (so source_data tracks current value).
    expect(result.state.active.token_burn_24h.first_seen_at).toBe(firstSeen);
    expect(result.state.active.token_burn_24h.detection.detector_id).toBe(
      "token_burn_24h",
    );
    // No Spine writes for steady-state → keeps the decision log clean.
    expect(writeStateFn).not.toHaveBeenCalled();
  });

  it("persists test_count anchor on every scan", async () => {
    const writeStore = vi.fn().mockResolvedValue(undefined);
    await runPulseScan(
      { ...baseInput, test_count: 740 },
      {
        writeStateFn: async () => ({
          written: true,
          spine_record_id: "x",
          audit_event_id: "y",
        }),
        auditFn: async () => {},
        readState: async () => ({
          active: {},
          test_count_anchor: 700,
          progress_meter_anchor: null,          last_scan_at: null,
        }),
        writeStateStore: writeStore,
      },
    );
    const savedState = writeStore.mock.calls[0][0] as PulseActiveState;
    expect(savedState.test_count_anchor).toBe(740);
  });

  it("falls back to previous anchor when test_count is null this scan", async () => {
    const writeStore = vi.fn().mockResolvedValue(undefined);
    await runPulseScan(
      { ...baseInput, test_count: null, previous_test_count: 700 },
      {
        writeStateFn: async () => ({
          written: true,
          spine_record_id: "x",
          audit_event_id: "y",
        }),
        auditFn: async () => {},
        readState: async () => ({
          active: {},
          test_count_anchor: 700,
          progress_meter_anchor: null,          last_scan_at: null,
        }),
        writeStateStore: writeStore,
      },
    );
    const savedState = writeStore.mock.calls[0][0] as PulseActiveState;
    expect(savedState.test_count_anchor).toBe(700);
  });
});

// Operator paging (2026-08-04). The silent-403 incident was not a detection
// failure — it was that a detection reached Spine and stopped there.
describe("runPulseScan → operator paging", () => {
  const NOW = new Date("2026-08-04T20:00:00Z");
  // A total RentCast outage: 10 × 403 in the window.
  const outageAudit = [
    {
      ts: new Date("2026-08-04T19:00:00Z").toISOString(),
      agent: "maverick" as const,
      event: "write_state.build_event",
      status: "confirmed_success" as const,
    },
    ...Array.from({ length: 10 }, () => ({
      ts: NOW.toISOString(),
      agent: "rentcast" as const,
      event: "paid_api_call",
      status: "confirmed_failure" as const,
      outputSummary: { endpoint: "listings/sale", http: 403 },
    })),
  ];

  function deps(sendFn: ReturnType<typeof vi.fn>, active: Record<string, never> | object = {}) {
    return {
      writeStateFn: vi.fn().mockResolvedValue({ written: true, spine_record_id: "x", audit_event_id: "y" }),
      auditFn: vi.fn().mockResolvedValue(undefined),
      readState: vi.fn().mockResolvedValue({
        active,
        test_count_anchor: null,
        progress_meter_anchor: null,
        last_scan_at: null,
      }),
      writeStateStore: vi.fn().mockResolvedValue(undefined),
      sendFn: sendFn as never,
    };
  }

  const env = {
    PULSE_CRON_SILENCE_WARNING_HOURS: "1000",
    PULSE_CRON_SILENCE_CRITICAL_HOURS: "2000",
    // These tests exercise VENDOR paging in isolation. send_lane_tripwire is
    // pageable too (2026-08-23), and this fixture's tiny audit window would
    // otherwise trip its missed-slots rule — suppress it here like the main
    // describe's base env does.
    PULSE_SEND_TRIPWIRE_MISSED_SLOTS_WARN: "999",
    PULSE_SEND_TRIPWIRE_MISSED_SLOTS_CRIT: "999",
    ALERT_PHONE: "+15550001111",
    ALERT_FROM: "+16302505865",
  };

  const input = (envOverride: Record<string, string | undefined> = {}) => ({
    audit_log: outageAudit,
    listings: [],
    test_count: null,
    previous_test_count: null,
    env: { ...env, ...envOverride },
    now: () => NOW,
  });

  it("pages the operator when a vendor outage fires fresh", async () => {
    const sendFn = vi.fn().mockResolvedValue(undefined);
    const result = await runPulseScan(input(), deps(sendFn));
    expect(sendFn).toHaveBeenCalledTimes(1);
    const [to, body, opts] = sendFn.mock.calls[0];
    expect(to).toBe("+15550001111");
    expect(body).toContain("RENTCAST");
    // Channel separation: never the agent-facing outreach line.
    expect(opts).toEqual({ from: "+16302505865" });
    expect(result.paged_ids).toEqual(["vendor_health:rentcast"]);
  });

  it("does NOT re-page a standing outage (edge-triggered, not hourly)", async () => {
    const sendFn = vi.fn().mockResolvedValue(undefined);
    const already = {
      "vendor_health:rentcast": {
        detection: mkDetection("vendor_health:rentcast", "critical"),
        first_seen_at: "2026-08-04T18:00:00Z",
      },
    };
    const result = await runPulseScan(input(), deps(sendFn, already));
    expect(sendFn).not.toHaveBeenCalled();
    expect(result.paged_ids).toEqual([]);
  });

  it("refuses to page without ALERT_FROM rather than using the outreach line", async () => {
    const sendFn = vi.fn().mockResolvedValue(undefined);
    const result = await runPulseScan(input({ ALERT_FROM: undefined }), deps(sendFn));
    expect(sendFn).not.toHaveBeenCalled();
    expect(result.paged_ids).toEqual([]);
  });

  it("does not page for advisory detectors outside the allowlist", async () => {
    const sendFn = vi.fn().mockResolvedValue(undefined);
    await runPulseScan(input({ PULSE_PAGING_DETECTORS: "firecrawl_payment_required" }), deps(sendFn));
    expect(sendFn).not.toHaveBeenCalled();
  });

  it("a failed page does not abort the scan — the Spine row still lands", async () => {
    const sendFn = vi.fn().mockRejectedValue(new Error("quo down"));
    const d = deps(sendFn);
    const result = await runPulseScan(input(), d);
    expect(result.paged_ids).toEqual([]);
    expect(d.writeStateFn).toHaveBeenCalled();
    expect(result.new_ids).toContain("vendor_health:rentcast");
  });
});
