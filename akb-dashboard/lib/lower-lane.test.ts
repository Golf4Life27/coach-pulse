// @agent: orchestrator — lower-of-two-lanes guard tests.
import { describe, it, expect } from "vitest";
import { takeLowerMao, type LaneMAO } from "./lower-lane";

const landlord = (yourMao: number | null, status: LaneMAO["status"] = "ok"): LaneMAO => ({
  lane: "landlord",
  status,
  investorMao: yourMao != null ? yourMao + 5000 : null,
  yourMao,
  reason: "",
});
const flipper = (yourMao: number | null, status: LaneMAO["status"] = "ok"): LaneMAO => ({
  lane: "flipper",
  status,
  investorMao: yourMao != null ? yourMao + 5000 : null,
  yourMao,
  reason: "",
});

describe("takeLowerMao", () => {
  it("takes the flipper lane when its Your_MAO is lower", () => {
    const v = takeLowerMao(landlord(100_000), flipper(80_000));
    expect(v.operative.lane).toBe("flipper");
    expect(v.operative.yourMao).toBe(80_000);
    expect(v.marginBetweenLanes).toBe(20_000);
    expect(v.reason).toMatch(/LOWER \(flipper\)/);
    expect(v.reason).toMatch(/Landlord lane would have been more permissive/);
  });

  it("takes the landlord lane when its Your_MAO is lower", () => {
    const v = takeLowerMao(landlord(60_000), flipper(75_000));
    expect(v.operative.lane).toBe("landlord");
    expect(v.operative.yourMao).toBe(60_000);
    expect(v.marginBetweenLanes).toBe(15_000);
    expect(v.reason).toMatch(/Flipper lane would have been more permissive/);
  });

  it("ties resolve to landlord (deterministic)", () => {
    const v = takeLowerMao(landlord(50_000), flipper(50_000));
    expect(v.operative.lane).toBe("landlord");
    expect(v.marginBetweenLanes).toBe(0);
  });

  it("uses landlord alone when flipper is holding", () => {
    const v = takeLowerMao(landlord(80_000), flipper(null, "hold"));
    expect(v.operative.lane).toBe("landlord");
    expect(v.operative.yourMao).toBe(80_000);
    expect(v.marginBetweenLanes).toBeNull();
    expect(v.reason).toMatch(/Only landlord lane/);
  });

  it("uses flipper alone when landlord is holding", () => {
    const v = takeLowerMao(landlord(null, "hold"), flipper(50_000));
    expect(v.operative.lane).toBe("flipper");
    expect(v.operative.yourMao).toBe(50_000);
    expect(v.reason).toMatch(/Only flipper lane/);
  });

  it("HOLDs when neither lane computed", () => {
    const v = takeLowerMao(landlord(null, "hold"), flipper(null, "hold"));
    expect(v.operative.lane).toBe("neither");
    expect(v.operative.yourMao).toBeNull();
  });

  it("HOLDs when both lanes are absent (null inputs)", () => {
    const v = takeLowerMao(null, null);
    expect(v.operative.lane).toBe("neither");
  });

  it("never auto-promotes a HOLD/BLOCK status as operative", () => {
    // Flipper at $40k but status="block" must not be used.
    const v = takeLowerMao(landlord(100_000), flipper(40_000, "block"));
    expect(v.operative.lane).toBe("landlord");
    expect(v.operative.yourMao).toBe(100_000);
  });

  it("guards against the permissive-lane-overrides regression (core invariant)", () => {
    // The whole reason for this guard: if landlord were allowed to override
    // a tighter flipper ceiling, we'd over-offer. This test pins the
    // invariant: when both compute, the LOWER wins.
    const v = takeLowerMao(landlord(150_000), flipper(70_000));
    expect(v.operative.yourMao).toBe(70_000);
    expect(v.operative.yourMao).toBeLessThan(150_000);
  });
});
