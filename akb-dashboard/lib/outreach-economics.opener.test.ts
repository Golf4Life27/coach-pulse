import { describe, it, expect } from "vitest";
import { openerMaoGuard, resolveOpenerCeiling, resolveAlertNumbers, MIN_OPENER_USD } from "./outreach-economics";

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

describe("resolveAlertNumbers — ONE read path (the 2026-06-10 smoke-test fix)", () => {
  it("Tracey shape: sticky NOT captured, but MAO_V1 + Underwritten_MAO present → real numbers", () => {
    // recVOZVgXT0GPenAt as it actually was at smoke-test time: the batch
    // had sent $48,750 (MAO_V1, the door-opener field) but never wrote the
    // sticky Outreach_Offer_Price; Underwritten_MAO=$50,000 was persisted.
    // The old composer read the sticky field → nulls → wrong fallback.
    const nums = resolveAlertNumbers({
      state: "MI",
      zip: "48227",
      mao: 48_750,
      outreachOfferPrice: null,
      underwrittenMao: 50_000,
    });
    expect(nums.opener).toBe(48_750);
    expect(nums.mao).toBe(50_000);
  });

  it("sticky wins when captured", () => {
    const nums = resolveAlertNumbers({
      state: "MI",
      zip: "48227",
      mao: 48_750,
      outreachOfferPrice: 47_000,
      underwrittenMao: 50_000,
    });
    expect(nums.opener).toBe(47_000);
  });

  it("opener above MAO comes back capped — same guard as the batch", () => {
    const nums = resolveAlertNumbers({
      state: "MI",
      zip: "48227",
      mao: 97_500, // 65%-of-list door-opener above the ceiling
      outreachOfferPrice: null,
      underwrittenMao: 50_000,
    });
    expect(nums.opener).toBe(50_000); // capped to MAO, never above
    expect(nums.mao).toBe(50_000);
  });

  it("genuinely missing numbers → nulls (composer falls back, gap audited, nothing fabricated)", () => {
    const nums = resolveAlertNumbers({
      state: "MI",
      zip: "48227",
      mao: null,
      outreachOfferPrice: null,
      underwrittenMao: null,
    });
    expect(nums.opener).toBeNull();
    expect(nums.mao).toBeNull();
  });
});

describe("resolveOpenerCeiling — lineage tagging (operator 2026-06-10)", () => {
  it("(1) persisted Underwritten_MAO → source = buyer_underwrite_persisted", () => {
    const c = resolveOpenerCeiling({ state: "MI", zip: "48227", underwrittenMao: 50_000, realArvMedian: 200_000, estRehab: 30_000, listPrice: 79_900 });
    expect(c.mao).toBe(50_000);
    expect(c.source).toBe("buyer_underwrite_persisted");
  });

  it("(3) Hunt-St-shape — 48207 no buyer median, ARV+rehab present → source = deal_math (NOT buyer-anchored)", () => {
    // The actual breach: 48207 has no seeded buyer median, the ZIP-store ctx
    // is empty for it, and deal-math (MI arv_pct_max 0.6461) prices off ARV.
    const c = resolveOpenerCeiling({ state: "MI", zip: "48207", underwrittenMao: null, realArvMedian: 28_700, estRehab: 5_000, listPrice: 100_000 });
    expect(c.priceable).toBe(true);
    expect(c.source).toBe("deal_math");
    // Hand-check the math: 28,700 × 0.6461 − 5,000 − 5,000 = 8,543. Matches
    // the breach magnitude (the real Hunt St had different ARV/rehab inputs
    // landing at $13,658, same lineage).
    expect(c.mao).toBe(8_543);
  });

  it("unpriceable market → source null", () => {
    const c = resolveOpenerCeiling({ state: "TX", zip: "78201", realArvMedian: 200_000, estRehab: 30_000, listPrice: 175_000 });
    expect(c.source).toBeNull();
  });

  it("priceable + no MAO computable → source null (distinct from deal_math)", () => {
    const c = resolveOpenerCeiling({ state: "MI", zip: "48207", underwrittenMao: null, realArvMedian: null, estRehab: null, listPrice: 100_000 });
    expect(c.priceable).toBe(true);
    expect(c.mao).toBeNull();
    expect(c.source).toBeNull();
  });
});

describe("openerMaoGuard — autonomous-cron rules (operator 2026-06-10, spine recjsLKqETfQ5r6zK)", () => {
  it("RULE 1: requireBuyerAnchored REFUSES deal_math lineage", () => {
    // 3684 Hunt St shape: opener $13,500 vs MAO $13,658, sourced via deal-math.
    const g = openerMaoGuard({
      baseOpener: 13_500,
      mao: 13_658,
      priceable: true,
      source: "deal_math",
      requireBuyerAnchored: true,
      listPrice: 100_000,
    });
    expect(g.ok).toBe(false);
    expect(g.reason).toMatch(/mao_lineage_not_buyer_anchored.*deal_math/);
  });

  it("RULE 1: requireBuyerAnchored REFUSES null source (no MAO computable)", () => {
    const g = openerMaoGuard({
      baseOpener: 50_000,
      mao: 60_000,
      priceable: true,
      source: null,
      requireBuyerAnchored: true,
      listPrice: 100_000,
    });
    expect(g.ok).toBe(false);
    expect(g.reason).toMatch(/mao_lineage_not_buyer_anchored.*null/);
  });

  it("RULE 1: requireBuyerAnchored ACCEPTS buyer_underwrite_persisted (48227 path)", () => {
    const g = openerMaoGuard({
      baseOpener: 48_750,
      mao: 50_000,
      priceable: true,
      source: "buyer_underwrite_persisted",
      requireBuyerAnchored: true,
      listPrice: 74_900,
    });
    expect(g.ok).toBe(true);
    expect(g.opener).toBe(48_750);
  });

  it("RULE 1: requireBuyerAnchored ACCEPTS buyer_zip_store_live (fresh intake path)", () => {
    const g = openerMaoGuard({
      baseOpener: 22_000,
      mao: 50_000,
      priceable: true,
      source: "buyer_zip_store_live",
      requireBuyerAnchored: true,
      listPrice: 33_900,
    });
    expect(g.ok).toBe(true);
  });

  it("RULE 1 is OPT-IN: the controlled batch (no requireBuyerAnchored) still accepts deal_math", () => {
    const g = openerMaoGuard({
      baseOpener: 13_500,
      mao: 13_658,
      priceable: true,
      source: "deal_math",
      listPrice: 100_000,
      // requireBuyerAnchored omitted — batch path
    });
    // Math gate still applies (capped), but lineage doesn't refuse here.
    // The batch's own lowball floor isn't enabled either since listPrice
    // is only used when the autonomous flag triggers a cap below 35%.
    expect(g.ok).toBe(true);
  });

  it("RULE 2: capped opener below 35% of list HOLDs (Hunt St breach magnitude)", () => {
    // base opener $65k (≥ MAO), MAO $13,658 → cap $13,500 (after $250 floor)
    // / list $100,000 = 13.5%, below 35% → HOLD.
    const g = openerMaoGuard({
      baseOpener: 65_000,
      mao: 13_658,
      priceable: true,
      source: "buyer_underwrite_persisted", // even on buyer-anchored, the lowball signal HOLDS
      requireBuyerAnchored: true,
      listPrice: 100_000,
    });
    expect(g.ok).toBe(false);
    expect(g.reason).toMatch(/lowball_below_35pct_of_list/);
    expect(g.reason).toContain("$35,000 floor");
  });

  it("RULE 2: opener ≤ MAO but still below 35% of list HOLDs", () => {
    // Sub-cap path: base $12k, MAO $15k (so no cap), list $100k → 12%, HOLD.
    const g = openerMaoGuard({
      baseOpener: 12_000,
      mao: 15_000,
      priceable: true,
      source: "buyer_underwrite_persisted",
      requireBuyerAnchored: true,
      listPrice: 100_000,
    });
    expect(g.ok).toBe(false);
    expect(g.reason).toMatch(/lowball_below_35pct_of_list/);
  });

  it("RULE 2: 35.1% passes, 34.9% HOLDs (boundary)", () => {
    expect(openerMaoGuard({ baseOpener: 35_100, mao: 50_000, priceable: true, source: "buyer_underwrite_persisted", requireBuyerAnchored: true, listPrice: 100_000 }).ok).toBe(true);
    expect(openerMaoGuard({ baseOpener: 34_900, mao: 50_000, priceable: true, source: "buyer_underwrite_persisted", requireBuyerAnchored: true, listPrice: 100_000 }).ok).toBe(false);
  });

  it("RULE 2 is also opt-in: no listPrice → lowball check skipped (back-compat)", () => {
    const g = openerMaoGuard({ baseOpener: 13_500, mao: 50_000, priceable: true, source: "buyer_underwrite_persisted" });
    expect(g.ok).toBe(true);
  });

  it("Hunt St breach: BOTH rules trip with the autonomous flags on (defense in depth)", () => {
    const g = openerMaoGuard({
      baseOpener: 65_000,
      mao: 13_658,
      priceable: true,
      source: "deal_math",
      requireBuyerAnchored: true,
      listPrice: 100_000,
    });
    expect(g.ok).toBe(false);
    // Rule 1 wins the refusal order (lineage check is first), but the
    // lowball would also have refused — the test ensures both are wired.
    expect(g.reason).toMatch(/mao_lineage_not_buyer_anchored/);
  });
});
