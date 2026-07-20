// Routing tests for the ONE sold-comp faucet: county → ATTOM → RentCast,
// honest zeros FINAL at every step, fallbacks on thrown errors only.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/rentcast", () => ({ getSaleComparables: vi.fn() }));
vi.mock("@/lib/comps/county-deeds", () => ({
  countyDeedSourceFor: vi.fn(),
  getCountyDeedComps: vi.fn(),
  censusGeocode: vi.fn(),
}));
vi.mock("@/lib/comps/attom-sales", () => ({ getAttomSaleComps: vi.fn() }));
vi.mock("@/lib/audit-log", () => ({ audit: vi.fn(async () => {}) }));

import { getSaleComparables, type RentCastSaleComp } from "@/lib/rentcast";
import { countyDeedSourceFor, getCountyDeedComps, censusGeocode } from "@/lib/comps/county-deeds";
import { getAttomSaleComps } from "@/lib/comps/attom-sales";
import { audit } from "@/lib/audit-log";
import { getSoldComps } from "./sold-comps";

const mockSourceFor = vi.mocked(countyDeedSourceFor);
const mockCounty = vi.mocked(getCountyDeedComps);
const mockGeocode = vi.mocked(censusGeocode);
const mockAttom = vi.mocked(getAttomSaleComps);
const mockRentCast = vi.mocked(getSaleComparables);
const mockAudit = vi.mocked(audit);

const DETROIT_SOURCE = {
  market: "detroit",
  cities: ["detroit"],
  state: "MI",
  kind: "detroit_assessor" as const,
  promoted: true,
  salesUrl: "https://example.test/sales",
  parcelsUrl: "https://example.test/parcels",
  salesWhere: "1=1",
};

function comp(price: number): RentCastSaleComp {
  return {
    price,
    squareFootage: 1_000,
    bedrooms: null,
    bathrooms: null,
    yearBuilt: 1940,
    distance: 0.2,
    daysOnMarket: null,
    removedDate: null,
    saleDate: "2026-06-01T00:00:00.000Z",
    formattedAddress: "1 TEST ST",
  };
}

const DETROIT = { address: "7714 E Canfield St", city: "Detroit", state: "MI", zip: "48214" };
const ATLANTA = { address: "1122 West Ave SW", city: "Atlanta", state: "GA", zip: "30315" };

beforeEach(() => {
  vi.clearAllMocks();
  mockGeocode.mockResolvedValue({ lat: 33.72, lng: -84.4 });
});

describe("getSoldComps — registry markets (county first)", () => {
  beforeEach(() => mockSourceFor.mockReturnValue(DETROIT_SOURCE));

  it("county comps are the answer; ATTOM and RentCast never called", async () => {
    mockCounty.mockResolvedValue([comp(80_000)]);
    const out = await getSoldComps(DETROIT, "recX");
    expect(out).toEqual([comp(80_000)]);
    expect(mockAttom).not.toHaveBeenCalled();
    expect(mockRentCast).not.toHaveBeenCalled();
  });

  it("an honest county zero is FINAL — no source gets to paper over it", async () => {
    mockCounty.mockResolvedValue([]);
    const out = await getSoldComps(DETROIT);
    expect(out).toEqual([]);
    expect(mockAttom).not.toHaveBeenCalled();
    expect(mockRentCast).not.toHaveBeenCalled();
  });

  it("county INFRA failure falls back to ATTOM (ahead of RentCast), audited", async () => {
    mockCounty.mockRejectedValue(new Error("ArcGIS 500"));
    mockAttom.mockResolvedValue([comp(95_000)]);
    const out = await getSoldComps(DETROIT, "recX");
    expect(out).toEqual([comp(95_000)]);
    expect(mockRentCast).not.toHaveBeenCalled();
    const events = mockAudit.mock.calls.map(([e]) => `${e.event}:${e.status}`);
    expect(events).toContain("county_deed_comp_pull:confirmed_failure");
    expect(events).toContain("attom_comp_pull:confirmed_success");
    const countyFail = mockAudit.mock.calls.find(([e]) => e.event === "county_deed_comp_pull")![0];
    expect(countyFail.outputSummary).toMatchObject({ fallback: "attom_sale_snapshot" });
  });

  it("full ladder: county fail → ATTOM fail → RentCast last resort, every rung audited", async () => {
    mockCounty.mockRejectedValue(new Error("ArcGIS 500"));
    mockAttom.mockRejectedValue(new Error("ATTOM sale/snapshot 503: outage"));
    mockRentCast.mockResolvedValue([comp(70_000)]);
    const out = await getSoldComps(DETROIT, "recL");
    expect(out).toEqual([comp(70_000)]);
    expect(mockRentCast).toHaveBeenCalledWith(DETROIT, "recL", undefined);
    const events = mockAudit.mock.calls.map(([e]) => `${e.event}:${e.status}`);
    expect(events).toContain("county_deed_comp_pull:confirmed_failure");
    expect(events).toContain("attom_comp_pull:confirmed_failure");
    const attomFail = mockAudit.mock.calls.find(
      ([e]) => e.event === "attom_comp_pull" && e.status === "confirmed_failure",
    )![0];
    expect(attomFail.outputSummary).toMatchObject({ fallback: "rentcast_property_records" });
  });
});

describe("getSoldComps — non-registry markets (ATTOM primary)", () => {
  beforeEach(() => mockSourceFor.mockReturnValue(null));

  it("ATTOM is primary; RentCast never called on success", async () => {
    mockAttom.mockResolvedValue([comp(214_900)]);
    const out = await getSoldComps(ATLANTA, "recY");
    expect(out).toEqual([comp(214_900)]);
    expect(mockCounty).not.toHaveBeenCalled();
    expect(mockRentCast).not.toHaveBeenCalled();
    expect(mockAttom).toHaveBeenCalledWith(33.72, -84.4, expect.objectContaining({ recordId: "recY" }));
  });

  it("an honest ATTOM zero is FINAL — never a RentCast trigger", async () => {
    mockAttom.mockResolvedValue([]);
    const out = await getSoldComps(ATLANTA);
    expect(out).toEqual([]);
    expect(mockRentCast).not.toHaveBeenCalled();
  });

  it("a thrown ATTOM error (entitlement/network) reaches RentCast last resort, audited", async () => {
    mockAttom.mockRejectedValue(new Error("ATTOM sale/snapshot 401: entitlement"));
    mockRentCast.mockResolvedValue([comp(60_000)]);
    const widen = { daysOld: 365 };
    const out = await getSoldComps(ATLANTA, "recZ", widen);
    expect(out).toEqual([comp(60_000)]);
    expect(mockRentCast).toHaveBeenCalledWith(ATLANTA, "recZ", widen);
    const fail = mockAudit.mock.calls.find(
      ([e]) => e.event === "attom_comp_pull" && e.status === "confirmed_failure",
    )![0];
    expect(fail.outputSummary).toMatchObject({ fallback: "rentcast_property_records" });
    expect(fail.error).toContain("401");
  });

  it("subject not geocodable → ATTOM leg cannot run → RentCast, audited", async () => {
    mockGeocode.mockResolvedValue(null);
    mockRentCast.mockResolvedValue([comp(50_000)]);
    const out = await getSoldComps(ATLANTA);
    expect(out).toEqual([comp(50_000)]);
    expect(mockAttom).not.toHaveBeenCalled();
    const fail = mockAudit.mock.calls.find(
      ([e]) => e.event === "attom_comp_pull" && e.status === "confirmed_failure",
    )![0];
    expect(fail.error).toContain("not geocodable");
  });

  it("widen maps onto the ATTOM pull: maxRadius → radiusMiles, daysOld → sinceIsoDate", async () => {
    mockAttom.mockResolvedValue([]);
    const before = new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10);
    await getSoldComps(ATLANTA, undefined, { daysOld: 365, maxRadius: 2 });
    const after = new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10);
    const opts = mockAttom.mock.calls[0][2]!;
    expect(opts.radiusMiles).toBe(2);
    expect([before, after]).toContain(opts.sinceIsoDate);
  });
});
