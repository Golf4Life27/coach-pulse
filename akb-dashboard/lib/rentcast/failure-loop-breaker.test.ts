// 2026-06-11 P0 — RentCast loop-breaker tests.

import { describe, it, expect, beforeEach } from "vitest";
import {
  callShapeKey,
  checkLoopBreaker,
  recordCallOutcome,
  recordCallError,
  _resetMemoryRing,
  RENTCAST_LOOP_TRIP_AFTER,
  RENTCAST_NOT_FOUND_TTL_S,
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

describe("stable-404 vs transient cooldown (P3 — stop the retry burn)", () => {
  it("a 404 trip is parked for the LONG not-found window, not the 6h transient one", async () => {
    let last;
    for (let i = 0; i < RENTCAST_LOOP_TRIP_AFTER; i++) {
      last = await recordCallOutcome("avm/value", PARAMS, 404);
    }
    expect(last!.tripped).toBe(true);
    expect(last!.cooldownS).toBe(RENTCAST_NOT_FOUND_TTL_S);
    // checkLoopBreaker reflects the same long cooldown for the stored 404.
    expect((await checkLoopBreaker("avm/value", PARAMS)).cooldownS).toBe(RENTCAST_NOT_FOUND_TTL_S);
  });

  it("a transient 5xx loop keeps the SHORT heal window (upstream may recover)", async () => {
    const shape = { ...PARAMS, recordId: "rec5XX" };
    let last;
    for (let i = 0; i < RENTCAST_LOOP_TRIP_AFTER; i++) {
      last = await recordCallOutcome("avm/value", shape, 503);
    }
    expect(last!.tripped).toBe(true);
    // 503 heals fast; 404 is parked ~weeks. The whole point of the split.
    expect(last!.cooldownS).toBeLessThan(RENTCAST_NOT_FOUND_TTL_S);
  });

  it("a 404 window is dramatically longer than the transient window", async () => {
    const a = await recordCallOutcome("properties", { ...PARAMS, recordId: "recA" }, 404);
    const b = await recordCallOutcome("properties", { ...PARAMS, recordId: "recB" }, 500);
    expect(a.cooldownS).toBeGreaterThan(b.cooldownS);
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
