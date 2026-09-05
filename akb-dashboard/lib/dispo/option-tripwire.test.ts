import { describe, expect, it } from "vitest";
import type { Listing } from "@/lib/types";
import {
  composeTripwireSms,
  daysUntil,
  selectTripwireCandidates,
  tripwireKey,
  tripwireStage,
  type TripwireStage,
} from "@/lib/dispo/option-tripwire";

const NOW = "2026-09-05T13:05:00.000Z"; // matches the cron's "5 13 * * *" UTC slot

function mkListing(overrides: Partial<Listing> = {}): Listing {
  return {
    id: "recABC123",
    address: "123 Main St",
    city: "Detroit",
    zip: "48201",
    listPrice: null,
    mao: null,
    dom: null,
    offerTier: null,
    liveStatus: null,
    executionPath: null,
    outreachStatus: "Negotiating",
    lastOutreachDate: null,
    agentName: "Jane Agent",
    agentPhone: null,
    agentEmail: null,
    verificationUrl: null,
    notes: null,
    distressScore: null,
    distressBucket: null,
    bedrooms: null,
    contractExecutedAt: "2026-08-20",
    optionDeadline: "2026-09-10",
    ...overrides,
  } as Listing;
}

describe("daysUntil", () => {
  it("counts whole UTC calendar days, ignoring time-of-day", () => {
    expect(daysUntil("2026-09-10", "2026-09-05T13:05:00.000Z")).toBe(5);
    expect(daysUntil("2026-09-10", "2026-09-05T00:00:00.000Z")).toBe(5);
    expect(daysUntil("2026-09-10", "2026-09-05T23:59:59.999Z")).toBe(5);
  });

  it("is negative once the deadline date has passed", () => {
    expect(daysUntil("2026-09-01", "2026-09-05T13:05:00.000Z")).toBe(-4);
  });

  it("is zero on the deadline's own calendar date", () => {
    expect(daysUntil("2026-09-05", "2026-09-05T23:00:00.000Z")).toBe(0);
  });

  it("returns null for unparseable input", () => {
    expect(daysUntil("not-a-date", NOW)).toBeNull();
    expect(daysUntil("2026-09-10", "not-a-date")).toBeNull();
  });
});

describe("tripwireStage", () => {
  const stageFor = (daysFromNow: number): TripwireStage | null => {
    const deadline = new Date(Date.parse(NOW) + daysFromNow * 86_400_000).toISOString().slice(0, 10);
    return tripwireStage(deadline, NOW);
  };

  it("is null with no deadline", () => {
    expect(tripwireStage(null, NOW)).toBeNull();
    expect(tripwireStage(undefined, NOW)).toBeNull();
    expect(tripwireStage("", NOW)).toBeNull();
  });

  it("is null far out (daysLeft > 5)", () => {
    expect(stageFor(6)).toBeNull();
    expect(stageFor(30)).toBeNull();
  });

  it("is t5 at the top edge, daysLeft === 5", () => {
    expect(stageFor(5)).toBe("t5");
  });

  it("is t5 at the bottom edge, daysLeft === 4", () => {
    expect(stageFor(4)).toBe("t5");
  });

  it("is null on the gap day, daysLeft === 3 (neither t5 nor t2)", () => {
    expect(stageFor(3)).toBeNull();
  });

  it("is t2 at the top edge, daysLeft === 2", () => {
    expect(stageFor(2)).toBe("t2");
  });

  it("is t2 at daysLeft === 1", () => {
    expect(stageFor(1)).toBe("t2");
  });

  it("is t2 at the bottom edge, daysLeft === 0 (deadline is today)", () => {
    expect(stageFor(0)).toBe("t2");
  });

  it("is lapsed the day after the deadline, daysLeft === -1", () => {
    expect(stageFor(-1)).toBe("lapsed");
  });

  it("is lapsed up to 14 days past the deadline, then goes quiet (stale records are history)", () => {
    expect(stageFor(-14)).toBe("lapsed");
    expect(stageFor(-15)).toBeNull();
    expect(stageFor(-30)).toBeNull();
  });
});

describe("selectTripwireCandidates", () => {
  it("includes a listing with an executed contract, a live option deadline, and an active status", () => {
    const listings = [mkListing()];
    const out = selectTripwireCandidates(listings, NOW);
    expect(out).toHaveLength(1);
    expect(out[0].listing.id).toBe("recABC123");
    expect(out[0].stage).toBe("t5");
    expect(out[0].daysLeft).toBe(5);
  });

  it("excludes a listing with no executed contract", () => {
    const listings = [mkListing({ contractExecutedAt: null })];
    expect(selectTripwireCandidates(listings, NOW)).toHaveLength(0);
  });

  it("excludes a listing with no option deadline", () => {
    const listings = [mkListing({ optionDeadline: null })];
    expect(selectTripwireCandidates(listings, NOW)).toHaveLength(0);
  });

  it.each(["Dead", "Walked", "Terminated", "Closed", "No Response"])(
    "excludes outreachStatus=%s even with a live deadline",
    (status) => {
      const listings = [mkListing({ outreachStatus: status })];
      expect(selectTripwireCandidates(listings, NOW)).toHaveLength(0);
    },
  );

  it("excludes a listing whose deadline is outside any stage window", () => {
    const listings = [mkListing({ optionDeadline: "2026-10-15" })]; // way > 5 days out
    expect(selectTripwireCandidates(listings, NOW)).toHaveLength(0);
  });

  it("includes a lapsed deadline (daysLeft < 0)", () => {
    const listings = [mkListing({ optionDeadline: "2026-09-01" })];
    const out = selectTripwireCandidates(listings, NOW);
    expect(out).toHaveLength(1);
    expect(out[0].stage).toBe("lapsed");
    expect(out[0].daysLeft).toBe(-4);
  });

  it("returns one candidate per qualifying listing, preserving order", () => {
    const listings = [
      mkListing({ id: "rec1", optionDeadline: "2026-09-07" }), // t2, daysLeft=2
      mkListing({ id: "rec2", outreachStatus: "Dead" }), // excluded
      mkListing({ id: "rec3", optionDeadline: "2026-09-08" }), // gap day, daysLeft=3 -> null
      mkListing({ id: "rec4", optionDeadline: "2026-09-09" }), // t5, daysLeft=4
    ];
    const out = selectTripwireCandidates(listings, NOW);
    expect(out.map((c) => c.listing.id)).toEqual(["rec1", "rec4"]);
  });
});

describe("composeTripwireSms", () => {
  const listing = mkListing({ address: "4521 Strathmoor St", optionDeadline: "2026-09-10" });

  it("t5 leads with the decision and stays under 300 chars", () => {
    const sms = composeTripwireSms(listing, "t5", 5);
    expect(sms).toContain("OPTION T-5");
    expect(sms).toContain("4521 Strathmoor St");
    expect(sms).toContain("assign");
    expect(sms).toContain("extend");
    expect(sms).toContain("terminate");
    expect(sms).toMatch(/Sep 10/);
    expect(sms.length).toBeLessThan(300);
  });

  it("t2 names the EMD dollar amount and says TERMINATE", () => {
    const sms = composeTripwireSms(listing, "t2", 1);
    expect(sms).toContain("OPTION T-2");
    expect(sms).toContain("DECIDE");
    expect(sms).toContain("TERMINATE");
    expect(sms).toContain("$1,000");
    expect(sms.length).toBeLessThan(300);
  });

  it("lapsed says the deadline passed and to confirm with title today", () => {
    const sms = composeTripwireSms(listing, "lapsed", -3);
    expect(sms).toContain("OPTION LAPSED");
    expect(sms).toContain("passed");
    expect(sms).toContain("title");
    expect(sms).toContain("TODAY");
    expect(sms.length).toBeLessThan(300);
  });

  it("never exceeds 300 chars even with a pathologically long address", () => {
    const longAddress = "A".repeat(500) + " St";
    const sms = composeTripwireSms(mkListing({ address: longAddress, optionDeadline: "2026-09-10" }), "t2", 0);
    expect(sms.length).toBeLessThanOrEqual(300);
    expect(sms).toContain("OPTION T-2");
  });

  it("falls back to the record id when address is empty", () => {
    const sms = composeTripwireSms(mkListing({ address: "", id: "recXYZ" }), "t5", 5);
    expect(sms).toContain("recXYZ");
  });
});

describe("tripwireKey", () => {
  it("formats as tripwire:<recordId>:<stage>", () => {
    expect(tripwireKey("recABC123", "t5")).toBe("tripwire:recABC123:t5");
    expect(tripwireKey("recABC123", "t2")).toBe("tripwire:recABC123:t2");
    expect(tripwireKey("recABC123", "lapsed")).toBe("tripwire:recABC123:lapsed");
  });

  it("keys differ by stage for the same record", () => {
    const a = tripwireKey("recSAME", "t5");
    const b = tripwireKey("recSAME", "t2");
    expect(a).not.toBe(b);
  });
});
