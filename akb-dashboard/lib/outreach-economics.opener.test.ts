import { describe, it, expect } from "vitest";
import { openerMaoGuard, resolveOpenerCeiling, MIN_OPENER_USD } from "./outreach-economics";

describe("openerMaoGuard", () => {
  it("unpriceable market → passes the opener through untouched (guard does not run)", () => {
    const g = openerMaoGuard({ baseOpener: 162_500, mao: null, priceable: false });
    expect(g.ok).toBe(true);
    expect(g.opener).toBe(162_500);
    expect(g.capped).toBe(false);
    expect(g.reason).toBeNull();
  });

  it("priceable + opener ≤ MAO → no change", () => {
    const g = openerMaoGuard({ baseOpener: 90_000, mao: 130_000, priceable: true });
    expect(g.ok).toBe(true);
    expect(g.opener).toBe(90_000);
    expect(g.capped).toBe(false);
  });

  it("priceable + opener > MAO → caps DOWN to the nearest $250 ≤ MAO", () => {
    // list ≈ ARV case: 65%-of-$250k = $162,500 opener vs MAO $130,100
    const g = openerMaoGuard({ baseOpener: 162_500, mao: 130_100, priceable: true });
    expect(g.ok).toBe(true);
    expect(g.capped).toBe(true);
    expect(g.opener).toBe(130_000); // floor to 250, never exceeds MAO
    expect(g.opener! <= 130_100).toBe(true);
    expect(g.reason).toMatch(/capped/);
  });

  it("priceable + MAO unknown → skip + flag (don't send blind where we can price)", () => {
    const g = openerMaoGuard({ baseOpener: 100_000, mao: null, priceable: true });
    expect(g.ok).toBe(false);
    expect(g.opener).toBeNull();
    // Distinct error — distinguishes "lead was never underwritten" from the
    // misleading "needs ARV + rehab" silent-fallback masquerade that caused
    // the 2026-06-09 48227 dry-run-zero incident.
    expect(g.reason).toMatch(/mao_not_underwritten/);
  });

  it("priceable + opener > MAO but capped value below the $5K floor → skip + flag", () => {
    const g = openerMaoGuard({ baseOpener: 100_000, mao: 4_000, priceable: true });
    expect(g.ok).toBe(false);
    expect(g.opener).toBeNull();
    expect(g.reason).toMatch(new RegExp(`min \\$${MIN_OPENER_USD.toLocaleString()}`));
  });
});

describe("resolveOpenerCeiling", () => {
  it("San Antonio (78201, no sourced buy-box) → unpriceable, mao null", () => {
    const c = resolveOpenerCeiling({ state: "TX", zip: "78201", realArvMedian: 265_000, estRehab: 54_000, listPrice: 250_000 });
    expect(c.priceable).toBe(false);
    expect(c.mao).toBeNull();
  });

  it("Detroit (48227, sourced 0.6461) → priceable, mao = ARV×0.6461 − rehab − fee", () => {
    // 200,000 × 0.6461 − 30,000 − 5,000 = 129,220 − 35,000 = 94,220
    const c = resolveOpenerCeiling({ state: "MI", zip: "48227", realArvMedian: 200_000, estRehab: 30_000, listPrice: 175_000 });
    expect(c.priceable).toBe(true);
    expect(c.mao).toBe(94_220);
  });

  it("Detroit priceable but ARV missing AND no underwritten MAO → null (NOT a silent fallback)", () => {
    // Silent fallback to flipper deal-math was the 2026-06-09 incident — when
    // there is no persisted Underwritten_MAO and no ZIP-store context, the
    // resolver returns null AND the guard surfaces mao_not_underwritten, NOT
    // the misleading "needs ARV + rehab" error.
    const c = resolveOpenerCeiling({ state: "MI", zip: "48227", realArvMedian: null, estRehab: 30_000, listPrice: 175_000 });
    expect(c.priceable).toBe(true);
    expect(c.mao).toBeNull();
  });

  it("priority (1): persisted underwrittenMao wins over every other path", () => {
    // The intake station wrote $50,000. Even with no ZIP store context and no
    // ARV/rehab, the send-time resolver reads the persisted ceiling.
    const c = resolveOpenerCeiling({
      state: "MI",
      zip: "48227",
      underwrittenMao: 50_000,
      realArvMedian: null,
      estRehab: null,
      listPrice: 79_900,
    });
    expect(c.priceable).toBe(true);
    expect(c.mao).toBe(50_000);
  });

  it("persisted underwrittenMao wins even when ARV + rehab are also present", () => {
    // The station's number is the operative ceiling — ARV-driven evaluateDeal
    // is the FALLBACK, not the override. The underwrite station decides.
    const c = resolveOpenerCeiling({
      state: "MI",
      zip: "48227",
      underwrittenMao: 50_000,
      realArvMedian: 200_000,
      estRehab: 30_000,
      listPrice: 175_000,
    });
    expect(c.mao).toBe(50_000); // station wins, not the $94,220 deal-math number
  });

  it("contractOfferPrice is NOT read — V2.1-reserved for DD-time contract number", () => {
    // The resolver type doesn't even accept contractOfferPrice. Persisting an
    // MAO ceiling into contractOfferPrice is the bug this fix prevents.
    const c = resolveOpenerCeiling({ state: "MI", zip: "48227", realArvMedian: null, estRehab: null });
    expect(c.mao).toBeNull();
  });
});
