import { describe, it, expect } from "vitest";
import {
  checkBackfillBudget,
  backfillDayKey,
  DEFAULT_BACKFILL_DAILY_RECORDS,
} from "./backfill-budget";

describe("checkBackfillBudget", () => {
  it("lets the sweep run on a fresh day", () => {
    const v = checkBackfillBudget(0, 5);
    expect(v.allowed).toBe(true);
    expect(v.remaining).toBe(5);
  });

  it("hands back only the day's REMAINING allowance", () => {
    expect(checkBackfillBudget(3, 5).remaining).toBe(2);
  });

  it("stops the sweep once the day's budget is spent", () => {
    const v = checkBackfillBudget(5, 5);
    expect(v.allowed).toBe(false);
    expect(v.reason).toBe("daily_record_budget_reached");
  });

  it("is not fooled by an overshoot", () => {
    const v = checkBackfillBudget(9, 5);
    expect(v.allowed).toBe(false);
    expect(v.remaining).toBe(0);
  });

  it("fails OPEN when the meter is unreadable", () => {
    // A monitoring outage must not dark-start the only lane that converts
    // supply into sendable inventory; the per-run limit and the global spend
    // ceiling remain the backstops.
    const v = checkBackfillBudget(null, 5);
    expect(v.allowed).toBe(true);
    expect(v.reason).toBe("meter_unreadable_fail_open");
  });

  it("a zero budget disables the lane outright", () => {
    const v = checkBackfillBudget(0, 0);
    expect(v.allowed).toBe(false);
    expect(v.reason).toBe("budget_disabled");
  });

  // THE REGRESSION THIS EXISTS FOR: the old gate compared TOTAL 24h paid calls
  // across every lane (~79/day observed) against a 60 ceiling, so the sweep
  // never ran — every slot on 2026-08-04 examined 3 and processed 0. Sibling
  // spend must not enter this decision at all.
  it("sibling-lane burn cannot lock the sweep out", () => {
    // Whatever the rest of the system spent today is irrelevant here; the only
    // input is the sweep's OWN record count.
    const v = checkBackfillBudget(0, DEFAULT_BACKFILL_DAILY_RECORDS);
    expect(v.allowed).toBe(true);
    expect(v.remaining).toBe(DEFAULT_BACKFILL_DAILY_RECORDS);
  });

  it("keys the meter per UTC day", () => {
    expect(backfillDayKey(new Date("2026-08-05T00:30:00Z"))).toBe("backfill:records:d:2026-08-05");
    expect(backfillDayKey(new Date("2026-08-04T23:59:00Z"))).toBe("backfill:records:d:2026-08-04");
  });
});
