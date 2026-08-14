import { describe, it, expect } from "vitest";
import {
  assessRetirement,
  computeCapacity,
  planPortfolio,
  yieldScore,
  DEFAULT_EXPLORATION_SHARE,
  MIN_CRAWLS_BEFORE_RETIREMENT,
  type ZipYieldRow,
} from "./portfolio";
import { buildYieldRows, type BuildYieldRowsInput } from "./send-yield";

function row(over: Partial<ZipYieldRow> = {}): ZipYieldRow {
  return {
    zip: "48214",
    sends: 0,
    recordsIngested: 0,
    crawlCount: 10,
    lastIngestedAt: "2026-08-01T00:00:00.000Z",
    eligibleForSends: true,
    ...over,
  };
}

describe("assessRetirement — silence only counts when speech was possible", () => {
  it("retires a ZIP that could send, was crawled enough, and sent nothing", () => {
    const v = assessRetirement(row());
    expect(v.retire).toBe(true);
  });

  // The San Antonio guard. All 56 SA ZIPs had zero sends on 2026-08-13 because
  // a non-disclosure hold made them unpriceable — not because they are bad.
  it("NEVER retires a ZIP that could not have sent (the San Antonio case)", () => {
    const v = assessRetirement(row({ eligibleForSends: false, crawlCount: 500 }));
    expect(v.retire).toBe(false);
    expect(v.reason).toMatch(/silence is not evidence/);
  });

  it("never retires a never-crawled ZIP", () => {
    expect(assessRetirement(row({ lastIngestedAt: null })).retire).toBe(false);
  });

  it("treats an unmeasured send counter as no-evidence, not as zero", () => {
    const v = assessRetirement(row({ sends: null }));
    expect(v.retire).toBe(false);
    expect(v.reason).toMatch(/not a zero/);
  });

  it("requires enough crawls before silence blames the ZIP", () => {
    expect(assessRetirement(row({ crawlCount: MIN_CRAWLS_BEFORE_RETIREMENT - 1 })).retire).toBe(false);
    expect(assessRetirement(row({ crawlCount: MIN_CRAWLS_BEFORE_RETIREMENT })).retire).toBe(true);
  });

  it("a single send keeps the slot", () => {
    expect(assessRetirement(row({ sends: 1 })).retire).toBe(false);
  });

  it("records ingested NEVER save a ZIP that sent nothing — the 1,326 case", () => {
    // 1,326 accepted records, zero sends: the exact San-Antonio-import shape,
    // but with eligibility true so only the metric is under test.
    expect(assessRetirement(row({ recordsIngested: 1326, sends: 0 })).retire).toBe(true);
  });
});

describe("computeCapacity — portfolio size is arithmetic, not a hand-picked list", () => {
  it("sizes from budget and cadence", () => {
    // 164 calls/day at weekly cadence -> 164 * 7 = 1,148 ZIP slots.
    const c = computeCapacity({ callsPerDayForIntake: 164, targetCycleHours: 168 });
    expect(c.maxZips).toBe(1148);
  });

  it("daily cadence costs 7x the slots of weekly — the operator's real lever", () => {
    const daily = computeCapacity({ callsPerDayForIntake: 100, targetCycleHours: 24 });
    const weekly = computeCapacity({ callsPerDayForIntake: 100, targetCycleHours: 168 });
    expect(daily.maxZips).toBe(100);
    expect(weekly.maxZips).toBe(700);
  });

  it("holds back an exploration reserve by default", () => {
    const c = computeCapacity({ callsPerDayForIntake: 100, targetCycleHours: 24 });
    expect(c.explorationSlots).toBe(Math.floor(100 * DEFAULT_EXPLORATION_SHARE));
    expect(c.earnedSlots + c.explorationSlots).toBe(c.maxZips);
  });

  it("degenerate budgets do not produce negative or fractional slots", () => {
    const c = computeCapacity({ callsPerDayForIntake: 0, targetCycleHours: 24 });
    expect(c.maxZips).toBe(0);
    expect(c.earnedSlots).toBe(0);
  });
});

describe("yieldScore — sends dominate, records only break ties", () => {
  it("one send outranks any number of accepted records", () => {
    const sender = row({ sends: 1, recordsIngested: 0 });
    const hoarder = row({ zip: "48215", sends: 0, recordsIngested: 100_000 });
    expect(yieldScore(sender)).toBeGreaterThan(yieldScore(hoarder));
  });

  it("records order two ZIPs with equal sends", () => {
    const a = row({ sends: 2, recordsIngested: 50 });
    const b = row({ zip: "48215", sends: 2, recordsIngested: 10 });
    expect(yieldScore(a)).toBeGreaterThan(yieldScore(b));
  });
});

describe("planPortfolio — admission by displacement", () => {
  const capacity = computeCapacity({ callsPerDayForIntake: 10, targetCycleHours: 24 }); // 10 slots, 1 exploration

  it("keeps the highest-sending ZIPs and benches the overflow", () => {
    const rows = Array.from({ length: 15 }, (_, i) =>
      row({ zip: `4820${i}`.slice(0, 5).padStart(5, "4"), sends: i, lastIngestedAt: "2026-08-01T00:00:00.000Z" }),
    ).map((r, i) => ({ ...r, zip: String(48200 + i) }));
    const plan = planPortfolio({ rows, capacity });
    expect(plan.overSubscribed).toBe(true);
    const active = plan.assignments.filter((a) => a.status === "active").map((a) => a.zip);
    // Highest sends (i=14 -> zip 48214) must be in; lowest (i=0) must not.
    expect(active).toContain("48214");
    expect(active).not.toContain("48200");
  });

  it("a benched ZIP is NOT retired — losing a competition is not evidence of failure", () => {
    const rows = Array.from({ length: 15 }, (_, i) => row({ zip: String(48200 + i), sends: i }));
    const plan = planPortfolio({ rows, capacity });
    expect(plan.counts.benched).toBeGreaterThan(0);
    // Every one of these could send and sent >0 except zip 48200; that one
    // retires on merit, the rest that miss out are benched, not retired.
    const benched = plan.assignments.filter((a) => a.status === "benched");
    for (const b of benched) expect(b.status).not.toBe("retired");
  });

  it("never-crawled ZIPs draw from the exploration reserve, not the earned pool", () => {
    const incumbents = Array.from({ length: 20 }, (_, i) => row({ zip: String(48200 + i), sends: 5 }));
    const newcomer = row({ zip: "78207", lastIngestedAt: null, sends: null, crawlCount: 0 });
    const plan = planPortfolio({ rows: [...incumbents, newcomer], capacity });
    const sa = plan.assignments.find((a) => a.zip === "78207");
    expect(sa?.status).toBe("exploring");
  });

  it("unused exploration slots fall through to the earned pool", () => {
    // No newcomers at all: all 10 slots should go to earners, not 9.
    const rows = Array.from({ length: 12 }, (_, i) => row({ zip: String(48200 + i), sends: i + 1 }));
    const plan = planPortfolio({ rows, capacity });
    expect(plan.counts.active).toBe(capacity.maxZips);
  });

  it("retired ZIPs do not consume slots", () => {
    const dead = Array.from({ length: 5 }, (_, i) => row({ zip: String(48300 + i), sends: 0 }));
    const live = Array.from({ length: 10 }, (_, i) => row({ zip: String(48200 + i), sends: 3 }));
    const plan = planPortfolio({ rows: [...dead, ...live], capacity });
    expect(plan.counts.retired).toBe(5);
    expect(plan.counts.active).toBe(10);
    expect(plan.counts.benched).toBe(0);
  });

  it("a whole unpriceable metro survives a planning pass intact", () => {
    // 56 San Antonio ZIPs, freshly seeded, never crawled, zero sends. The
    // policy must not quietly delete the operator's only proven market.
    const sa = Array.from({ length: 56 }, (_, i) =>
      row({ zip: String(78200 + i), sends: null, crawlCount: 0, lastIngestedAt: null, eligibleForSends: false }),
    );
    const plan = planPortfolio({ rows: sa, capacity });
    expect(plan.counts.retired).toBe(0);
  });

  it("is deterministic and dedupes", () => {
    const rows = [row({ zip: "48214", sends: 1 }), row({ zip: "48214", sends: 9 })];
    const plan = planPortfolio({ rows, capacity });
    expect(plan.assignments.filter((a) => a.zip === "48214")).toHaveLength(1);
  });
});

// ── buildYieldRows: the join, and the two ways it must fail safe ──────────
describe("buildYieldRows — eligibility and the unmeasured case", () => {
  const reg = (over: Partial<BuildYieldRowsInput["registry"][number]> = {}) => ({
    zip: "48214",
    lastIngestedAt: "2026-08-01T00:00:00.000Z",
    recordsIngested: 10,
    crawlCount: 9,
    openerHold: false,
    saturated: false,
    seeded: true,
    ...over,
  });

  it("a failed send read yields NULL sends, not zeros — one bad night must not wipe the circuit", () => {
    const rows = buildYieldRows({
      registry: [reg(), reg({ zip: "48215" })],
      sendsByZip: new Map(),
      sendsMeasured: false,
    });
    expect(rows.every((r) => r.sends === null)).toBe(true);
    for (const r of rows) expect(assessRetirement(r).retire).toBe(false);
  });

  it("a successful read with no sends for a ZIP is a real zero", () => {
    const rows = buildYieldRows({ registry: [reg()], sendsByZip: new Map(), sendsMeasured: true });
    expect(rows[0].sends).toBe(0);
    expect(assessRetirement(rows[0]).retire).toBe(true);
  });

  it("held, saturated or unseeded ZIPs are never eligible — so never retired", () => {
    const cases = [reg({ openerHold: true }), reg({ saturated: true }), reg({ seeded: false })];
    for (const c of cases) {
      const [r] = buildYieldRows({ registry: [c], sendsByZip: new Map(), sendsMeasured: true });
      expect(r.eligibleForSends).toBe(false);
      expect(assessRetirement(r).retire).toBe(false);
    }
  });
});
