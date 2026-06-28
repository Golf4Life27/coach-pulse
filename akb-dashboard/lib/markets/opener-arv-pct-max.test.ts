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
