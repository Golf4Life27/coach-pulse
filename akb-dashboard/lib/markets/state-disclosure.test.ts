// Parity pins for the single disclosure-state truth (Consolidation Night
// 2026-07-29, item A).
//
// WHY THESE TESTS EXIST. Two modules hardcoded their own copies of
// NON_DISCLOSURE_STATES and silently disagreed about Alabama for weeks —
// the exact dual-implementation drift pattern behind every major defect
// found in the 7/29 audits. These pins make any future divergence, or any
// silent change to the AL delta, a loud test failure instead of a quiet
// disagreement.

import { describe, it, expect } from "vitest";
import {
  NON_DISCLOSURE_STATES,
  BUYER_MEDIAN_UNRELIABLE_STATES,
  PARTIAL_DISCLOSURE_ADDITIONS,
} from "@/lib/markets/state-disclosure";
import { NON_DISCLOSURE_STATES as REGISTRY_LIST } from "@/lib/markets/registry";
import { NON_DISCLOSURE_STATES as DISCLOSURE_LIST } from "@/lib/markets/disclosure";

describe("state-disclosure single source of truth", () => {
  it("pins the legal 12", () => {
    expect([...NON_DISCLOSURE_STATES].sort()).toEqual([
      "AK", "ID", "KS", "LA", "MO", "MS", "MT", "ND", "NM", "TX", "UT", "WY",
    ]);
  });

  it("the buyer-median-unreliable set is exactly the legal 12 plus the documented additions", () => {
    const expected = new Set([...NON_DISCLOSURE_STATES, ...PARTIAL_DISCLOSURE_ADDITIONS]);
    expect(BUYER_MEDIAN_UNRELIABLE_STATES).toEqual(expected);
  });

  it("the ONLY delta between the two sets is Alabama — pinned so it cannot drift silently", () => {
    const delta = [...BUYER_MEDIAN_UNRELIABLE_STATES].filter(
      (s) => !NON_DISCLOSURE_STATES.has(s),
    );
    expect(delta).toEqual(["AL"]);
    // The reverse direction must be empty: the unreliable set strictly
    // contains the legal set.
    const reverse = [...NON_DISCLOSURE_STATES].filter(
      (s) => !BUYER_MEDIAN_UNRELIABLE_STATES.has(s),
    );
    expect(reverse).toEqual([]);
  });

  // The consolidation contract: both consumer modules re-export from here,
  // preserving each module's pre-consolidation behavior exactly.
  it("registry re-exports the legal 12 (opener/frontier gating unchanged: AL does NOT hold openers)", () => {
    expect(REGISTRY_LIST).toBe(NON_DISCLOSURE_STATES);
    expect(REGISTRY_LIST.has("AL")).toBe(false);
    expect(REGISTRY_LIST.has("TX")).toBe(true);
  });

  it("disclosure re-exports the unreliable set (AL pricing stays on ARV-comps)", () => {
    expect(DISCLOSURE_LIST).toBe(BUYER_MEDIAN_UNRELIABLE_STATES);
    expect(DISCLOSURE_LIST.has("AL")).toBe(true);
    expect(DISCLOSURE_LIST.has("TX")).toBe(true);
  });

  // Any change to this line is an OPERATOR RULING (gates the hottest
  // market), never a refactor side effect. See state-disclosure.ts header.
  it("Alabama openers are NOT held (pending operator ruling — do not change in a refactor)", () => {
    expect(NON_DISCLOSURE_STATES.has("AL")).toBe(false);
  });
});
