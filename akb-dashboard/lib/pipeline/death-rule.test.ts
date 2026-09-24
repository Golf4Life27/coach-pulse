import { describe, expect, it } from "vitest";
import { classifyDeathRule, type DeathRuleRecord } from "./death-rule";

const NOW = "2026-09-24T12:00:00.000Z";
const daysAgo = (n: number) => new Date(new Date(NOW).getTime() - n * 24 * 60 * 60 * 1000).toISOString();

function rec(overrides: Partial<DeathRuleRecord> = {}): DeathRuleRecord {
  return {
    outreachStatus: "Negotiating",
    lastInboundAt: null,
    lastOutboundAt: null,
    lastOutreachDate: null,
    createdTime: null,
    contractExecutedAt: null,
    ...overrides,
  };
}

describe("classifyDeathRule", () => {
  it("silent 15 days (their last inbound), regardless of who owes the reply → dead", () => {
    // They messaged us 15 days ago; we never followed up since (no
    // Last_Outbound_At at all here) — the clock is still THEIR silence.
    const result = classifyDeathRule(rec({ lastInboundAt: daysAgo(15) }), NOW);
    expect(result.verdict).toBe("dead");
    expect(result.daysSilent).toBe(15);
    expect(result.clockSource).toBe("last_inbound");
  });

  it("silent 13 days → alive (under the 14-day threshold)", () => {
    const result = classifyDeathRule(rec({ lastInboundAt: daysAgo(13) }), NOW);
    expect(result.verdict).toBe("alive");
    expect(result.daysSilent).toBe(13);
  });

  it("exactly 14 days silent → dead (threshold is inclusive)", () => {
    const result = classifyDeathRule(rec({ lastInboundAt: daysAgo(14) }), NOW);
    expect(result.verdict).toBe("dead");
  });

  it("executed + silent 30 days → executed_needs_termination_card, never dead", () => {
    const result = classifyDeathRule(
      rec({ lastInboundAt: daysAgo(30), contractExecutedAt: "2026-08-01T00:00:00.000Z" }),
      NOW,
    );
    expect(result.verdict).toBe("executed_needs_termination_card");
  });

  it("never-engaged cold record (no reply ever, no engaged status) → alive (out of scope)", () => {
    const result = classifyDeathRule(
      rec({ outreachStatus: "Texted", lastInboundAt: null, lastOutboundAt: daysAgo(40) }),
      NOW,
    );
    expect(result.verdict).toBe("alive");
    expect(result.daysSilent).toBeNull();
  });

  it("already Dead → alive (skip; this rule only kills, never resurrects)", () => {
    const result = classifyDeathRule(
      rec({ outreachStatus: "Dead", lastInboundAt: daysAgo(90) }),
      NOW,
    );
    expect(result.verdict).toBe("alive");
  });

  it("engaged status with no Last_Inbound_At falls back to Last_Outbound_At", () => {
    const result = classifyDeathRule(
      rec({ outreachStatus: "Offer Accepted", lastInboundAt: null, lastOutboundAt: daysAgo(20) }),
      NOW,
    );
    expect(result.verdict).toBe("dead");
    expect(result.clockSource).toBe("fallback_engaged");
  });

  it("engaged status with no timestamps anywhere → alive (never kill on missing data)", () => {
    const result = classifyDeathRule(rec({ outreachStatus: "Negotiating" }), NOW);
    expect(result.verdict).toBe("alive");
    expect(result.daysSilent).toBeNull();
  });
});
