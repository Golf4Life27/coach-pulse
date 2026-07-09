// H2 send-cap — unit tests. Proves the safety meter is FAIL-CLOSED and tight:
// empty allowlist → zero; per-zip + per-run caps; env clamped to ceilings.

import { describe, it, expect } from "vitest";
import { applySendCap, readSendCapConfig, resolveCoverage, type SendCapConfig } from "./send-cap";

type Plan = { id: string; zip: string | null };
const zipOf = (p: Plan) => p.zip;
const plans = (...zips: Array<string | null>): Plan[] =>
  zips.map((z, i) => ({ id: `rec${i}`, zip: z }));

function cfg(over: Partial<SendCapConfig> = {}): SendCapConfig {
  return { maxPerRun: 5, maxPerZip: 2, coveredZips: new Set(["48227", "48205"]), coverageMode: "allowlist" as const, ...over };
}

describe("applySendCap", () => {
  it("FAIL-CLOSED: empty covered-ZIP allowlist caps everything (zero allowed)", () => {
    const d = applySendCap(plans("48227", "48205"), zipOf, cfg({ coveredZips: new Set() }));
    expect(d.allowed).toHaveLength(0);
    expect(d.capped.every((c) => c.reason === "zip_not_covered")).toBe(true);
  });

  it("drops uncovered ZIPs, keeps covered", () => {
    const d = applySendCap(plans("48227", "99999", "48205"), zipOf, cfg());
    expect(d.allowed.map((p) => p.zip)).toEqual(["48227", "48205"]);
    expect(d.capped).toHaveLength(1);
    expect(d.capped[0].reason).toBe("zip_not_covered");
  });

  it("enforces the per-zip cap", () => {
    const d = applySendCap(plans("48227", "48227", "48227"), zipOf, cfg({ maxPerRun: 10 }));
    expect(d.allowed).toHaveLength(2);
    expect(d.capped).toHaveLength(1);
    expect(d.capped[0].reason).toBe("per_zip_cap");
  });

  it("enforces the per-run cap across covered ZIPs", () => {
    // 6 covered sends, per-zip 3, per-run 5 → exactly 5 fire, 1 per_run_cap.
    const d = applySendCap(
      plans("48227", "48205", "48227", "48205", "48227", "48205"),
      zipOf,
      cfg({ maxPerRun: 5, maxPerZip: 3 }),
    );
    expect(d.allowed).toHaveLength(5);
    expect(d.capped).toHaveLength(1);
    expect(d.capped[0].reason).toBe("per_run_cap");
  });

  it("normalizes ZIP+4 to the 5-digit ZIP", () => {
    const d = applySendCap(plans("48227-1234"), zipOf, cfg());
    expect(d.allowed).toHaveLength(1);
  });

  it("null/blank ZIP is never covered", () => {
    const d = applySendCap(plans(null, ""), zipOf, cfg());
    expect(d.allowed).toHaveLength(0);
    expect(d.capped.every((c) => c.reason === "zip_not_covered")).toBe(true);
  });
});

describe("readSendCapConfig", () => {
  it("defaults are tight (5 / 2) with an empty allowlist", () => {
    const c = readSendCapConfig({} as unknown as NodeJS.ProcessEnv);
    expect(c.maxPerRun).toBe(5);
    expect(c.maxPerZip).toBe(2);
    expect(c.coveredZips.size).toBe(0);
  });

  it("clamps an over-large env to the hard ceilings (no blast via env typo)", () => {
    const c = readSendCapConfig({ H2_MAX_SENDS_PER_RUN: "9999", H2_MAX_SENDS_PER_ZIP: "500" } as unknown as NodeJS.ProcessEnv);
    expect(c.maxPerRun).toBe(25);
    expect(c.maxPerZip).toBe(10);
  });

  it("parses H2_COVERED_ZIPS (comma/space, ZIP+4 tolerated)", () => {
    const c = readSendCapConfig({ H2_COVERED_ZIPS: "48227, 48205 48213-0001" } as unknown as NodeJS.ProcessEnv);
    expect([...c.coveredZips].sort()).toEqual(["48205", "48213", "48227"]);
  });

  it("a negative/garbage env falls back to the tight default", () => {
    const c = readSendCapConfig({ H2_MAX_SENDS_PER_RUN: "-3", H2_MAX_SENDS_PER_ZIP: "abc" } as unknown as NodeJS.ProcessEnv);
    expect(c.maxPerRun).toBe(5);
    expect(c.maxPerZip).toBe(2);
  });
});

describe("auto coverage mode (UNLEASH ruling 2026-07-09)", () => {
  it("H2_COVERED_ZIPS=auto reads as auto mode with an empty allowlist", () => {
    const c = readSendCapConfig({ H2_COVERED_ZIPS: "auto" } as unknown as NodeJS.ProcessEnv);
    expect(c.coverageMode).toBe("auto");
    expect(c.coveredZips.size).toBe(0);
  });

  it("unset env stays allowlist + FAIL-CLOSED (zero coverage)", () => {
    const c = readSendCapConfig({} as unknown as NodeJS.ProcessEnv);
    expect(c.coverageMode).toBe("allowlist");
    expect(c.coveredZips.size).toBe(0);
  });

  it("resolveCoverage fills coverage from the seeded set in auto mode only", () => {
    const auto = readSendCapConfig({ H2_COVERED_ZIPS: "auto" } as unknown as NodeJS.ProcessEnv);
    const resolved = resolveCoverage(auto, ["44105", "48203", "bad"]);
    expect([...resolved.coveredZips].sort()).toEqual(["44105", "48203"]);
    // allowlist mode is a passthrough — the env list stays authoritative:
    const listed = cfg();
    expect(resolveCoverage(listed, ["44105"]).coveredZips).toBe(listed.coveredZips);
  });

  it("auto mode with an EMPTY seed store still sends nothing (fail-closed preserved)", () => {
    const auto = resolveCoverage(readSendCapConfig({ H2_COVERED_ZIPS: "auto" } as unknown as NodeJS.ProcessEnv), []);
    const d = applySendCap(plans("44105"), zipOf, auto);
    expect(d.allowed).toHaveLength(0);
  });
});
