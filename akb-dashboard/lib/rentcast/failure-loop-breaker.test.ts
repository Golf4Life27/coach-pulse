// 2026-06-11 P0 — RentCast loop-breaker tests.

import { describe, it, expect, beforeEach } from "vitest";
import {
  callShapeKey,
  checkLoopBreaker,
  recordCallOutcome,
  recordCallError,
  _resetMemoryRing,
  RENTCAST_LOOP_TRIP_AFTER,
} from "./failure-loop-breaker";

const PARAMS = { address: "123 Main St", city: "San Antonio", state: "TX", zip: "78201", recordId: "recABC" };

beforeEach(() => {
  _resetMemoryRing();
});

describe("callShapeKey", () => {
  it("same inputs → same key (case-insensitive on address fields)", () => {
    expect(callShapeKey("properties", PARAMS)).toBe(
      callShapeKey("properties", { ...PARAMS, address: "123 MAIN ST", city: "san antonio" }),
    );
  });
  it("different recordId → different key", () => {
    expect(callShapeKey("properties", PARAMS)).not.toBe(
      callShapeKey("properties", { ...PARAMS, recordId: "recXYZ" }),
    );
  });
  it("different endpoint → different key (a 404 on /properties shouldn't trip /avm/value)", () => {
    expect(callShapeKey("properties", PARAMS)).not.toBe(
      callShapeKey("avm/value", PARAMS),
    );
  });
});

describe("checkLoopBreaker on a fresh key", () => {
  it("returns tripped=false when no prior failures recorded", async () => {
    const v = await checkLoopBreaker("properties", PARAMS);
    expect(v.tripped).toBe(false);
    expect(v.count).toBe(0);
    expect(v.lastStatus).toBeNull();
  });
});

describe("recordCallOutcome — failure path", () => {
  it("increments on 404 but does not trip below threshold", async () => {
    for (let i = 0; i < RENTCAST_LOOP_TRIP_AFTER - 1; i++) {
      const v = await recordCallOutcome("properties", PARAMS, 404);
      expect(v.tripped).toBe(false);
      expect(v.count).toBe(i + 1);
    }
  });
  it("trips at exactly RENTCAST_LOOP_TRIP_AFTER", async () => {
    for (let i = 0; i < RENTCAST_LOOP_TRIP_AFTER - 1; i++) {
      await recordCallOutcome("properties", PARAMS, 404);
    }
    const v = await recordCallOutcome("properties", PARAMS, 404);
    expect(v.tripped).toBe(true);
    expect(v.count).toBe(RENTCAST_LOOP_TRIP_AFTER);
    expect(v.lastStatus).toBe(404);
  });
  it("stays tripped on subsequent failures (no re-alert spam — edge-triggered)", async () => {
    for (let i = 0; i < RENTCAST_LOOP_TRIP_AFTER + 5; i++) {
      await recordCallOutcome("properties", PARAMS, 404);
    }
    const v = await checkLoopBreaker("properties", PARAMS);
    expect(v.tripped).toBe(true);
    expect(v.count).toBe(RENTCAST_LOOP_TRIP_AFTER + 5);
  });
});

describe("recordCallOutcome — success path", () => {
  it("a 2xx clears the counter — recovery heals the breaker", async () => {
    for (let i = 0; i < RENTCAST_LOOP_TRIP_AFTER; i++) {
      await recordCallOutcome("properties", PARAMS, 404);
    }
    expect((await checkLoopBreaker("properties", PARAMS)).tripped).toBe(true);

    await recordCallOutcome("properties", PARAMS, 200);
    const v = await checkLoopBreaker("properties", PARAMS);
    expect(v.tripped).toBe(false);
    expect(v.count).toBe(0);
  });
  it("a 2xx on a different shape does NOT clear the looping shape", async () => {
    for (let i = 0; i < RENTCAST_LOOP_TRIP_AFTER; i++) {
      await recordCallOutcome("properties", PARAMS, 404);
    }
    await recordCallOutcome("properties", { ...PARAMS, recordId: "recOTHER" }, 200);
    const v = await checkLoopBreaker("properties", PARAMS);
    expect(v.tripped).toBe(true);
  });
});

describe("recordCallError — network failures", () => {
  it("counts thrown errors toward the trip threshold", async () => {
    for (let i = 0; i < RENTCAST_LOOP_TRIP_AFTER - 1; i++) {
      await recordCallError("properties", PARAMS);
    }
    const v = await recordCallError("properties", PARAMS);
    expect(v.tripped).toBe(true);
    expect(v.lastStatus).toBe(-1);
  });
});

describe("call-shape isolation", () => {
  it("a tripped shape does NOT trip a sibling endpoint on the same record", async () => {
    for (let i = 0; i < RENTCAST_LOOP_TRIP_AFTER; i++) {
      await recordCallOutcome("properties", PARAMS, 404);
    }
    const sibling = await checkLoopBreaker("avm/value", PARAMS);
    expect(sibling.tripped).toBe(false);
  });
});
