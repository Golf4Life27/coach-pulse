// Send-lane tripwire tests — every fixture below is a REAL shape from the
// 2026-08-18 zero-send day (the incident this detector exists to catch on
// the same hour instead of the next morning).

import { describe, it, expect } from "vitest";
import {
  detectSendLaneTripwire,
  expectedSlotsInWindow,
  parseLaneRun,
  H2_LIVE_SLOTS_UTC,
} from "./send-lane-tripwire";
import type { AuditEntry } from "@/lib/audit-log";

const NOW = new Date("2026-08-18T17:00:00Z");

function laneRun(
  event: string,
  iso: string,
  outputSummary: Record<string, unknown>,
): AuditEntry {
  return { ts: iso, agent: "crier", event, status: "confirmed_success", outputSummary } as AuditEntry;
}

// Anchor the visible window without lane semantics.
const windowAnchor = (iso: string): AuditEntry =>
  ({ ts: iso, agent: "any", event: "freshness_reverify", status: "confirmed_success" }) as AuditEntry;

const baseInput = {
  audit_log: [] as AuditEntry[],
  listings: [],
  test_count: null,
  previous_test_count: null,
  env: {},
  now: () => NOW,
};

describe("parseLaneRun", () => {
  it("reads h2 runs (first_touch_sent) and creative runs (sent/planned)", () => {
    const h2 = parseLaneRun(
      laneRun("h2_outreach_live", "2026-08-18T16:30:30Z", {
        processed: 3, first_touch_sent: 0, idempotent_skipped: 3, errors: 0, outside_hours: 0,
      }),
    )!;
    expect(h2.sent).toBe(0);
    expect(h2.attempted).toBe(6); // processed 3 + idempotent 3
    const cr = parseLaneRun(
      laneRun("creative_outreach_live", "2026-08-18T16:35:00Z", { planned: 10, sent: 0, refused: 10 }),
    )!;
    expect(cr.sent).toBe(0);
    expect(cr.attempted).toBe(10);
  });

  it("ignores non-lane events", () => {
    expect(parseLaneRun(windowAnchor("2026-08-18T16:00:00Z"))).toBeNull();
  });
});

describe("rule A — live run fired blanks", () => {
  it("CRITICAL on the 2026-08-18 16:30Z shape: work in hand, zero sent", () => {
    const dets = detectSendLaneTripwire({
      ...baseInput,
      audit_log: [
        laneRun("h2_outreach_live", "2026-08-18T16:30:30Z", {
          processed: 3, first_touch_sent: 0, idempotent_skipped: 3, errors: 0, outside_hours: 0,
        }),
      ],
    });
    const blank = dets.find((d) => d.id === "send_lane_tripwire_blanks");
    expect(blank?.severity).toBe("critical");
    expect(blank?.title).toContain("sent 0");
  });

  it("silent when the run actually sent, and silent on a genuinely empty queue", () => {
    const dets = detectSendLaneTripwire({
      ...baseInput,
      audit_log: [
        laneRun("h2_outreach_live", "2026-08-18T16:30:30Z", {
          processed: 2, first_touch_sent: 1, errors: 1, idempotent_skipped: 0, outside_hours: 0,
        }),
        laneRun("h2_outreach_live", "2026-08-18T15:00:00Z", {
          processed: 0, first_touch_sent: 0, errors: 0, idempotent_skipped: 0, outside_hours: 0,
        }),
      ],
    });
    expect(dets.find((d) => d.id === "send_lane_tripwire_blanks")).toBeUndefined();
  });

  it("blank runs older than 6h do not fire rule A (they belong to slot history)", () => {
    const dets = detectSendLaneTripwire({
      ...baseInput,
      audit_log: [
        laneRun("h2_outreach_live", "2026-08-18T09:00:00Z", {
          processed: 4, first_touch_sent: 0, idempotent_skipped: 4, errors: 0, outside_hours: 0,
        }),
      ],
    });
    expect(dets.find((d) => d.id === "send_lane_tripwire_blanks")).toBeUndefined();
  });
});

describe("rule B — scheduled slots that never ran", () => {
  it("fires when visible-window slots have no lane-run entries (the skipped-deploy class)", () => {
    // Window reaches back to 12:30Z; h2 slots 13:00/14:00/15:00/16:00/16:30
    // are all visible and complete by NOW 17:00Z — none ran.
    const dets = detectSendLaneTripwire({
      ...baseInput,
      audit_log: [windowAnchor("2026-08-18T12:30:00Z")],
    });
    const miss = dets.find((d) => d.id === "send_lane_tripwire_missed_slots");
    expect(miss).toBeDefined();
    expect(miss?.severity).toBe("critical"); // ≥4 missing
  });

  it("honest coverage: slots outside the visible audit window are never counted", () => {
    // Window only reaches back 20 minutes — no full slot inside it.
    const dets = detectSendLaneTripwire({
      ...baseInput,
      audit_log: [windowAnchor("2026-08-18T16:40:00Z")],
    });
    expect(dets.find((d) => d.id === "send_lane_tripwire_missed_slots")).toBeUndefined();
  });

  it("covered slots (run within grace of the slot) do not count as missing", () => {
    const runs = ["13:01", "14:01", "15:00", "16:00", "16:30"].map((t) =>
      laneRun("h2_outreach_live", `2026-08-18T${t}:30Z`, {
        processed: 0, first_touch_sent: 0, errors: 0, idempotent_skipped: 0, outside_hours: 0,
      }),
    );
    const dets = detectSendLaneTripwire({
      ...baseInput,
      audit_log: [windowAnchor("2026-08-18T12:30:00Z"), ...runs],
    });
    expect(dets.find((d) => d.id === "send_lane_tripwire_missed_slots")).toBeUndefined();
  });
});

describe("expectedSlotsInWindow", () => {
  it("crosses midnight UTC correctly", () => {
    // Window 23:00Z yesterday → 00:30Z today covers yesterday's 23:45 slot only.
    const now = Date.parse("2026-08-18T00:30:00Z");
    const start = Date.parse("2026-08-17T23:00:00Z");
    const slots = expectedSlotsInWindow(H2_LIVE_SLOTS_UTC, start, now);
    expect(slots).toEqual([Date.parse("2026-08-17T23:45:00Z")]);
  });
});
