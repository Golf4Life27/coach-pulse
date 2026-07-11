// Mission Control heartbeat: day bucketing, freshness tiers, slots, tape.
import { describe, it, expect } from "vitest";
import {
  countLiveNegotiations,
  bucketByDay,
  cronFreshness,
  nextSendSlotIso,
  buildTape,
} from "./heartbeat";

const TODAY = "2026-07-04T05:00:00.000Z"; // CT midnight
const YDAY = "2026-07-03T05:00:00.000Z";

describe("bucketByDay — operator-local day boundaries", () => {
  it("splits today vs yesterday and drops older", () => {
    const rows = [
      { ts: "2026-07-04T13:02:31.000Z" }, // today (Linda)
      { ts: "2026-07-04T15:00:40.000Z" }, // today
      { ts: "2026-07-03T13:03:39.000Z" }, // yesterday
      { ts: "2026-07-02T15:15:21.000Z" }, // older — dropped
      { ts: "garbage" },
    ];
    expect(bucketByDay(rows, TODAY, YDAY)).toEqual({ today: 2, yesterday: 1 });
  });
});

describe("cronFreshness — daily cron tiers", () => {
  const NOW = "2026-07-04T15:14:00.000Z";
  it("ok within 26h, late to 50h, stale beyond, never on null", () => {
    expect(cronFreshness("2026-07-04T13:02:00.000Z", NOW)).toBe("ok");
    expect(cronFreshness("2026-07-03T09:00:00.000Z", NOW)).toBe("late");
    expect(cronFreshness("2026-07-01T13:00:00.000Z", NOW)).toBe("stale");
    expect(cronFreshness(null, NOW)).toBe("never");
  });
});

describe("nextSendSlotIso — 15:00 / 17:30 / 19:45 UTC", () => {
  it("picks the next slot today, rolls to tomorrow after the last", () => {
    expect(nextSendSlotIso("2026-07-04T15:14:00.000Z")).toBe("2026-07-04T17:30:00.000Z");
    expect(nextSendSlotIso("2026-07-04T19:46:00.000Z")).toBe("2026-07-05T15:00:00.000Z");
    expect(nextSendSlotIso("2026-07-04T03:00:00.000Z")).toBe("2026-07-04T15:00:00.000Z");
  });
});

describe("buildTape — merged newest-first, quarantine labeled", () => {
  it("labels quarantined (Dead) sends, formats offers, merges replies", () => {
    const tape = buildTape({
      outbound: [
        { ts: "2026-07-04T15:00:40.000Z", address: "1654 2nd St NW, Center Point, AL", offer: 80_665, status: "Texted" },
        { ts: "2026-07-04T15:00:46.000Z", address: "3232 Magnolia Ave, Tarrant, AL", offer: 25_500, status: "Dead" },
      ],
      inbound: [{ ts: "2026-07-03T15:11:22.000Z", address: "7200 Suttles Dr SW, South Fulton, GA" }],
    });
    expect(tape.map((t) => t.kind)).toEqual(["quarantined", "sent", "reply"]);
    expect(tape[0].line).toContain("3232 Magnolia Ave");
    expect(tape[1].line).toContain("$80,665");
    expect(tape[2].line).toContain("7200 Suttles Dr SW");
  });
});

describe("countLiveNegotiations — the north-star counter (operator 2026-07-10)", () => {
  it("counts this month's replied conversation-status records only", () => {
    const rows = [
      { lastInboundAt: "2026-07-09T18:10:00Z", status: "Negotiating" },        // Nazareth-class ✓
      { lastInboundAt: "2026-07-09T17:45:00Z", status: "Response Received" },  // Mahmoud-class ✓
      { lastInboundAt: "2026-06-10T16:18:00Z", status: "Negotiating" },        // last month ✗
      { lastInboundAt: "2026-07-08T12:00:00Z", status: "Dead" },               // rejected ✗
      { lastInboundAt: null, status: "Negotiating" },                          // never replied ✗
    ];
    expect(countLiveNegotiations(rows, "2026-07-01T05:00:00.000Z")).toBe(2);
  });
});
