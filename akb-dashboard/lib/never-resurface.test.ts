// @agent: maverick — never-resurface matcher tests.
//
// The strict matcher predates this commit; the loose matcher landed for
// the Pipeline_State backfill hard-guard (decision rechGJ32oW9Qmv8wp).
// Both are exercised here so future churn doesn't drift either one.

import { describe, it, expect } from "vitest";
import {
  NEVER_RESURFACE,
  isNeverResurface,
  isNeverResurfaceLoose,
} from "./never-resurface";

describe("NEVER_RESURFACE constant", () => {
  it("contains the locked Canon §9 thirteen addresses (lowercased)", () => {
    expect(NEVER_RESURFACE.size).toBe(13);
    expect(NEVER_RESURFACE.has("2715 monterey st")).toBe(true);
    expect(NEVER_RESURFACE.has("910 green st")).toBe(true);
    expect(NEVER_RESURFACE.has("707 n pine st")).toBe(true);
  });
});

describe("isNeverResurface — strict matcher (existing behavior)", () => {
  it("matches exact lowercased + trimmed entries", () => {
    expect(isNeverResurface("2715 monterey st")).toBe(true);
    expect(isNeverResurface("  2715 Monterey St  ")).toBe(true);
  });

  it("does NOT match full-form addresses (this is the gap the loose matcher closes)", () => {
    // Real Listings_V1 addresses are full-form ("street, city, state zip").
    // The strict matcher misses these — by design, kept for backwards-compat
    // with the verify-listing route's intake-time strict match.
    expect(isNeverResurface("2715 Monterey St, San Antonio, TX 78201")).toBe(false);
  });

  it("rejects empty / null / undefined", () => {
    expect(isNeverResurface(null)).toBe(false);
    expect(isNeverResurface(undefined)).toBe(false);
    expect(isNeverResurface("")).toBe(false);
  });
});

describe("isNeverResurfaceLoose — substring matcher (Pipeline_State backfill hard-guard)", () => {
  it("matches full-form Listings_V1 addresses against the short-form blocklist", () => {
    expect(isNeverResurfaceLoose("2715 Monterey St, San Antonio, TX 78201")).toBe(true);
    expect(isNeverResurfaceLoose("910 Green St, Memphis, TN 38106")).toBe(true);
    expect(isNeverResurfaceLoose("707 N Pine St, Anywhere, TX 78250")).toBe(true);
    // 2026-06-05 — 336 Burwood Dr: corporate-investor seller (Mainstay).
    // Same precedent as 910 Green St; reply recorded in Verification_Notes.
    expect(isNeverResurfaceLoose("336 Burwood Dr, Memphis, TN 38109")).toBe(true);
  });

  it("matches case-insensitively + tolerates leading/trailing whitespace", () => {
    expect(isNeverResurfaceLoose("  2715 MONTEREY ST  ")).toBe(true);
    expect(isNeverResurfaceLoose("2715 monterey st")).toBe(true);
  });

  it("does NOT match unrelated addresses (negative control)", () => {
    expect(isNeverResurfaceLoose("23 Fields Ave")).toBe(false);
    expect(isNeverResurfaceLoose("1138 Santa Anna, San Antonio, TX 78201")).toBe(false);
    expect(isNeverResurfaceLoose("3273 Steele St")).toBe(false);
  });

  it("does NOT false-positive when the house-number prefix differs", () => {
    // Blocklist has "2715 monterey st" — a DIFFERENT 2715 monterey st-named
    // street in another city would also match; that's accepted, but a
    // DIFFERENT number on monterey st must NOT match.
    expect(isNeverResurfaceLoose("100 Monterey St, San Antonio, TX 78201")).toBe(false);
    expect(isNeverResurfaceLoose("99 Green St, Memphis, TN 38106")).toBe(false);
  });

  it("rejects empty / null / undefined / whitespace-only", () => {
    expect(isNeverResurfaceLoose(null)).toBe(false);
    expect(isNeverResurfaceLoose(undefined)).toBe(false);
    expect(isNeverResurfaceLoose("")).toBe(false);
    expect(isNeverResurfaceLoose("   ")).toBe(false);
  });
});
