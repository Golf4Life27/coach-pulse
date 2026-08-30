// @agent: crier — two-stage doctrine list-anchor opener (operator 2026-08-30).
import { describe, it, expect } from "vitest";
import {
  DEFAULT_LIST_ANCHOR_PCT,
  LIST_ANCHOR_BASIS,
  isListAnchorMode,
  listAnchorPct,
  priceOpenerListAnchor,
} from "./list-anchor-opener";

const env = (v: Record<string, string>) => v as unknown as NodeJS.ProcessEnv;

describe("listAnchorPct", () => {
  it("defaults to 62%", () => {
    expect(listAnchorPct(env({}))).toBe(DEFAULT_LIST_ANCHOR_PCT);
    expect(DEFAULT_LIST_ANCHOR_PCT).toBe(0.62);
  });
  it("env tunes within the operator's 60-65% band", () => {
    expect(listAnchorPct(env({ H2_LIST_ANCHOR_PCT: "0.60" }))).toBe(0.6);
    expect(listAnchorPct(env({ H2_LIST_ANCHOR_PCT: "0.65" }))).toBe(0.65);
  });
  it("values outside the band (or garbage) fall back to 0.62 — never obeyed", () => {
    expect(listAnchorPct(env({ H2_LIST_ANCHOR_PCT: "0.40" }))).toBe(0.62);
    expect(listAnchorPct(env({ H2_LIST_ANCHOR_PCT: "0.85" }))).toBe(0.62);
    expect(listAnchorPct(env({ H2_LIST_ANCHOR_PCT: "banana" }))).toBe(0.62);
  });
});

describe("isListAnchorMode", () => {
  it("explicit opt-in only — exactly the basis string", () => {
    expect(isListAnchorMode(env({ H2_OPENER_MODE: "list_anchor_soft_v1" }))).toBe(true);
    expect(isListAnchorMode(env({ H2_OPENER_MODE: "true" }))).toBe(false);
    expect(isListAnchorMode(env({ H2_OPENER_MODE: "list_anchor" }))).toBe(false);
    expect(isListAnchorMode(env({}))).toBe(false);
  });
});

describe("priceOpenerListAnchor", () => {
  it("62% of list, rounded to the offer step", () => {
    // 0.62 × 120,000 = 74,400 → rounds to 74,500 at the $250 step.
    const r = priceOpenerListAnchor(120_000, 0.62);
    expect(r.result.opener).toBe(74_500);
    expect(r.basisLabel).toBe(LIST_ANCHOR_BASIS);
    expect(r.result.basis).toBe("list_anchor_soft");
    expect(r.result.anchorPct).toBe(0.62);
  });
  it("Roselawn regression: $120K list opens mid-$70s, never $47.5K", () => {
    const r = priceOpenerListAnchor(120_000);
    expect(r.result.opener).toBeGreaterThan(70_000);
  });
  it("HOLDs (opener null) when list price is missing or non-positive", () => {
    for (const lp of [null, undefined, 0, -5]) {
      const r = priceOpenerListAnchor(lp as number | null);
      expect(r.result.opener).toBeNull();
      expect(r.basisLabel).toBe("hold_no_list_price");
      expect(r.result.basis).toBe("hold_no_value_basis");
    }
  });
  it("no ARV judgements at the opener stage — every guard flag stays quiet", () => {
    const r = priceOpenerListAnchor(80_000);
    expect(r.result.overListTripwire).toBe(false);
    expect(r.result.arvDistrusted).toBe(false);
    expect(r.corroborationFlags).toEqual([]);
    expect(r.result.ceiling).toBeNull();
    expect(r.arvUsed).toBeNull();
  });
  it("derivation receipt reproduces the opener from its own terms", () => {
    const r = priceOpenerListAnchor(100_000, 0.62);
    expect(r.result.opener).toBe(62_000);
    expect(r.derivation.opener).toBe(62_000);
    expect(r.derivation.basis).toBe(LIST_ANCHOR_BASIS);
    expect(r.derivation.anchor).toBe(0.62);
  });
});
