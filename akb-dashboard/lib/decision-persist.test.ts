// crossedUnderwater — the post-vision park's crossing detector (pure).
import { describe, it, expect } from "vitest";
import { crossedUnderwater } from "./decision-persist";

describe("crossedUnderwater — fires once, exactly at the crossing", () => {
  it("no prior spread (first compute) → negative fires", () => {
    expect(crossedUnderwater(null, -14_608, true)).toBe(true);
    expect(crossedUnderwater(undefined, -1, true)).toBe(true);
  });
  it("positive → negative fires (the vision pass revealed the gut job)", () => {
    expect(crossedUnderwater(3_500, -14_608, true)).toBe(true);
  });
  it("already underwater → does NOT re-fire (no card spam on recomputes)", () => {
    expect(crossedUnderwater(-14_608, -15_200, true)).toBe(false);
  });
  it("still positive / recovered / null new spread → never fires", () => {
    expect(crossedUnderwater(3_500, 2_000, true)).toBe(false);
    expect(crossedUnderwater(-5_000, 4_000, true)).toBe(false);
    expect(crossedUnderwater(3_500, null, true)).toBe(false);
  });
  it("no opener sent → never fires (nothing is riding the number yet)", () => {
    expect(crossedUnderwater(null, -14_608, false)).toBe(false);
  });
});
