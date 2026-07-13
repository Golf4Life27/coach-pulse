import { describe, it, expect } from "vitest";
import {
  selectEngagedUnderwriteTargets,
  underwriteFresh,
  ENGAGED_STATUSES,
} from "./engaged-underwrite-select";
import type { Listing } from "@/lib/types";

const NOW = new Date("2026-07-13T02:00:00Z");

function deal(o: Partial<Listing> = {}): Listing {
  return {
    id: "recENGAGED0000001",
    address: "1 Test St, Detroit, MI 48228",
    outreachStatus: "Negotiating",
    executionPath: "Auto Proceed",
    arvValidatedAt: null,
    lastInboundAt: "2026-07-12T20:00:00Z",
    lastOutboundAt: null,
    ...o,
    // minimal remaining Listing surface — cast keeps the fixture terse
  } as unknown as Listing;
}

describe("underwriteFresh", () => {
  it("no ARV stamp → never fresh (this is the whole gap — un-underwritten deals)", () => {
    expect(underwriteFresh({ arvValidatedAt: null }, NOW)).toBe(false);
  });
  it("validated within 14d → fresh; older → stale", () => {
    expect(underwriteFresh({ arvValidatedAt: "2026-07-05T00:00:00Z" }, NOW)).toBe(true);
    expect(underwriteFresh({ arvValidatedAt: "2026-06-20T00:00:00Z" }, NOW)).toBe(false);
  });
});

describe("selectEngagedUnderwriteTargets", () => {
  it("REGRESSION Sunbeam class: an engaged Auto-Proceed deal with no ARV is a target", () => {
    const targets = selectEngagedUnderwriteTargets(
      [deal({ id: "recSUNBEAM", address: "3123 Sunbeam St", outreachStatus: "Negotiating", executionPath: "Auto Proceed", arvValidatedAt: null })],
      NOW,
    );
    expect(targets.map((t) => t.id)).toEqual(["recSUNBEAM"]);
  });

  it("all four engaged statuses qualify; non-engaged do not", () => {
    for (const s of ENGAGED_STATUSES) {
      expect(selectEngagedUnderwriteTargets([deal({ outreachStatus: s })], NOW)).toHaveLength(1);
    }
    expect(selectEngagedUnderwriteTargets([deal({ outreachStatus: "Texted" })], NOW)).toHaveLength(0);
    expect(selectEngagedUnderwriteTargets([deal({ outreachStatus: "Dead" })], NOW)).toHaveLength(0);
  });

  it("gate: only Auto Proceed (raw intake never underwrites — protects the budget)", () => {
    expect(selectEngagedUnderwriteTargets([deal({ executionPath: "Manual Review" })], NOW)).toHaveLength(0);
    expect(selectEngagedUnderwriteTargets([deal({ executionPath: null })], NOW)).toHaveLength(0);
  });

  it("freshness dedupe: a record underwritten <14d ago is skipped", () => {
    expect(selectEngagedUnderwriteTargets([deal({ arvValidatedAt: "2026-07-10T00:00:00Z" })], NOW)).toHaveLength(0);
    expect(selectEngagedUnderwriteTargets([deal({ arvValidatedAt: "2026-06-01T00:00:00Z" })], NOW)).toHaveLength(1);
  });

  it("newest activity first (bounded runs do the hottest deals)", () => {
    const targets = selectEngagedUnderwriteTargets(
      [
        deal({ id: "recOLD", lastInboundAt: "2026-07-01T00:00:00Z" }),
        deal({ id: "recNEW", lastInboundAt: "2026-07-12T23:00:00Z" }),
      ],
      NOW,
    );
    expect(targets.map((t) => t.id)).toEqual(["recNEW", "recOLD"]);
  });
});
