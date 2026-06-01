// @agent: maverick — Pipeline_State backfill apply-planner tests.
//
// Pure planner: enforces idempotency, the never-resurface hard-guard
// (Canon §9), and the confirm-token gate. Regression tests for each
// non-negotiable guardrail the operator locked in decision rechGJ32oW9Qmv8wp.

import { describe, it, expect } from "vitest";
import {
  planBackfillRecord,
  expectedConfirmToken,
  confirmTokenMatches,
  type BackfillApplyCandidate,
} from "./backfill-apply";

function L(over: Partial<BackfillApplyCandidate> & { id: string }): BackfillApplyCandidate {
  return { address: "100 Test St, San Antonio, TX 78201", ...over };
}

describe("planBackfillRecord — idempotency (skip already-populated)", () => {
  it("skips records whose pipelineStage is already set, even if derive would propose a different stage", () => {
    const p = planBackfillRecord(
      L({
        id: "rec1",
        pipelineStage: "negotiating", // engine-set
        outreachStatus: "Dead", // would derive to `dead` — but we don't clobber
      }),
    );
    expect(p.action).toBe("skip_already_populated");
    expect(p.apply_stage).toBeNull();
    expect(p.reason).toBe("already_populated");
  });

  it("treats whitespace-only pipelineStage as empty (still processes)", () => {
    const p = planBackfillRecord(
      L({
        id: "rec2",
        pipelineStage: "   ",
        outreachStatus: "Texted",
        executionPath: "Auto Proceed",
        liveStatus: "Active",
      }),
    );
    expect(p.action).toBe("apply_derived");
    expect(p.apply_stage).toBe("outreach_sent");
  });
});

describe("planBackfillRecord — defensive no-address skip", () => {
  it("refuses to backfill when address is missing — can't run the blacklist guard safely", () => {
    const p = planBackfillRecord({ id: "recX", address: null, outreachStatus: "Texted" });
    expect(p.action).toBe("skip_no_address");
    expect(p.apply_stage).toBeNull();
    expect(p.reason).toBe("no_address_unsafe");
  });

  it("treats whitespace-only address as missing", () => {
    const p = planBackfillRecord({ id: "recY", address: "   ", outreachStatus: "Texted" });
    expect(p.action).toBe("skip_no_address");
  });
});

describe("planBackfillRecord — Canon §9 blacklist HARD-GUARD (decision rechGJ32oW9Qmv8wp)", () => {
  // The 12 blacklist entries in lib/never-resurface.ts are tested via the
  // loose matcher in lib/never-resurface.test.ts; here we lock in the
  // planner's override behavior.

  it("OVERRIDES derived `negotiating` to `dead` when address contains a blacklist entry", () => {
    const p = planBackfillRecord(
      L({
        id: "rec_blacklist_neg",
        address: "2715 Monterey St, San Antonio, TX 78201", // matches blacklist
        outreachStatus: "Negotiating",
      }),
    );
    expect(p.action).toBe("apply_blacklist_dead");
    expect(p.apply_stage).toBe("dead");
    expect(p.derived_stage).toBe("negotiating");
    expect(p.reason).toBe("blacklist_hard_guard_override");
    expect(p.message).toContain("Canon §9");
  });

  it("OVERRIDES derived `outreach_ready` to `dead` when address is blacklisted (e.g. empty status + Auto Proceed + Active)", () => {
    const p = planBackfillRecord(
      L({
        id: "rec_blacklist_ready",
        address: "707 N Pine St, Anywhere, TX 78250", // contains "707 n pine st"
        outreachStatus: "",
        executionPath: "Auto Proceed",
        liveStatus: "Active",
      }),
    );
    expect(p.action).toBe("apply_blacklist_dead");
    expect(p.apply_stage).toBe("dead");
    expect(p.derived_stage).toBe("outreach_ready");
  });

  it("OVERRIDES derived `under_contract` to `dead` even with envelope set (blacklist beats everything)", () => {
    const p = planBackfillRecord(
      L({
        id: "rec_blacklist_uc",
        address: "910 Green St, Memphis, TN 38106", // contains "910 green st"
        envelopeId: "env-deadbeef",
        outreachStatus: "Contract Signed",
      }),
    );
    expect(p.action).toBe("apply_blacklist_dead");
    expect(p.apply_stage).toBe("dead");
    expect(p.derived_stage).toBe("under_contract");
  });

  it("does NOT override when derive already proposed `dead` — no spurious override reason", () => {
    const p = planBackfillRecord(
      L({
        id: "rec_blacklist_already_dead",
        address: "2715 Monterey St, San Antonio, TX 78201",
        outreachStatus: "Dead",
      }),
    );
    expect(p.action).toBe("apply_derived");
    expect(p.apply_stage).toBe("dead");
    expect(p.reason).not.toBe("blacklist_hard_guard_override");
  });

  it("does NOT touch records that DON'T match the blacklist (negative control)", () => {
    const p = planBackfillRecord(
      L({
        id: "rec_clean",
        address: "23 Fields Ave",
        outreachStatus: "Negotiating",
      }),
    );
    expect(p.action).toBe("apply_derived");
    expect(p.apply_stage).toBe("negotiating");
    expect(p.reason).not.toBe("blacklist_hard_guard_override");
  });
});

describe("planBackfillRecord — derive passthrough (clean + with-conflict)", () => {
  it("applies the derived stage verbatim on clean records (no conflicts → derived_clean)", () => {
    const p = planBackfillRecord(L({ id: "rec_clean", outreachStatus: "Texted" }));
    expect(p.action).toBe("apply_derived");
    expect(p.apply_stage).toBe("outreach_sent");
    expect(p.derived_stage).toBe("outreach_sent");
    expect(p.reason).toBe("derived_clean");
    expect(p.conflicts).toEqual([]);
  });

  it("flags conflicts (23 Fields class) but still applies the derived stage", () => {
    const p = planBackfillRecord(
      L({
        id: "rec1HTUqK0YEVb7uA",
        address: "23 Fields Ave",
        outreachStatus: "Negotiating",
        executionPath: "Reject",
      }),
    );
    expect(p.action).toBe("apply_derived");
    expect(p.apply_stage).toBe("negotiating");
    expect(p.reason).toBe("derived_with_conflict");
    expect(p.conflicts).toHaveLength(1);
  });
});

describe("expectedConfirmToken + confirmTokenMatches", () => {
  it("formats as BACKFILL-PIPELINE-STATE-YYYY-MM-DD in UTC", () => {
    expect(expectedConfirmToken(new Date("2026-05-31T23:59:59.000Z"))).toBe(
      "BACKFILL-PIPELINE-STATE-2026-05-31",
    );
    expect(expectedConfirmToken(new Date("2026-12-09T00:00:00.000Z"))).toBe(
      "BACKFILL-PIPELINE-STATE-2026-12-09",
    );
  });

  it("matches the exact expected token for today", () => {
    const now = new Date("2026-05-31T12:00:00.000Z");
    expect(confirmTokenMatches("BACKFILL-PIPELINE-STATE-2026-05-31", now)).toBe(true);
  });

  it("rejects the wrong day", () => {
    const now = new Date("2026-05-31T12:00:00.000Z");
    expect(confirmTokenMatches("BACKFILL-PIPELINE-STATE-2026-05-30", now)).toBe(false);
  });

  it("rejects null / empty / wrong-shape / wrong-length tokens", () => {
    const now = new Date("2026-05-31T12:00:00.000Z");
    expect(confirmTokenMatches(null, now)).toBe(false);
    expect(confirmTokenMatches(undefined, now)).toBe(false);
    expect(confirmTokenMatches("", now)).toBe(false);
    expect(confirmTokenMatches("BACKFILL", now)).toBe(false);
    expect(confirmTokenMatches("backfill-pipeline-state-2026-05-31", now)).toBe(false);
    // Extra char
    expect(confirmTokenMatches("BACKFILL-PIPELINE-STATE-2026-05-311", now)).toBe(false);
  });
});
