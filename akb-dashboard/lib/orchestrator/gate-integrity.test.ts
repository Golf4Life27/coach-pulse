// CONVEYOR Milestone 4 — Gate Integrity tests.
//
// Part 1: PROVE no advance path bypasses the Pre-EMD gate. A source-scan guard
//   asserts every app/api route that WRITES an EMD/Contract-Signed advance
//   state also imports the gate — so a new ungated side door fails this test.
//   Plus a behavioral check that the shared enforced path refuses a bad deal.
// Part 2: PROVE the dashboard-surfaced verdict === the enforced gate verdict
//   for the same record (23 Fields + Poteet), i.e. one source of truth.

import { describe, it, expect, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Mock the live data fetches so the shared enforced path runs without secrets.
vi.mock("@/lib/airtable", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/airtable")>()),
  getListings: vi.fn(async () => []),
}));
vi.mock("@/lib/federation/property-intel-store", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/federation/property-intel-store")>()),
  findPropertyIntelRecordByListing: vi.fn(async () => null),
}));

import { evaluatePreEmdGate, emdAdvanceDecision, preEmdDashboardVerdict, type PreEmdGateInput } from "./pre-emd-gate";
import { runPreEmdGateForDeal } from "./pre-emd-gate-live";
import type { Deal } from "@/lib/types";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_API = join(HERE, "..", "..", "app", "api");
const FIX = join(HERE, "__fixtures__", "pre-emd");
const NOW = new Date("2026-06-16T12:00:00.000Z");

function walkRoutes(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walkRoutes(p));
    else if (e === "route.ts") out.push(p);
  }
  return out;
}

function fixtureInput(name: string): PreEmdGateInput {
  return { ...JSON.parse(readFileSync(join(FIX, name), "utf8")).input, now: NOW };
}

describe("Gate integrity Part 1 — request-emd / sign_contract are the only doors", () => {
  const routes = walkRoutes(APP_API);

  it("enumerated the app/api route surface", () => {
    expect(routes.length).toBeGreaterThan(10);
  });

  it("EVERY route that writes an EMD/Contract-Signed advance state imports the Pre-EMD gate", () => {
    const writers: string[] = [];
    const ungated: string[] = [];
    for (const f of routes) {
      const src = readFileSync(f, "utf8");
      // An "advance writer" writes a Deal AND sets a forward EMD / contract
      // state. (Reads of "Contract Signed" — e.g. status sets — don't match
      // because they don't call updateDealRecord.)
      const advances = /updateDealRecord/.test(src) && (/EMD_Status/.test(src) || /"Contract Signed"/.test(src));
      if (!advances) continue;
      writers.push(f.replace(APP_API, "app/api"));
      const gated = /runPreEmdGateForDeal|emdAdvanceDecision|evaluatePreEmdGate/.test(src);
      if (!gated) ungated.push(f.replace(APP_API, "app/api"));
    }
    // request-emd (EMD_Status) + actions/[type] (Contract Signed) — and BOTH
    // must be gated. An ungated writer here is a side door.
    expect(writers.length).toBeGreaterThanOrEqual(2);
    expect(ungated).toEqual([]);
  });

  it("the shared enforced path refuses a deal with no DD (what sign_contract + request-emd call)", async () => {
    const deal = { id: "recDealX", propertyAddress: "23 Fields Ave, Memphis, TN", contractPrice: 61750 } as Deal;
    const gate = await runPreEmdGateForDeal(deal); // getListings mocked → [] → fail-closed
    const decision = emdAdvanceDecision({ ...gate, evaluatedAt: gate.evaluatedAt });
    expect(gate.verdict).toBe("BLOCKED");
    expect(decision.allowed).toBe(false);
    expect(decision.httpStatus).toBe(423);
  });
});

describe("Gate integrity Part 2 — dashboard verdict === enforced verdict (one source of truth)", () => {
  for (const name of ["23-fields-ave.json", "poteet-938-avenue-i.json"]) {
    it(`${name}: displayed verdict equals enforced verdict (both BLOCKED)`, () => {
      const result = evaluatePreEmdGate(fixtureInput(name));

      // Displayed (pre-emd-state panel) and enforced (request-emd /
      // sign_contract) BOTH derive from this same result.
      const displayed = preEmdDashboardVerdict(result);
      const enforced = emdAdvanceDecision(result);

      const enforcedVerdict = enforced.allowed ? "ADVANCE_UNLOCKED" : "BLOCKED";
      expect(displayed.verdict).toBe(enforcedVerdict);
      expect(displayed.verdict).toBe("BLOCKED");
      expect(displayed.display).toBe("block");
      expect(enforced.allowed).toBe(false);
    });
  }

  it("an unlocked record displays 'pass' and is enforced-allowed (same result)", () => {
    const result = evaluatePreEmdGate(fixtureInput("fully-populated-pass.json"));
    const displayed = preEmdDashboardVerdict(result);
    const enforced = emdAdvanceDecision(result);
    expect(displayed.verdict).toBe("ADVANCE_UNLOCKED");
    expect(displayed.display).toBe("pass");
    expect(enforced.allowed).toBe(true);
  });
});
