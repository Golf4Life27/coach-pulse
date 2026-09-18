import { describe, it, expect } from "vitest";
import { decideCounter, type CounterDecisionInputs } from "./counter-decision";

function inputs(o: Partial<CounterDecisionInputs> = {}): CounterDecisionInputs {
  return {
    counterUsd: null,
    stickyUsd: null,
    ceilingUsd: null,
    verdict: null,
    arvUsd: null,
    arvConfidence: null,
    rehabUsd: null,
    listUsd: null,
    agentFirstName: null,
    ...o,
  };
}

const ONE_DOLLAR_FIGURE_RE = /\$[\d,]+(?:\.\d+)?/g;

function dollarAmountsIn(text: string): number[] {
  const out: number[] = [];
  let m: RegExpExecArray | null;
  const re = new RegExp(ONE_DOLLAR_FIGURE_RE.source, ONE_DOLLAR_FIGURE_RE.flags);
  while ((m = re.exec(text)) != null) out.push(Number(m[0].replace(/[$,]/g, "")));
  return out;
}

function isAscii(s: string): boolean {
  return /^[\x00-\x7F]*$/.test(s);
}

// ── The three real deals (2026-09-18 operator escalation) ────────────────

describe("real deals — the 2026-09-18 escalation", () => {
  it("265 Harrison St, Gary IN: list $45k, our opener $28k, counter $35k, NO ARV/rehab -> blind", () => {
    const d = decideCounter(
      inputs({ counterUsd: 35_000, stickyUsd: 28_000, listUsd: 45_000, ceilingUsd: null, arvUsd: null, rehabUsd: null }),
    );
    expect(d.stance).toBe("blind");
    expect(d.headline).toBe("Blind: no ARV or rehab on this deal yet");
    expect(d.options.map((o) => o.key)).toEqual(["stall"]);
  });

  it("331 NE 9th Ave, Ocala FL: list $105k, our $65k, counter $95k, NO ARV/rehab -> blind", () => {
    const d = decideCounter(
      inputs({ counterUsd: 95_000, stickyUsd: 65_000, listUsd: 105_000, ceilingUsd: null, arvUsd: null, rehabUsd: null }),
    );
    expect(d.stance).toBe("blind");
    expect(d.options).toHaveLength(1);
    expect(d.options[0].key).toBe("stall");
  });

  it("724 Dennison, Dayton: ARV $45.5k HIGH, rehab $25.7k, counter $65k, our $49.5k -> walk or hold, headline names ARV", () => {
    const d = decideCounter(
      inputs({
        counterUsd: 65_000,
        stickyUsd: 49_500,
        ceilingUsd: 4_800, // ARV - rehab - fee: thin, well under sticky
        verdict: "PASS",
        arvUsd: 45_500,
        arvConfidence: "HIGH",
        rehabUsd: 25_700,
      }),
    );
    expect(["walk", "hold"]).toContain(d.stance);
    expect(d.headline).toContain("45,500");
    // Never the old dead-end text.
    expect(d.headline.toLowerCase()).not.toContain("draft number not sticky");
  });
});

// ── blind ──────────────────────────────────────────────────────────────

describe("blind stance", () => {
  it("null ceiling -> blind even with a counter and sticky present", () => {
    const d = decideCounter(inputs({ counterUsd: 40_000, stickyUsd: 30_000, ceilingUsd: null }));
    expect(d.stance).toBe("blind");
    expect(d.reason).toContain("No ARV on file");
  });

  it("NEEDS_DATA verdict -> blind even when a ceiling number exists", () => {
    const d = decideCounter(inputs({ counterUsd: 40_000, stickyUsd: 30_000, ceilingUsd: 35_000, verdict: "NEEDS_DATA" }));
    expect(d.stance).toBe("blind");
  });

  it("HOLD_LOW_CONF verdict -> blind", () => {
    const d = decideCounter(inputs({ counterUsd: 40_000, stickyUsd: 30_000, ceilingUsd: 35_000, verdict: "HOLD_LOW_CONF" }));
    expect(d.stance).toBe("blind");
  });

  it("blind facts name what is missing", () => {
    const d = decideCounter(inputs({ arvUsd: null, rehabUsd: null, ceilingUsd: null }));
    expect(d.facts).toContain("No ARV on file");
    expect(d.facts).toContain("No rehab estimate on file");
  });
});

// ── no counter on record ─────────────────────────────────────────────────

describe("no counter recorded", () => {
  it("counterUsd null with a real ceiling -> hold, stall-only", () => {
    const d = decideCounter(inputs({ counterUsd: null, stickyUsd: 28_000, ceilingUsd: 40_000, verdict: "GO" }));
    expect(d.stance).toBe("hold");
    expect(d.options.map((o) => o.key)).toEqual(["stall"]);
  });
});

// ── accept ────────────────────────────────────────────────────────────

describe("accept stance", () => {
  it("counter under ceiling -> accept, label names the counter", () => {
    const d = decideCounter(
      inputs({ counterUsd: 35_000, stickyUsd: 28_600, ceilingUsd: 40_000, verdict: "GO", arvUsd: 70_000, rehabUsd: 15_000 }),
    );
    expect(d.stance).toBe("accept");
    expect(d.headline).toBe("Accept at $35,000: it clears the ceiling");
    const accept = d.options.find((o) => o.key === "accept")!;
    expect(accept.label).toBe("Accept at $35,000");
    expect(accept.amountUsd).toBe(35_000);
  });

  it("rounding-down-to-250: counter far enough over sticky adds a counter sub-option at the rounded-down midpoint", () => {
    // midpoint(28000, 34500) = 31250 — already a $250 multiple, so rounding
    // down is a no-op here; the roundDown250 test below covers the actual
    // floor-to-250 arithmetic.
    const d = decideCounter(inputs({ counterUsd: 34_500, stickyUsd: 28_000, ceilingUsd: 40_000, verdict: "GO" }));
    const counter = d.options.find((o) => o.key === "counter");
    expect(counter).toBeDefined();
    expect(counter!.label).toBe("Counter at $31,250");
    expect(counter!.amountUsd).toBe(31_250);
  });

  it("roundDown250 arithmetic: a non-multiple-of-250 midpoint rounds DOWN, never up", () => {
    // midpoint(28000, 34600) = 31300 -> floors to 31250, not 31500.
    const d = decideCounter(inputs({ counterUsd: 34_600, stickyUsd: 28_000, ceilingUsd: 40_000, verdict: "GO" }));
    const counter = d.options.find((o) => o.key === "counter")!;
    expect(counter.amountUsd).toBe(31_250);
  });

  it("cap-at-ceiling: the accept sub-option's number never exceeds the ceiling", () => {
    const d = decideCounter(inputs({ counterUsd: 39_900, stickyUsd: 10_000, ceilingUsd: 40_000, verdict: "GO" }));
    const counter = d.options.find((o) => o.key === "counter");
    if (counter) expect(counter.amountUsd!).toBeLessThanOrEqual(40_000);
  });

  it("counter within $250 of sticky -> no extra counter sub-option, just accept + stall", () => {
    const d = decideCounter(inputs({ counterUsd: 28_100, stickyUsd: 28_000, ceilingUsd: 40_000, verdict: "GO" }));
    expect(d.options.map((o) => o.key)).toEqual(["accept", "stall"]);
  });
});

// ── counter (main stance) ────────────────────────────────────────────────

describe("counter stance", () => {
  it("counter over ceiling, ceiling above sticky -> counter at the ceiling rounded down to 250", () => {
    const d = decideCounter(
      inputs({ counterUsd: 50_000, stickyUsd: 28_000, ceilingUsd: 31_100, verdict: "GO", arvUsd: 70_000, rehabUsd: 15_000 }),
    );
    expect(d.stance).toBe("counter");
    expect(d.headline).toBe("Counter at $31,000: their number is above what a buyer can pay");
    const counter = d.options.find((o) => o.key === "counter")!;
    expect(counter.amountUsd).toBe(31_000);
    expect(counter.amountUsd).toBeLessThanOrEqual(31_100); // never exceeds the ceiling
    expect(d.options.some((o) => o.key === "hold")).toBe(true);
    expect(d.options.some((o) => o.key === "stall")).toBe(true);
  });
});

// ── hold ──────────────────────────────────────────────────────────────

describe("hold stance", () => {
  it("counter over ceiling, ceiling at or below sticky -> hold at sticky", () => {
    const d = decideCounter(inputs({ counterUsd: 40_000, stickyUsd: 28_000, ceilingUsd: 25_000, verdict: "TIGHT" }));
    expect(d.stance).toBe("hold");
    expect(d.headline).toBe("Hold at $28,000: we are already at the ceiling");
    const hold = d.options.find((o) => o.key === "hold")!;
    expect(hold.label).toBe("Hold at $28,000");
    expect(hold.amountUsd).toBe(28_000);
    expect(d.options.some((o) => o.key === "walk")).toBe(true);
  });
});

// ── walk ──────────────────────────────────────────────────────────────

describe("walk stance", () => {
  it("counter at/above ARV -> walk, whatever the ceiling math says", () => {
    const d = decideCounter(
      inputs({ counterUsd: 60_000, stickyUsd: 20_000, ceilingUsd: 5_000, verdict: "TIGHT", arvUsd: 55_000 }),
    );
    expect(d.stance).toBe("walk");
    expect(d.options[0].key).toBe("walk");
    expect(d.options[0].label).toBe("Walk away politely");
  });

  it("PASS verdict with no ARV present still walks", () => {
    const d = decideCounter(inputs({ counterUsd: 40_000, stickyUsd: 20_000, ceilingUsd: 15_000, verdict: "PASS", arvUsd: null }));
    expect(d.stance).toBe("walk");
    expect(d.headline).toBe("Walk: their $40,000 is above the $15,000 ceiling and the math says PASS");
  });
});

// ── PASS with counter inside the ceiling (265 Harrison St, 2026-09-18) ───
// Real record: counter $35,000, ceiling (Buyer_Ceiling) $41,032, MAO
// (Your_MAO_V21 = ceiling - $10k target fee) $31,032. Verdict PASS came from
// "price $35,000 > MAO $31,032" — a thin-fee miss, not an unaffordable
// counter. The old code walked on any PASS; this must not.

describe("PASS with counter inside the ceiling", () => {
  const harrison = {
    counterUsd: 35_000,
    stickyUsd: 28_000,
    ceilingUsd: 41_032,
    verdict: "PASS",
    arvUsd: 138_401,
    arvConfidence: "MED",
    rehabUsd: 54_395,
    listUsd: 45_000,
  };

  it("counter above our MAO -> counter at the MAO, headline names both numbers and the thin fee", () => {
    const d = decideCounter(inputs({ ...harrison, maoUsd: 31_032 }));
    expect(d.stance).toBe("counter");
    expect(d.headline).toContain("31,000");
    expect(d.headline).toContain("35,000");
    expect(d.headline).toContain("6,032");
    expect(d.headline.toLowerCase()).not.toContain("after-repair");
    expect(d.options.map((o) => o.key)).toEqual(["counter", "accept", "stall", "walk"]);
    const counter = d.options.find((o) => o.key === "counter")!;
    expect(counter.amountUsd).toBe(31_000);
    const accept = d.options.find((o) => o.key === "accept")!;
    expect(accept.amountUsd).toBe(35_000);
  });

  it("no MAO on record -> falls through to accept (counter is under ceiling), PASS surfaced in facts", () => {
    const d = decideCounter(inputs({ ...harrison, maoUsd: null }));
    expect(d.stance).toBe("accept");
    expect(d.facts).toContain("Underwrite verdict: PASS");
  });

  it("PASS with counter genuinely above the ceiling still walks, naming the ceiling", () => {
    const d = decideCounter(
      inputs({ counterUsd: 50_000, stickyUsd: 28_000, ceilingUsd: 41_032, verdict: "PASS", arvUsd: 138_401 }),
    );
    expect(d.stance).toBe("walk");
    expect(d.headline).toBe("Walk: their $50,000 is above the $41,032 ceiling and the math says PASS");
  });

  it("724 Dennison still walks/holds with ARV named (counter >= ARV outranks the PASS thin-fee branch)", () => {
    const d = decideCounter(
      inputs({
        counterUsd: 65_000,
        stickyUsd: 49_500,
        ceilingUsd: 4_800,
        verdict: "PASS",
        arvUsd: 45_500,
        arvConfidence: "HIGH",
        rehabUsd: 25_700,
        maoUsd: -5_200,
      }),
    );
    expect(["walk", "hold"]).toContain(d.stance);
    expect(d.headline).toContain("45,500");
  });
});

// ── universal message rules ───────────────────────────────────────────

const FIXTURES: CounterDecisionInputs[] = [
  inputs({ counterUsd: 35_000, stickyUsd: 28_000, listUsd: 45_000, agentFirstName: "Duane" }), // blind
  inputs({ counterUsd: null, stickyUsd: 28_000, ceilingUsd: 40_000, verdict: "GO" }), // no counter
  inputs({ counterUsd: 35_000, stickyUsd: 28_600, ceilingUsd: 40_000, verdict: "GO", agentFirstName: "Roberto" }), // accept
  inputs({ counterUsd: 34_500, stickyUsd: 28_000, ceilingUsd: 40_000, verdict: "GO", agentFirstName: "Marie" }), // accept + counter sub-option
  inputs({ counterUsd: 50_000, stickyUsd: 28_000, ceilingUsd: 31_100, verdict: "GO", agentFirstName: "Alex" }), // counter
  inputs({ counterUsd: 40_000, stickyUsd: 28_000, ceilingUsd: 25_000, verdict: "TIGHT" }), // hold
  inputs({ counterUsd: 60_000, stickyUsd: 20_000, ceilingUsd: 5_000, verdict: "TIGHT", arvUsd: 55_000, agentFirstName: "Sam" }), // walk
];

describe("universal message rules", () => {
  it("every message is plain ASCII", () => {
    for (const fx of FIXTURES) {
      const d = decideCounter(fx);
      for (const o of d.options) expect(isAscii(o.message)).toBe(true);
    }
  });

  it("every message is <= 320 chars (SMS length) and 1-3 sentences", () => {
    for (const fx of FIXTURES) {
      const d = decideCounter(fx);
      for (const o of d.options) {
        expect(o.message.length).toBeLessThanOrEqual(320);
        const sentences = o.message.split(/[.?!]+/).filter((s) => s.trim().length > 0);
        expect(sentences.length).toBeGreaterThanOrEqual(1);
        expect(sentences.length).toBeLessThanOrEqual(3);
      }
    }
  });

  it("starts with 'Hey <first>,' when a first name is present", () => {
    const withName = FIXTURES.filter((f) => f.agentFirstName);
    expect(withName.length).toBeGreaterThan(0);
    for (const fx of withName) {
      const d = decideCounter(fx);
      for (const o of d.options) expect(o.message.startsWith(`Hey ${fx.agentFirstName},`)).toBe(true);
    }
  });

  it("one-dollar-figure rule: at most one dollar figure per message, and it is the option's amountUsd", () => {
    for (const fx of FIXTURES) {
      const d = decideCounter(fx);
      for (const o of d.options) {
        const amounts = dollarAmountsIn(o.message);
        expect(amounts.length).toBeLessThanOrEqual(1);
        if (o.amountUsd == null) {
          expect(amounts.length).toBe(0);
        } else {
          expect(amounts.length).toBe(1);
          expect(amounts[0]).toBe(Math.round(o.amountUsd));
        }
      }
    }
  });

  it("never proposes a number above the ceiling when a ceiling is known", () => {
    for (const fx of FIXTURES) {
      if (fx.ceilingUsd == null) continue;
      const d = decideCounter(fx);
      for (const o of d.options) {
        if (o.key === "hold") continue; // hold may restate a sticky above a freshly-lowered ceiling (doctrine: sticky is a floor of what we've said)
        if (o.amountUsd != null) expect(o.amountUsd).toBeLessThanOrEqual(fx.ceilingUsd);
      }
    }
  });
});
