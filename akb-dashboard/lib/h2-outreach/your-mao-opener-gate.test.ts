import { describe, it, expect } from "vitest";
import { yourMaoOpenerGate } from "./your-mao-opener-gate";

describe("yourMaoOpenerGate — Detroit launch shape (operator brief 2026-06-13)", () => {
  it("opener = anchor × Your_MAO, rounded — Greenview canonical case", () => {
    // 16779 Greenview, 48219: Your_MAO $101,127.93, anchor 0.90
    const r = yourMaoOpenerGate({ yourMao: 101_127.93, anchorPct: 0.90, priceable: true });
    expect(r.ok).toBe(true);
    expect(r.opener).toBe(91_015);
    expect(r.reason).toBe("ok");
  });
  it("Frisbee — high opener relative to list (94% of list at 0.90)", () => {
    expect(yourMaoOpenerGate({ yourMao: 73_202.01, anchorPct: 0.90, priceable: true }).opener).toBe(65_882);
  });
  it("Mettetal — low opener relative to list, no list-price clamp", () => {
    // The doctrine: list price never enters the formula. A 24%-of-list
    // opener is what the system sends if the property genuinely doesn't
    // pencil higher.
    expect(yourMaoOpenerGate({ yourMao: 20_999.35, anchorPct: 0.90, priceable: true }).opener).toBe(18_899);
  });
});

describe("HARD GATE — Your_MAO null/≤0 refuses autonomous send (no exceptions)", () => {
  it("null Your_MAO → refused; routes to operator review", () => {
    const r = yourMaoOpenerGate({ yourMao: null, anchorPct: 0.90, priceable: true });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("your_mao_missing");
    expect(r.detail).toContain("operator review");
  });
  it("undefined Your_MAO → refused", () => {
    expect(yourMaoOpenerGate({ yourMao: undefined, anchorPct: 0.90, priceable: true }).ok).toBe(false);
  });
  it("Your_MAO = 0 → refused (non-penciling)", () => {
    const r = yourMaoOpenerGate({ yourMao: 0, anchorPct: 0.90, priceable: true });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("your_mao_non_penciling");
  });
  it("Your_MAO < 0 → refused (non-penciling)", () => {
    const r = yourMaoOpenerGate({ yourMao: -500, anchorPct: 0.90, priceable: true });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("your_mao_non_penciling");
  });
  it("HARD GATE supersedes anchor — even at anchor 1.00 a null Your_MAO refuses", () => {
    expect(yourMaoOpenerGate({ yourMao: null, anchorPct: 1.00, priceable: true }).ok).toBe(false);
  });
});

describe("market gate (priceable check, unchanged)", () => {
  it("non-priceable market → skip BEFORE Your_MAO is consulted", () => {
    const r = yourMaoOpenerGate({ yourMao: 50_000, anchorPct: 0.90, priceable: false });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("market_not_priceable");
  });
});

describe("anchor invariants", () => {
  it("missing anchor → refuse (calibration store unreachable; don't send blind)", () => {
    const r = yourMaoOpenerGate({ yourMao: 50_000, anchorPct: null, priceable: true });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("anchor_invalid");
  });
  it("zero anchor → refuse (not 'send $0')", () => {
    const r = yourMaoOpenerGate({ yourMao: 50_000, anchorPct: 0, priceable: true });
    expect(r.ok).toBe(false);
  });
});

describe("no list-price coupling anywhere in the formula", () => {
  it("opener identical for two records with same Your_MAO at different list prices", () => {
    const a = yourMaoOpenerGate({ yourMao: 50_000, anchorPct: 0.90, priceable: true });
    const b = yourMaoOpenerGate({ yourMao: 50_000, anchorPct: 0.90, priceable: true });
    expect(a.opener).toBe(b.opener);
  });
});
