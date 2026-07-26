import { describe, it, expect } from "vitest";
import {
  computeZipSaturation,
  ZIP_SATURATION_WINDOW_DAYS_DEFAULT,
  ZIP_SATURATION_THRESHOLD_DEFAULT,
  type SaturationListing,
} from "./zip-saturation";

// Live example driving this signal (operator 2026-07-26): an agent in ZIP
// 44310 replied "We have had over 15 of these offers. Seller asked me to
// stop sending them to him." — sellers there are blanketed by competing
// wholesalers; continuing to crawl/text now burns credits and reputation.

const NOW = new Date("2026-07-26T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

function listing(overrides: Partial<SaturationListing> & { zip: string | null }): SaturationListing {
  return {
    doNotText: false,
    notes: null,
    lastInboundAt: null,
    ...overrides,
  };
}

describe("computeZipSaturation — defaults", () => {
  it("exposes the documented env-tunable defaults (14 days, threshold 2)", () => {
    expect(ZIP_SATURATION_WINDOW_DAYS_DEFAULT).toBe(14);
    expect(ZIP_SATURATION_THRESHOLD_DEFAULT).toBe(2);
  });
});

describe("computeZipSaturation — signal definition", () => {
  it("doNotText=true within the window counts as a negative signal", () => {
    const r = computeZipSaturation(
      [listing({ zip: "44310", doNotText: true, lastInboundAt: daysAgo(1) })],
      NOW,
    );
    expect(r.get("44310")?.negativeSignals).toBe(1);
  });

  it('notes containing "OPT-OUT honored" counts as a negative signal', () => {
    const r = computeZipSaturation(
      [listing({ zip: "44310", notes: "2026-07-20 OPT-OUT honored per seller request", lastInboundAt: daysAgo(1) })],
      NOW,
    );
    expect(r.get("44310")?.negativeSignals).toBe(1);
  });

  it('notes containing "L3 INBOUND: REJECTION" counts as a negative signal', () => {
    const r = computeZipSaturation(
      [listing({ zip: "44310", notes: "L3 INBOUND: REJECTION — stop texting", lastInboundAt: daysAgo(1) })],
      NOW,
    );
    expect(r.get("44310")?.negativeSignals).toBe(1);
  });

  it("a listing with none of the three markers is not a negative signal", () => {
    const r = computeZipSaturation(
      [listing({ zip: "44310", notes: "seller interested, following up", lastInboundAt: daysAgo(1) })],
      NOW,
    );
    expect(r.has("44310")).toBe(false);
  });

  it("missing zip is never counted even with a hard negative", () => {
    const r = computeZipSaturation(
      [listing({ zip: null, doNotText: true, lastInboundAt: daysAgo(1) })],
      NOW,
    );
    expect(r.size).toBe(0);
  });

  it("missing lastInboundAt is never counted, regardless of other fields", () => {
    const r = computeZipSaturation(
      [listing({ zip: "44310", doNotText: true, lastInboundAt: null })],
      NOW,
    );
    expect(r.has("44310")).toBe(false);
  });

  it("missing notes/doNotText (both falsy/null) is never counted", () => {
    const r = computeZipSaturation(
      [listing({ zip: "44310", doNotText: null as unknown as boolean, notes: null, lastInboundAt: daysAgo(1) })],
      NOW,
    );
    expect(r.has("44310")).toBe(false);
  });
});

describe("computeZipSaturation — window edges", () => {
  it("a negative signal exactly at the window boundary is included", () => {
    const r = computeZipSaturation(
      [listing({ zip: "44310", doNotText: true, lastInboundAt: daysAgo(14) })],
      NOW,
      { threshold: 1 },
    );
    expect(r.get("44310")?.negativeSignals).toBe(1);
  });

  it("a negative signal just past the window is excluded", () => {
    const r = computeZipSaturation(
      [listing({ zip: "44310", doNotText: true, lastInboundAt: daysAgo(14.01) })],
      NOW,
      { threshold: 1 },
    );
    expect(r.has("44310")).toBe(false);
  });

  it("a custom windowDays option overrides the env default", () => {
    const withinCustom = computeZipSaturation(
      [listing({ zip: "44310", doNotText: true, lastInboundAt: daysAgo(20) })],
      NOW,
      { windowDays: 30, threshold: 1 },
    );
    expect(withinCustom.get("44310")?.negativeSignals).toBe(1);

    const outsideDefault = computeZipSaturation(
      [listing({ zip: "44310", doNotText: true, lastInboundAt: daysAgo(20) })],
      NOW,
    );
    expect(outsideDefault.has("44310")).toBe(false);
  });
});

describe("computeZipSaturation — threshold", () => {
  it("below threshold: negativeSignals recorded but saturated is false", () => {
    const r = computeZipSaturation(
      [listing({ zip: "44310", doNotText: true, lastInboundAt: daysAgo(1) })],
      NOW,
    );
    expect(r.get("44310")).toEqual({ negativeSignals: 1, saturated: false });
  });

  it("at threshold: saturated flips true (default threshold 2, matching the 44310 doctrine example)", () => {
    const listings = [
      listing({ zip: "44310", doNotText: true, lastInboundAt: daysAgo(1) }),
      listing({ zip: "44310", notes: "OPT-OUT honored", lastInboundAt: daysAgo(2) }),
    ];
    const r = computeZipSaturation(listings, NOW);
    expect(r.get("44310")).toEqual({ negativeSignals: 2, saturated: true });
  });

  it("a custom threshold option overrides the env default", () => {
    const listings = [
      listing({ zip: "44310", doNotText: true, lastInboundAt: daysAgo(1) }),
      listing({ zip: "44310", notes: "L3 INBOUND: REJECTION", lastInboundAt: daysAgo(2) }),
      listing({ zip: "44310", notes: "OPT-OUT honored", lastInboundAt: daysAgo(3) }),
    ];
    const strict = computeZipSaturation(listings, NOW, { threshold: 3 });
    expect(strict.get("44310")).toEqual({ negativeSignals: 3, saturated: true });

    const belowStrict = computeZipSaturation(listings.slice(0, 2), NOW, { threshold: 3 });
    expect(belowStrict.get("44310")).toEqual({ negativeSignals: 2, saturated: false });
  });

  it("different ZIPs are counted independently", () => {
    const listings = [
      listing({ zip: "44310", doNotText: true, lastInboundAt: daysAgo(1) }),
      listing({ zip: "44310", notes: "OPT-OUT honored", lastInboundAt: daysAgo(2) }),
      listing({ zip: "48221", doNotText: true, lastInboundAt: daysAgo(1) }),
    ];
    const r = computeZipSaturation(listings, NOW);
    expect(r.get("44310")?.saturated).toBe(true);
    expect(r.get("48221")).toEqual({ negativeSignals: 1, saturated: false });
  });

  it("no listings → empty map", () => {
    expect(computeZipSaturation([], NOW).size).toBe(0);
  });
});
