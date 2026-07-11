import { describe, it, expect } from "vitest";
import {
  readsAgree,
  planLegs,
  callsAvoided,
  readP2Config,
  DEFAULT_LEG_FAILURE_CAP,
  type PlanLegsInput,
} from "./p2-done-gate";

function input(overrides: Partial<PlanLegsInput> = {}): PlanLegsInput {
  return {
    arvValidatedAt: null,
    rehabEstimatedAt: null,
    estimatedMonthlyRent: null,
    force: false,
    kvAvailable: true,
    rehabStable: false,
    failures: { arv: 0, rehab: 0, rent: 0 },
    ...overrides,
  };
}

describe("readsAgree", () => {
  it("agrees when confidences match and mids sit within ±$5", () => {
    expect(readsAgree({ conf: 42, mid: 51_183 }, { conf: 42, mid: 51_183 })).toBe(true);
    expect(readsAgree({ conf: 42, mid: 51_183 }, { conf: 42, mid: 51_188 })).toBe(true);
  });

  it("refuses on mid drift, conf drift, or missing reads", () => {
    expect(readsAgree({ conf: 42, mid: 51_183 }, { conf: 42, mid: 51_190 })).toBe(false);
    expect(readsAgree({ conf: 42, mid: 51_183 }, { conf: 43, mid: 51_183 })).toBe(false);
    expect(readsAgree({ conf: 42, mid: null }, { conf: 42, mid: 51_183 })).toBe(false);
    expect(readsAgree({ conf: null, mid: 51_183 }, { conf: null, mid: 51_183 })).toBe(true);
  });
});

describe("planLegs", () => {
  it("runs all legs on a fresh record", () => {
    expect(planLegs(input())).toEqual({ arv: "run", rehab: "run", rent: "run" });
  });

  it("fires ONLY the missing legs — a completed leg never re-buys its call", () => {
    const p = planLegs(
      input({ arvValidatedAt: "2026-07-01T00:00:00Z", estimatedMonthlyRent: 950 }),
    );
    expect(p).toEqual({ arv: "skip_done", rehab: "run", rent: "skip_done" });
  });

  it("gives the rehab leg exactly one confirmation read, then stable stops it", () => {
    // Read exists, ledger available, not yet stable → the confirmation read runs.
    const confirming = planLegs(input({ rehabEstimatedAt: "2026-07-01T00:00:00Z" }));
    expect(confirming.rehab).toBe("run");
    // Two agreeing reads recorded → never again.
    const stable = planLegs(
      input({ rehabEstimatedAt: "2026-07-01T00:00:00Z", rehabStable: true }),
    );
    expect(stable.rehab).toBe("skip_stable");
  });

  it("fails toward NOT spending when the ledger is unreachable", () => {
    const p = planLegs(
      input({ rehabEstimatedAt: "2026-07-01T00:00:00Z", kvAvailable: false }),
    );
    expect(p.rehab).toBe("skip_done");
  });

  it("benches a leg after the consecutive-failure cap", () => {
    const p = planLegs(
      input({ failures: { arv: DEFAULT_LEG_FAILURE_CAP, rehab: 2, rent: 99 } }),
    );
    expect(p.arv).toBe("skip_failure_capped");
    expect(p.rehab).toBe("run");
    expect(p.rent).toBe("skip_failure_capped");
  });

  it("force overrides every skip", () => {
    const p = planLegs(
      input({
        force: true,
        arvValidatedAt: "x",
        rehabEstimatedAt: "x",
        rehabStable: true,
        estimatedMonthlyRent: 950,
        failures: { arv: 99, rehab: 99, rent: 99 },
      }),
    );
    expect(p).toEqual({ arv: "run", rehab: "run", rent: "run" });
  });
});

describe("callsAvoided", () => {
  it("quantifies the burn each skip avoided, by vendor", () => {
    const avoided = callsAvoided([
      { arv: "skip_done", rehab: "skip_stable", rent: "run" },
      { arv: "run", rehab: "skip_failure_capped", rent: "skip_done" },
    ]);
    expect(avoided).toEqual({ scraperapi: 1, anthropic: 2, rentcast: 1 });
  });
});

describe("readP2Config", () => {
  it("defaults and env overrides", () => {
    expect(readP2Config({})).toEqual({ stableDeltaUsd: 5, failureCap: 5 });
    expect(readP2Config({ P2_STABLE_REHAB_DELTA_USD: "100", P2_LEG_FAILURE_CAP: "3" })).toEqual({
      stableDeltaUsd: 100,
      failureCap: 3,
    });
    expect(readP2Config({ P2_STABLE_REHAB_DELTA_USD: "-1", P2_LEG_FAILURE_CAP: "0" })).toEqual({
      stableDeltaUsd: 5,
      failureCap: 5,
    });
  });
});
