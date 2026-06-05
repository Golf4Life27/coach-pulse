// @agent: appraiser — rehab read-history median tests.
import { describe, it, expect } from "vitest";
import { foldRehabRead, isValidRehabRead, median, type RehabRead } from "./rehab-median";

const read = (conf: number, mid: number, ts = `2026-06-05T0${conf % 9}:00:00.000Z`): RehabRead => ({
  ts,
  conf,
  rehab_low: Math.round(mid * 0.85),
  rehab_mid: mid,
  rehab_high: Math.round(mid * 1.15),
});

describe("isValidRehabRead", () => {
  it("rejects conf=0 (parse-failure / refused vision)", () => {
    expect(isValidRehabRead(read(0, 38170))).toBe(false);
  });
  it("rejects non-positive rehab_mid", () => {
    expect(isValidRehabRead({ ts: "x", conf: 62, rehab_low: 0, rehab_mid: 0, rehab_high: 0 })).toBe(false);
  });
  it("accepts a real read", () => {
    expect(isValidRehabRead(read(62, 38170))).toBe(true);
  });
  it("rejects null/garbage", () => {
    expect(isValidRehabRead(null)).toBe(false);
    expect(isValidRehabRead({} as never)).toBe(false);
  });
});

describe("median", () => {
  it("odd → middle", () => expect(median([52, 58, 62])).toBe(58));
  it("even → mean of two middles", () => expect(median([52, 58, 62, 68])).toBe(60));
  it("empty → null", () => expect(median([])).toBeNull());
});

describe("foldRehabRead — the persist-median fix", () => {
  it("EXCLUDES a conf=0 misfire — it does not enter history or perturb the median", () => {
    // Three good 62 reads already persisted; a conf=0/$86,750 misfire arrives.
    const prior = [read(62, 38170, "t1"), read(62, 38000, "t2"), read(62, 38500, "t3")];
    const r = foldRehabRead(prior, read(0, 86750, "t4"));
    expect(r.newReadAccepted).toBe(false);
    expect(r.validCount).toBe(3); // misfire NOT added
    expect(r.medianConf).toBe(62);
    expect(r.medianRehabMid).toBe(38170);
    expect(r.gatePass).toBe(true); // misfire didn't flip the gate
  });

  it("median gates UP: a single low outlier doesn't drop a strong median below 60", () => {
    // 62,62,62,62 + one 52 → median 62 → still PASS.
    const prior = [read(62, 38000, "a"), read(62, 38000, "b"), read(62, 38000, "c"), read(62, 38000, "d")];
    const r = foldRehabRead(prior, read(52, 41000, "e"));
    expect(r.newReadAccepted).toBe(true);
    expect(r.validCount).toBe(5);
    expect(r.medianConf).toBe(62);
    expect(r.gatePass).toBe(true);
  });

  it("median gates DOWN: a genuinely weak photo set (mostly <60) HOLDs", () => {
    // 52,55,58,58 + one 62 → median 58 → HOLD. The gate correctly holds.
    const prior = [read(52, 40000, "a"), read(55, 39000, "b"), read(58, 38000, "c"), read(58, 38000, "d")];
    const r = foldRehabRead(prior, read(62, 37000, "e"));
    expect(r.validCount).toBe(5);
    expect(r.medianConf).toBe(58);
    expect(r.gatePass).toBe(false); // does NOT pass on one good read
  });

  it("rejects 'keep highest' bias: max would be 62 (PASS) but median is 58 (HOLD)", () => {
    const prior = [read(58, 38000, "a"), read(58, 38000, "b"), read(58, 38000, "c")];
    const r = foldRehabRead(prior, read(62, 37000, "d"));
    // 58,58,58,62 → median = (58+58)/2 = 58. Max-of would be 62.
    expect(r.medianConf).toBe(58);
    expect(r.gatePass).toBe(false);
  });

  it("caps history to the last 5 valid reads", () => {
    let hist: RehabRead[] = [];
    for (let i = 1; i <= 8; i++) hist = foldRehabRead(hist, read(60 + i, 38000 + i, `t${i}`)).history;
    expect(hist.length).toBe(5);
    expect(hist[0].ts).toBe("t4"); // oldest kept is the 4th
    expect(hist[4].ts).toBe("t8");
  });

  it("persists the median rehab band (low/mid/high medianed independently)", () => {
    const prior = [read(62, 30000, "a"), read(62, 40000, "b")];
    const r = foldRehabRead(prior, read(62, 50000, "c"));
    expect(r.medianRehabMid).toBe(40000); // median of 30k,40k,50k
  });

  it("no valid reads at all (first fire is a misfire) → null median, no gate, nothing to persist", () => {
    const r = foldRehabRead([], read(0, 0, "t1"));
    expect(r.validCount).toBe(0);
    expect(r.medianRehabMid).toBeNull();
    expect(r.medianConf).toBeNull();
    expect(r.gatePass).toBe(false);
  });

  it("sanitizes a corrupt prior history blob", () => {
    const corrupt = [{ ts: "x", conf: 0, rehab_low: 0, rehab_mid: 0, rehab_high: 0 }, read(62, 38000, "ok")];
    const r = foldRehabRead(corrupt as never, read(62, 39000, "new"));
    expect(r.validCount).toBe(2); // only the one valid prior + new
    expect(r.medianConf).toBe(62);
  });
});
