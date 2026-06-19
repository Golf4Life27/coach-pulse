// price-transition (the `priced` writer) — unit tests.
// Proves the opener→priced advance routes through the sole-writer engine,
// is legal from null/verified, idempotent at priced, and FAIL-CLOSED on an
// illegal predecessor (never writes priced over a skip edge).

import { describe, it, expect, vi } from "vitest";
import { transitionToPriced } from "./price-transition";
import type { TransitionDeps } from "./engine";

function mkDeps() {
  const updateListing = vi.fn(async () => []);
  const audit = vi.fn(async () => {});
  // getCurrentStage must never be called when `current` is passed.
  const getCurrentStage = vi.fn(async () => null);
  const deps: TransitionDeps = {
    updateListing,
    audit: audit as unknown as TransitionDeps["audit"],
    getCurrentStage,
    now: () => new Date("2026-06-18T00:00:00.000Z"),
  };
  return { deps, updateListing, audit, getCurrentStage };
}

describe("transitionToPriced", () => {
  it("fresh intake (null) → priced: applied as initial assignment, writes Pipeline_Stage", async () => {
    const { deps, updateListing, getCurrentStage } = mkDeps();
    const res = await transitionToPriced("rec0000000000NEW0", null, "intake_opener_written:src1", deps);
    expect(res.ok).toBe(true);
    expect(res.outcome).toBe("applied");
    expect(res.to).toBe("priced");
    expect(res.legality.reason).toBe("ok_initial_assignment");
    expect(updateListing).toHaveBeenCalledWith("rec0000000000NEW0", { Pipeline_Stage: "priced" });
    // current was supplied → no extra fetch.
    expect(getCurrentStage).not.toHaveBeenCalled();
  });

  it("verified → priced: applied as legal forward-one-step", async () => {
    const { deps, updateListing } = mkDeps();
    const res = await transitionToPriced("rec0000000000VER0", "verified", "reprice", deps);
    expect(res.ok).toBe(true);
    expect(res.outcome).toBe("applied");
    expect(res.legality.reason).toBe("ok_forward_one_step");
    expect(updateListing).toHaveBeenCalledWith("rec0000000000VER0", { Pipeline_Stage: "priced" });
  });

  it("priced → priced: idempotent no-op, NO write", async () => {
    const { deps, updateListing } = mkDeps();
    const res = await transitionToPriced("rec000000000PRC0", "priced", "reprice", deps);
    expect(res.ok).toBe(true);
    expect(res.outcome).toBe("noop");
    expect(updateListing).not.toHaveBeenCalled();
  });

  it("FAIL-CLOSED: intake → priced is refused (skips verified), NO write", async () => {
    const { deps, updateListing } = mkDeps();
    const res = await transitionToPriced("rec00000000INTK0", "intake", "reprice", deps);
    expect(res.ok).toBe(false);
    expect(res.outcome).toBe("rejected_illegal");
    expect(res.legality.reason).toBe("illegal_skip_forward");
    expect(updateListing).not.toHaveBeenCalled();
  });

  it("FAIL-CLOSED: outreach_ready → priced is refused (backward), NO write", async () => {
    const { deps, updateListing } = mkDeps();
    const res = await transitionToPriced("rec0000000RDY000", "outreach_ready", "reprice", deps);
    expect(res.ok).toBe(false);
    expect(res.outcome).toBe("rejected_illegal");
    expect(updateListing).not.toHaveBeenCalled();
  });
});
