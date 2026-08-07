import { describe, it, expect } from "vitest";
import {
  groupByZip,
  isPlausibleSqft,
  resolveSqft,
  summarizeSqftBackfill,
  SQFT_MIN,
  SQFT_MAX,
} from "./sqft-backfill";

describe("groupByZip — one paid call per ZIP, not per record", () => {
  it("groups records so a ZIP with 20 gaps costs ONE call", () => {
    const { byZip, noZip } = groupByZip([
      { recordId: "r1", address: "1 A St", zip: "48228" },
      { recordId: "r2", address: "2 B St", zip: "48228" },
      { recordId: "r3", address: "3 C St", zip: "44105" },
    ]);
    expect(byZip.get("48228")).toHaveLength(2);
    expect(byZip.get("44105")).toHaveLength(1);
    expect(noZip).toHaveLength(0);
  });

  it("sets aside a record with no usable ZIP rather than guessing one", () => {
    const { byZip, noZip } = groupByZip([
      { recordId: "r1", address: "1 A St", zip: null },
      { recordId: "r2", address: "2 B St", zip: "bad" },
    ]);
    expect(byZip.size).toBe(0);
    expect(noZip).toHaveLength(2);
  });
});

describe("isPlausibleSqft — a bad sqft is worse than no sqft", () => {
  it("accepts a real house", () => {
    expect(isPlausibleSqft(900)).toBe(true);
    expect(isPlausibleSqft(2_400)).toBe(true);
  });

  it("rejects values that would produce a confident WRONG ARV", () => {
    // ARV = seed $/sqft × sqft. An 80 or a 200,000 here does not fail loudly,
    // it prices a house — at a number nobody would recognise as wrong.
    expect(isPlausibleSqft(80)).toBe(false);
    expect(isPlausibleSqft(200_000)).toBe(false);
    expect(isPlausibleSqft(0)).toBe(false);
    expect(isPlausibleSqft(-900)).toBe(false);
    expect(isPlausibleSqft(null)).toBe(false);
    expect(isPlausibleSqft("1200")).toBe(false);
    expect(isPlausibleSqft(NaN)).toBe(false);
  });

  it("pins the band so a later edit has to argue with a test", () => {
    expect(SQFT_MIN).toBe(300);
    expect(SQFT_MAX).toBe(12_000);
  });
});

describe("resolveSqft", () => {
  const feed = (rows: Array<{ address: string; squareFootage: number | null }>) =>
    async () => ({ candidates: rows, credentialed: true, error: null, raw_count: rows.length }) as never;

  it("fills sqft from the ZIP feed despite formatting drift", async () => {
    // The matcher is the one merged for enrichment: "Elm St" must find
    // "Elm Street" or the lead is lost to punctuation.
    const out = await resolveSqft(
      [{ recordId: "r1", address: "1234 Elm St, Detroit, MI 48228", zip: "48228" }],
      { fetchZip: feed([{ address: "1234 Elm Street, Detroit, MI 48228", squareFootage: 1_150 }]) },
    );
    expect(out[0].sqft).toBe(1_150);
    expect(out[0].skipped).toBeNull();
  });

  it("spends ONE call for many records in the same ZIP", async () => {
    let calls = 0;
    const counted = async (zip: string) => {
      calls++;
      return { candidates: [{ address: "1 A St", squareFootage: 900 }], credentialed: true, error: null, raw_count: 1 } as never;
    };
    await resolveSqft(
      [
        { recordId: "r1", address: "1 A St", zip: "48228" },
        { recordId: "r2", address: "2 B St", zip: "48228" },
        { recordId: "r3", address: "3 C St", zip: "48228" },
      ],
      { fetchZip: counted },
    );
    expect(calls).toBe(1);
  });

  it("names why a gap stayed open instead of reporting a silent zero", async () => {
    const out = await resolveSqft(
      [
        { recordId: "r1", address: "1 A St", zip: "48228" },
        { recordId: "r2", address: "9999 Missing Rd", zip: "48228" },
        { recordId: "r3", address: "2 B St", zip: "48228" },
        { recordId: "r4", address: "3 C St", zip: null },
      ],
      {
        fetchZip: feed([
          { address: "1 A St", squareFootage: 1_000 },
          { address: "2 B St", squareFootage: null },
        ]),
      },
    );
    expect(summarizeSqftBackfill(out)).toEqual({
      attempted: 4,
      filled: 1,
      by_skip: { no_feed_match: 1, feed_has_no_sqft: 1, no_zip: 1 },
    });
  });

  it("a vendor blip on one ZIP is a skip, never a thrown run", async () => {
    const out = await resolveSqft(
      [{ recordId: "r1", address: "1 A St", zip: "48228" }],
      { fetchZip: async () => { throw new Error("rentcast down"); } },
    );
    expect(out[0].skipped).toBe("zip_fetch_failed");
    expect(out[0].sqft).toBeNull();
  });

  it("refuses an out-of-band sqft rather than writing a wrong ARV input", async () => {
    const out = await resolveSqft(
      [{ recordId: "r1", address: "1 A St", zip: "48228" }],
      { fetchZip: feed([{ address: "1 A St", squareFootage: 47 }]) },
    );
    expect(out[0].skipped).toBe("sqft_out_of_band");
    expect(out[0].sqft).toBeNull();
  });

  it("stops starting new ZIPs when the wall clock runs out", async () => {
    let calls = 0;
    const out = await resolveSqft(
      [
        { recordId: "r1", address: "1 A St", zip: "48228" },
        { recordId: "r2", address: "2 B St", zip: "44105" },
      ],
      {
        fetchZip: async () => {
          calls++;
          return { candidates: [], credentialed: true, error: null, raw_count: 0 } as never;
        },
        outOfTime: () => calls >= 1,
      },
    );
    expect(calls).toBe(1);
    expect(out.length).toBeLessThan(2);
  });
});
