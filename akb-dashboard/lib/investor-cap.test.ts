// @agent: appraiser — investor-required cap (operative) tests.
import { describe, it, expect } from "vitest";
import { marketTierFor, investorCapBand, checkCapFloor, INVESTOR_CAP_CANDIDATES } from "./investor-cap";

describe("marketTierFor", () => {
  it("maps TN→memphis, TX→tx_metro, else default", () => {
    expect(marketTierFor("TN")).toBe("tn_memphis");
    expect(marketTierFor("TX")).toBe("tx_metro");
    expect(marketTierFor("AZ")).toBe("default");
    expect(marketTierFor(null)).toBe("default");
  });
});

describe("investorCapBand", () => {
  it("returns the conservative candidate band + highest as conservativeHigh", () => {
    const tx = investorCapBand("TX", "78228");
    expect(tx.tier).toBe("tx_metro");
    expect(tx.candidates).toEqual(INVESTOR_CAP_CANDIDATES.tx_metro);
    expect(tx.conservativeHigh).toBe(Math.max(...INVESTOR_CAP_CANDIDATES.tx_metro));
    expect(tx.source).toMatch(/PENDING/);
  });
  it("Memphis caps are higher (higher-yield/higher-risk) than TX", () => {
    expect(Math.max(...INVESTOR_CAP_CANDIDATES.tn_memphis)).toBeGreaterThan(
      Math.max(...INVESTOR_CAP_CANDIDATES.tx_metro),
    );
  });
});

describe("checkCapFloor", () => {
  it("passes when investor cap ≥ market-implied floor (conservative)", () => {
    expect(checkCapFloor(0.10, 0.074).ok).toBe(true);
    expect(checkCapFloor(0.074, 0.074).ok).toBe(true);
  });
  it("FLAGS when investor cap is below the market-implied floor (too aggressive)", () => {
    const r = checkCapFloor(0.05, 0.074);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/BELOW the market-implied floor/);
  });
  it("skips the check (ok) when no market floor available", () => {
    expect(checkCapFloor(0.10, null).ok).toBe(true);
  });
});
