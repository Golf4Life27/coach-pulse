// Ship 2 — ATTOM adapter pure-mapper tests.

import { describe, it, expect } from "vitest";
import {
  buildSnapshotUrl,
  mapSnapshotToCandidate,
  mapSnapshotResponse,
} from "./attom";

describe("buildSnapshotUrl", () => {
  it("targets /property/snapshot with postalcode", () => {
    const url = buildSnapshotUrl("78201");
    expect(url).toContain("api.gateway.attomdata.com/propertyapi/v1.0.0/property/snapshot");
    expect(url).toContain("postalcode=78201");
  });
});

describe("mapSnapshotToCandidate", () => {
  const raw = {
    identifier: { attomId: 12345 },
    address: { line1: "123 Main St", locality: "San Antonio", countrySubd: "TX", postal1: "78201" },
    summary: { proptype: "SFR", propsubtype: "Single Family Residence", yearbuilt: 1960 },
    building: { rooms: { beds: 3 }, size: { livingsize: 1400 } },
    sale: { amount: { saleamt: 90000 }, salesearchdate: "2024-01-01" },
  };

  it("maps address + type + beds from documented snapshot paths", () => {
    const c = mapSnapshotToCandidate(raw);
    expect(c.sourceId).toBe("attom:12345");
    expect(c.address).toBe("123 Main St");
    expect(c.city).toBe("San Antonio");
    expect(c.state).toBe("TX");
    expect(c.zip).toBe("78201");
    expect(c.propertyType).toBe("Single Family Residence");
    expect(c.beds).toBe(3);
  });

  it("resolves listPrice + listedDate to null (snapshot endpoint blocker)", () => {
    const c = mapSnapshotToCandidate(raw);
    expect(c.listPrice).toBeNull();
    expect(c.listedDate).toBeNull();
  });

  it("defaults hasDistressSignal false (events package not wired)", () => {
    expect(mapSnapshotToCandidate(raw).hasDistressSignal).toBe(false);
  });

  it("degrades gracefully on a sparse/empty property object", () => {
    const c = mapSnapshotToCandidate({});
    expect(c.address).toBeNull();
    expect(c.beds).toBeNull();
    expect(c.sourceId).toContain("attom:");
  });

  it("falls back to Id then address for sourceId", () => {
    expect(mapSnapshotToCandidate({ identifier: { Id: 99 } }).sourceId).toBe("attom:99");
    expect(
      mapSnapshotToCandidate({ address: { line1: "5 Oak", postal1: "78205" } }).sourceId,
    ).toBe("attom:5 Oak:78205");
  });
});

describe("mapSnapshotResponse", () => {
  it("maps a property array", () => {
    const out = mapSnapshotResponse({
      status: { code: 0, total: 2 },
      property: [{ identifier: { attomId: 1 } }, { identifier: { attomId: 2 } }],
    });
    expect(out).toHaveLength(2);
  });
  it("returns [] when property array absent", () => {
    expect(mapSnapshotResponse({})).toEqual([]);
    expect(mapSnapshotResponse({ status: { code: 1, msg: "no results" } })).toEqual([]);
  });
});
