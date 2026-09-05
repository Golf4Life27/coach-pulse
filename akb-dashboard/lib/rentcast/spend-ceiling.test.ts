import { describe, it, expect, beforeEach } from "vitest";
import {
  evaluateSpendCeiling,
  invocationSpend,
  noteInvocationCall,
  __resetInvocationCounter,
  dayKey,
  monthKey,
  type SpendWindows,
} from "./spend-ceiling";

const CAPS: SpendWindows = { invocation: 60, day: 150, month: 1000 };

describe("evaluateSpendCeiling", () => {
  it("allows a call under every window", () => {
    const v = evaluateSpendCeiling({ invocation: 5, day: 40, month: 600 }, CAPS);
    expect(v.allowed).toBe(true);
    expect(v.blockedBy).toBeNull();
    expect(v.reason).toBeNull();
  });

  it("blocks at the invocation cap FIRST — a loop running right now is the worst case", () => {
    // Every window is over; the invocation trip must win, because it is the
    // only one that means the bleed is happening this second.
    const v = evaluateSpendCeiling({ invocation: 60, day: 999, month: 99_999 }, CAPS);
    expect(v.allowed).toBe(false);
    expect(v.blockedBy).toBe("invocation");
  });

  it("blocks on the day window when the invocation window is fine", () => {
    const v = evaluateSpendCeiling({ invocation: 2, day: 150, month: 200 }, CAPS);
    expect(v.blockedBy).toBe("day");
    expect(v.reason).toContain("rentcast_daily_cap");
  });

  it("blocks on the month window last — that one is about the bill", () => {
    const v = evaluateSpendCeiling({ invocation: 2, day: 10, month: 1000 }, CAPS);
    expect(v.blockedBy).toBe("month");
    expect(v.reason).toContain("rentcast_monthly_cap");
  });

  it("is inclusive at the cap: AT the limit refuses, one below allows", () => {
    expect(evaluateSpendCeiling({ invocation: 59, day: 0, month: 0 }, CAPS).allowed).toBe(true);
    expect(evaluateSpendCeiling({ invocation: 60, day: 0, month: 0 }, CAPS).allowed).toBe(false);
  });

  it("surfaces spent + caps on a refusal so the audit row can be diagnosed", () => {
    const v = evaluateSpendCeiling({ invocation: 2, day: 151, month: 300 }, CAPS);
    expect(v.spent).toEqual({ invocation: 2, day: 151, month: 300 });
    expect(v.caps).toEqual(CAPS);
  });

  it("the June shape: 18,750 calls in a month is refused, not billed", () => {
    // Reconstructed from the RentCast payment history — four $250 overage
    // auto-charges in June 2026. Under this ceiling the month window trips
    // at 1,000 and the remaining ~17,750 calls never reach the wire.
    const v = evaluateSpendCeiling({ invocation: 1, day: 20, month: 18_750 }, CAPS);
    expect(v.allowed).toBe(false);
    expect(v.blockedBy).toBe("month");
  });
});

describe("the in-memory invocation counter", () => {
  beforeEach(() => __resetInvocationCounter());

  it("counts without any infrastructure — this is the KV-outage backstop", () => {
    expect(invocationSpend()).toBe(0);
    noteInvocationCall();
    noteInvocationCall();
    expect(invocationSpend()).toBe(2);
  });

  it("a runaway loop hits the cap with KV completely absent", () => {
    // The whole point: even with day/month blind (fail-open), a single
    // lambda cannot exceed the invocation cap.
    let refusedAt: number | null = null;
    for (let i = 0; i < 500; i++) {
      const v = evaluateSpendCeiling({ invocation: invocationSpend(), day: 0, month: 0 }, CAPS);
      if (!v.allowed) { refusedAt = i; break; }
      noteInvocationCall();
    }
    expect(refusedAt).toBe(60);
  });
});

describe("KV bucket keys", () => {
  it("buckets by UTC day and UTC month", () => {
    const d = new Date("2026-06-09T23:59:00.000Z");
    expect(dayKey(d)).toBe("rc:spend:d:2026-06-09");
    expect(monthKey(d)).toBe("rc:spend:m:2026-06");
  });

  it("rolls the day bucket at UTC midnight, not local", () => {
    expect(dayKey(new Date("2026-06-10T00:00:01.000Z"))).toBe("rc:spend:d:2026-06-10");
  });
});

describe("the 2026-09-05 throttle — lane share of the day cap", () => {
  // Day cap 80 (the throttle default): sweep yields at 20, batch at 40,
  // discovery at 60, live keeps all 80.
  const THROTTLED: SpendWindows = { invocation: 60, day: 80, month: 5000 };

  it("a sweep is refused once a quarter of the day is spent, while live work still runs", () => {
    const sweep = evaluateSpendCeiling({ invocation: 1, day: 20, month: 100 }, THROTTLED, "sweep");
    expect(sweep.allowed).toBe(false);
    expect(sweep.blockedBy).toBe("day");
    expect(sweep.lane).toBe("sweep");
    expect(sweep.laneDayCap).toBe(20);
    expect(sweep.reason).toContain("sweep lane share 20");

    const live = evaluateSpendCeiling({ invocation: 1, day: 20, month: 100 }, THROTTLED, "live");
    expect(live.allowed).toBe(true);
    expect(live.laneDayCap).toBe(80);
  });

  it("the morning sweeps cannot spend the seller's rent estimate: at 79 calls live still goes, batch does not", () => {
    expect(evaluateSpendCeiling({ invocation: 1, day: 79, month: 100 }, THROTTLED, "live").allowed).toBe(true);
    expect(evaluateSpendCeiling({ invocation: 1, day: 79, month: 100 }, THROTTLED, "batch").allowed).toBe(false);
    expect(evaluateSpendCeiling({ invocation: 1, day: 79, month: 100 }, THROTTLED, "discovery").allowed).toBe(false);
  });

  it("live is refused only at the full day cap", () => {
    const v = evaluateSpendCeiling({ invocation: 1, day: 80, month: 100 }, THROTTLED, "live");
    expect(v.allowed).toBe(false);
    expect(v.blockedBy).toBe("day");
  });

  it("lane defaults to live so existing callers keep the plain cap", () => {
    const v = evaluateSpendCeiling({ invocation: 1, day: 60, month: 100 }, THROTTLED);
    expect(v.lane).toBe("live");
    expect(v.allowed).toBe(true);
  });

  it("the invocation trip still wins over the lane share — a loop is the worst case", () => {
    const v = evaluateSpendCeiling({ invocation: 60, day: 0, month: 0 }, THROTTLED, "sweep");
    expect(v.blockedBy).toBe("invocation");
  });
});

describe("the effective day cap is the smaller of hard ceiling and throttle", () => {
  it("defaults: throttle 80 under a 300 hard ceiling → 80", async () => {
    const mod = await import("./spend-ceiling");
    expect(mod.RENTCAST_DAILY_THROTTLE).toBe(80);
    expect(mod.RENTCAST_HARD_CEILING).toBe(300);
    expect(mod.RENTCAST_DAILY_CAP).toBe(80);
    expect(mod.currentCaps().day).toBe(80);
  });
});
