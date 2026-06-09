import { describe, it, expect } from "vitest";
import { detectFirecrawlPaymentRequired } from "./firecrawl-payment-required";
import type { PulseDetectorInput } from "../detector-input";
import type { AuditEntry } from "@/lib/audit-log";

const NOW = new Date("2026-06-08T22:00:00Z");

function input(audit: AuditEntry[], env: Record<string, string | undefined> = {}): PulseDetectorInput {
  return {
    audit_log: audit,
    listings: [],
    test_count: null,
    previous_test_count: null,
    env,
    now: () => NOW,
  };
}

function intakeAudit(fc: Record<string, unknown>): AuditEntry {
  return {
    ts: NOW.toISOString(),
    agent: "scout",
    event: "listings_intake_live",
    status: "confirmed_success",
    outputSummary: {
      firecrawl_payment_required: false,
      firecrawl_payment_required_count: 0,
      firecrawl_balance_remaining: null,
      zips_kept_due_blocked: 0,
      ...fc,
    },
  };
}

describe("detectFirecrawlPaymentRequired", () => {
  it("silent when no intake telemetry is present", () => {
    expect(detectFirecrawlPaymentRequired(input([]))).toEqual([]);
  });

  it("silent on a healthy run (no 402, balance fine)", () => {
    const r = detectFirecrawlPaymentRequired(
      input([intakeAudit({ firecrawl_balance_remaining: 5000 })]),
    );
    expect(r).toEqual([]);
  });

  it("fires CRITICAL on a 402 (wallet empty NOW)", () => {
    const r = detectFirecrawlPaymentRequired(
      input([intakeAudit({ firecrawl_payment_required: true, firecrawl_payment_required_count: 6, zips_kept_due_blocked: 6 })]),
    );
    expect(r).toHaveLength(1);
    expect(r[0].severity).toBe("critical");
    expect(r[0].id).toBe("firecrawl_payment_required");
    expect(r[0].title).toContain("WALLET EMPTY");
    expect(r[0].source_data?.zips_kept_due_blocked).toBe(6);
  });

  it("fires WARNING on low balance (no 402 yet)", () => {
    const r = detectFirecrawlPaymentRequired(
      input([intakeAudit({ firecrawl_balance_remaining: 20 })]),
    );
    expect(r).toHaveLength(1);
    expect(r[0].severity).toBe("warning");
    expect(r[0].title).toContain("balance low");
  });

  it("does NOT warn when balance is above the floor", () => {
    const r = detectFirecrawlPaymentRequired(
      input([intakeAudit({ firecrawl_balance_remaining: 500 })]),
    );
    expect(r).toEqual([]);
  });

  it("402 takes precedence over low balance (CRITICAL not WARNING)", () => {
    const r = detectFirecrawlPaymentRequired(
      input([intakeAudit({ firecrawl_payment_required: true, firecrawl_balance_remaining: 0 })]),
    );
    expect(r[0].severity).toBe("critical");
  });

  it("respects the PULSE_FIRECRAWL_LOW_BALANCE_FLOOR override", () => {
    const r = detectFirecrawlPaymentRequired(
      input([intakeAudit({ firecrawl_balance_remaining: 80 })], { PULSE_FIRECRAWL_LOW_BALANCE_FLOOR: "100" }),
    );
    expect(r).toHaveLength(1);
    expect(r[0].severity).toBe("warning");
  });

  it("null balance + no 402 → silent (can't assert anything)", () => {
    const r = detectFirecrawlPaymentRequired(
      input([intakeAudit({ firecrawl_balance_remaining: null })]),
    );
    expect(r).toEqual([]);
  });
});
