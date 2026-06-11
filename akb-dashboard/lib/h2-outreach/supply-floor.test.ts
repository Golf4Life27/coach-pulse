// Supply-floor evaluator tests — the daily-minimum SUPPLY signal.

import { describe, it, expect } from "vitest";
import { evaluateSupplyFloor, SUPPLY_FLOOR } from "./supply-floor";

const HEALTHY = {
  sendableQueueDepth: 15,
  stalledBehindAgents: 4,
  intakeLive: true,
  seededZipsCount: 5,
};

describe("supply healthy", () => {
  it("no alert when depth >= floor", () => {
    const v = evaluateSupplyFloor(HEALTHY);
    expect(v.alertNeeded).toBe(false);
    expect(v.belowFloor).toBe(false);
    expect(v.bindingConstraint).toBe("supply_healthy");
  });
  it("treats depth === floor as healthy (strict <, not <=)", () => {
    const v = evaluateSupplyFloor({ ...HEALTHY, sendableQueueDepth: SUPPLY_FLOOR });
    expect(v.alertNeeded).toBe(false);
  });
});

describe("binding-constraint precedence — intake_dry wins over everything", () => {
  it("CRAWLER_INTAKE_LIVE off → intake_dry, regardless of other signals", () => {
    const v = evaluateSupplyFloor({
      sendableQueueDepth: 0,
      stalledBehindAgents: 20,
      intakeLive: false,
      seededZipsCount: 1,
    });
    expect(v.bindingConstraint).toBe("intake_dry");
    expect(v.description.toLowerCase()).toContain("crawler_intake_live");
    expect(v.description.toLowerCase()).toContain("hunt is off");
  });
});

describe("zips_exhausted — second precedence", () => {
  it("intake live + map 1 ZIP wide + depth low → zips_exhausted", () => {
    const v = evaluateSupplyFloor({
      sendableQueueDepth: 2,
      stalledBehindAgents: 0,
      intakeLive: true,
      seededZipsCount: 1,
    });
    expect(v.bindingConstraint).toBe("zips_exhausted");
    expect(v.description).toContain("1 priceable seeded ZIP");
  });
  it("seededZipsCount 0 (store unreachable / fallback emptied) still trips zips_exhausted", () => {
    const v = evaluateSupplyFloor({
      sendableQueueDepth: 0,
      stalledBehindAgents: 0,
      intakeLive: true,
      seededZipsCount: 0,
    });
    expect(v.bindingConstraint).toBe("zips_exhausted");
  });
});

describe("stalled_behind_agents — third precedence", () => {
  it("intake live, map wide, stalls ≥ depth → stalled_behind_agents", () => {
    const v = evaluateSupplyFloor({
      sendableQueueDepth: 3,
      stalledBehindAgents: 20,
      intakeLive: true,
      seededZipsCount: 5,
    });
    expect(v.bindingConstraint).toBe("stalled_behind_agents");
    expect(v.description).toContain("20 records held");
    expect(v.description.toLowerCase()).toContain("stall-release");
  });
});

describe("natural_low_supply — bottom of the precedence chain", () => {
  it("intake live, map wide, stalls low → natural_low_supply (no single lever)", () => {
    const v = evaluateSupplyFloor({
      sendableQueueDepth: 5,
      stalledBehindAgents: 2,
      intakeLive: true,
      seededZipsCount: 5,
    });
    expect(v.bindingConstraint).toBe("natural_low_supply");
    expect(v.description.toLowerCase()).toContain("routine");
  });
});

describe("today's actual shape — operator's anchor case", () => {
  it("CRAWLER_INTAKE_LIVE unset + 1 seeded ZIP + ~20 stalled → intake_dry (the source-of-truth root cause)", () => {
    const v = evaluateSupplyFloor({
      sendableQueueDepth: 0,
      stalledBehindAgents: 20,
      intakeLive: false,
      seededZipsCount: 1,
    });
    expect(v.alertNeeded).toBe(true);
    expect(v.bindingConstraint).toBe("intake_dry");
    // Precedence ensures the operator sees the deepest cause first,
    // not the surface symptom (stalls).
  });
});

describe("alertNeeded ↔ belowFloor", () => {
  it("alertNeeded === belowFloor for every shape", () => {
    const cases = [
      { sendableQueueDepth: 0, stalledBehindAgents: 0, intakeLive: false, seededZipsCount: 0 },
      { sendableQueueDepth: 9, stalledBehindAgents: 0, intakeLive: true, seededZipsCount: 5 },
      { sendableQueueDepth: 10, stalledBehindAgents: 0, intakeLive: true, seededZipsCount: 5 },
      { sendableQueueDepth: 100, stalledBehindAgents: 0, intakeLive: true, seededZipsCount: 5 },
    ];
    for (const c of cases) {
      const v = evaluateSupplyFloor(c);
      expect(v.alertNeeded).toBe(v.belowFloor);
    }
  });
});
