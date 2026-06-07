// @agent: outreach — L3 dollar-amount detection tests.
import { describe, it, expect } from "vitest";
import { detectL3DollarAmounts } from "./l3-amount-detector";

describe("detectL3DollarAmounts", () => {
  it("catches the 12724 Strathmoor live fixture: $70k Ali Fawaz counter (5/6/2026)", () => {
    const reply =
      "Hi Alex thanks for the text it's a bit low it's only been on the market for a few days. I can make $70k work for you tho I'm sure";
    const r = detectL3DollarAmounts(reply);
    expect(r.shouldEscalate).toBe(true);
    expect(r.amounts).toHaveLength(1);
    expect(r.amounts[0].amountUsd).toBe(70_000);
    expect(r.amounts[0].context).toContain("$70k");
  });

  it("catches the Waverly live fixture: 'won't take less than $100k'", () => {
    const reply = "Won't take less than $100k for that one. Pass.";
    const r = detectL3DollarAmounts(reply);
    expect(r.shouldEscalate).toBe(true);
    expect(r.amounts[0].amountUsd).toBe(100_000);
  });

  it("parses comma-formatted $70,000", () => {
    expect(detectL3DollarAmounts("I'll do $70,000 cash").amounts[0].amountUsd).toBe(70_000);
  });

  it("parses bare $70000 (no comma, no suffix)", () => {
    expect(detectL3DollarAmounts("Bring me $70000 and we have a deal").amounts[0].amountUsd).toBe(70_000);
  });

  it("parses $1.2M (million suffix)", () => {
    expect(detectL3DollarAmounts("$1.2M minimum").amounts[0].amountUsd).toBe(1_200_000);
  });

  it("does NOT fire on dollar-less small numerals ('I called 5 times')", () => {
    const r = detectL3DollarAmounts("I called 5 times already, lose my number");
    expect(r.shouldEscalate).toBe(false);
  });

  it("does NOT fire on empty/null replies", () => {
    expect(detectL3DollarAmounts(null).shouldEscalate).toBe(false);
    expect(detectL3DollarAmounts("").shouldEscalate).toBe(false);
    expect(detectL3DollarAmounts("   ").shouldEscalate).toBe(false);
  });

  it("deduplicates the same amount expressed multiple ways", () => {
    const r = detectL3DollarAmounts("I said $70k. Seventy thousand. $70,000. Same number.");
    // $70k + $70,000 dedupe to one entry.
    expect(r.amounts.map((a) => a.amountUsd)).toEqual([70_000]);
  });

  it("returns multiple distinct amounts when present (e.g. range mention)", () => {
    const r = detectL3DollarAmounts("Range is $60k to $75k.");
    expect(r.amounts.map((a) => a.amountUsd).sort((a, b) => a - b)).toEqual([60_000, 75_000]);
  });
});
