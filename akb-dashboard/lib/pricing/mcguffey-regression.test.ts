import { describe, expect, it } from "vitest";
import { ownCompsArv } from "@/lib/pricing/own-comps-arv";
import { corroborateOpener } from "@/lib/opener-sanity-gate";
// The REAL 2849 Mcguffey comp payload shape: every entry stale-excluded.
const comps = JSON.stringify([
  {price:53000,sqft:2184,sale_date:"2025-05-21T00:00:00.000Z",excluded_reason:"older_than_365d",formatted_address:"1576 Filmore Ave"},
  {price:88900,sqft:988,sale_date:"2022-12-15T00:00:00.000Z",excluded_reason:"older_than_365d",formatted_address:"730 Liberty Rd"},
  {price:10000,sqft:1232,sale_date:"2018-05-02T00:00:00.000Z",excluded_reason:"older_than_365d",formatted_address:"2709 Mcguffey Rd"},
  {price:7300,sqft:1152,sale_date:"2008-09-11T00:00:00.000Z",excluded_reason:"older_than_365d",formatted_address:"2741 Mcguffey Rd"},
]);
describe("2849 Mcguffey Rd — the accepted offer that should never have fired", () => {
  it("own-comps yields zero usable from a non-empty comp set", () => {
    const own = ownCompsArv({ compsJson: comps, sqft: 1378, now: new Date("2026-08-20T00:00:00Z") });
    expect(own.parsedCompCount).toBe(4);
    expect(own.compCount).toBe(0);
  });
  it("the gate HOLDS the $45,250 opener", () => {
    const own = ownCompsArv({ compsJson: comps, sqft: 1378, now: new Date("2026-08-20T00:00:00Z") });
    const r = corroborateOpener({
      opener: 45250, listPrice: 66000, arvUsed: 120000, sqft: 1378,
      cappedToList: false, arvConfidence: "THIN",
      ownComps: { parsed: own.parsedCompCount, usable: own.compCount },
    });
    expect(r.corroborated).toBe(false);
    expect(r.flags).toContain("unverified_value_basis");
  });
});
