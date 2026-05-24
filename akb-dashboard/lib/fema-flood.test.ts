// INV-022 Sprint 2 — FEMA NFHL + geocode pure helper tests.

import { describe, it, expect } from "vitest";
import {
  buildNfhlQueryUrl,
  parseNfhlZone,
  shouldPullFlood,
  buildGeocodeUrl,
  parseGeocode,
} from "./fema-flood";

describe("buildNfhlQueryUrl", () => {
  it("encodes point as lng,lat with WGS84 + intersect params", () => {
    const url = buildNfhlQueryUrl({ lat: 35.0, lng: -90.0 });
    expect(url).toContain("hazards.fema.gov");
    expect(url).toContain("geometry=-90%2C35"); // lng,lat
    expect(url).toContain("inSR=4326");
    expect(url).toContain("esriSpatialRelIntersects");
    expect(url).toContain("FLD_ZONE");
    expect(url).toContain("returnGeometry=false");
  });
});

describe("parseNfhlZone", () => {
  it("returns the FLD_ZONE of the intersecting polygon", () => {
    expect(
      parseNfhlZone({ features: [{ attributes: { FLD_ZONE: "AE" } }] }),
    ).toBe("AE");
  });
  it("empty features → X (outside mapped SFHA)", () => {
    expect(parseNfhlZone({ features: [] })).toBe("X");
  });
  it("blank FLD_ZONE → X", () => {
    expect(parseNfhlZone({ features: [{ attributes: { FLD_ZONE: "  " } }] })).toBe("X");
  });
  it("missing features array → null (error/unknown, NOT a real X answer)", () => {
    expect(parseNfhlZone({})).toBe(null);
    expect(parseNfhlZone(null)).toBe(null);
    expect(parseNfhlZone("oops")).toBe(null);
  });
});

describe("shouldPullFlood", () => {
  it("pulls when zone empty/null (never hydrated)", () => {
    expect(shouldPullFlood(null)).toBe(true);
    expect(shouldPullFlood(undefined)).toBe(true);
    expect(shouldPullFlood("")).toBe(true);
    expect(shouldPullFlood("   ")).toBe(true);
  });
  it("skips when already populated (static-per-parcel cache)", () => {
    expect(shouldPullFlood("X")).toBe(false);
    expect(shouldPullFlood("AE")).toBe(false);
  });
});

describe("buildGeocodeUrl", () => {
  it("builds a Google geocode URL with address + key", () => {
    const url = buildGeocodeUrl("23 Fields Ave, Memphis, TN 38109", "KEY123");
    expect(url).toContain("maps.googleapis.com/maps/api/geocode/json");
    expect(url).toContain("address=23+Fields+Ave");
    expect(url).toContain("key=KEY123");
  });
});

describe("parseGeocode", () => {
  it("extracts lat/lng from an OK response", () => {
    const out = parseGeocode({
      status: "OK",
      results: [{ geometry: { location: { lat: 35.07, lng: -90.05 } } }],
    });
    expect(out).toEqual({ lat: 35.07, lng: -90.05 });
  });
  it("ZERO_RESULTS → null", () => {
    expect(parseGeocode({ status: "ZERO_RESULTS", results: [] })).toBe(null);
  });
  it("malformed → null", () => {
    expect(parseGeocode(null)).toBe(null);
    expect(parseGeocode({ status: "OK", results: [{}] })).toBe(null);
  });
});
