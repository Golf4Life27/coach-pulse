import { describe, it, expect } from "vitest";
import {
  selectNextLeg,
  metrosBehindSchedule,
  metrosPerDay,
  DEFAULT_CIRCUIT_DAYS,
  DISTRESS_DOM_DAYS,
  type MetroCircuitRow,
} from "./metro-circuit";

const NOW = new Date("2026-08-05T01:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

const row = (metro: string, zip: string, lastSweptAt: string | null): MetroCircuitRow => ({
  metro,
  zip,
  lastSweptAt,
});

describe("the circuit's governing premise", () => {
  // If the distress gate moves, the circuit period must be re-derived. A
  // circuit longer than the DOM threshold would let properties age into
  // eligibility without ever having been discovered — the one thing this
  // design promises cannot happen.
  it("a full circuit completes before a new listing could become eligible", () => {
    expect(DEFAULT_CIRCUIT_DAYS).toBeLessThan(DISTRESS_DOM_DAYS);
  });

  it("leaves margin for a metro to be missed once without opening a gap", () => {
    expect(DEFAULT_CIRCUIT_DAYS * 2).toBeLessThanOrEqual(DISTRESS_DOM_DAYS);
  });
});

describe("selectNextLeg", () => {
  it("goes to a never-swept metro first", () => {
    const rows = [
      row("Detroit", "48228", daysAgo(2)),
      row("Cleveland", "44105", null),
    ];
    const leg = selectNextLeg(rows, NOW);
    expect(leg?.metro).toBe("Cleveland");
    expect(leg?.reason).toBe("never_swept");
    expect(leg?.ageDays).toBeNull();
  });

  it("otherwise goes to the stalest metro", () => {
    const rows = [
      row("Detroit", "48228", daysAgo(2)),
      row("Dayton", "45406", daysAgo(19)),
      row("Atlanta", "30331", daysAgo(9)),
    ];
    const leg = selectNextLeg(rows, NOW);
    expect(leg?.metro).toBe("Dayton");
    expect(leg?.ageDays).toBe(19);
  });

  it("judges a metro by its OLDEST corner, not its newest", () => {
    // Detroit was partly swept yesterday but has a ZIP untouched for 30 days;
    // it is not done. This is what makes "the metro is empty when we leave"
    // true rather than aspirational.
    const rows = [
      row("Detroit", "48228", daysAgo(1)),
      row("Detroit", "48224", daysAgo(30)),
      row("Atlanta", "30331", daysAgo(5)),
    ];
    expect(selectNextLeg(rows, NOW)?.metro).toBe("Detroit");
  });

  it("sweeps the stalest ZIPs first inside a capped leg", () => {
    const rows = [
      row("Detroit", "48228", daysAgo(1)),
      row("Detroit", "48224", daysAgo(30)),
      row("Detroit", "48219", daysAgo(15)),
    ];
    expect(selectNextLeg(rows, NOW, 2)?.zips).toEqual(["48224", "48219"]);
  });

  it("orders deterministically on a tie so no metro starves", () => {
    const rows = [row("Toledo", "43607", null), row("Akron", "44301", null)];
    expect(selectNextLeg(rows, NOW)?.metro).toBe("Akron");
  });

  it("ignores malformed rows and returns null on an empty registry", () => {
    expect(selectNextLeg([], NOW)).toBeNull();
    expect(selectNextLeg([row("Detroit", "4822", null)], NOW)).toBeNull();
  });
});

describe("metrosBehindSchedule", () => {
  it("names the metros the train has not reached in time", () => {
    const rows = [
      row("Detroit", "48228", daysAgo(2)),
      row("Dayton", "45406", daysAgo(40)),
      row("Memphis", "38116", null),
    ];
    const behind = metrosBehindSchedule(rows, NOW);
    expect(behind.map((b) => b.metro)).toEqual(["Memphis", "Dayton"]);
  });

  it("is quiet when every metro is on schedule", () => {
    const rows = [row("Detroit", "48228", daysAgo(3)), row("Atlanta", "30331", daysAgo(10))];
    expect(metrosBehindSchedule(rows, NOW)).toEqual([]);
  });
});

describe("metrosPerDay", () => {
  it("paces the train to finish a circuit on time", () => {
    expect(metrosPerDay(9, 21)).toBe(1);
    expect(metrosPerDay(42, 21)).toBe(2);
  });

  it("never stalls at zero", () => {
    expect(metrosPerDay(1, 365)).toBe(1);
    expect(metrosPerDay(0, 21)).toBe(0);
  });
});
