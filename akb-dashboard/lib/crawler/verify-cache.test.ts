import { describe, it, expect } from "vitest";
import { verifyCacheKey } from "./verify-cache";

describe("verifyCacheKey", () => {
  it("normalizes punctuation/case/space so address variants share one slot", () => {
    const a = verifyCacheKey("346 Modder Ave.");
    const b = verifyCacheKey("346 modder ave");
    expect(a).toBe(b);
    expect(a).toContain("intake:vfy:");
  });

  it("returns null for a blank address (uncacheable)", () => {
    expect(verifyCacheKey(null)).toBeNull();
    expect(verifyCacheKey("")).toBeNull();
    expect(verifyCacheKey("   ")).toBeNull();
  });

  it("url-encodes the normalized key (safe for the KV path)", () => {
    const k = verifyCacheKey("346 Modder Ave");
    expect(k).not.toContain(" ");
  });
});
