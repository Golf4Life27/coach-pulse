import { describe, it, expect } from "vitest";
import { AUTO_CLOSE_TEMPLATE, isNumberFreeBody, autoCloseClaimKey } from "./auto-close";

describe("Tier 0 auto-close hard guards (pure)", () => {
  it("the approved template is number-free and price-free", () => {
    expect(isNumberFreeBody(AUTO_CLOSE_TEMPLATE)).toBe(true);
    expect(AUTO_CLOSE_TEMPLATE).not.toContain("$");
  });

  it("the assertion REFUSES any body carrying a $ or a 2+ digit run", () => {
    expect(isNumberFreeBody("we can do $50,000")).toBe(false);
    expect(isNumberFreeBody("our offer was 48750")).toBe(false);
    expect(isNumberFreeBody("call me at 3135551234")).toBe(false);
    expect(isNumberFreeBody("see you in 30 minutes")).toBe(false);
    expect(isNumberFreeBody("")).toBe(false);
  });

  it("a single digit passes (the guard targets prices/phones, not '1 question')", () => {
    expect(isNumberFreeBody("1 quick thing before you go")).toBe(true);
  });

  it("claim key is per-record (max one close per thread ever)", () => {
    expect(autoCloseClaimKey("recABC")).toBe("auto_close:recABC");
    expect(autoCloseClaimKey("recABC")).toBe(autoCloseClaimKey("recABC"));
    expect(autoCloseClaimKey("recXYZ")).not.toBe(autoCloseClaimKey("recABC"));
  });
});
