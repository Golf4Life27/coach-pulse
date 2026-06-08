import { describe, expect, it } from "vitest";
import type { AuditEntry } from "@/lib/audit-log";
import {
  countCallsByDeal24h,
  countCallsBySource24h,
  splitRunaway,
} from "./derive";

const NOW = new Date("2026-06-08T18:00:00Z");

function mk(
  hoursBefore: number,
  agent: string,
  recordId?: string,
  event = "paid_api_call",
): AuditEntry {
  return {
    ts: new Date(NOW.getTime() - hoursBefore * 3_600_000).toISOString(),
    agent,
    event,
    status: "confirmed_success",
    recordId,
  };
}

describe("countCallsBySource24h", () => {
  it("counts rentcast + attom paid_api_call events in the last 24h", () => {
    const audit = [
      mk(1, "rentcast", "rec1"),
      mk(2, "rentcast", "rec1"),
      mk(3, "attom"),
      mk(5, "attom", "rec2"),
    ];
    expect(countCallsBySource24h(audit, NOW)).toEqual({
      rentcast: 2,
      attom: 2,
      total: 4,
    });
  });

  it("excludes calls older than 24h", () => {
    const audit = [mk(1, "rentcast", "rec1"), mk(25, "rentcast", "rec1")];
    expect(countCallsBySource24h(audit, NOW).rentcast).toBe(1);
  });

  it("ignores non-paid_api_call events", () => {
    const audit = [
      mk(1, "rentcast", "rec1", "verify_listing"),
      mk(1, "sentry", "rec1", "gate_run"),
    ];
    expect(countCallsBySource24h(audit, NOW).total).toBe(0);
  });

  it("ignores events from non-paid agents", () => {
    const audit = [mk(1, "pulse"), mk(1, "sentry"), mk(1, "crier")];
    expect(countCallsBySource24h(audit, NOW).total).toBe(0);
  });
});

describe("countCallsByDeal24h", () => {
  it("groups calls by recordId and sorts by total desc", () => {
    const audit = [
      mk(1, "rentcast", "recA"),
      mk(2, "rentcast", "recA"),
      mk(2, "attom", "recA"),
      mk(3, "rentcast", "recB"),
    ];
    const rows = countCallsByDeal24h(audit, NOW);
    expect(rows).toEqual([
      { recordId: "recA", calls: 3, bySource: { rentcast: 2, attom: 1 } },
      { recordId: "recB", calls: 1, bySource: { rentcast: 1, attom: 0 } },
    ]);
  });

  it("drops calls without a recordId (zip-level discovery)", () => {
    const audit = [mk(1, "attom"), mk(1, "rentcast", "rec1")];
    const rows = countCallsByDeal24h(audit, NOW);
    expect(rows.map((r) => r.recordId)).toEqual(["rec1"]);
  });
});

describe("splitRunaway", () => {
  it("partitions strictly above threshold", () => {
    const rows = [
      { recordId: "hot", calls: 12, bySource: { rentcast: 8, attom: 4 } },
      { recordId: "warm", calls: 10, bySource: { rentcast: 10, attom: 0 } },
      { recordId: "cold", calls: 2, bySource: { rentcast: 2, attom: 0 } },
    ];
    const split = splitRunaway(rows, 10);
    expect(split.runaway.map((r) => r.recordId)).toEqual(["hot"]);
    expect(split.rest.map((r) => r.recordId)).toEqual(["warm", "cold"]);
  });
});
