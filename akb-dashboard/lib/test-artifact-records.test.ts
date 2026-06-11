import { describe, it, expect } from "vitest";
import {
  isTestArtifact,
  testArtifactReason,
  TEST_ARTIFACT_RECORDS,
} from "./test-artifact-records";

describe("isTestArtifact", () => {
  it("flags recG4GNM2sa0ZYj7p (Callaghan — 3-cron lab rat)", () => {
    expect(isTestArtifact("recG4GNM2sa0ZYj7p")).toBe(true);
  });
  it("returns false on null, undefined, empty", () => {
    expect(isTestArtifact(null)).toBe(false);
    expect(isTestArtifact(undefined)).toBe(false);
    expect(isTestArtifact("")).toBe(false);
  });
  it("returns false on any other live record", () => {
    expect(isTestArtifact("recNSpOGnmUuHpA46")).toBe(false); // Freeland
    expect(isTestArtifact("recOnTegmyBdjkVpA")).toBe(false); // Cook Rd
  });
});

describe("testArtifactReason", () => {
  it("returns the canonical reason for Callaghan", () => {
    const r = testArtifactReason("recG4GNM2sa0ZYj7p");
    expect(r).not.toBeNull();
    expect(r!.toLowerCase()).toContain("lab rat");
    expect(r!.toLowerCase()).toContain("debug cron");
  });
  it("returns null for non-artifact records", () => {
    expect(testArtifactReason("recXYZ")).toBeNull();
  });
});

describe("invariants on the registry", () => {
  it("every entry has a non-empty reason", () => {
    for (const [, r] of TEST_ARTIFACT_RECORDS) {
      expect(r.reason.length).toBeGreaterThan(0);
    }
  });
});
