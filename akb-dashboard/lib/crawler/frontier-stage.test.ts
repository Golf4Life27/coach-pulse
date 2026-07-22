import { describe, it, expect } from "vitest";
import {
  decideStaging,
  listExpansionMetros,
  targetStagedBacklog,
  type ExpansionMetro,
} from "./frontier-stage";

const RESTRICTED = new Set(["IL", "MO", "SC", "NC", "OK", "ND"]);
const NON_DISCLOSURE = new Set(["AK", "ID", "KS", "LA", "MS", "MO", "MT", "ND", "NM", "TX", "UT", "WY"]);

const METROS: ExpansionMetro[] = [
  { id: "toledo_oh", label: "Toledo, OH", state: "OH", market: "Toledo", zips: ["43605", "43607", "43608"] },
  { id: "flint_mi", label: "Flint, MI", state: "MI", market: "Flint", zips: ["48503", "48504"] },
  { id: "wichita_ks", label: "Wichita, KS", state: "KS", market: "Wichita", zips: ["67214"] },
  { id: "chicago_il", label: "Chicago, IL", state: "IL", market: "Chicago", zips: ["60636"] },
];

function base(overrides: Partial<Parameters<typeof decideStaging>[0]> = {}) {
  return {
    existingZips: new Set<string>(),
    restrictedStates: RESTRICTED,
    nonDisclosureStates: NON_DISCLOSURE,
    stagedBacklog: 0,
    targetBacklog: 12,
    maxPerPass: 30,
    metros: METROS,
    ...overrides,
  };
}

describe("decideStaging — chew through one metro, then the next", () => {
  it("stages the first metro fully before opening the second", () => {
    const d = decideStaging(base({ targetBacklog: 4, maxPerPass: 4 }));
    expect(d.toStage.map((s) => s.zip)).toEqual(["43605", "43607", "43608", "48503"]);
    expect(d.metrosOpened).toEqual(["toledo_oh", "flint_mi"]);
  });

  it("never stages restricted or non-disclosure states, whatever the config says", () => {
    const d = decideStaging(base());
    const staged = d.toStage.map((s) => s.zip);
    expect(staged).not.toContain("67214"); // KS non-disclosure
    expect(staged).not.toContain("60636"); // IL restricted
    expect(d.skipped.non_disclosure_state).toBe(1);
    expect(d.skipped.restricted_state).toBe(1);
  });

  it("never re-stages a ZIP already in the registry (any tier)", () => {
    const d = decideStaging(base({ existingZips: new Set(["43605", "48503"]) }));
    expect(d.toStage.map((s) => s.zip)).toEqual(["43607", "43608", "48504"]);
    expect(d.skipped.already_in_registry).toBe(2);
  });

  it("stages only up to the backlog gap, bounded by maxPerPass", () => {
    expect(decideStaging(base({ stagedBacklog: 10, targetBacklog: 12 })).toStage).toHaveLength(2);
    expect(decideStaging(base({ targetBacklog: 100, maxPerPass: 3 })).toStage).toHaveLength(3);
    expect(decideStaging(base({ stagedBacklog: 20, targetBacklog: 12 })).toStage).toHaveLength(0);
  });

  it("flags queue exhaustion so the operator knows to append metros", () => {
    const allIn = new Set(["43605", "43607", "43608", "48503", "48504"]);
    const d = decideStaging(base({ existingZips: allIn }));
    expect(d.toStage).toHaveLength(0);
    expect(d.queueExhausted).toBe(true);
    // Not exhausted when the pass simply wanted nothing.
    expect(decideStaging(base({ stagedBacklog: 50, targetBacklog: 12 })).queueExhausted).toBe(false);
  });

  it("drops malformed zips with a count", () => {
    const d = decideStaging(
      base({ metros: [{ id: "m", label: "M", state: "OH", market: "M", zips: ["4360", "43605"] }] }),
    );
    expect(d.toStage.map((s) => s.zip)).toEqual(["43605"]);
    expect(d.skipped.malformed_zip).toBe(1);
  });
});

describe("targetStagedBacklog", () => {
  it("keeps 2× promotion capacity queued, with a floor", () => {
    expect(targetStagedBacklog(20)).toBe(40);
    expect(targetStagedBacklog(0)).toBe(12);
    expect(targetStagedBacklog(3)).toBe(12);
  });
});

describe("the live expansion config", () => {
  it("contains only well-formed, stageable metros (no restricted / non-disclosure states)", () => {
    const metros = listExpansionMetros();
    expect(metros.length).toBeGreaterThan(10);
    for (const m of metros) {
      expect(RESTRICTED.has(m.state)).toBe(false);
      expect(NON_DISCLOSURE.has(m.state)).toBe(false);
      expect(m.zips.length).toBeGreaterThan(0);
      for (const z of m.zips) expect(z).toMatch(/^\d{5}$/);
    }
    // No duplicate ZIPs across the whole queue.
    const all = metros.flatMap((m) => m.zips);
    expect(new Set(all).size).toBe(all.length);
  });
});
