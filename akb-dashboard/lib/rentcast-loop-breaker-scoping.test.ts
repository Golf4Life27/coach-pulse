// 2026-07-27 P0 — getSubjectFacts / getListingPhotosFromRentCast /
// getRentCastAssessedValue collapsed onto bare global breaker keys
// ("listings/sale|||||", "properties|||||") because their paidFetch calls
// carried no recordId/breakerInputs — one address's 404s tripped the
// breaker for every property system-wide. Also verifies the honest-404
// pattern (#135) is extended to these call sites: a 404 answer is not a
// breaker failure or a confirmed_failure audit entry, but a real 5xx
// still is.
//
// RENTCAST_API_KEY is read at module load in lib/rentcast.ts, so it must
// be set before that module is imported — vi.hoisted runs before imports.
vi.hoisted(() => {
  process.env.RENTCAST_API_KEY = "test-key";
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getSubjectFacts, getListingPhotosFromRentCast, getRentCastAssessedValue } from "./rentcast";
import { _resetMemoryRing, checkLoopBreaker, callShapeKey, RENTCAST_LOOP_TRIP_AFTER } from "./rentcast/failure-loop-breaker";
import { readMemoryRing } from "./audit-log";

const ADDR_A = { address: "123 Main St", city: "San Antonio", state: "TX", zip: "78201" };
const ADDR_B = { address: "456 Oak Ave", city: "San Antonio", state: "TX", zip: "78202" };

beforeEach(() => {
  _resetMemoryRing();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("breaker key scoping — no more global-key collapse", () => {
  it("getSubjectFacts keys the breaker per-address, not a bare global key", async () => {
    // A real failure (not the honest-404 case) so the counter actually moves.
    const fetchMock = vi.fn(async () => new Response("upstream error", { status: 502 }));
    vi.stubGlobal("fetch", fetchMock);

    await getSubjectFacts(ADDR_A);

    // The bare global key (empty recordId/address/city/state/zip) must
    // stay untouched — proof the call shaped its key from the address.
    const globalKey = await checkLoopBreaker("listings/sale", {});
    expect(globalKey.count).toBe(0);

    const addrAKey = await checkLoopBreaker("listings/sale", { ...ADDR_A, recordId: null });
    expect(addrAKey.count).toBe(1);
  });

  it("two different addresses accumulate on two different keys, not one", async () => {
    // 5xx forces a real failure so we can watch the counter climb (404 is
    // the honest-empty case, exercised separately below).
    const fetch5xx = vi.fn(async () => new Response("upstream error", { status: 502 }));
    vi.stubGlobal("fetch", fetch5xx);

    for (let i = 0; i < RENTCAST_LOOP_TRIP_AFTER; i++) await getSubjectFacts(ADDR_A);

    const aState = await checkLoopBreaker("listings/sale", { ...ADDR_A, recordId: null });
    const bState = await checkLoopBreaker("listings/sale", { ...ADDR_B, recordId: null });
    expect(aState.tripped).toBe(true);
    // Address B's counter is untouched by address A's failures — the old
    // bare-key bug would have tripped B here too.
    expect(bState.tripped).toBe(false);
    expect(bState.count).toBe(0);
    expect(callShapeKey("listings/sale", { ...ADDR_A, recordId: null })).not.toBe(
      callShapeKey("listings/sale", { ...ADDR_B, recordId: null }),
    );
  });

  it("getListingPhotosFromRentCast also keys per-address", async () => {
    const fetch5xx = vi.fn(async () => new Response("upstream error", { status: 502 }));
    vi.stubGlobal("fetch", fetch5xx);

    await getListingPhotosFromRentCast(ADDR_A);

    const globalKey = await checkLoopBreaker("listings/sale", {});
    expect(globalKey.count).toBe(0);
    const addrAKey = await checkLoopBreaker("listings/sale", { ...ADDR_A, recordId: null });
    expect(addrAKey.count).toBe(1);
  });

  it("getRentCastAssessedValue keys per-address + recordId", async () => {
    const fetch5xx = vi.fn(async () => new Response("upstream error", { status: 502 }));
    vi.stubGlobal("fetch", fetch5xx);

    await getRentCastAssessedValue(ADDR_A, "recABC");

    const globalKey = await checkLoopBreaker("properties", {});
    expect(globalKey.count).toBe(0);
    const keyed = await checkLoopBreaker("properties", { ...ADDR_A, recordId: "recABC" });
    expect(keyed.count).toBe(1);
  });
});

describe("honest-404 handling — a no-record answer is not a failure", () => {
  it("getSubjectFacts: 404 on both legs does not increment the breaker", async () => {
    const fetchMock = vi.fn(async () => new Response("not found", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    for (let i = 0; i < RENTCAST_LOOP_TRIP_AFTER + 2; i++) {
      const facts = await getSubjectFacts(ADDR_A);
      expect(facts.source).toBeNull();
    }

    const listingsState = await checkLoopBreaker("listings/sale", { ...ADDR_A, recordId: null });
    const propertiesState = await checkLoopBreaker("properties", { ...ADDR_A, recordId: null });
    expect(listingsState.tripped).toBe(false);
    expect(listingsState.count).toBe(0);
    expect(propertiesState.tripped).toBe(false);
    expect(propertiesState.count).toBe(0);
  });

  it("getListingPhotosFromRentCast: 404 on both legs does not increment the breaker", async () => {
    const fetchMock = vi.fn(async () => new Response("not found", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    for (let i = 0; i < RENTCAST_LOOP_TRIP_AFTER + 2; i++) {
      const result = await getListingPhotosFromRentCast(ADDR_A);
      expect(result.photos).toEqual([]);
    }

    const listingsState = await checkLoopBreaker("listings/sale", { ...ADDR_A, recordId: null });
    const propertiesState = await checkLoopBreaker("properties", { ...ADDR_A, recordId: null });
    expect(listingsState.tripped).toBe(false);
    expect(propertiesState.tripped).toBe(false);
  });

  it("getRentCastAssessedValue: 404 does not increment the breaker", async () => {
    const fetchMock = vi.fn(async () => new Response("not found", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    for (let i = 0; i < RENTCAST_LOOP_TRIP_AFTER + 2; i++) {
      expect(await getRentCastAssessedValue(ADDR_A, "recABC")).toBeNull();
    }

    const state = await checkLoopBreaker("properties", { ...ADDR_A, recordId: "recABC" });
    expect(state.tripped).toBe(false);
    expect(state.count).toBe(0);
  });

  it("a genuine 5xx still counts as a breaker failure and trips", async () => {
    const fetchMock = vi.fn(async () => new Response("upstream error", { status: 502 }));
    vi.stubGlobal("fetch", fetchMock);

    for (let i = 0; i < RENTCAST_LOOP_TRIP_AFTER; i++) {
      expect(await getRentCastAssessedValue(ADDR_A, "recABC")).toBeNull();
    }

    const state = await checkLoopBreaker("properties", { ...ADDR_A, recordId: "recABC" });
    expect(state.tripped).toBe(true);
    expect(state.count).toBe(RENTCAST_LOOP_TRIP_AFTER);
    expect(state.lastStatus).toBe(502);
  });

  it("a 404 audits confirmed_success (not confirmed_failure) while a 5xx still audits confirmed_failure", async () => {
    const fetch404 = vi.fn(async () => new Response("not found", { status: 404 }));
    vi.stubGlobal("fetch", fetch404);
    await getRentCastAssessedValue(ADDR_A, "rec404");
    const entries404 = readMemoryRing(50).filter(
      (e) => e.agent === "rentcast" && e.event === "paid_api_call" && e.recordId === "rec404",
    );
    expect(entries404.length).toBeGreaterThan(0);
    for (const e of entries404) {
      expect(e.status).toBe("confirmed_success");
      expect(e.outputSummary?.http).toBe(404);
    }

    vi.unstubAllGlobals();
    const fetch5xx = vi.fn(async () => new Response("upstream error", { status: 502 }));
    vi.stubGlobal("fetch", fetch5xx);
    await getRentCastAssessedValue(ADDR_A, "rec5xx");
    const entries5xx = readMemoryRing(50).filter(
      (e) => e.agent === "rentcast" && e.event === "paid_api_call" && e.recordId === "rec5xx",
    );
    expect(entries5xx.length).toBeGreaterThan(0);
    for (const e of entries5xx) {
      expect(e.status).toBe("confirmed_failure");
    }
  });

  it("a 404 never trips the breaker even far past the threshold, but a 5xx does immediately after", async () => {
    const fetch404 = vi.fn(async () => new Response("not found", { status: 404 }));
    vi.stubGlobal("fetch", fetch404);
    for (let i = 0; i < RENTCAST_LOOP_TRIP_AFTER * 3; i++) {
      await getRentCastAssessedValue(ADDR_B, "recXYZ");
    }
    expect((await checkLoopBreaker("properties", { ...ADDR_B, recordId: "recXYZ" })).tripped).toBe(false);

    // Switch the same shape to a real failure — it must still be able to trip.
    vi.unstubAllGlobals();
    const fetch5xx = vi.fn(async () => new Response("upstream error", { status: 503 }));
    vi.stubGlobal("fetch", fetch5xx);
    for (let i = 0; i < RENTCAST_LOOP_TRIP_AFTER; i++) {
      await getRentCastAssessedValue(ADDR_B, "recXYZ");
    }
    expect((await checkLoopBreaker("properties", { ...ADDR_B, recordId: "recXYZ" })).tripped).toBe(true);
  });
});
