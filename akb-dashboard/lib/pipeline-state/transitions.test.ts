// @agent: orchestrator — Pipeline_State legal-transition tests.
import { describe, it, expect } from "vitest";
import {
  FORWARD_NEXT,
  RESURRECTION_TARGETS,
  isLegalTransition,
  nextStages,
} from "./transitions";
import { ALL_PIPELINE_STAGES, type PipelineStage } from "./stages";

describe("FORWARD_NEXT", () => {
  it("provides exactly one forward step from each non-terminal stage", () => {
    expect(FORWARD_NEXT["intake"]).toEqual(["verified"]);
    expect(FORWARD_NEXT["outreach_sent"]).toEqual(["responded"]); // new edge
    expect(FORWARD_NEXT["responded"]).toEqual(["negotiating"]);
    expect(FORWARD_NEXT["under_contract"]).toEqual(["dispo_active"]);
    expect(FORWARD_NEXT["assignment_signed"]).toEqual(["closed"]);
  });
  it("has no forward edge from terminals", () => {
    expect(FORWARD_NEXT["closed"]).toEqual([]);
    expect(FORWARD_NEXT["dead"]).toEqual([]);
  });
});

describe("isLegalTransition — initial assignment", () => {
  it("null → <any stage> is legal (ok_initial_assignment)", () => {
    for (const to of ALL_PIPELINE_STAGES) {
      const r = isLegalTransition(null, to);
      expect(r.legal).toBe(true);
      expect(r.reason).toBe("ok_initial_assignment");
    }
  });
});

describe("isLegalTransition — forward one step", () => {
  it("allows the standard forward edge for every live stage", () => {
    const forward = ALL_PIPELINE_STAGES.filter((s) => s !== "dead");
    for (let i = 0; i < forward.length - 1; i++) {
      const r = isLegalTransition(forward[i], forward[i + 1]);
      expect(r.legal).toBe(true);
      expect(r.reason).toBe("ok_forward_one_step");
    }
  });

  it("refuses skipping forward >1 stage with illegal_skip_forward", () => {
    const r = isLegalTransition("intake", "negotiating");
    expect(r.legal).toBe(false);
    expect(r.reason).toBe("illegal_skip_forward");
    expect(r.message).toContain("intake");
    expect(r.message).toContain("negotiating");
  });

  it("refuses backward moves with illegal_backward", () => {
    const r = isLegalTransition("negotiating", "outreach_sent");
    expect(r.legal).toBe(false);
    expect(r.reason).toBe("illegal_backward");
  });
});

describe("isLegalTransition — kill edge", () => {
  it("any non-terminal → dead is legal (ok_kill_edge)", () => {
    for (const from of ALL_PIPELINE_STAGES) {
      if (from === "closed" || from === "dead") continue;
      const r = isLegalTransition(from, "dead");
      expect(r.legal).toBe(true);
      expect(r.reason).toBe("ok_kill_edge");
    }
  });

  it("closed → dead is REFUSED — closed is terminal-success, not killable", () => {
    const r = isLegalTransition("closed", "dead");
    expect(r.legal).toBe(false);
    expect(r.reason).toBe("illegal_from_terminal_without_resurrection");
  });

  it("dead → dead is a noop, not a kill edge", () => {
    const r = isLegalTransition("dead", "dead");
    expect(r.legal).toBe(true);
    expect(r.reason).toBe("ok_noop");
  });
});

describe("isLegalTransition — resurrection (dead → live)", () => {
  it("requires resurrection: true flag — refuses without it", () => {
    const r = isLegalTransition("dead", "negotiating");
    expect(r.legal).toBe(false);
    expect(r.reason).toBe("illegal_from_terminal_without_resurrection");
  });

  it("with resurrection: true, dead → responded is legal", () => {
    const r = isLegalTransition("dead", "responded", { resurrection: true });
    expect(r.legal).toBe(true);
    expect(r.reason).toBe("ok_resurrection");
  });

  it("with resurrection: true, dead → negotiating is legal", () => {
    const r = isLegalTransition("dead", "negotiating", { resurrection: true });
    expect(r.legal).toBe(true);
  });

  it("rejects resurrection to any target other than responded|negotiating", () => {
    for (const to of ALL_PIPELINE_STAGES) {
      if (to === "responded" || to === "negotiating") continue;
      if (to === "dead") continue; // noop
      const r = isLegalTransition("dead", to, { resurrection: true });
      expect(r.legal).toBe(false);
      // Could be illegal_resurrection_target — or illegal_unknown_stage for bad inputs.
      expect(r.reason).toBe("illegal_resurrection_target");
    }
  });

  it("only resurrects from dead — the flag is irrelevant on live stages", () => {
    // The flag is harmless on legal forward moves.
    const r = isLegalTransition("outreach_sent", "responded", { resurrection: true });
    expect(r.legal).toBe(true);
    expect(r.reason).toBe("ok_forward_one_step");
  });
});

describe("isLegalTransition — defenses", () => {
  it("rejects unknown target stages", () => {
    const r = isLegalTransition("intake", "wat" as PipelineStage);
    expect(r.legal).toBe(false);
    expect(r.reason).toBe("illegal_unknown_stage");
  });

  it("treats from === to as noop, audit-only (no write)", () => {
    const r = isLegalTransition("negotiating", "negotiating");
    expect(r.legal).toBe(true);
    expect(r.reason).toBe("ok_noop");
  });

  it("refuses anything out of `closed` (terminal-success)", () => {
    for (const to of ALL_PIPELINE_STAGES) {
      if (to === "closed") continue;
      const r = isLegalTransition("closed", to);
      expect(r.legal).toBe(false);
    }
  });
});

describe("nextStages", () => {
  it("from null returns every stage (initial assignment is unconstrained)", () => {
    expect(nextStages(null)).toEqual(ALL_PIPELINE_STAGES);
  });

  it("from a live stage returns [forward, dead]", () => {
    expect(nextStages("intake").sort()).toEqual(["dead", "verified"].sort());
    expect(nextStages("outreach_sent").sort()).toEqual(["dead", "responded"].sort());
  });

  it("from `dead` without resurrection returns []", () => {
    expect(nextStages("dead")).toEqual([]);
  });

  it("from `dead` with resurrection returns the resurrection targets", () => {
    expect(nextStages("dead", { resurrection: true }).sort()).toEqual(
      [...RESURRECTION_TARGETS].sort(),
    );
  });

  it("from `closed` returns []", () => {
    expect(nextStages("closed")).toEqual([]);
  });
});
