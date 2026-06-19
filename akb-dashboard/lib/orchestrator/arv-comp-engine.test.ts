// ARV Comp Engine — unit tests (CONVEYOR Milestone 3).
// VALIDATED / ESCALATE / BLOCKED on real seeds; conservative low-end ARV;
// no-AVM proof; DD-1 auto-tick wiring; fail-closed.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  evaluateArvFromSeed,
  isArvEngineAutocompleteLive,
  type ArvSubject,
} from "./arv-comp-engine";
import type { ZipArvSeed } from "@/lib/zip-arv-seed-store";
import { evaluatePreEmdGate } from "./pre-emd-gate";
import { proveNoNetwork } from "./dry-run-trace";

const DIR = dirname(fileURLToPath(import.meta.url));
const NOW = new Date("2026-06-16T12:00:00.000Z");

function seedMap(): Map<string, ZipArvSeed> {
  const raw = JSON.parse(readFileSync(join(DIR, "__fixtures__", "arv-engine", "detroit-seeds.json"), "utf8")).seeds;
  const m = new Map<string, ZipArvSeed>();
  for (const s of raw) {
    m.set(s.zip, {
      zip: s.zip, renovatedPerSqft: s.renovatedPerSqft, arvLowPerSqft: s.arvLowPerSqft,
      compCount: s.compCount, confidence: s.confidence, dontPrice: s.dontPrice,
      source: s.source, market: "detroit_mi", state: "MI", fetchedAt: s.fetchedAt,
      receiptsJson: null, recordId: "seed:" + s.zip,
    });
  }
  return m;
}
const SEEDS = seedMap();
const SFR = "Single Family";

describe("ARV Comp Engine (Milestone 3)", () => {
  it("VALIDATED: STRONG seed + sqft + ≥3 comps + SFR → conservative low-end ARV", () => {
    const subj: ArvSubject = { recordId: "r1", zip: "48227", sqft: 1300, propertyType: SFR };
    const r = evaluateArvFromSeed(subj, SEEDS.get("48227")!, NOW);
    expect(r.decision).toBe("VALIDATED");
    // conservative = Arv_Low_PerSqft (41.18) × sqft, NOT renovated (71).
    expect(r.engineArv).toBe(Math.round(41.18 * 1300)); // 53534
    expect(r.arvBasis).toBe("renovated_comp_low_end_per_sqft");
    expect(r.engineArv!).toBeLessThan(71 * 1300); // strictly below the renovated value
    expect(r.confidence).toBe("high");
    expect(r.source).toBe("seed_renovated_low");
    expect(r.issues).toEqual([]);
  });

  it("BLOCKED: a DONT_PRICE ZIP is never priced", () => {
    const r = evaluateArvFromSeed({ zip: "48206", sqft: 1200, propertyType: SFR }, SEEDS.get("48206")!, NOW);
    expect(r.decision).toBe("BLOCKED");
    expect(r.seedTier).toBe("DONT_PRICE");
    expect(r.engineArv).toBeNull();
  });

  it("BLOCKED: no seed for the ZIP (launch-market ZIPs are unseeded)", () => {
    const r = evaluateArvFromSeed({ zip: "78201", sqft: 1500, propertyType: SFR }, SEEDS.get("78201") ?? null, NOW);
    expect(r.decision).toBe("BLOCKED");
    expect(r.seedTier).toBe("NONE");
    expect(r.reason).toMatch(/no .*seed/i);
  });

  it("ESCALATE: subject sqft missing → routed to operator, not auto-validated", () => {
    const r = evaluateArvFromSeed({ zip: "48227", sqft: null, propertyType: SFR }, SEEDS.get("48227")!, NOW);
    expect(r.decision).toBe("ESCALATE");
    expect(r.issues.join(" ")).toMatch(/sqft/i);
    expect(r.engineArv).toBeNull();
  });

  it("ESCALATE: <3 comps (thin) → routed to operator", () => {
    const thin: ZipArvSeed = { ...SEEDS.get("48227")!, compCount: 2, confidence: "STRONG" };
    const r = evaluateArvFromSeed({ zip: "48227", sqft: 1300, propertyType: SFR }, thin, NOW);
    expect(r.decision).toBe("ESCALATE");
    expect(r.issues.join(" ")).toMatch(/comp_count/);
  });

  it("ESCALATE: stale seed → routed to operator", () => {
    const stale: ZipArvSeed = { ...SEEDS.get("48227")!, fetchedAt: "2026-01-01T00:00:00.000Z" };
    const r = evaluateArvFromSeed({ zip: "48227", sqft: 1300, propertyType: SFR }, stale, NOW);
    expect(r.decision).toBe("ESCALATE");
    expect(r.freshness.stale).toBe(true);
  });

  it("NO AVM: the engine never reads a RentCast AVM as ARV (source + code-level)", () => {
    // runtime: source is only ever seed-derived or none.
    for (const zip of ["48227", "48206", "78201"]) {
      const r = evaluateArvFromSeed({ zip, sqft: 1300, propertyType: SFR }, SEEDS.get(zip) ?? null, NOW);
      expect(["seed_renovated_low", "none"]).toContain(r.source);
    }
    // code-level: the engine imports no rentcast/AVM module and makes no
    // network call, so it CANNOT read an AVM. (The only "AVM" mentions in the
    // file are in the comment documenting that it is never used.)
    const src = readFileSync(join(DIR, "arv-comp-engine.ts"), "utf8");
    expect(/import[^;]*rentcast/i.test(src)).toBe(false);
    expect(/import[^;]*avm/i.test(src)).toBe(false);
    expect(src.includes("fetch(")).toBe(false);
  });

  it("DD-1 auto-ticks on VALIDATED, blocks on ESCALATE / BLOCKED / null (fail-closed)", () => {
    const validated = evaluateArvFromSeed({ zip: "48227", sqft: 1300, propertyType: SFR }, SEEDS.get("48227")!, NOW);
    const g1 = evaluatePreEmdGate({ recordId: "r", arvEngine: validated, now: NOW });
    expect(g1.checks.find((c) => c.id === "DD-1")!.status).toBe("pass");

    const escalate = evaluateArvFromSeed({ zip: "48227", sqft: null, propertyType: SFR }, SEEDS.get("48227")!, NOW);
    const g2 = evaluatePreEmdGate({ recordId: "r", arvEngine: escalate, now: NOW });
    expect(g2.checks.find((c) => c.id === "DD-1")!.status).toBe("BLOCKED");
    expect(g2.checks.find((c) => c.id === "DD-1")!.reason).toMatch(/escalat/i);

    const blocked = evaluateArvFromSeed({ zip: "48206", sqft: 1200, propertyType: SFR }, SEEDS.get("48206")!, NOW);
    expect(evaluatePreEmdGate({ recordId: "r", arvEngine: blocked, now: NOW }).checks.find((c) => c.id === "DD-1")!.status).toBe("BLOCKED");

    // null engine result (engine errored / not run) → BLOCKED, never a pass.
    expect(evaluatePreEmdGate({ recordId: "r", arvEngine: null, now: NOW }).checks.find((c) => c.id === "DD-1")!.status).toBe("BLOCKED");
  });

  it("watched mode is the default (autocomplete flag OFF) and the engine is pure (zero network)", () => {
    expect(isArvEngineAutocompleteLive()).toBe(false);
    const { fetchCalls } = proveNoNetwork(() =>
      [...SEEDS.keys()].map((zip) => evaluateArvFromSeed({ zip, sqft: 1200, propertyType: SFR }, SEEDS.get(zip)!, NOW)),
    );
    expect(fetchCalls).toBe(0);
  });
});
