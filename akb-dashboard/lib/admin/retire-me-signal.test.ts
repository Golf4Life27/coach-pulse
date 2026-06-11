// Retire-me signal tests.

import { describe, it, expect, beforeEach } from "vitest";
import {
  noteZeroRun,
  noteWorkRun,
  _resetMemoryRing,
  ZERO_RUN_THRESHOLD,
} from "./retire-me-signal";

const CRON_ID = "url-backfill";
const CTX = { cron_path: "/api/admin/url-backfill?apply=1&limit=10", reason: "cohort_drained" };

beforeEach(() => {
  _resetMemoryRing();
});

describe("noteZeroRun", () => {
  it("counts consecutive zero runs without alerting below threshold", async () => {
    for (let i = 0; i < ZERO_RUN_THRESHOLD - 1; i++) {
      const r = await noteZeroRun(CRON_ID, CTX);
      expect(r.consecutiveZeroRuns).toBe(i + 1);
      expect(r.alerted).toBe(false);
    }
  });
  it("edge-triggers exactly once at the threshold", async () => {
    for (let i = 0; i < ZERO_RUN_THRESHOLD - 1; i++) await noteZeroRun(CRON_ID, CTX);
    const trip = await noteZeroRun(CRON_ID, CTX);
    expect(trip.alerted).toBe(true);
    expect(trip.consecutiveZeroRuns).toBe(ZERO_RUN_THRESHOLD);
    // Stays alerted but does not re-alert (no spam).
    const after = await noteZeroRun(CRON_ID, CTX);
    expect(after.alerted).toBe(true);
    expect(after.consecutiveZeroRuns).toBe(ZERO_RUN_THRESHOLD + 1);
  });
});

describe("noteWorkRun", () => {
  it("clears the counter — a fresh batch heals the signal", async () => {
    for (let i = 0; i < ZERO_RUN_THRESHOLD; i++) await noteZeroRun(CRON_ID, CTX);
    await noteWorkRun(CRON_ID);
    const r = await noteZeroRun(CRON_ID, CTX);
    expect(r.consecutiveZeroRuns).toBe(1);
    expect(r.alerted).toBe(false);
  });
});

describe("cron-id isolation", () => {
  it("a drained backfill does NOT trigger a sibling's retire signal", async () => {
    for (let i = 0; i < ZERO_RUN_THRESHOLD; i++) {
      await noteZeroRun("url-backfill", CTX);
    }
    const sibling = await noteZeroRun("appraiser-backfill", {
      ...CTX,
      cron_path: "/api/admin/appraiser-backfill",
    });
    expect(sibling.alerted).toBe(false);
    expect(sibling.consecutiveZeroRuns).toBe(1);
  });
});
