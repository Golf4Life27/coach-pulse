import { describe, expect, it } from "vitest";
import type { AuditEntry } from "@/lib/audit-log";
import type { PulseDetectorInput } from "../detector-input";
import { detectPaidApiSpend } from "./paid-api-spend";

const NOW = new Date("2026-06-08T18:00:00Z");

function mk(
  hoursBefore: number,
  agent: string,
  recordId?: string,
): AuditEntry {
  return {
    ts: new Date(NOW.getTime() - hoursBefore * 3_600_000).toISOString(),
    agent,
    event: "paid_api_call",
    status: "confirmed_success",
    recordId,
  };
}

function mkInput(audit: AuditEntry[], env: Record<string, string | undefined> = {}): PulseDetectorInput {
  return {
    audit_log: audit,
    listings: [],
    test_count: null,
    previous_test_count: null,
    env,
    now: () => NOW,
  };
}

describe("detectPaidApiSpend", () => {
  it("returns no detection when there is zero paid-API activity", () => {
    expect(detectPaidApiSpend(mkInput([]))).toEqual([]);
  });

  it("fires info with a daily anchor when activity exists but no deal runs away", () => {
    const audit = [
      mk(1, "rentcast", "recA"),
      mk(2, "rentcast", "recB"),
      mk(3, "attom"),
    ];
    const out = detectPaidApiSpend(mkInput(audit));
    expect(out).toHaveLength(1);
    expect(out[0].severity).toBe("info");
    expect(out[0].id).toBe("paid_api_spend_24h");
    expect(out[0].source_data?.by_source_24h).toEqual({
      rentcast: 2,
      attom: 1,
      total: 3,
    });
    expect(out[0].source_data?.runaway_deals).toEqual([]);
  });

  it("bumps to warning when a deal crosses the runaway threshold", () => {
    const audit = Array.from({ length: 11 }, (_, i) =>
      mk(i * 0.1, "rentcast", "recHot"),
    );
    const out = detectPaidApiSpend(mkInput(audit));
    expect(out[0].severity).toBe("warning");
    const runaway = out[0].source_data?.runaway_deals as Array<{ recordId: string; calls: number }>;
    expect(runaway).toHaveLength(1);
    expect(runaway[0]).toMatchObject({ recordId: "recHot", calls: 11 });
  });

  it("bumps to critical when a deal is at >=2x the runaway threshold", () => {
    const audit = Array.from({ length: 20 }, (_, i) =>
      mk(i * 0.1, "attom", "recBurning"),
    );
    const out = detectPaidApiSpend(mkInput(audit));
    expect(out[0].severity).toBe("critical");
  });

  it("respects PULSE_PAID_API_RUNAWAY env override", () => {
    const audit = Array.from({ length: 4 }, (_, i) =>
      mk(i * 0.1, "rentcast", "recHot"),
    );
    const out = detectPaidApiSpend(
      mkInput(audit, { PULSE_PAID_API_RUNAWAY: "3" }),
    );
    expect(out[0].severity).toBe("warning");
  });

  it("ignores invalid env override and uses default", () => {
    const audit = Array.from({ length: 11 }, (_, i) =>
      mk(i * 0.1, "rentcast", "recHot"),
    );
    const out = detectPaidApiSpend(
      mkInput(audit, { PULSE_PAID_API_RUNAWAY: "not-a-number" }),
    );
    expect(out[0].severity).toBe("warning"); // 11 > default 10
  });
});
