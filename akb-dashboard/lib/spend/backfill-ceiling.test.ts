// Pins the backfill sweep's paid-call ceiling (2026-07-29).
//
// WHY THIS TEST EXISTS. The appraiser backfill sweep was the #1 paid-API
// burner in the system — every 5 minutes over a ~1,751-record pool, with
// a rehab leg that calls RentCast photo endpoints unconditionally (2 paid
// calls/record) before falling back to Firecrawl. 288 runs/day x 3 records
// x 2 calls = 1,728/day, matching the observed 1,709-call spike on
// 2026-07-28 against a ~150/day baseline and a 1,000-call/month plan.
//
// The invariant these tests protect is the ORDERING: this graveyard sweep
// must yield its budget BEFORE the live-deal lane does, per the operator
// ruling of 2026-07-13 (Spine recT0bGaqgqeh0z4s) that paid data belongs on
// engaged deals, not on every active record. If someone later raises the
// sweep ceiling at or above the engaged lane's, the sweep starts starving
// the money lane and this test fails loudly.

import { describe, it, expect, afterEach } from "vitest";
import { backfillPaid24hCeiling } from "@/app/api/admin/appraiser-backfill/route";
import { paidCalls24hHardCeiling } from "@/app/api/cron/auto-underwrite-engaged/route";

const ENV_KEYS = ["BACKFILL_PAID_24H_CEILING", "RENTCAST_24H_HARD_CEILING"] as const;
const saved = new Map<string, string | undefined>();

afterEach(() => {
  for (const k of ENV_KEYS) {
    const prior = saved.get(k);
    if (prior === undefined) delete process.env[k];
    else process.env[k] = prior;
    saved.delete(k);
  }
});

function setEnv(key: (typeof ENV_KEYS)[number], value: string | undefined): void {
  if (!saved.has(key)) saved.set(key, process.env[key]);
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

describe("backfillPaid24hCeiling", () => {
  it("defaults to 60 paid calls per 24h", () => {
    setEnv("BACKFILL_PAID_24H_CEILING", undefined);
    expect(backfillPaid24hCeiling()).toBe(60);
  });

  it("honors a valid env override", () => {
    setEnv("BACKFILL_PAID_24H_CEILING", "25");
    expect(backfillPaid24hCeiling()).toBe(25);
  });

  it("floors a fractional override rather than spending a partial call", () => {
    setEnv("BACKFILL_PAID_24H_CEILING", "40.9");
    expect(backfillPaid24hCeiling()).toBe(40);
  });

  it.each(["0", "-10", "not-a-number", ""])(
    "falls back to the 60 default on invalid input %j",
    (raw) => {
      setEnv("BACKFILL_PAID_24H_CEILING", raw);
      expect(backfillPaid24hCeiling()).toBe(60);
    },
  );

  // THE LOAD-BEARING INVARIANT. The sweep must hit its ceiling and stop
  // while the engaged (live-deal) lane still has headroom on the same
  // shared 24h paid-call counter.
  it("yields before the engaged live-deal lane on the shared counter", () => {
    setEnv("BACKFILL_PAID_24H_CEILING", undefined);
    setEnv("RENTCAST_24H_HARD_CEILING", undefined);
    expect(backfillPaid24hCeiling()).toBeLessThan(paidCalls24hHardCeiling());
  });

  it("keeps yielding first even when both ceilings are tuned via env", () => {
    setEnv("BACKFILL_PAID_24H_CEILING", "60");
    setEnv("RENTCAST_24H_HARD_CEILING", "150");
    expect(backfillPaid24hCeiling()).toBeLessThan(paidCalls24hHardCeiling());
  });

  // Guards the actual cost bound: at the */30 cadence (48 runs/day) with
  // limit=3 and 2 RentCast photo calls per record, an ungated sweep would
  // still bill 288 calls/day. The ceiling has to be well under that or it
  // is decorative.
  it("binds below the uncapped cost of the */30 cadence (48 x 3 x 2 = 288)", () => {
    setEnv("BACKFILL_PAID_24H_CEILING", undefined);
    const uncappedDailyCost = 48 * 3 * 2;
    expect(backfillPaid24hCeiling()).toBeLessThan(uncappedDailyCost);
  });
});
