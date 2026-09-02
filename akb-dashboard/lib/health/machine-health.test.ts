import { describe, it, expect } from "vitest";
import { parseLaneRun, summarizeLaneRuns, summarizeVendors, type AuditRow } from "./machine-health";
import type { PulseDetection } from "@/lib/pulse/types";

const NOW = Date.parse("2026-09-02T22:00:00Z");

function outreach(ts: string, sent: number, errors: number, credits = 40, tripped = false): AuditRow {
  return {
    ts,
    agent: "crier",
    event: "h2_outreach_live",
    status: errors > 0 ? "uncertain" : "confirmed_success",
    outputSummary: {
      processed: 20,
      first_touch_sent: sent,
      errors,
      presend_probe: { probes: 20, credits_used: credits },
      send_cap: { daily: { cap: 200 } },
      quo_breaker: { tripped, tripped_at: tripped ? ts : null },
    },
  };
}

describe("parseLaneRun", () => {
  it("reads the outreach counters and flags a blank run", () => {
    const r = parseLaneRun(outreach("2026-09-02T14:02:03Z", 0, 19));
    expect(r).toMatchObject({ lane: "outreach", processed: 20, sent: 0, errors: 19, probeCredits: 40, blank: true, note: "blank run" });
  });
  it("reads bumps and labels a breaker trip", () => {
    const r = parseLaneRun({ ts: "2026-09-02T16:15:20Z", event: "h2_bump_live", outputSummary: { processed: 10, bumped: 0, errors: 10, quo_breaker: { tripped: true } } });
    expect(r).toMatchObject({ lane: "bump", sent: 0, blank: true, note: "402 breaker tripped" });
  });
  it("ignores other events", () => {
    expect(parseLaneRun({ ts: "x", event: "quo_reconcile" })).toBeNull();
  });
});

describe("summarizeLaneRuns", () => {
  it("totals today, drops runs older than 24h, and reports the cap and last send", () => {
    const s = summarizeLaneRuns(
      [
        outreach("2026-09-02T13:03:47Z", 1, 16),
        outreach("2026-09-02T14:02:03Z", 0, 19),
        outreach("2026-09-02T15:00:56Z", 0, 20),
        outreach("2026-09-01T10:00:00Z", 12, 0), // > 24h ago, excluded
      ],
      NOW,
    );
    expect(s.runsToday).toBe(3);
    expect(s.sentToday).toBe(1);
    expect(s.blankRunsToday).toBe(2);
    expect(s.probeCreditsToday).toBe(120);
    expect(s.dailyCap).toBe(200);
    expect(s.lastSentAt).toBe("2026-09-02T13:03:47Z");
    expect(s.runs[0].ts).toBe("2026-09-02T15:00:56Z"); // newest first
  });
});

describe("summarizeVendors", () => {
  const det = (detector_id: PulseDetection["detector_id"], title: string): PulseDetection => ({
    id: `${detector_id}_x`,
    detector_id,
    severity: "critical",
    title,
    description: "",
    detected_at: "2026-09-02T21:00:00Z",
  });
  it("shows Quo credits EMPTY after a recent 402 trip", () => {
    const v = summarizeVendors([], [{ ts: "2026-09-02T18:06:00Z", event: "quo_credits_exhausted" }], NOW);
    expect(v.quoCredits).toEqual({ ok: false, label: "EMPTY", detail: "402 at 18:06Z · lane tripped" });
    expect(v.rows[0]).toMatchObject({ name: "Quo (send)", ok: false });
  });
  it("is green with no detections and an old trip", () => {
    const v = summarizeVendors([], [{ ts: "2026-08-01T00:00:00Z", event: "quo_credits_exhausted" }], NOW);
    expect(v.quoCredits.ok).toBe(true);
    expect(v.rows.every((r) => r.ok)).toBe(true);
  });
  it("surfaces vendor and cron detections by name", () => {
    const v = summarizeVendors(
      [det("firecrawl_payment_required", "Firecrawl 402"), det("cron_cycle_silent", "No cron audit event in 3h")],
      [],
      NOW,
    );
    expect(v.rows.find((r) => r.name === "Firecrawl")).toMatchObject({ ok: false, detail: "Firecrawl 402" });
    expect(v.rows.find((r) => r.name === "Cron slots")).toMatchObject({ ok: false });
    expect(v.rows.find((r) => r.name === "RentCast / ATTOM")?.ok).toBe(true);
  });
});
