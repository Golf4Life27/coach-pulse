import { describe, it, expect } from "vitest";
import {
  isoDay,
  dailySampleKey,
  aggregateRows,
  summarize,
  buildUpsertFields,
  ZDS,
  type DailyStatRow,
} from "./zip-daily-stats";

function row(over: Partial<DailyStatRow> & { date: string; zip: string }): DailyStatRow {
  return {
    recordId: "rec",
    sampleKey: dailySampleKey(over.zip, new Date(`${over.date}T00:00:00Z`)),
    considered: 0,
    accepted: 0,
    rejected: 0,
    ingested: 0,
    domSum: 0,
    domCount: 0,
    priceSum: 0,
    priceCount: 0,
    ...over,
  };
}

describe("isoDay / dailySampleKey", () => {
  it("formats the UTC calendar day", () => {
    expect(isoDay(new Date("2026-05-27T23:59:00Z"))).toBe("2026-05-27");
  });
  it("composes {zip}_{day}", () => {
    expect(dailySampleKey("78201", new Date("2026-05-27T12:00:00Z"))).toBe("78201_2026-05-27");
  });
});

describe("aggregateRows", () => {
  it("sums counters and counts distinct days", () => {
    const agg = aggregateRows([
      row({ zip: "78201", date: "2026-05-25", considered: 10, accepted: 2, rejected: 8, ingested: 4, domSum: 100, domCount: 2, priceSum: 200000, priceCount: 2 }),
      row({ zip: "78201", date: "2026-05-26", considered: 5, accepted: 1, rejected: 4, ingested: 2, domSum: 30, domCount: 1, priceSum: 150000, priceCount: 1 }),
    ]);
    expect(agg.considered).toBe(15);
    expect(agg.accepted).toBe(3);
    expect(agg.rejected).toBe(12);
    expect(agg.ingested).toBe(6);
    expect(agg.domSum).toBe(130);
    expect(agg.domCount).toBe(3);
    expect(agg.sampleDays).toBe(2);
  });

  it("counts the same day once even across multiple rows", () => {
    const agg = aggregateRows([
      row({ zip: "78201", date: "2026-05-25", considered: 1 }),
      row({ zip: "78201", date: "2026-05-25", considered: 1 }),
    ]);
    expect(agg.sampleDays).toBe(1);
    expect(agg.considered).toBe(2);
  });

  it("is all-zero for an empty set", () => {
    const agg = aggregateRows([]);
    expect(agg.considered).toBe(0);
    expect(agg.sampleDays).toBe(0);
  });
});

describe("summarize", () => {
  it("derives accept rate, rounded averages, ingested volume", () => {
    const s = summarize(
      aggregateRows([
        row({ zip: "x", date: "2026-05-25", considered: 8, accepted: 2, ingested: 5, domSum: 100, domCount: 3, priceSum: 300000, priceCount: 3 }),
      ]),
    );
    expect(s.acceptRate).toBeCloseTo(0.25, 6);
    expect(s.avgDom).toBe(33); // round(100/3)
    expect(s.avgListPrice).toBe(100000);
    expect(s.recordsIngested).toBe(5);
    expect(s.considered).toBe(8);
  });

  it("returns null rates/averages when there is no data", () => {
    const s = summarize(aggregateRows([]));
    expect(s.acceptRate).toBeNull();
    expect(s.avgDom).toBeNull();
    expect(s.avgListPrice).toBeNull();
    expect(s.recordsIngested).toBe(0);
  });
});

describe("buildUpsertFields", () => {
  it("maps to field IDs with the day-stamped Date + Sample_Key", () => {
    const f = buildUpsertFields({
      zip: "78201",
      date: new Date("2026-05-27T18:30:00Z"),
      considered: 10,
      accepted: 3,
      rejected: 7,
      ingested: 5,
      domSum: 40,
      domCount: 2,
      priceSum: 500000,
      priceCount: 2,
      runAt: "2026-05-27T18:30:00.000Z",
    });
    expect(f[ZDS.sampleKey]).toBe("78201_2026-05-27");
    expect(f[ZDS.date]).toBe("2026-05-27");
    expect(f[ZDS.rejected]).toBe(7);
    expect(f[ZDS.runAt]).toBe("2026-05-27T18:30:00.000Z");
  });
});
