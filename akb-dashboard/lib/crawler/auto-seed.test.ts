import { describe, it, expect } from "vitest";
import { decideAutoSeed } from "./auto-seed";

const base = {
  zip: "78201",
  state: "TX",
  alreadySeeded: false,
  canSeed: true,
  hasRepresentativeSubject: true,
};

describe("decideAutoSeed — frontier gating", () => {
  it("seeds an unseeded, in-budget ZIP with a subject", () => {
    const d = decideAutoSeed(base);
    expect(d.seed).toBe(true);
    expect(d.reason).toBe("ok");
  });

  it("never seeds a restricted state (load-frozen)", () => {
    // IL is in the restricted set
    const d = decideAutoSeed({ ...base, zip: "60601", state: "IL" });
    expect(d.seed).toBe(false);
    expect(d.reason).toBe("restricted_state");
  });

  it("skips already-seeded ZIPs (no paid pull — pricing is free)", () => {
    const d = decideAutoSeed({ ...base, alreadySeeded: true });
    expect(d.seed).toBe(false);
    expect(d.reason).toBe("already_seeded");
  });

  it("pauses on exhausted budget", () => {
    const d = decideAutoSeed({ ...base, canSeed: false });
    expect(d.seed).toBe(false);
    expect(d.reason).toBe("budget_exhausted");
  });

  it("skips when no representative subject to pull comps against", () => {
    const d = decideAutoSeed({ ...base, hasRepresentativeSubject: false });
    expect(d.seed).toBe(false);
    expect(d.reason).toBe("no_representative_subject");
  });

  it("rejects an invalid ZIP", () => {
    expect(decideAutoSeed({ ...base, zip: "abc" }).seed).toBe(false);
  });

  it("restricted-state check precedes budget/seed checks", () => {
    const d = decideAutoSeed({ zip: "60601", state: "IL", alreadySeeded: false, canSeed: false, hasRepresentativeSubject: false });
    expect(d.reason).toBe("restricted_state");
  });
});
