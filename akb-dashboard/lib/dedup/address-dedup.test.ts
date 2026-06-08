import { describe, it, expect } from "vitest";
import { analyzeAddressDedup, summarizeDedup, type DedupListing } from "./address-dedup";
import { SOURCE_VERSION_V2 } from "@/lib/source-version";

function mk(over: Partial<DedupListing>): DedupListing {
  return {
    id: "rec" + Math.random().toString(36).slice(2, 10),
    address: "100 Main St",
    sourceVersion: SOURCE_VERSION_V2,
    pipelineStage: "outreach_ready",
    outreachStatus: null,
    liveStatus: "Active",
    doNotText: false,
    ...over,
  };
}

describe("analyzeAddressDedup", () => {
  it("returns nothing when every address is unique", () => {
    const g = analyzeAddressDedup([
      mk({ address: "100 Main St" }),
      mk({ address: "200 Oak Ave" }),
    ]);
    expect(g).toHaveLength(0);
  });

  it("groups normalized-equal addresses (punctuation/case/space insensitive)", () => {
    const g = analyzeAddressDedup([
      mk({ id: "a", address: "346 Modder Ave" }),
      mk({ id: "b", address: "346 modder ave." }),
    ]);
    expect(g).toHaveLength(1);
    expect(g[0].records.map((r) => r.id).sort()).toEqual(["a", "b"]);
  });

  it("flags the 346 Modder shape: v1 legacy + v2, double-contact risk", () => {
    const g = analyzeAddressDedup([
      mk({ id: "v2", address: "346 Modder Ave", sourceVersion: SOURCE_VERSION_V2, pipelineStage: "responded" }),
      mk({ id: "v1", address: "346 Modder Ave", sourceVersion: "v1_legacy", pipelineStage: "outreach_ready" }),
    ]);
    expect(g).toHaveLength(1);
    expect(g[0].crossVersion).toBe(true);
    expect(g[0].doubleContactRisk).toBe(true);
    expect(g[0].contactableIds.sort()).toEqual(["v1", "v2"]);
  });

  it("clears double-contact risk once the legacy dupe is dead / Do_Not_Text", () => {
    const g = analyzeAddressDedup([
      mk({ id: "v2", sourceVersion: SOURCE_VERSION_V2, pipelineStage: "responded" }),
      mk({ id: "v1", sourceVersion: "v1_legacy", pipelineStage: "dead" }),
    ]);
    expect(g[0].crossVersion).toBe(true);
    expect(g[0].doubleContactRisk).toBe(false); // dead dupe can't double-contact
    expect(g[0].contactableIds).toEqual(["v2"]);
  });

  it("treats Do_Not_Text and non-Active live status as non-contactable", () => {
    const g = analyzeAddressDedup([
      mk({ id: "a", doNotText: true }),
      mk({ id: "b", liveStatus: "Off Market" }),
      mk({ id: "c" }),
    ]);
    expect(g[0].doubleContactRisk).toBe(false); // only c is contactable
    expect(g[0].contactableIds).toEqual(["c"]);
  });

  it("skips blank addresses entirely", () => {
    const g = analyzeAddressDedup([mk({ address: null }), mk({ address: "" })]);
    expect(g).toHaveLength(0);
  });

  it("sorts double-contact groups ahead of benign collisions", () => {
    const g = analyzeAddressDedup([
      // benign: same address, both dead
      mk({ id: "x1", address: "5 Pine St", pipelineStage: "dead" }),
      mk({ id: "x2", address: "5 Pine St", pipelineStage: "dead" }),
      // risky: two contactable
      mk({ id: "y1", address: "9 Elm St", pipelineStage: "outreach_ready" }),
      mk({ id: "y2", address: "9 Elm St", pipelineStage: "verified" }),
    ]);
    expect(g[0].doubleContactRisk).toBe(true);
    expect(g[0].sampleAddress).toBe("9 Elm St");
  });
});

describe("summarizeDedup", () => {
  it("counts collisions, cross-version, and double-contact groups", () => {
    const listings = [
      mk({ id: "v2", address: "346 Modder Ave", sourceVersion: SOURCE_VERSION_V2 }),
      mk({ id: "v1", address: "346 Modder Ave", sourceVersion: "v1_legacy" }),
      mk({ id: "u", address: "1 Unique Way" }),
    ];
    const groups = analyzeAddressDedup(listings);
    const s = summarizeDedup(listings, groups);
    expect(s.total_listings).toBe(3);
    expect(s.collision_groups).toBe(1);
    expect(s.cross_version_groups).toBe(1);
    expect(s.double_contact_groups).toBe(1);
    expect(s.records_in_collisions).toBe(2);
  });
});
