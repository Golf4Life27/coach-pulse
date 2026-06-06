// @agent: orchestrator — V2.1 economics hydration + quarantine-marker tests.
import { describe, it, expect } from "vitest";
import {
  computeV21LandlordMao,
  defaultInvestorCapFor,
  checkTxTaxPlausibility,
  resolveAnnualTaxes,
  TX_TAX_RATE_FLOOR,
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
  it("TN/Memphis is UNCONFIRMED → null → HOLD (candidate band, never a silent default)", () => {
    // Confirmation gates the computation. An unconfirmed cap defaulting in
    // is the false-dispose machine (too-high cap → understated value →
    // negative MAO → live deal silently buried). 38109 must HOLD.
    expect(defaultInvestorCapFor("TN", "38109")).toBeNull();
  });
  it("null (HOLD) outside the sourced maps — no guessed cap", () => {
    expect(defaultInvestorCapFor("CA", "90001")).toBeNull();
    expect(defaultInvestorCapFor(null, null)).toBeNull();
  });
});

describe("cap gate ends-to-end: unconfirmed market → V2.1 HOLD", () => {
  it("a fully-hydrated TN record still HOLDs because the cap is unconfirmed", () => {
    // Rent + taxes + rehab all present, but TN cap is null → HOLD → no MAO
    // → the triage classifier receives null → never disposes. The exact
    // false-dispose this gate prevents.
    const cap = defaultInvestorCapFor("TN", "38109");
    const r = computeV21LandlordMao({ monthlyRent: 1200, annualTaxes: 1800, estRehab: 25000, capRate: cap });
    expect(r.status).toBe("hold");
    expect(r.yourMao).toBeNull();
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

describe("TX tax-plausibility guard", () => {
  it("rejects the $555 Bexar/Callaghan class — 0.28% of $196k is impossible for TX", () => {
    const r = checkTxTaxPlausibility("TX", 555, 196310);
    expect(r.plausible).toBe(false);
    expect(r.effectiveRate).toBeCloseTo(0.00283, 4);
    expect(r.reason).toContain("FAIL");
  });
  it("accepts Dreamland-class (Bexar 2.2%+) — well above the 1.2% floor", () => {
    // Dreamland: 6,222/278,000 ≈ 2.24%.
    expect(checkTxTaxPlausibility("TX", 6222, 278000).plausible).toBe(true);
  });
  it("rejects just-below the floor; accepts just-above", () => {
    expect(checkTxTaxPlausibility("TX", 1190, 100_000).plausible).toBe(false); // 1.19%
    expect(checkTxTaxPlausibility("TX", 1210, 100_000).plausible).toBe(true);  // 1.21%
    expect(TX_TAX_RATE_FLOOR).toBe(0.012);
  });
  it("non-TX is out of scope — passes through (TN HOLDs on cap upstream)", () => {
    expect(checkTxTaxPlausibility("TN", 500, 100000).plausible).toBe(true);
    expect(checkTxTaxPlausibility(null, 500, 100000).plausible).toBe(true);
  });
  it("missing assessedValue → passes through (don't manufacture rejections)", () => {
    expect(checkTxTaxPlausibility("TX", 555, null).plausible).toBe(true);
  });
});

describe("resolveAnnualTaxes — confirmed-override precedence + plausibility", () => {
  it("confirmed value WINS over RentCast and freezes write", () => {
    // The Callaghan regression: RentCast returns the bad $555 but the
    // operator stamped $4,515 — confirmed must win.
    const r = resolveAnnualTaxes({
      state: "TX",
      confirmedTaxes: 4515,
      confirmedLabel: "operator_2026-06-05",
      rentcastTaxes: 555,
      assessedValue: 196310,
    });
    expect(r.source).toBe("confirmed");
    expect(r.annualTaxes).toBe(4515);
    expect(r.freezeWrite).toBe(true);
    expect(r.confirmedLabel).toBe("operator_2026-06-05");
  });

  it("confirmed value survives a SECOND cron re-run with same inputs (idempotent)", () => {
    // The structural anti-regression — verified facts must survive autonomy.
    const inputs = {
      state: "TX" as const,
      confirmedTaxes: 4515,
      confirmedLabel: "bexar_cad_2026-06-04",
      rentcastTaxes: 555,
      assessedValue: 196310,
    };
    const r1 = resolveAnnualTaxes(inputs);
    const r2 = resolveAnnualTaxes(inputs);
    expect(r1.annualTaxes).toBe(4515);
    expect(r2.annualTaxes).toBe(4515);
    expect(r1.freezeWrite).toBe(true);
    expect(r2.freezeWrite).toBe(true);
    // After re-run, source is still confirmed (no silent demotion).
    expect(r2.source).toBe("confirmed");
  });

  it("no confirmed + plausible RentCast → uses RentCast (not frozen)", () => {
    const r = resolveAnnualTaxes({
      state: "TX",
      confirmedTaxes: null,
      confirmedLabel: null,
      rentcastTaxes: 6222,
      assessedValue: 278000,
    });
    expect(r.source).toBe("rentcast_auto");
    expect(r.annualTaxes).toBe(6222);
    expect(r.freezeWrite).toBe(false);
  });

  it("ATTOM assessor BEATS RentCast when both present and ATTOM is plausible", () => {
    // Same record: ATTOM returns $4,500 (good), RentCast returns $555 (bad).
    // ATTOM wins; RentCast is irrelevant.
    const r = resolveAnnualTaxes({
      state: "TX",
      confirmedTaxes: null,
      confirmedLabel: null,
      attomTaxes: 4500,
      attomAssessedValue: 196310,
      rentcastTaxes: 555,
      assessedValue: 196310,
    });
    expect(r.source).toBe("attom_assessor");
    expect(r.annualTaxes).toBe(4500);
  });

  it("ATTOM assessor that fails plausibility does NOT fall through to RentCast — caller HOLDs", () => {
    // If ATTOM itself returns an implausible number, the auto path is broken
    // for this record. Don't silently fall back; HOLD. (Anti-regression:
    // never let a worse source rescue a bad better source.)
    const r = resolveAnnualTaxes({
      state: "TX",
      confirmedTaxes: null,
      confirmedLabel: null,
      attomTaxes: 200, // 0.1% effective — broken
      attomAssessedValue: 200000,
      rentcastTaxes: 6222,
      assessedValue: 200000,
    });
    expect(r.source).toBe("attom_assessor_implausible");
    expect(r.annualTaxes).toBeNull();
  });

  it("ATTOM absent → falls back to RentCast (with plausibility)", () => {
    const r = resolveAnnualTaxes({
      state: "TX",
      confirmedTaxes: null,
      confirmedLabel: null,
      attomTaxes: null,
      rentcastTaxes: 6222,
      assessedValue: 278000,
    });
    expect(r.source).toBe("rentcast_auto");
  });

  it("no confirmed + implausible RentCast → null (V2.1 HOLD downstream)", () => {
    // Without a confirmed override, the $555 path now resolves to null
    // taxes → V2.1 HOLD → no MAO persisted. The cron NULLs any prior
    // tainted V21 value (route handles that branch).
    const r = resolveAnnualTaxes({
      state: "TX",
      confirmedTaxes: null,
      confirmedLabel: null,
      rentcastTaxes: 555,
      assessedValue: 196310,
    });
    expect(r.source).toBe("rentcast_implausible");
    expect(r.annualTaxes).toBeNull();
    expect(r.plausibilityReason).toContain("FAIL");
  });

  it("no confirmed + no RentCast → missing (V2.1 HOLD)", () => {
    const r = resolveAnnualTaxes({
      state: "TX",
      confirmedTaxes: null,
      confirmedLabel: null,
      rentcastTaxes: null,
      assessedValue: null,
    });
    expect(r.source).toBe("missing");
    expect(r.annualTaxes).toBeNull();
  });

  it("confirmed value works even when no RentCast comparator exists", () => {
    const r = resolveAnnualTaxes({
      state: "TX",
      confirmedTaxes: 4515,
      confirmedLabel: "operator_2026-06-05",
      rentcastTaxes: null,
      assessedValue: null,
    });
    expect(r.source).toBe("confirmed");
    expect(r.annualTaxes).toBe(4515);
  });
});
