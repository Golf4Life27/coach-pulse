// @agent: orchestrator — Pipeline_State engine (sole-writer) tests.
//
// All I/O is dependency-injected so the engine can be exercised without
// hitting Airtable or KV. The audit recorder is a spy; the Airtable
// writer is a spy that captures the exact field payload.

import { describe, it, expect, vi } from "vitest";
import { transitionStage, type TransitionDeps } from "./engine";
import type { FieldDrift } from "@/lib/airtable-verify";
import type { PipelineStage } from "./stages";

function makeDeps(opts: {
  current?: PipelineStage | null;
  drift?: FieldDrift[];
} = {}): TransitionDeps & {
  audits: Array<Record<string, unknown>>;
  updates: Array<{ recordId: string; fields: Record<string, unknown> }>;
} {
  const audits: Array<Record<string, unknown>> = [];
  const updates: Array<{ recordId: string; fields: Record<string, unknown> }> = [];
  return {
    audits,
    updates,
    getCurrentStage: async () => opts.current ?? null,
    updateListing: async (recordId, fields) => {
      updates.push({ recordId, fields });
      return opts.drift ?? [];
    },
    audit: async (e) => {
      audits.push(e as unknown as Record<string, unknown>);
    },
    now: () => new Date("2026-05-31T20:00:00.000Z"),
  };
}

describe("transitionStage — happy path", () => {
  it("legal forward step writes Airtable + audits success", async () => {
    const deps = makeDeps({ current: "outreach_sent" });
    const result = await transitionStage(
      {
        recordId: "rec1HTUqK0YEVb7uA",
        to: "responded",
        reason: "inbound_reply_classified",
        attribution: "sentinel",
        triggered_by: "orchestrator",
      },
      deps,
    );
    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("applied");
    expect(result.from).toBe("outreach_sent");
    expect(result.to).toBe("responded");
    expect(deps.updates).toEqual([
      { recordId: "rec1HTUqK0YEVb7uA", fields: { Pipeline_Stage: "responded" } },
    ]);
    expect(deps.audits).toHaveLength(1);
    expect(deps.audits[0]).toMatchObject({
      agent: "sentinel",
      event: "pipeline_stage_transition",
      status: "confirmed_success",
      recordId: "rec1HTUqK0YEVb7uA",
    });
  });

  it("kill edge (any non-terminal → dead) writes + audits success", async () => {
    const deps = makeDeps({ current: "negotiating" });
    const r = await transitionStage(
      {
        recordId: "recAAAAAAAAAAAAAA",
        to: "dead",
        reason: "no_response_timeout",
        attribution: "crier",
        triggered_by: "d3",
      },
      deps,
    );
    expect(r.ok).toBe(true);
    expect(r.outcome).toBe("applied");
    expect(deps.updates).toHaveLength(1);
  });

  it("noop (from === to) audits but does NOT write Airtable", async () => {
    const deps = makeDeps({ current: "negotiating" });
    const r = await transitionStage(
      {
        recordId: "recBBBBBBBBBBBBBB",
        to: "negotiating",
        reason: "spurious",
        attribution: "sentry",
        triggered_by: "operator",
      },
      deps,
    );
    expect(r.ok).toBe(true);
    expect(r.outcome).toBe("noop");
    expect(deps.updates).toHaveLength(0);
    expect(deps.audits).toHaveLength(1);
    expect(deps.audits[0]).toMatchObject({ status: "confirmed_success", decision: "noop" });
  });
});

describe("transitionStage — initial assignment (current === null)", () => {
  it("null → any stage writes + audits as ok_initial_assignment", async () => {
    const deps = makeDeps({ current: null });
    const r = await transitionStage(
      {
        recordId: "recCCCCCCCCCCCCCC",
        to: "outreach_ready",
        reason: "initial_from_intake_classifier",
        attribution: "sentinel",
        triggered_by: "intake",
      },
      deps,
    );
    expect(r.ok).toBe(true);
    expect(r.outcome).toBe("applied");
    expect(r.legality.reason).toBe("ok_initial_assignment");
    expect(deps.updates).toEqual([
      { recordId: "recCCCCCCCCCCCCCC", fields: { Pipeline_Stage: "outreach_ready" } },
    ]);
  });
});

describe("transitionStage — illegal-edge refusals (the new guard)", () => {
  it("rejects illegal skip-forward without writing Airtable", async () => {
    const deps = makeDeps({ current: "intake" });
    const r = await transitionStage(
      {
        recordId: "recDDDDDDDDDDDDDD",
        to: "negotiating",
        reason: "operator_yolo",
        attribution: "sentry",
        triggered_by: "operator",
      },
      deps,
    );
    expect(r.ok).toBe(false);
    expect(r.outcome).toBe("rejected_illegal");
    expect(r.legality.reason).toBe("illegal_skip_forward");
    // Critical: no write on refusal.
    expect(deps.updates).toHaveLength(0);
    // But still audited (confirmed_failure) — refusals are visible in Pulse.
    expect(deps.audits).toHaveLength(1);
    expect(deps.audits[0]).toMatchObject({
      status: "confirmed_failure",
      decision: "illegal_skip_forward",
    });
  });

  it("rejects backward moves without writing", async () => {
    const deps = makeDeps({ current: "negotiating" });
    const r = await transitionStage(
      {
        recordId: "recEEEEEEEEEEEEEE",
        to: "outreach_sent",
        reason: "operator_undo",
        attribution: "sentry",
        triggered_by: "operator",
      },
      deps,
    );
    expect(r.ok).toBe(false);
    expect(r.legality.reason).toBe("illegal_backward");
    expect(deps.updates).toHaveLength(0);
  });

  it("rejects transitions out of `dead` without resurrection flag", async () => {
    const deps = makeDeps({ current: "dead" });
    const r = await transitionStage(
      {
        recordId: "recFFFFFFFFFFFFFF",
        to: "negotiating",
        reason: "inbound_after_dead",
        attribution: "sentinel",
        triggered_by: "resurrection",
        // resurrection: true intentionally omitted — caller must opt in.
      },
      deps,
    );
    expect(r.ok).toBe(false);
    expect(r.legality.reason).toBe("illegal_from_terminal_without_resurrection");
    expect(deps.updates).toHaveLength(0);
  });

  it("allows dead → negotiating WITH resurrection: true", async () => {
    const deps = makeDeps({ current: "dead" });
    const r = await transitionStage(
      {
        recordId: "recGGGGGGGGGGGGGG",
        to: "negotiating",
        reason: "inbound_reply_after_dead",
        attribution: "sentinel",
        triggered_by: "resurrection",
        resurrection: true,
      },
      deps,
    );
    expect(r.ok).toBe(true);
    expect(r.outcome).toBe("applied");
    expect(r.legality.reason).toBe("ok_resurrection");
  });

  it("rejects unknown target stages (defense)", async () => {
    const deps = makeDeps({ current: "intake" });
    const r = await transitionStage(
      {
        recordId: "recHHHHHHHHHHHHHH",
        to: "wat" as PipelineStage,
        reason: "typo",
        attribution: "sentry",
        triggered_by: "operator",
      },
      deps,
    );
    expect(r.ok).toBe(false);
    expect(r.outcome).toBe("rejected_target");
    expect(deps.updates).toHaveLength(0);
    expect(deps.audits).toHaveLength(1);
  });

  it("rejects bad recordId without an audit (defense)", async () => {
    const deps = makeDeps({ current: "intake" });
    const r = await transitionStage(
      {
        recordId: "not-a-record",
        to: "verified",
        reason: "x",
        attribution: "sentry",
        triggered_by: "operator",
      },
      deps,
    );
    expect(r.ok).toBe(false);
    expect(r.outcome).toBe("rejected_record");
    expect(deps.updates).toHaveLength(0);
  });
});

describe("transitionStage — caller-provided current stage", () => {
  it("skips the getCurrentStage fetch when `current` is supplied", async () => {
    const fetchSpy = vi.fn().mockResolvedValue("intake");
    const deps = {
      ...makeDeps({ current: "intake" }),
      getCurrentStage: fetchSpy,
    };
    await transitionStage(
      {
        recordId: "recIIIIIIIIIIIIII",
        to: "responded",
        reason: "noop_from_known_state",
        attribution: "sentry",
        triggered_by: "operator",
        current: { pipelineStage: "outreach_sent" },
      },
      deps,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
