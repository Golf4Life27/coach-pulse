import { describe, expect, it } from "vitest";
import { summarizeBuildLedger, type BuildStep } from "./build-ledger";

const NOW = new Date("2026-09-05T12:00:00Z");

function step(over: Partial<BuildStep> = {}): BuildStep {
  return {
    id: "rec1",
    step: "Step A",
    project: "Project X",
    status: "In Progress",
    progressPct: 50,
    owner: "machine",
    actionItem: null,
    nextStep: null,
    blockedBy: null,
    order: 1,
    spineRef: null,
    updatedAt: "2026-09-05T00:00:00Z",
    notes: null,
    ...over,
  };
}

describe("summarizeBuildLedger", () => {
  it("returns empty shape for empty input", () => {
    const summary = summarizeBuildLedger([], NOW);
    expect(summary.projects).toEqual([]);
    expect(summary.operatorActionItems).toEqual([]);
    expect(summary.counts).toEqual({ inWorks: 0, blocked: 0, done: 0, operatorActions: 0 });
    expect(summary.staleSteps).toEqual([]);
  });

  it("computes mean progress per project, treating Done as 100 regardless of stored pct", () => {
    const steps = [
      step({ id: "r1", step: "S1", project: "Proj A", status: "Done", progressPct: 40 }),
      step({ id: "r2", step: "S2", project: "Proj A", status: "In Progress", progressPct: 50 }),
    ];
    const summary = summarizeBuildLedger(steps, NOW);
    const proj = summary.projects.find((p) => p.project === "Proj A")!;
    expect(proj.progressPct).toBe(75); // mean(100, 50)
    expect(proj.stepsTotal).toBe(2);
    expect(proj.stepsDone).toBe(1);
  });

  it("collects operator action items and sorts them most-recently-updated first", () => {
    const steps = [
      step({
        id: "r1",
        step: "Call buyer",
        project: "Proj A",
        owner: "operator",
        actionItem: "Call the buyer back",
        updatedAt: "2026-09-01T00:00:00Z",
      }),
      step({
        id: "r2",
        step: "Sign form",
        project: "Proj B",
        owner: "operator",
        actionItem: "Sign the W9",
        updatedAt: "2026-09-04T00:00:00Z",
      }),
      step({ id: "r3", step: "Machine step", project: "Proj C", owner: "machine", actionItem: null }),
    ];
    const summary = summarizeBuildLedger(steps, NOW);
    expect(summary.operatorActionItems).toHaveLength(2);
    expect(summary.operatorActionItems[0].step).toBe("Sign form");
    expect(summary.operatorActionItems[1].step).toBe("Call buyer");
    expect(summary.counts.operatorActions).toBe(2);
  });

  it("orders projects with operator action items first, then by lowest progress, parked/idea last", () => {
    const steps = [
      // Proj Low: no action item, 20% progress
      step({ id: "r1", step: "S1", project: "Proj Low", status: "In Progress", progressPct: 20, owner: "machine" }),
      // Proj High: no action item, 90% progress
      step({ id: "r2", step: "S1", project: "Proj High", status: "In Progress", progressPct: 90, owner: "machine" }),
      // Proj Action: has an operator action item, 80% progress — should still be first
      step({
        id: "r3",
        step: "S1",
        project: "Proj Action",
        status: "In Progress",
        progressPct: 80,
        owner: "operator",
        actionItem: "Approve the contract",
      }),
      // Proj Parked: all steps Parked — should be last regardless of progress
      step({ id: "r4", step: "S1", project: "Proj Parked", status: "Parked", progressPct: 0, owner: "machine" }),
    ];
    const summary = summarizeBuildLedger(steps, NOW);
    const order = summary.projects.map((p) => p.project);
    expect(order[0]).toBe("Proj Action");
    expect(order[order.length - 1]).toBe("Proj Parked");
    // Between the remaining two, lowest progress first.
    expect(order.indexOf("Proj Low")).toBeLessThan(order.indexOf("Proj High"));
  });

  it("flags In Progress steps not updated in 7+ days as stale, and ignores fresh or non-in-progress steps", () => {
    const steps = [
      step({ id: "r1", step: "Stale one", status: "In Progress", updatedAt: "2026-08-20T00:00:00Z" }), // >7d old
      step({ id: "r2", step: "Fresh one", status: "In Progress", updatedAt: "2026-09-04T00:00:00Z" }), // <7d old
      step({ id: "r3", step: "Old but blocked", status: "Blocked", updatedAt: "2026-08-01T00:00:00Z" }),
      step({ id: "r4", step: "Old but done", status: "Done", updatedAt: "2026-08-01T00:00:00Z" }),
    ];
    const summary = summarizeBuildLedger(steps, NOW);
    expect(summary.staleSteps.map((s) => s.id)).toEqual(["r1"]);
  });

  it("counts inWorks (In Progress + Planned), blocked, and done", () => {
    const steps = [
      step({ id: "r1", status: "In Progress" }),
      step({ id: "r2", status: "Planned" }),
      step({ id: "r3", status: "Blocked" }),
      step({ id: "r4", status: "Done" }),
      step({ id: "r5", status: "Idea" }),
    ];
    const summary = summarizeBuildLedger(steps, NOW);
    expect(summary.counts.inWorks).toBe(2);
    expect(summary.counts.blocked).toBe(1);
    expect(summary.counts.done).toBe(1);
  });
});
