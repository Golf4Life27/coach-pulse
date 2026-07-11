import { describe, it, expect } from "vitest";
import { filterForwardInventory, forwardInventorySplit } from "./forward-inventory";
import { SOURCE_VERSION_V2, SOURCE_VERSION_V1_LEGACY } from "./source-version";

const rows = [
  { id: "a", sourceVersion: SOURCE_VERSION_V2 },
  { id: "b", sourceVersion: SOURCE_VERSION_V1_LEGACY },
  { id: "c", sourceVersion: null },
  { id: "d", sourceVersion: SOURCE_VERSION_V2 },
];

describe("filterForwardInventory", () => {
  it("keeps only current-era rows — legacy AND unversioned rows are ghosts", () => {
    expect(filterForwardInventory(rows).map((r) => r.id)).toEqual(["a", "d"]);
  });
});

describe("forwardInventorySplit", () => {
  it("reports how many ghost rows the gauge dropped", () => {
    const { forward, legacyDropped } = forwardInventorySplit(rows);
    expect(forward).toHaveLength(2);
    expect(legacyDropped).toBe(2);
  });
});
