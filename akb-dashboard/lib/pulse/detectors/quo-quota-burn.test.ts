// Phase 14.3 / Q.2 — Quo quota burn tests.

import { describe, it, expect } from "vitest";
import { countQuoSendsLast24h, detectQuoQuotaBurn } from "./quo-quota-burn";
import type { AuditEntry } from "@/lib/audit-log";

const NOW = new Date("2026-05-19T03:00:00Z");

function quoSend(hoursBefore: number): AuditEntry {
  return {
    ts: new Date(NOW.getTime() - hoursBefore * 3_600_000).toISOString(),
    agent: "quo",
    event: "send_attempt",
    status: "confirmed_success",
  };
}

const baseInput = {
  audit_log: [] as AuditEntry[],
  listings: [],
  test_count: null,
  previous_test_count: null,
  env: {},
  now: () => NOW,
};

describe("countQuoSendsLast24h", () => {
  it("counts quo.send_attempt within 24h", () => {
    expect(
      countQuoSendsLast24h([quoSend(1), quoSend(5), quoSend(30)], NOW),
    ).toBe(2);
  });

  it("ignores non-quo agents + non-send events", () => {
    const audit: AuditEntry[] = [
      quoSend(1),
      { ts: quoSend(1).ts, agent: "gmail", event: "send_attempt", status: "confirmed_success" },
      { ts: quoSend(1).ts, agent: "quo", event: "fetch", status: "confirmed_success" },
    ];
    expect(countQuoSendsLast24h(audit, NOW)).toBe(1);
  });
});

describe("detectQuoQuotaBurn", () => {
  it("doesn't fire below warning threshold", () => {
    // Default limit 500, warning 70% = 350. 100 sends → 20% → silent.
    const dets = detectQuoQuotaBurn({
      ...baseInput,
      audit_log: Array.from({ length: 100 }, () => quoSend(1)),
    });
    expect(dets).toEqual([]);
  });

  it("fires warning at ≥70% of limit", () => {
    // 350/500 = 70%
    const dets = detectQuoQuotaBurn({
      ...baseInput,
      audit_log: Array.from({ length: 350 }, () => quoSend(1)),
    });
    expect(dets[0].severity).toBe("warning");
    expect(dets[0].detector_id).toBe("quo_quota_burn");
  });

  it("fires critical at ≥90% of limit", () => {
    // 450/500 = 90%
    const dets = detectQuoQuotaBurn({
      ...baseInput,
      audit_log: Array.from({ length: 450 }, () => quoSend(1)),
    });
    expect(dets[0].severity).toBe("critical");
  });

  it("disabled when PULSE_QUO_DAILY_LIMIT=0", () => {
    const dets = detectQuoQuotaBurn({
      ...baseInput,
      audit_log: Array.from({ length: 1000 }, () => quoSend(1)),
      env: { PULSE_QUO_DAILY_LIMIT: "0" },
    });
    expect(dets).toEqual([]);
  });

  it("respects operator-defined limit override", () => {
    const dets = detectQuoQuotaBurn({
      ...baseInput,
      audit_log: Array.from({ length: 80 }, () => quoSend(1)),
      env: { PULSE_QUO_DAILY_LIMIT: "100" }, // 80% of 100
    });
    expect(dets[0].severity).toBe("warning");
  });
});
