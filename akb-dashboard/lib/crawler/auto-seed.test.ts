import { describe, it, expect } from "vitest";
import {
  decideAutoSeed,
  evaluateSeedQuality,
  seedPullWiden,
  seedFilterOverride,
  seedQualityThresholds,
} from "./auto-seed";

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

describe("evaluateSeedQuality — the comp count + dispersion gate", () => {
  it("fails a single-comp seed (48205's $82k Alma St case)", () => {
    const v = evaluateSeedQuality({ compCountUsed: 1, perSqftValues: [65] }, { minComps: 4, maxCv: 0.35 });
    expect(v.pass).toBe(false);
    expect(v.reason).toContain("too_few_comps");
  });

  it("fails a 6×-spread noisy cluster even when comp count clears (48206's 29/72/171)", () => {
    const v = evaluateSeedQuality({ compCountUsed: 3, perSqftValues: [29, 72, 171] }, { minComps: 3, maxCv: 0.35 });
    expect(v.pass).toBe(false);
    expect(v.reason).toContain("dispersion_too_high");
    expect(v.cv! > 0.35).toBe(true);
  });

  it("passes a tight cluster (48202's 131/135/137 → CV ~0.02)", () => {
    const v = evaluateSeedQuality({ compCountUsed: 3, perSqftValues: [131, 135, 137] }, { minComps: 3, maxCv: 0.35 });
    expect(v.pass).toBe(true);
    expect(v.cv! < 0.05).toBe(true);
    expect(v.meanPerSqft).toBe(134);
  });

  it("passes a deep, reasonably tight cluster at the default thresholds", () => {
    const v = evaluateSeedQuality({ compCountUsed: 5, perSqftValues: [120, 130, 135, 140, 150] });
    expect(v.pass).toBe(true);
  });

  it("uses min(compCountUsed, usable $/sqft values) for the count gate", () => {
    // claims 5 comps but only 2 have a positive $/sqft → fails on count
    const v = evaluateSeedQuality({ compCountUsed: 5, perSqftValues: [100, 0, -1, 105] }, { minComps: 4, maxCv: 0.35 });
    expect(v.pass).toBe(false);
    expect(v.reason).toContain("too_few_comps");
  });
});

describe("seed widen + gate knobs (env-tunable defaults)", () => {
  it("widens the RentCast request (more comps / wider radius / relaxed recency)", () => {
    const w = seedPullWiden();
    expect(w.compCount).toBe(25);
    expect(w.maxRadius).toBe(2);
    expect(w.daysOld).toBe(365);
  });

  it("relaxes the engine clip to match the wide pull", () => {
    const o = seedFilterOverride();
    expect(o.comp_filters?.max_distance_miles).toBe(2);
    expect(o.comp_filters?.max_age_days).toBe(365);
    expect(o.comp_filters?.beds_exact_match_required).toBe(false);
    expect(o.distressed_proxy?.apply_only_if_zip_has_at_least_comps).toBe(3);
  });

  it("defaults the gate to ≥4 comps and CV ≤ 0.35", () => {
    const t = seedQualityThresholds();
    expect(t.minComps).toBe(4);
    expect(t.maxCv).toBe(0.35);
  });
});
