import { describe, it, expect } from "vitest";
import { detectVendorHealth, tallyVendorHealth, looksLikeAuthFailure } from "./vendor-health";
import type { PulseDetectorInput } from "../detector-input";
import type { AuditEntry } from "@/lib/audit-log";

const NOW = new Date("2026-08-04T20:00:00Z");

function input(
  audit: AuditEntry[],
  env: Record<string, string | undefined> = {},
  rentcast_month_spend: PulseDetectorInput["rentcast_month_spend"] = null,
): PulseDetectorInput {
  return {
    audit_log: audit,
    listings: [],
    test_count: null,
    previous_test_count: null,
    env,
    rentcast_month_spend,
    now: () => NOW,
  };
}

function paidCall(
  agent: "rentcast" | "attom",
  http: number,
  { minutesAgo = 1 }: { minutesAgo?: number } = {},
): AuditEntry {
  return {
    ts: new Date(NOW.getTime() - minutesAgo * 60_000).toISOString(),
    agent,
    event: "paid_api_call",
    status: http >= 200 && http < 300 ? "confirmed_success" : "confirmed_failure",
    outputSummary: { endpoint: "listings/sale", http },
  };
}

function quoSend(ok: boolean): AuditEntry {
  return {
    ts: NOW.toISOString(),
    agent: "crier",
    event: "send_attempt",
    status: ok ? "confirmed_success" : "confirmed_failure",
    outputSummary: { http: ok ? 200 : 401 },
  };
}

const rows = (n: number, f: () => AuditEntry) => Array.from({ length: n }, f);

describe("tallyVendorHealth", () => {
  it("separates vendors that share the paid_api_call event name", () => {
    // The exact blind spot that let the 2-day RentCast outage run unnoticed:
    // one event name, two vendors, opposite health.
    const audit = [...rows(10, () => paidCall("rentcast", 403)), ...rows(10, () => paidCall("attom", 200))];
    const t = tallyVendorHealth(audit, 6, NOW);
    expect(t.get("rentcast")).toMatchObject({ success: 0, failure: 10 });
    expect(t.get("attom")).toMatchObject({ success: 10, failure: 0 });
  });

  it("ignores rows outside the window", () => {
    const t = tallyVendorHealth(rows(10, () => paidCall("rentcast", 403, { minutesAgo: 600 })), 6, NOW);
    expect(t.get("rentcast")).toBeUndefined();
  });

  it("reads Quo health off agent 'crier', which is what live senders actually stamp", () => {
    const t = tallyVendorHealth([...rows(5, () => quoSend(false)), quoSend(true)], 6, NOW);
    expect(t.get("quo")).toMatchObject({ success: 1, failure: 5 });
  });

  it("counts an unconfirmed send as neither success nor failure", () => {
    const pending: AuditEntry = { ...quoSend(true), status: "uncertain" };
    const t = tallyVendorHealth([pending], 6, NOW);
    expect(t.get("quo")).toMatchObject({ success: 0, failure: 0 });
  });
});

describe("looksLikeAuthFailure", () => {
  it("calls a 403-majority an auth problem", () => {
    expect(looksLikeAuthFailure([403, 500])).toBe(true);
    expect(looksLikeAuthFailure([500, 403])).toBe(false);
    expect(looksLikeAuthFailure([])).toBe(false);
  });
});

describe("detectVendorHealth", () => {
  it("fires CRITICAL on a total vendor outage and names it as a credential problem", () => {
    const fires = detectVendorHealth(input(rows(10, () => paidCall("rentcast", 403))));
    expect(fires).toHaveLength(1);
    expect(fires[0].severity).toBe("critical");
    expect(fires[0].id).toBe("vendor_health:rentcast");
    expect(fires[0].source_data?.auth_shaped).toBe(true);
    expect(fires[0].title).toContain("RENTCAST");
  });

  it("stays silent on a healthy vendor", () => {
    expect(detectVendorHealth(input(rows(20, () => paidCall("rentcast", 200))))).toEqual([]);
  });

  it("stays silent below min_samples — one bad call is not an outage", () => {
    expect(detectVendorHealth(input(rows(2, () => paidCall("rentcast", 403))))).toEqual([]);
  });

  it("does not let a healthy vendor mask a failing one", () => {
    const audit = [...rows(10, () => paidCall("rentcast", 403)), ...rows(90, () => paidCall("attom", 200))];
    const fires = detectVendorHealth(input(audit));
    expect(fires.map((f) => f.source_data?.vendor)).toEqual(["rentcast"]);
  });

  it("warns at 80% of the RentCast monthly cap", () => {
    const fires = detectVendorHealth(input([], {}, { used: 800, cap: 1000 }));
    expect(fires).toHaveLength(1);
    expect(fires[0].severity).toBe("warning");
    expect(fires[0].id).toBe("vendor_health:rentcast_monthly_cap");
  });

  it("escalates to critical once the cap is reached", () => {
    const fires = detectVendorHealth(input([], {}, { used: 1000, cap: 1000 }));
    expect(fires[0].severity).toBe("critical");
  });

  it("stays silent on an unreadable meter rather than guessing", () => {
    expect(detectVendorHealth(input([], {}, { used: null, cap: 1000 }))).toEqual([]);
    expect(detectVendorHealth(input([], {}, null))).toEqual([]);
  });
});
