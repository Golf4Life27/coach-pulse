import { describe, it, expect } from "vitest";
import {
  judgeSpread,
  isSpreadWatchRecord,
  ENGAGED_CUT_ALERT_PCT,
} from "./spread-watch";
import { extractScrapedPrice } from "@/lib/crawler/intake-filter";

describe("3123 Sunbeam — the receipt this watcher exists for", () => {
  it("fires SPREAD DEAD on the exact 7/13 numbers", () => {
    // Contract $113,750 signed 7/12; seller cut list $175K→$115K on 7/13.
    // Public ask $1,250 above our contract price — the assignment fee has no
    // room to exist. This sat invisible for 17 days.
    const v = judgeSpread({
      protectPriceUsd: 113_750,
      storedListUsd: 175_000,
      scrapedListUsd: 115_000,
      stillActive: true,
    });
    expect(v.kind).toBe("spread_dead");
    expect(v.alert).toBe(true);
    expect(v.detail).toMatch(/Walk or renegotiate TODAY/);
  });

  it("stays quiet when the spread is genuinely intact", () => {
    const v = judgeSpread({
      protectPriceUsd: 113_750,
      storedListUsd: 175_000,
      scrapedListUsd: 174_900, // trivial reprice, spread untouched
      stillActive: true,
    });
    expect(v.kind).toBe("ok");
    expect(v.alert).toBe(false);
  });

  it("warns on a material public cut even while the spread survives", () => {
    // 175K → 150K: our 113,750 + fee still clears, but the seller is
    // capitulating in public — that is a renegotiation window, not noise.
    const v = judgeSpread({
      protectPriceUsd: 113_750,
      storedListUsd: 175_000,
      scrapedListUsd: 150_000,
      stillActive: true,
    });
    expect(v.kind).toBe("price_cut_material");
    expect(v.alert).toBe(true);
    expect(v.detail).toMatch(/−14%/);
  });
});

describe("716 8th Ct — status transitions, not just price", () => {
  it("fires on an inactive page whatever the price says", () => {
    const v = judgeSpread({
      protectPriceUsd: 71_750,
      storedListUsd: 110_000,
      scrapedListUsd: 110_000, // price unchanged — the STATUS is the event
      stillActive: false,
      inactiveMarkers: ["pending", "under contract"],
    });
    expect(v.kind).toBe("status_inactive");
    expect(v.alert).toBe(true);
    expect(v.detail).toMatch(/pending, under contract/);
  });
});

describe("honest gaps", () => {
  it("reports unwatchable — never guesses — when the page states no price", () => {
    const v = judgeSpread({
      protectPriceUsd: 113_750,
      storedListUsd: 175_000,
      scrapedListUsd: null,
      stillActive: true,
    });
    expect(v.kind).toBe("unwatchable");
    expect(v.alert).toBe(false);
    expect(v.detail).toMatch(/unverified/);
  });

  it("a cut below the alert threshold stays quiet", () => {
    const stored = 100_000;
    const justUnder = stored * (1 - ENGAGED_CUT_ALERT_PCT) + 1_000;
    const v = judgeSpread({
      protectPriceUsd: 40_000,
      storedListUsd: stored,
      scrapedListUsd: Math.round(justUnder),
      stillActive: true,
    });
    expect(v.kind).toBe("ok");
  });
});

describe("isSpreadWatchRecord — the contract stamp outranks the status field", () => {
  it("watches engaged statuses", () => {
    for (const s of ["Negotiating", "Counter Received", "Offer Accepted"]) {
      expect(isSpreadWatchRecord({ outreachStatus: s })).toBe(true);
    }
  });

  it("watches ANY record with a contract stamp — Sunbeam's status wobbled while the contract was the fact", () => {
    expect(isSpreadWatchRecord({ outreachStatus: "Dead", contractExecutedAt: "2026-07-13" })).toBe(true);
  });

  it("does not watch the cold pool — that is price-drop-fastlane's lane", () => {
    expect(isSpreadWatchRecord({ outreachStatus: "" })).toBe(false);
    expect(isSpreadWatchRecord({ outreachStatus: "Texted" })).toBe(false);
    expect(isSpreadWatchRecord({ outreachStatus: "Response Received" })).toBe(false);
  });
});

describe("extractScrapedPrice — the ground truth the watch judges against", () => {
  it("reads the Sunbeam Zillow shape past the payment estimate", () => {
    // The real page order: monthly payment renders BEFORE the ask.
    const page = "Est. $1,427/mo Get pre-qualified Price cut: $60K (7/13) $115,000 3 bd 2 ba 1,395 sqft";
    expect(extractScrapedPrice(page)).toBe(115_000);
  });

  it("skips per-month amounts and estimate-labelled values", () => {
    expect(extractScrapedPrice("$2,350/mo rent estimate then list $89,900 here")).toBe(89_900);
    expect(extractScrapedPrice("Zestimate: $109,700")).toBeNull();
  });

  it("ignores badge shorthand and out-of-range noise", () => {
    // "$60K" (no comma grouping) and a $1,427 payment both fail the shape.
    expect(extractScrapedPrice("Price cut: $60K since listing")).toBeNull();
    expect(extractScrapedPrice("payments from $1,427")).toBeNull();
  });

  it("returns null on an empty or priceless page — never zero", () => {
    expect(extractScrapedPrice(null)).toBeNull();
    expect(extractScrapedPrice("3 bd 2 ba, charming starter home")).toBeNull();
  });
});
