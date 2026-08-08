import { describe, it, expect } from "vitest";
import { extractScopeTier, scopeReprice } from "./scope-intel";

describe("extractScopeTier — agent condition language → BBC tier", () => {
  it("the operator's own W 106th read: 'light/medium' resolves to the HEAVIER tier", () => {
    expect(extractScopeTier("looks like a light/medium rehab")!.tier).toBe("Medium");
    expect(extractScopeTier("light to medium scope")!.tier).toBe("Medium");
  });

  it("the Indianapolis reply (2026-08-06, unprompted): good news reads Cosmetic", () => {
    const s = extractScopeTier(
      "brand new roof on both the garage and home itself, fully finished basement with updated mechanicals throughout",
    )!;
    expect(s.tier).toBe("Cosmetic");
  });

  it("needs-a-roof is Heavy; a NEW roof is not", () => {
    expect(extractScopeTier("it needs a new roof and furnace")!.tier).toBe("Heavy");
    expect(extractScopeTier("brand new roof last year")!.tier).toBe("Cosmetic");
  });

  it("heaviest signal wins when several fire", () => {
    // "cosmetic" + "gut" in one sentence → Gut (pessimistic).
    expect(extractScopeTier("front half is cosmetic but the back is a gut job")!.tier).toBe("Gut");
  });

  it("negated heavy signals are discarded, not flipped", () => {
    const s = extractScopeTier("solid house, does not need major work, just paint and carpet");
    expect(s!.tier).toBe("Light"); // paint-and-carpet stands; negated "major work" is dropped
  });

  it("silence yields null — never a guessed tier", () => {
    expect(extractScopeTier("The seller would not consider an offer anywhere near that range.")).toBeNull();
    expect(extractScopeTier("")).toBeNull();
    expect(extractScopeTier(null)).toBeNull();
  });
});

describe("scopeReprice — only the rehab term moves", () => {
  // 2175 W 106th: 1,258 sqft OH, stored rehab $41,514. Suppose the underwritten
  // MAO was $49,000 at that stored rehab. Agent scope Medium at OH multiplier.
  const signal = { tier: "Medium" as const, phrase: "light/medium" };

  it("re-prices the ceiling as mao + storedRehab − scopeRehab", () => {
    const r = scopeReprice({ signal, sqft: 1_258, state: "OH", storedRehab: 41_514, mao: 49_000 });
    expect(r.scopeRehab).not.toBeNull();
    expect(r.ceiling).toBe(49_000 + 41_514 - r.scopeRehab!);
    expect(r.delta).toBe(r.ceiling! - 49_000);
  });

  it("fails to nulls without sqft / mao / stored rehab — the alert just omits the line", () => {
    expect(scopeReprice({ signal, sqft: null, state: "OH", storedRehab: 41_514, mao: 49_000 }).ceiling).toBeNull();
    expect(scopeReprice({ signal, sqft: 1_258, state: "OH", storedRehab: null, mao: 49_000 }).ceiling).toBeNull();
    expect(scopeReprice({ signal, sqft: 1_258, state: "OH", storedRehab: 41_514, mao: null }).ceiling).toBeNull();
  });

  it("a LIGHTER stated scope raises the ceiling; a heavier one lowers it", () => {
    const lighter = scopeReprice({
      signal: { tier: "Light", phrase: "light rehab" },
      sqft: 1_258, state: "OH", storedRehab: 41_514, mao: 49_000,
    });
    const heavier = scopeReprice({
      signal: { tier: "Gut", phrase: "gut" },
      sqft: 1_258, state: "OH", storedRehab: 41_514, mao: 49_000,
    });
    expect(lighter.ceiling!).toBeGreaterThan(49_000);
    expect(heavier.ceiling!).toBeLessThan(49_000);
  });
});
