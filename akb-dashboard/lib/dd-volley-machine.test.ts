import { describe, it, expect } from "vitest";
import {
  MAX_VOLLEYS,
  classificationOpensVolley,
  ddSequenceFor,
  parseVolleyState,
  serializeVolleyState,
  initVolleyState,
  pendingSlot,
  ddAnswersComplete,
  isVolleyCapped,
  nextDDSlot,
  recordDDAnswer,
  markAsked,
  decideDDAction,
  canDeriveContractNumber,
  withinRecomputeTolerance,
  ddAnswerStampLine,
  type DDVolleyState,
} from "./dd-volley-machine";

const T0 = "2026-07-13T02:00:00.000Z";
const T1 = "2026-07-13T02:05:00.000Z";
const T2 = "2026-07-13T02:10:00.000Z";
const T3 = "2026-07-13T02:15:00.000Z";

describe("classification gating", () => {
  it("only the four engagement classes open a volley", () => {
    expect(classificationOpensVolley("seller_costs")).toBe(true);
    expect(classificationOpensVolley("interest")).toBe(true);
    expect(classificationOpensVolley("offer_format")).toBe(true);
    expect(classificationOpensVolley("counter")).toBe(true);
    for (const c of ["acceptance", "rejection", "soft_no", "disclosure_step", "appointment", "unknown"]) {
      expect(classificationOpensVolley(c)).toBe(false);
    }
  });

  it("seller_costs leads with payoff, then liens, then timeline", () => {
    expect(ddSequenceFor("seller_costs").map((s) => s.slot)).toEqual([
      "payoff_amount",
      "lien_details",
      "timeline",
    ]);
  });
});

describe("DD question templates are guardrail-safe", () => {
  it("carry no dollar figure (sticky-or-silence holds for DD drafts too)", () => {
    for (const cls of ["seller_costs", "interest", "offer_format", "counter"]) {
      for (const s of ddSequenceFor(cls)) {
        expect(s.question).not.toMatch(/\$\s*\d/);
      }
    }
  });
  it("seller_costs cost topics carry proceeds-at-closing / title framing", () => {
    const payoff = ddSequenceFor("seller_costs").find((s) => s.slot === "payoff_amount")!;
    const liens = ddSequenceFor("seller_costs").find((s) => s.slot === "lien_details")!;
    expect(payoff.question).toMatch(/proceeds at closing|title company/i);
    expect(liens.question).toMatch(/title company at closing/i);
  });
});

describe("state machine — happy path (interest → 4-slot complete)", () => {
  it("asks each slot in order, stamps each answer, ends complete", () => {
    // Open + ask first.
    let a = decideDDAction(null, "interest", "Yeah I might be interested", "m0", T0);
    expect(a.kind).toBe("ask");
    if (a.kind !== "ask") throw new Error("unreachable");
    expect(a.slot).toBe("condition");
    expect(a.state.volleyCount).toBe(1);
    let state = a.state;

    // Answer condition → asks access.
    a = decideDDAction(state, "interest", "Roof is newer, needs a kitchen", "m1", T1);
    expect(a.kind).toBe("ask");
    if (a.kind !== "ask") throw new Error("unreachable");
    expect(a.slot).toBe("access");
    expect(a.state.answers.map((x) => x.slot)).toEqual(["condition"]);
    state = a.state;

    // Answer access → asks occupancy.
    a = decideDDAction(state, "interest", "Vacant, lockbox on it", "m2", T2);
    expect(a.kind).toBe("ask");
    if (a.kind !== "ask") throw new Error("unreachable");
    expect(a.slot).toBe("occupancy");
    state = a.state;

    // We've now asked 3 (condition/access/occupancy) — cap is 3. Answering
    // occupancy completes 3 of 4 but the 4th (timeline) can't be asked (cap).
    a = decideDDAction(state, "interest", "Nobody living there", "m3", T3);
    expect(a.kind).toBe("capped");
  });
});

describe("state machine — seller_costs completes within the cap", () => {
  it("3-slot sequence fits MAX_VOLLEYS exactly → number_gate_open", () => {
    let a = decideDDAction(null, "seller_costs", "Are you covering the water bill?", "s0", T0);
    expect(a.kind === "ask" && a.slot).toBe("payoff_amount");
    let state = (a as { state: DDVolleyState }).state;

    a = decideDDAction(state, "seller_costs", "About 40k left on the mortgage", "s1", T1);
    expect(a.kind === "ask" && a.slot).toBe("lien_details");
    state = (a as { state: DDVolleyState }).state;

    a = decideDDAction(state, "seller_costs", "No other liens, taxes are current", "s2", T2);
    expect(a.kind === "ask" && a.slot).toBe("timeline");
    state = (a as { state: DDVolleyState }).state;

    // Final answer completes the sequence → gate opens.
    a = decideDDAction(state, "seller_costs", "Close in 30 days works", "s3", T3);
    expect(a.kind).toBe("number_gate_open");
    if (a.kind !== "number_gate_open") throw new Error("unreachable");
    expect(a.state.status).toBe("complete");
    expect(ddAnswersComplete(a.state)).toBe(true);
  });
});

describe("never skip a stamped answer (idempotency)", () => {
  it("re-processing the same inbound msg id does not double-stamp", () => {
    const state = markAsked(initVolleyState("seller_costs", T0), "payoff_amount", T0);
    const once = recordDDAnswer(state, "40k owed", "dup", T1);
    expect(once.answers).toHaveLength(1);
    const twice = recordDDAnswer(once, "40k owed", "dup", T2);
    expect(twice.answers).toHaveLength(1); // same msg id → no second stamp
  });

  it("an empty answer never stamps (no phantom fact)", () => {
    const state = markAsked(initVolleyState("interest", T0), "condition", T0);
    expect(recordDDAnswer(state, "   ", "m", T1).answers).toHaveLength(0);
  });

  it("recordDDAnswer with nothing pending is a no-op", () => {
    const fresh = initVolleyState("interest", T0); // nothing asked yet
    expect(pendingSlot(fresh)).toBeNull();
    expect(recordDDAnswer(fresh, "irrelevant", "m", T1)).toEqual(fresh);
  });
});

describe("number-gate refuses without stamped DD answers", () => {
  it("no volley → refuse", () => {
    const g = canDeriveContractNumber(null);
    expect(g.ok).toBe(false);
    expect(g.reason).toBe("no_dd_volley_started");
  });

  it("volley open but answers incomplete → refuse with missing slots", () => {
    const state = markAsked(initVolleyState("seller_costs", T0), "payoff_amount", T0);
    const g = canDeriveContractNumber(state);
    expect(g.ok).toBe(false);
    expect(g.missing).toEqual(["payoff_amount", "lien_details", "timeline"]);
    expect(g.reason).toMatch(/dd_answers_incomplete/);
  });

  it("all slots stamped → allow", () => {
    let state = initVolleyState("seller_costs", T0);
    for (const slot of ["payoff_amount", "lien_details", "timeline"]) {
      state = markAsked(state, slot, T0);
      state = recordDDAnswer(state, `answer for ${slot}`, `m-${slot}`, T1);
    }
    const g = canDeriveContractNumber(state);
    expect(g.ok).toBe(true);
    expect(g.missing).toEqual([]);
  });
});

describe("max-volley cap", () => {
  it("caps after MAX_VOLLEYS questions when the sequence is longer than the cap", () => {
    // interest has 4 slots but the cap is 3.
    expect(MAX_VOLLEYS).toBe(3);
    let state = initVolleyState("interest", T0);
    for (const slot of ["condition", "access", "occupancy"]) {
      state = markAsked(state, slot, T0);
      state = recordDDAnswer(state, `a-${slot}`, `m-${slot}`, T1);
    }
    expect(state.volleyCount).toBe(3);
    expect(nextDDSlot(state)).toBeNull(); // cap blocks the 4th
    expect(isVolleyCapped(state)).toBe(true);
    expect(ddAnswersComplete(state)).toBe(false);
    // The gate still refuses — timeline never got stamped.
    expect(canDeriveContractNumber(state).ok).toBe(false);
  });
});

describe("recompute tolerance (±$5 doctrine)", () => {
  it("within $5 → the sticky number stands", () => {
    expect(withinRecomputeTolerance(113_750, 113_752)).toBe(true);
    expect(withinRecomputeTolerance(42_499, 42_504)).toBe(true);
  });
  it("beyond $5 → a genuine change", () => {
    expect(withinRecomputeTolerance(113_750, 113_800)).toBe(false);
  });
});

describe("persistence round-trip", () => {
  it("serialize → parse is lossless", () => {
    let state = markAsked(initVolleyState("counter", T0), "counter_basis", T0);
    state = recordDDAnswer(state, "Comps down the street", "c1", T1);
    const round = parseVolleyState(serializeVolleyState(state));
    expect(round).toEqual(state);
  });
  it("garbage / empty parses to null (fail-soft)", () => {
    expect(parseVolleyState("")).toBeNull();
    expect(parseVolleyState("not json")).toBeNull();
    expect(parseVolleyState("{}")).toBeNull();
    expect(parseVolleyState(null)).toBeNull();
  });
});

describe("ddAnswerStampLine", () => {
  it("stamps a provenance-tagged notes line", () => {
    const line = ddAnswerStampLine("condition", "roof is new", T0, "m9");
    expect(line).toContain("[DD Volley] condition:");
    expect(line).toContain("roof is new");
    expect(line).toContain("msg=m9");
    expect(line.startsWith("2026-07-13")).toBe(true);
  });
});
