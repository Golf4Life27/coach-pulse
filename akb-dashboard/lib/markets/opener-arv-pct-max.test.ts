import { describe, it, expect } from "vitest";
import {
  resolveOpenerArvPctMax,
  openerArvPctMax,
  NATIONAL_OPENER_ARV_PCT_MAX,
  isNonDisclosureState,
  type Market,
} from "./registry";

function mkt(over: Partial<Market> = {}): Market {
  return {
    id: "test_mi",
    label: "Test",
    state: "MI",
    counties: [],
    zip_prefixes: [],
    buyer_params_present: true,
    buyer_params: { arv_pct_max: 0.65, max_rehab_usd: 0, max_price_usd: null, criteria: { beds_min: null, baths_min: null, year_built_min: null, sqft_min: null, sqft_max: null, property_types_allowed: null } },
    arv_source_verified: true,
    sourcing_allowed: true,
    ...over,
  };
}

describe("resolveOpenerArvPctMax — national opener buy-box policy", () => {
  it("configured + ARV-source-verified market → its arv_pct_max", () => {
    const r = resolveOpenerArvPctMax(mkt({ arv_source_verified: true }), "MI");
    expect(r.source).toBe("configured_verified");
    expect(r.arvPctMax).toBe(0.65);
  });

  it("configured but UNverified (dormant non-disclosure, e.g. Dallas) → HOLD", () => {
    const r = resolveOpenerArvPctMax(mkt({ state: "TX", arv_source_verified: false }), "TX");
    expect(r.source).toBe("hold_configured_unverified");
    expect(r.arvPctMax).toBeNull();
  });

  it("unconfigured DISCLOSURE + non-restricted state → the national default", () => {
    const r = resolveOpenerArvPctMax(null, "OH");
    expect(r.source).toBe("national_default_disclosure");
    expect(r.arvPctMax).toBe(NATIONAL_OPENER_ARV_PCT_MAX);
    expect(r.arvPctMax).toBe(0.70);
  });

  it("unconfigured NON-DISCLOSURE state (TX) → HOLD (ARV unprovable)", () => {
    const r = resolveOpenerArvPctMax(null, "TX");
    expect(r.source).toBe("hold_non_disclosure");
    expect(r.arvPctMax).toBeNull();
  });

  it("restricted state → HOLD, and it BEATS a verified configured market", () => {
    expect(resolveOpenerArvPctMax(null, "IL").source).toBe("hold_restricted");
    // even a 'verified' market in a restricted state holds (restricted checked first):
    const r = resolveOpenerArvPctMax(mkt({ state: "IL", arv_source_verified: true }), "IL");
    expect(r.source).toBe("hold_restricted");
    expect(r.arvPctMax).toBeNull();
  });

  it("a market row with no buyer_params (state stub) falls through to the state policy", () => {
    // OH stub, no params → disclosure default; TX stub → non-disclosure hold.
    expect(resolveOpenerArvPctMax(mkt({ state: "OH", buyer_params: null, buyer_params_present: false }), "OH").source).toBe("national_default_disclosure");
    expect(resolveOpenerArvPctMax(mkt({ state: "TX", buyer_params: null, buyer_params_present: false }), "TX").source).toBe("hold_non_disclosure");
  });

  it("no state → HOLD", () => {
    expect(resolveOpenerArvPctMax(null, null).source).toBe("hold_no_state");
    expect(resolveOpenerArvPctMax(null, "").arvPctMax).toBeNull();
  });

  it("openerArvPctMax convenience returns just the number / null", () => {
    expect(openerArvPctMax(null, "OH")).toBe(0.70);
    expect(openerArvPctMax(null, "TX")).toBeNull();
    expect(openerArvPctMax(null, "IL")).toBeNull();
  });
});

describe("isNonDisclosureState", () => {
  it("the 12 non-disclosure states are flagged; disclosure states are not", () => {
    for (const s of ["AK", "ID", "KS", "LA", "MS", "MO", "MT", "ND", "NM", "TX", "UT", "WY"]) {
      expect(isNonDisclosureState(s)).toBe(true);
    }
    for (const s of ["MI", "OH", "GA", "FL", "TN", "CA"]) {
      expect(isNonDisclosureState(s)).toBe(false);
    }
  });
  it("case-insensitive + tolerates blanks", () => {
    expect(isNonDisclosureState("tx")).toBe(true);
    expect(isNonDisclosureState(" Tx ")).toBe(true);
    expect(isNonDisclosureState(null)).toBe(false);
  });
});

describe("adding a market must never make things worse than not adding it (2026-08-07)", () => {
  // THE BUG. A dormant market HELD outright while the same listing in a state
  // with no market entry priced off the national default — so writing down
  // what we knew about a metro DISABLED it. Memphis was 295 records, 33% of
  // the entire eligible pool, every one holding on hold_no_value_basis purely
  // because memphis_tn exists with arv_source_verified:false.
  const dormantTn = () => mkt({ id: "memphis_tn", state: "TN", arv_source_verified: false,
    buyer_params: { arv_pct_max: 0.7175, max_rehab_usd: 75_062, max_price_usd: 308_710,
      criteria: { beds_min: null, baths_min: null, year_built_min: null, sqft_min: null, sqft_max: null, property_types_allowed: null } } });

  it("a dormant market in a DISCLOSURE state falls back to the national default", () => {
    const r = resolveOpenerArvPctMax(dormantTn(), "TN");
    expect(r.source).toBe("national_default_unverified");
    expect(r.arvPctMax).toBe(NATIONAL_OPENER_ARV_PCT_MAX);
  });

  it("the fallback is MORE conservative than the config it replaces", () => {
    // 0.70 national vs Memphis's own 0.7175 — we offer LESS, not more. There
    // is no reading where holding was safe and this is reckless.
    const m = dormantTn();
    expect(resolveOpenerArvPctMax(m, "TN").arvPctMax!)
      .toBeLessThan(m.buyer_params!.arv_pct_max);
  });

  it("a market entry can never price WORSE than no entry at all", () => {
    for (const st of ["TN", "OH", "GA", "AL", "IN", "MI"]) {
      const withEntry = resolveOpenerArvPctMax(mkt({ state: st, arv_source_verified: false }), st).arvPctMax;
      const without = resolveOpenerArvPctMax(null, st).arvPctMax;
      expect(withEntry, st).not.toBeNull();
      expect(withEntry, st).toBe(without);
    }
  });

  it("STILL HOLDS a dormant market in a non-disclosure state", () => {
    // TX is the reason the gate exists. A dormant TX market cannot borrow the
    // national default, because the default assumes provable sold comps.
    const r = resolveOpenerArvPctMax(mkt({ state: "TX", arv_source_verified: false }), "TX");
    expect(r.source).toBe("hold_configured_unverified");
    expect(r.arvPctMax).toBeNull();
  });

  it("STILL HOLDS a restricted state regardless of config", () => {
    expect(resolveOpenerArvPctMax(mkt({ state: "IL", arv_source_verified: false }), "IL").source)
      .toBe("hold_restricted");
  });

  it("a VERIFIED market still uses its own buy-box, not the default", () => {
    const r = resolveOpenerArvPctMax(mkt({ state: "MI", arv_source_verified: true }), "MI");
    expect(r.source).toBe("configured_verified");
    expect(r.arvPctMax).toBe(0.65);
  });

  it("sourcing_allowed=false also falls back rather than holding, in a disclosure state", () => {
    const r = resolveOpenerArvPctMax(mkt({ state: "TN", sourcing_allowed: false }), "TN");
    expect(r.arvPctMax).toBe(NATIONAL_OPENER_ARV_PCT_MAX);
  });
});
