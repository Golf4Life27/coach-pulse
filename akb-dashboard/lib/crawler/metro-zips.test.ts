import { describe, it, expect } from "vitest";
import { METRO_ZIPS, ALL_CIRCUIT_ZIPS, buildCircuitRows, type RegistryZipInput } from "./metro-zips";

describe("buildCircuitRows — discovery circuit registry (2026-09-17)", () => {
  it("with no registry rows, returns exactly METRO_ZIPS flattened", () => {
    const rows = buildCircuitRows([]);
    expect(rows.map((r) => r.zip).sort()).toEqual([...ALL_CIRCUIT_ZIPS].sort());
  });

  it("unions a new registry ZIP in, tagged with its market as metro", () => {
    const registry: RegistryZipInput[] = [{ zip: "90210", state: "CA", market: "Los Angeles" }];
    const rows = buildCircuitRows(registry);
    expect(rows.some((r) => r.zip === "90210" && r.metro === "Los Angeles")).toBe(true);
    expect(rows.length).toBe(ALL_CIRCUIT_ZIPS.length + 1);
  });

  it("falls back to state as the metro label when a registry row has no market", () => {
    const registry: RegistryZipInput[] = [{ zip: "90210", state: "CA", market: null }];
    const rows = buildCircuitRows(registry);
    expect(rows.find((r) => r.zip === "90210")?.metro).toBe("CA");
  });

  it("de-dupes by ZIP: a registry row for a ZIP already on METRO_ZIPS never overrides its metro", () => {
    const existingZip = METRO_ZIPS[0].zips[0];
    const registry: RegistryZipInput[] = [
      { zip: existingZip, state: "ZZ", market: "Somewhere Else" },
    ];
    const rows = buildCircuitRows(registry);
    expect(rows.length).toBe(ALL_CIRCUIT_ZIPS.length);
    expect(rows.find((r) => r.zip === existingZip)?.metro).toBe(METRO_ZIPS[0].metro);
  });

  it("excludes a TX registry ZIP when list-anchor mode is OFF (default)", () => {
    const registry: RegistryZipInput[] = [{ zip: "78201", state: "TX", market: "San Antonio" }];
    const rows = buildCircuitRows(registry, { listAnchorModeActive: false });
    expect(rows.some((r) => r.zip === "78201")).toBe(false);
  });

  it("includes a TX registry ZIP when list-anchor mode is ON", () => {
    const registry: RegistryZipInput[] = [{ zip: "78201", state: "TX", market: "San Antonio" }];
    const rows = buildCircuitRows(registry, { listAnchorModeActive: true });
    expect(rows.some((r) => r.zip === "78201" && r.metro === "San Antonio")).toBe(true);
  });

  it("skips a malformed ZIP from the registry", () => {
    const registry: RegistryZipInput[] = [{ zip: "not-a-zip", state: "OH", market: "Columbus" }];
    const rows = buildCircuitRows(registry);
    expect(rows.length).toBe(ALL_CIRCUIT_ZIPS.length);
  });
});
