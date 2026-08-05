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
