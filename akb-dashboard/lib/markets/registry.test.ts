// @agent: orchestrator — market registry tests.
import { describe, it, expect } from "vitest";
import {
  getMarketConfig,
  getMarketForListing,
  isMarketLive,
  getRestrictedStates,
  getWholesaleFeeDefault,
  listMarkets,
} from "./registry";

describe("market registry — load + invariants", () => {
  it("loads the BBC config with markets and restricted_states", () => {
    const c = getMarketConfig();
    expect(c.markets.length).toBeGreaterThan(0);
    expect(c.restricted_states).toEqual(expect.arrayContaining(["IL", "MO", "SC", "NC", "OK", "ND"]));
  });

  it("Detroit is the V1 live market — params present + ARV%Max 64.61% + Max_Rehab $68,537", () => {
    const det = listMarkets().find((m) => m.id === "detroit_mi");
    expect(det).toBeTruthy();
    expect(det!.buyer_params_present).toBe(true);
    expect(det!.buyer_params!.arv_pct_max).toBe(0.6461);
    expect(det!.buyer_params!.max_rehab_usd).toBe(68537);
  });

  it("Detroit arv_source_verified is TRUE — flipped 2026-06-06 on the spread-sweep proof (Strathmoor PASS)", () => {
    const det = listMarkets().find((m) => m.id === "detroit_mi");
    expect(det!.arv_source_verified).toBe(true);
  });

  it("Detroit is LIVE-for-sourcing (all three gates true)", () => {
    const det = listMarkets().find((m) => m.id === "detroit_mi")!;
    expect(isMarketLive(det).live).toBe(true);
  });

  it("wholesale_fee_default is $5,000 (V2.1)", () => {
    expect(getWholesaleFeeDefault()).toBe(5000);
  });

  it("Memphis + Dallas have BBC params seeded but stay DORMANT (arv_source_verified:false)", () => {
    const memphis = listMarkets().find((m) => m.id === "memphis_tn")!;
    expect(memphis.buyer_params_present).toBe(true);
    expect(memphis.buyer_params!.arv_pct_max).toBe(0.7175);
    expect(memphis.buyer_params!.max_rehab_usd).toBe(75062);
    expect(memphis.buyer_params!.max_price_usd).toBe(308710);
    expect(memphis.arv_source_verified).toBe(false); // dormant
    expect(isMarketLive(memphis).live).toBe(false);

    const dallas = listMarkets().find((m) => m.id === "dallas_tx")!;
    expect(dallas.buyer_params!.arv_pct_max).toBe(0.5883);
    expect(dallas.buyer_params!.max_rehab_usd).toBe(60722);
    expect(dallas.buyer_params!.max_price_usd).toBe(353422);
    expect(dallas.arv_source_verified).toBe(false); // dormant
    expect(isMarketLive(dallas).live).toBe(false);
  });

  it("Detroit Max_Price is null (the $321B artifact is removed, not seeded)", () => {
    const det = listMarkets().find((m) => m.id === "detroit_mi")!;
    expect(det.buyer_params!.max_price_usd).toBeNull();
  });

  it("still-dormant metros with no params (Houston/SA) remain placeholder", () => {
    const placeholders = listMarkets().filter((m) => !m.buyer_params_present);
    for (const m of placeholders) expect(m.buyer_params).toBeNull();
  });
});

describe("restricted states — structural unsourceability", () => {
  it("getRestrictedStates returns the six restricted states uppercased", () => {
    const s = getRestrictedStates();
    expect(s.has("IL")).toBe(true);
    expect(s.has("MO")).toBe(true);
    expect(s.has("SC")).toBe(true);
    expect(s.has("NC")).toBe(true);
    expect(s.has("OK")).toBe(true);
    expect(s.has("ND")).toBe(true);
  });

  it("any market in a restricted state has sourcing_allowed forced to false at load time", () => {
    // The load-time freezer overrides whatever the JSON says for IL/MO/etc.
    // Pinning the invariant: no future config-typo can resurrect a
    // restricted-state market — the gate is structural.
    for (const m of listMarkets()) {
      if (getRestrictedStates().has(m.state.toUpperCase())) {
        expect(m.sourcing_allowed).toBe(false);
      }
    }
  });
});

describe("getMarketForListing — ZIP-prefix wins, state fallback", () => {
  it("resolves Detroit via the 48 prefix", () => {
    expect(getMarketForListing({ state: "MI", zip: "48206" })?.id).toBe("detroit_mi");
  });
  it("resolves Memphis via the 38 prefix", () => {
    expect(getMarketForListing({ state: "TN", zip: "38109" })?.id).toBe("memphis_tn");
  });
  it("resolves San Antonio via the 78 prefix", () => {
    expect(getMarketForListing({ state: "TX", zip: "78228" })?.id).toBe("san_antonio_tx");
  });
  it("falls back to state when ZIP doesn't match any prefix", () => {
    expect(getMarketForListing({ state: "MI", zip: "99999" })?.state).toBe("MI");
  });
  it("returns null when neither ZIP nor state matches a configured market", () => {
    expect(getMarketForListing({ state: "WY", zip: "82001" })).toBeNull();
  });
  it("handles null/empty inputs", () => {
    expect(getMarketForListing({ state: null, zip: null })).toBeNull();
    expect(getMarketForListing({})).toBeNull();
  });
});

describe("isMarketLive — three-gate liveness", () => {
  const detroit = listMarkets().find((m) => m.id === "detroit_mi")!;

  it("Detroit is LIVE today (flipped on proof) — all three gates pass", () => {
    const v = isMarketLive(detroit);
    expect(v.live).toBe(true);
  });

  it("an un-verified market is NOT live, cites arv_source_verified", () => {
    const unverified = { ...detroit, arv_source_verified: false };
    const v = isMarketLive(unverified);
    expect(v.live).toBe(false);
    expect(v.reasons.some((r) => r.includes("arv_source_verified"))).toBe(true);
  });

  it("true placeholder (no params) is NOT live, cites buyer_params_present", () => {
    const placeholder = listMarkets().find((m) => !m.buyer_params_present)!;
    const v = isMarketLive(placeholder);
    expect(v.live).toBe(false);
    expect(v.reasons.some((r) => r.includes("buyer_params_present"))).toBe(true);
  });

  it("params-seeded-but-dormant (Memphis) is NOT live, cites arv_source_verified", () => {
    const memphis = listMarkets().find((m) => m.id === "memphis_tn")!;
    const v = isMarketLive(memphis);
    expect(v.live).toBe(false);
    expect(v.reasons.some((r) => r.includes("arv_source_verified"))).toBe(true);
  });

  it("null market is NOT live", () => {
    const v = isMarketLive(null);
    expect(v.live).toBe(false);
    expect(v.reasons[0]).toContain("no market");
  });
});
