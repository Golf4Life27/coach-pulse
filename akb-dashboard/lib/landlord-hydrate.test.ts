// @agent: orchestrator — V2.1 economics hydration + quarantine-marker tests.
import { describe, it, expect } from "vitest";
import {
  computeV21LandlordMao,
  defaultInvestorCapFor,
  buildMaoV21Marker,
  parseMaoV21Marker,
  upsertMaoV21Marker,
  MAO_V21_SENTINEL,
} from "./landlord-hydrate";

describe("defaultInvestorCapFor", () => {
  it("10% for the 78228 transitional zip (Callaghan)", () => {
    expect(defaultInvestorCapFor("TX", "78228")).toBe(0.1);
  });
  it("9% for other TX", () => {
    expect(defaultInvestorCapFor("TX", "78230")).toBe(0.09);
  });
  it("11% for TN", () => {
    expect(defaultInvestorCapFor("TN", "38109")).toBe(0.11);
  });
  it("null (HOLD) outside the sourced maps — no guessed cap", () => {
    expect(defaultInvestorCapFor("CA", "90001")).toBeNull();
    expect(defaultInvestorCapFor(null, null)).toBeNull();
  });
});

describe("computeV21LandlordMao", () => {
  it("uses the V2.1 $5k fee (NOT the legacy $15k+$30k=$45k)", () => {
    // rent 2000/mo, taxes 4000, cap 9%, rehab 20000.
    // gross 24000, opex 35% = 8400, NOI = 24000-8400-4000 = 11600.
    // value = 11600/0.09 = 128889. investor = 128889-20000 = 108889.
    // your = 108889 - 5000 = 103889.
    const r = computeV21LandlordMao({ monthlyRent: 2000, annualTaxes: 4000, estRehab: 20000, capRate: 0.09 });
    expect(r.status).toBe("ok");
    expect(r.investorMao).toBe(108889);
    expect(r.yourMao).toBe(103889);
    expect(r.used.wholesaleFee).toBe(5000);
  });

  it("a genuinely uneconomic set yields a NEGATIVE Your_MAO (disposes downstream)", () => {
    // Low rent, high taxes + rehab → value can't cover rehab+fee.
    // rent 900/mo gross 10800, opex 3780, taxes 5000 → NOI 2020.
    // value = 2020/0.09 = 22444. investor = 22444 - 30000 = -7556.
    // your = -7556 - 5000 = -12556  (≤0 → uneconomic).
    const r = computeV21LandlordMao({ monthlyRent: 900, annualTaxes: 5000, estRehab: 30000, capRate: 0.09 });
    expect(r.status).toBe("ok");
    expect(r.yourMao).toBeLessThan(0);
  });

  it("HOLDs (no number) when rent is missing — never fabricates", () => {
    const r = computeV21LandlordMao({ monthlyRent: null, annualTaxes: 4000, estRehab: 20000, capRate: 0.09 });
    expect(r.status).toBe("hold");
    expect(r.yourMao).toBeNull();
  });

  it("HOLDs when taxes missing", () => {
    expect(computeV21LandlordMao({ monthlyRent: 2000, annualTaxes: null, estRehab: 20000, capRate: 0.09 }).status).toBe("hold");
  });

  it("HOLDs when cap missing (unsourced market) — never guesses a cap", () => {
    expect(computeV21LandlordMao({ monthlyRent: 2000, annualTaxes: 4000, estRehab: 20000, capRate: null }).status).toBe("hold");
  });

  it("HOLDs when rehab missing (can't floor Investor_MAO)", () => {
    const r = computeV21LandlordMao({ monthlyRent: 2000, annualTaxes: 4000, estRehab: null, capRate: 0.09 });
    expect(r.status).toBe("hold");
    expect(r.investorMao).toBeNull();
  });

  it("HOLDs when NOI ≤ 0 (doesn't cash-flow) — not a fake value", () => {
    // rent 500 gross 6000, opex 2100, taxes 5000 → NOI = -1100 ≤ 0.
    const r = computeV21LandlordMao({ monthlyRent: 500, annualTaxes: 5000, estRehab: 10000, capRate: 0.09 });
    expect(r.status).toBe("hold");
  });
});

describe("MAO_V2.1 provenance marker (quarantine boundary)", () => {
  const now = new Date("2026-06-05T00:00:00.000Z");

  it("builds a parseable single-line marker", () => {
    const line = buildMaoV21Marker(
      { status: "ok", yourMao: 103889, investorMao: 108889, cap: 0.09, rent: 2000, taxes: 4000 },
      now,
    );
    expect(line).toContain(MAO_V21_SENTINEL);
    expect(line).toContain("your_mao=103889");
    expect(line).toContain("@2026-06-05");
    const parsed = parseMaoV21Marker(line);
    expect(parsed).not.toBeNull();
    expect(parsed!.yourMao).toBe(103889);
    expect(parsed!.cap).toBe(0.09);
    expect(parsed!.rent).toBe(2000);
    expect(parsed!.status).toBe("ok");
  });

  it("round-trips a negative your_mao", () => {
    const line = buildMaoV21Marker({ status: "ok", yourMao: -12556, investorMao: -7556, cap: 0.09, rent: 900, taxes: 5000 }, now);
    expect(parseMaoV21Marker(line)!.yourMao).toBe(-12556);
  });

  it("parses null fields as '-' → null", () => {
    const line = buildMaoV21Marker({ status: "hold", yourMao: null, investorMao: null, cap: 0.09, rent: 1890, taxes: null }, now);
    const p = parseMaoV21Marker(line)!;
    expect(p.yourMao).toBeNull();
    expect(p.taxes).toBeNull();
    expect(p.rent).toBe(1890);
  });

  it("returns null when NO marker is present (legacy / quarantined record)", () => {
    expect(parseMaoV21Marker(null)).toBeNull();
    expect(parseMaoV21Marker("just some agent notes, no marker")).toBeNull();
  });

  it("upsert REPLACES a prior marker (notes don't accrete duplicates)", () => {
    const old = buildMaoV21Marker({ status: "ok", yourMao: 100, investorMao: 105, cap: 0.09, rent: 2000, taxes: 4000 }, now);
    const fresh = buildMaoV21Marker({ status: "ok", yourMao: 200, investorMao: 205, cap: 0.09, rent: 2100, taxes: 4000 }, now);
    const notes = upsertMaoV21Marker(`prior context\n${old}`, fresh);
    expect((notes.match(/MAO_V2\.1/g) ?? []).length).toBe(1);
    expect(parseMaoV21Marker(notes)!.yourMao).toBe(200);
    expect(notes).toContain("prior context");
  });

  it("upsert onto empty notes returns just the marker", () => {
    const m = buildMaoV21Marker({ status: "ok", yourMao: 1, investorMao: 6, cap: 0.09, rent: 1, taxes: 1 }, now);
    expect(upsertMaoV21Marker(null, m)).toBe(m);
  });
});
