import { describe, it, expect } from "vitest";
import { classifyHold, type HoldClassifyInput } from "./hold-reason";

function base(over: Partial<HoldClassifyInput> = {}): HoldClassifyInput {
  return {
    opener: null,
    arvDistrusted: false,
    flooredToFallback: false,
    flagReseed: false,
    arvSource: "none",
    seedDontPrice: false,
    marketHasBuybox: true,
    ...over,
  };
}

describe("classifyHold — a value-anchored send is not a hold", () => {
  it("opener present → value_send, nobody owns it, automatable", () => {
    const r = classifyHold(base({ opener: 42_779, arvSource: "seed_renovated" }));
    expect(r.category).toBe("value_send");
    expect(r.owner).toBe("none");
    expect(r.automatable).toBe(true);
  });
});

describe("classifyHold — system-owned holds (no human reaches the desk)", () => {
  it("priceable market, ZIP not seeded → needs_seed / auto_seed / automatable", () => {
    const r = classifyHold(base({ arvSource: "none", marketHasBuybox: true }));
    expect(r.category).toBe("needs_seed");
    expect(r.owner).toBe("auto_seed");
    expect(r.automatable).toBe(true);
  });

  it("ARV below list but LOW-confidence → needs_seed (a re-seed may lift it) / auto_seed", () => {
    const r = classifyHold(base({ arvDistrusted: true, flagReseed: true, arvSource: "stored" }));
    expect(r.category).toBe("needs_seed");
    expect(r.owner).toBe("auto_seed");
    expect(r.automatable).toBe(true);
  });

  it("ZIP comps too thin/noisy (DONT_PRICE) → seed_dont_price / data_limited / automatable (cached skip)", () => {
    const r = classifyHold(base({ seedDontPrice: true, arvSource: "none" }));
    expect(r.category).toBe("seed_dont_price");
    expect(r.owner).toBe("data_limited");
    expect(r.automatable).toBe(true);
  });
});

describe("classifyHold — creative-lane holds (a different pipeline, not a per-record call)", () => {
  it("trusted ARV below list → cash_no_pencil / creative_lane / NOT automatable", () => {
    const r = classifyHold(base({ arvDistrusted: true, flagReseed: false, arvSource: "seed_renovated" }));
    expect(r.category).toBe("cash_no_pencil");
    expect(r.owner).toBe("creative_lane");
    expect(r.automatable).toBe(false);
  });

  it("buy-box opener below the floor → cash_no_pencil / creative_lane", () => {
    const r = classifyHold(base({ flooredToFallback: true, arvSource: "seed_renovated" }));
    expect(r.category).toBe("cash_no_pencil");
    expect(r.owner).toBe("creative_lane");
  });

  it("value known + buy-box present but did not pencil (rehab eats it) → cash_no_pencil / creative_lane", () => {
    const r = classifyHold(base({ arvSource: "seed_renovated", marketHasBuybox: true }));
    expect(r.category).toBe("cash_no_pencil");
    expect(r.owner).toBe("creative_lane");
    expect(r.automatable).toBe(false);
  });
});

describe("classifyHold — one-time config holds", () => {
  it("market has no buy-box → no_market_buybox / configure_market (one-time, unlocks the whole market)", () => {
    const r = classifyHold(base({ marketHasBuybox: false, arvSource: "none" }));
    expect(r.category).toBe("no_market_buybox");
    expect(r.owner).toBe("configure_market");
    expect(r.automatable).toBe(false);
  });
});

describe("classifyHold — precedence", () => {
  it("ARV<list distrust is read BEFORE the no-value branches", () => {
    // distrusted + also DONT_PRICE seed + no buybox: distrust (the value signal) wins.
    const r = classifyHold(base({ arvDistrusted: true, flagReseed: false, seedDontPrice: true, marketHasBuybox: false }));
    expect(r.category).toBe("cash_no_pencil");
  });

  it("a DONT_PRICE seed is read before the market-buybox check", () => {
    const r = classifyHold(base({ seedDontPrice: true, marketHasBuybox: false }));
    expect(r.category).toBe("seed_dont_price");
  });
});

describe("classifyHold — the operator's headline: most holds never reach the desk", () => {
  it("only cash_no_pencil + operator_review are non-automatable; seed/dont_price/send are", () => {
    const systemOwned = [
      classifyHold(base({ opener: 50_000 })),                                   // send
      classifyHold(base({ arvSource: "none" })),                                // needs_seed
      classifyHold(base({ arvDistrusted: true, flagReseed: true })),            // needs_seed (re-seed)
      classifyHold(base({ seedDontPrice: true })),                              // dont_price skip
    ];
    for (const r of systemOwned) expect(r.automatable).toBe(true);

    const needsAttention = [
      classifyHold(base({ arvDistrusted: true, flagReseed: false, arvSource: "seed_renovated" })), // creative
      classifyHold(base({ marketHasBuybox: false })),                                              // config
    ];
    for (const r of needsAttention) expect(r.automatable).toBe(false);
  });
});
