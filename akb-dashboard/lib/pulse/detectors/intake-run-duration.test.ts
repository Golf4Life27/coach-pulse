import { describe, it, expect } from "vitest";
import { detectIntakeRunDuration } from "./intake-run-duration";
import type { PulseDetectorInput } from "../detector-input";
import type { AuditEntry } from "@/lib/audit-log";

const NOW = new Date("2026-06-08T18:00:00Z");

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

function intakeAudit(totalMs: number, extra: Record<string, unknown> = {}): AuditEntry {
  return {
    ts: NOW.toISOString(),
    agent: "scout",
    event: "listings_intake_live",
    status: "confirmed_success",
    outputSummary: {
      timing: {
        total_ms: totalMs,
        per_zip_avg_ms: 10_000,
        zips_processed: 6,
        lambda_budget_ms: 180_000,
        collect_ms: 5_000,
        verify_ms: totalMs - 8_000,
        classify_write_ms: 3_000,
        ...extra,
      },
    },
  };
}

describe("detectIntakeRunDuration", () => {
  it("silent when no intake run is in the audit log", () => {
    expect(detectIntakeRunDuration(input([]))).toEqual([]);
  });

  it("silent on a healthy short run (well under the warn fraction)", () => {
    // 70s of 300s = 23% — fine
    expect(detectIntakeRunDuration(input([intakeAudit(70_000)]))).toEqual([]);
  });

  it("fires WARNING at >= 70% of the 300s ceiling (210s)", () => {
    const r = detectIntakeRunDuration(input([intakeAudit(215_000)]));
    expect(r).toHaveLength(1);
    expect(r[0].severity).toBe("warning");
    expect(r[0].id).toBe("intake_run_duration_creep");
  });

  it("escalates to CRITICAL at >= 85% (255s)", () => {
    const r = detectIntakeRunDuration(input([intakeAudit(260_000)]));
    expect(r).toHaveLength(1);
    expect(r[0].severity).toBe("critical");
  });

  it("surfaces the phase split in source_data for diagnosis", () => {
    const r = detectIntakeRunDuration(input([intakeAudit(220_000)]));
    expect(r[0].source_data?.collect_ms).toBe(5_000);
    expect(r[0].source_data?.verify_ms).toBe(212_000);
    expect(r[0].source_data?.per_zip_avg_ms).toBe(10_000);
  });

  it("respects env fraction overrides", () => {
    // Lower the warn threshold so a 50% run fires.
    const r = detectIntakeRunDuration(
      input([intakeAudit(150_000)], { PULSE_INTAKE_DURATION_WARN_FRACTION: "0.4" }),
    );
    expect(r).toHaveLength(1);
    expect(r[0].severity).toBe("warning");
  });

  it("reads the MOST RECENT intake run (newest-first)", () => {
    const r = detectIntakeRunDuration(
      input([intakeAudit(265_000), intakeAudit(50_000)]),
    );
    // first entry (265s = 88%) is the recent one → critical, not the 50s one
    expect(r).toHaveLength(1);
    expect(r[0].severity).toBe("critical");
  });

  it("also reads dry-run intake events", () => {
    const dry: AuditEntry = { ...intakeAudit(220_000), event: "listings_intake_dry_run" };
    const r = detectIntakeRunDuration(input([dry]));
    expect(r).toHaveLength(1);
  });

  it("ignores intake audits without a timing block (older shape)", () => {
    const old: AuditEntry = {
      ts: NOW.toISOString(),
      agent: "scout",
      event: "listings_intake_live",
      status: "confirmed_success",
      outputSummary: { accepted: 3 },
    };
    expect(detectIntakeRunDuration(input([old]))).toEqual([]);
  });
});
