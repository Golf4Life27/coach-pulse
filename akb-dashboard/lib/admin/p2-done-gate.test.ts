import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  readsAgree,
  planLegs,
  callsAvoided,
  readP2Config,
  DEFAULT_LEG_FAILURE_CAP,
  type PlanLegsInput,
} from "./p2-done-gate";

// Fixtures predate the sold-comps-only ARV epoch (#126) — pin the epoch
// before them so the done-gate semantics under test are undisturbed. The
// epoch gate itself is covered in its own describe below.
beforeAll(() => {
  process.env.ARV_ENGINE_EPOCH = "2026-01-01T00:00:00.000Z";
});
afterAll(() => {
  delete process.env.ARV_ENGINE_EPOCH;
});

function input(overrides: Partial<PlanLegsInput> = {}): PlanLegsInput {
  return {
    arvValidatedAt: null,
    // Default TRUE so every pre-existing case still exercises the behaviour it
    // was written for (stamp semantics). The comps requirement gets its own
    // describe below.
    arvCompEvidencePresent: true,
    rehabEstimatedAt: null,
    estimatedMonthlyRent: null,
    force: false,
    kvAvailable: true,
    rehabStable: false,
    failures: { arv: 0, rehab: 0, rent: 0 },
    ...overrides,
  };
}

describe("readsAgree", () => {
  it("agrees when confidences match and mids sit within ±$5", () => {
    expect(readsAgree({ conf: 42, mid: 51_183 }, { conf: 42, mid: 51_183 })).toBe(true);
    expect(readsAgree({ conf: 42, mid: 51_183 }, { conf: 42, mid: 51_188 })).toBe(true);
  });

  it("refuses on mid drift, conf drift, or missing reads", () => {
    expect(readsAgree({ conf: 42, mid: 51_183 }, { conf: 42, mid: 51_190 })).toBe(false);
    expect(readsAgree({ conf: 42, mid: 51_183 }, { conf: 43, mid: 51_183 })).toBe(false);
    expect(readsAgree({ conf: 42, mid: null }, { conf: 42, mid: 51_183 })).toBe(false);
    expect(readsAgree({ conf: null, mid: 51_183 }, { conf: null, mid: 51_183 })).toBe(true);
  });
});

describe("planLegs", () => {
  it("runs all legs on a fresh record", () => {
    expect(planLegs(input())).toEqual({ arv: "run", rehab: "run", rent: "run" });
  });

  it("fires ONLY the missing legs — a completed leg never re-buys its call", () => {
    const p = planLegs(
      input({ arvValidatedAt: "2026-07-01T00:00:00Z", estimatedMonthlyRent: 950 }),
    );
    expect(p).toEqual({ arv: "skip_done", rehab: "run", rent: "skip_done" });
  });

  it("gives the rehab leg exactly one confirmation read, then stable stops it", () => {
    // Read exists, ledger available, not yet stable → the confirmation read runs.
    const confirming = planLegs(input({ rehabEstimatedAt: "2026-07-01T00:00:00Z" }));
    expect(confirming.rehab).toBe("run");
    // Two agreeing reads recorded → never again.
    const stable = planLegs(
      input({ rehabEstimatedAt: "2026-07-01T00:00:00Z", rehabStable: true }),
    );
    expect(stable.rehab).toBe("skip_stable");
  });

  it("fails toward NOT spending when the ledger is unreachable", () => {
    const p = planLegs(
      input({ rehabEstimatedAt: "2026-07-01T00:00:00Z", kvAvailable: false }),
    );
    expect(p.rehab).toBe("skip_done");
  });

  it("benches a leg after the consecutive-failure cap", () => {
    const p = planLegs(
      input({ failures: { arv: DEFAULT_LEG_FAILURE_CAP, rehab: 2, rent: 99 } }),
    );
    expect(p.arv).toBe("skip_failure_capped");
    expect(p.rehab).toBe("run");
    expect(p.rent).toBe("skip_failure_capped");
  });

  it("force overrides every skip", () => {
    const p = planLegs(
      input({
        force: true,
        arvValidatedAt: "x",
        rehabEstimatedAt: "x",
        rehabStable: true,
        estimatedMonthlyRent: 950,
        failures: { arv: 99, rehab: 99, rent: 99 },
      }),
    );
    expect(p).toEqual({ arv: "run", rehab: "run", rent: "run" });
  });

  it("an unparseable ARV stamp is not 'done' — the leg re-runs", () => {
    expect(planLegs(input({ arvValidatedAt: "garbage" })).arv).toBe("run");
  });
});

// ── ARV engine epoch (#126 remediation) ───────────────────────────────────
describe("planLegs — ARV epoch invalidation", () => {
  const EPOCH = "2026-07-17T15:40:00.000Z";
  beforeAll(() => {
    process.env.ARV_ENGINE_EPOCH = EPOCH;
  });
  afterAll(() => {
    process.env.ARV_ENGINE_EPOCH = "2026-01-01T00:00:00.000Z"; // restore file-level pin
  });

  it("a pre-epoch ARV stamp is contaminated output — the leg re-runs; rehab/rent gates unchanged", () => {
    const p = planLegs(
      input({ arvValidatedAt: "2026-07-17T14:45:32Z", estimatedMonthlyRent: 1830, rehabStable: true }),
    );
    // The 1122 West Ave record's exact shape: pre-epoch ARV stamp, rent
    // present, rehab stable → ONLY the ARV leg re-buys its call.
    expect(p).toEqual({ arv: "run", rehab: "skip_stable", rent: "skip_done" });
  });

  it("a post-epoch stamp is done", () => {
    expect(planLegs(input({ arvValidatedAt: "2026-07-17T16:00:00Z" })).arv).toBe("skip_done");
  });

  it("failure cap still benches a pre-epoch record (no infinite re-burn on errors)", () => {
    const p = planLegs(
      input({ arvValidatedAt: "2026-07-17T14:45:32Z", failures: { arv: DEFAULT_LEG_FAILURE_CAP, rehab: 0, rent: 0 } }),
    );
    expect(p.arv).toBe("skip_failure_capped");
  });
});

describe("callsAvoided", () => {
  it("quantifies the burn each skip avoided, by vendor", () => {
    const avoided = callsAvoided([
      { arv: "skip_done", rehab: "skip_stable", rent: "run" },
      { arv: "run", rehab: "skip_failure_capped", rent: "skip_done" },
    ]);
    expect(avoided).toEqual({ scraperapi: 1, anthropic: 2, rentcast: 1 });
  });
});

describe("readP2Config", () => {
  it("defaults and env overrides", () => {
    expect(readP2Config({})).toEqual({ stableDeltaUsd: 5, failureCap: 5 });
    expect(readP2Config({ P2_STABLE_REHAB_DELTA_USD: "100", P2_LEG_FAILURE_CAP: "3" })).toEqual({
      stableDeltaUsd: 100,
      failureCap: 3,
    });
    expect(readP2Config({ P2_STABLE_REHAB_DELTA_USD: "-1", P2_LEG_FAILURE_CAP: "0" })).toEqual({
      stableDeltaUsd: 5,
      failureCap: 5,
    });
  });
});

// ── Terminal no-photo-source flag (Consolidation Night 2026-07-29, item E) ──
// A rehab 422 of no_photos_available / street_view_only_insufficient is an
// ANSWER, not a transient failure. Before this state existed, the failure
// bench looped: 5 paid rounds → 7-day bench → TTL lapse → 5 more rounds,
// forever — each round re-buying the RentCast photo pulls inside
// collectPhotos for a property with no photo source.
describe("planLegs — rehabUnproducible terminal state", () => {
  const base = {
    arvValidatedAt: null,
    rehabEstimatedAt: null,
    estimatedMonthlyRent: null,
    force: false,
    kvAvailable: true,
    rehabStable: false,
    arvCompEvidencePresent: true,
    failures: { arv: 0, rehab: 0, rent: 0 },
  };

  it("skips the rehab leg when the no-photo-source flag is set", () => {
    const p = planLegs({ ...base, rehabUnproducible: true });
    expect(p.rehab).toBe("skip_unproducible");
    // Other legs are unaffected — ARV and rent don't need photos.
    expect(p.arv).toBe("run");
    expect(p.rent).toBe("run");
  });

  it("the terminal answer outranks the confirmation-read path", () => {
    const p = planLegs({
      ...base,
      rehabUnproducible: true,
      rehabEstimatedAt: "2026-07-01T00:00:00Z",
    });
    expect(p.rehab).toBe("skip_unproducible");
  });

  it("force=1 overrides — the operator can always demand a fresh attempt", () => {
    const p = planLegs({ ...base, rehabUnproducible: true, force: true });
    expect(p.rehab).toBe("run");
  });

  it("absent flag → unchanged behavior (first read runs)", () => {
    const p = planLegs({ ...base, rehabUnproducible: false });
    expect(p.rehab).toBe("run");
  });

  it("skip_unproducible counts as an avoided vision call in burn quantification", () => {
    const avoided = callsAvoided([
      { arv: "run", rehab: "skip_unproducible", rent: "run" },
    ]);
    expect(avoided.anthropic).toBe(1);
  });
});

// ── ARV COMP EVIDENCE (2026-08-15, the 16-slice no-op sweep) ──────────────
//
// The first comp-coverage sweep ran 16 slices over the SAME 4 records and
// wrote zero comps: every ARV leg planned "skip_done" purely because
// ARV_Validated_At was recent, while ARV_Comp_Details_JSON sat empty. Since
// the own-comps ARV basis shipped, that field IS the leg's load-bearing
// output — a stamp is a claim, the comps are the evidence. The driver then
// logged "Total records backfilled this run: 64".
describe("ARV leg requires comp evidence, not just a trusted stamp", () => {
  const TRUSTED = "2026-08-10T00:00:00.000Z"; // after the test epoch

  it("THE BUG: trusted stamp + EMPTY comps → runs (was skip_done, wrote nothing)", () => {
    const p = planLegs(input({ arvValidatedAt: TRUSTED, arvCompEvidencePresent: false }));
    expect(p.arv).toBe("run");
  });

  it("trusted stamp + comps present → skip_done (unchanged, and the terminator)", () => {
    const p = planLegs(input({ arvValidatedAt: TRUSTED, arvCompEvidencePresent: true }));
    expect(p.arv).toBe("skip_done");
  });

  it("comps present but NO stamp still runs — evidence alone is not done", () => {
    const p = planLegs(input({ arvValidatedAt: null, arvCompEvidencePresent: true }));
    expect(p.arv).toBe("run");
  });

  it("TERMINATES: an honest-empty compute writes exclusion receipts, so the very next pass skips", () => {
    // arv-write.ts persists comps_excluded when comps_used is empty, so the
    // field is non-empty even for a property with no usable comps. Keyed on
    // WRITTEN rather than USABLE precisely so this cannot re-buy forever.
    const before = planLegs(input({ arvValidatedAt: TRUSTED, arvCompEvidencePresent: false }));
    expect(before.arv).toBe("run");
    const after = planLegs(input({ arvValidatedAt: TRUSTED, arvCompEvidencePresent: true }));
    expect(after.arv).toBe("skip_done");
  });

  it("the failure cap still outranks a comps-driven re-run — a broken record benches", () => {
    const p = planLegs(input({
      arvValidatedAt: TRUSTED,
      arvCompEvidencePresent: false,
      failures: { arv: 5, rehab: 0, rent: 0 },
      failureCap: 5,
    }));
    expect(p.arv).toBe("skip_failure_capped");
  });

  it("force still overrides everything", () => {
    const p = planLegs(input({ arvValidatedAt: TRUSTED, arvCompEvidencePresent: true, force: true }));
    expect(p.arv).toBe("run");
  });
});
