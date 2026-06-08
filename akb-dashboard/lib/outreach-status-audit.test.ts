import { describe, it, expect } from "vitest";
import { classifyOutreachTruth, auditOutreachStatuses, type OutreachAuditInput } from "./outreach-status-audit";

function mk(over: Partial<OutreachAuditInput>): OutreachAuditInput {
  return {
    id: "rec1",
    address: "100 Main St",
    state: "MI",
    sourceVersion: "v2_post_2026-05-26",
    outreachStatus: "Response Received",
    lastInboundAt: null,
    lastOutboundAt: null,
    executionPath: "Auto Proceed",
    ...over,
  };
}

describe("classifyOutreachTruth", () => {
  it("SUPPORTED when a recorded inbound backs the reply", () => {
    const f = classifyOutreachTruth(mk({ lastInboundAt: "2026-05-06T18:00:00Z", lastOutboundAt: "2026-05-05T00:00:00Z" }));
    expect(f.verdict).toBe("supported");
    expect(f.proposedStatus).toBeNull();
  });

  it("IMPOSSIBLE when never contacted (no outbound) — the 11 MI records", () => {
    const f = classifyOutreachTruth(mk({ lastInboundAt: null, lastOutboundAt: null }));
    expect(f.verdict).toBe("impossible");
    expect(f.proposedStatus).toBe(""); // revert to pre-outreach
    expect(f.needsConversationCheck).toBe(false);
  });

  it("IMPOSSIBLE holds even for a Reject record (still can't have replied)", () => {
    const f = classifyOutreachTruth(mk({ executionPath: "Reject", lastOutboundAt: null }));
    expect(f.verdict).toBe("impossible");
  });

  it("UNVERIFIED when texted but no recorded inbound — needs conversation check", () => {
    const f = classifyOutreachTruth(mk({ lastOutboundAt: "2026-05-06T20:18:00Z", lastInboundAt: null }));
    expect(f.verdict).toBe("unverified");
    expect(f.proposedStatus).toBe("Texted");
    expect(f.needsConversationCheck).toBe(true);
  });

  it("NOT_APPLICABLE for a status that doesn't assert a reply", () => {
    const f = classifyOutreachTruth(mk({ outreachStatus: "Texted" }));
    expect(f.verdict).toBe("not_applicable");
  });

  it("also catches a never-contacted Negotiating/Offer Accepted", () => {
    expect(classifyOutreachTruth(mk({ outreachStatus: "Negotiating", lastOutboundAt: null })).verdict).toBe("impossible");
    expect(classifyOutreachTruth(mk({ outreachStatus: "Offer Accepted", lastOutboundAt: null })).verdict).toBe("impossible");
  });
});

describe("auditOutreachStatuses", () => {
  it("reproduces the 16 MI shape: 11 impossible + 5 unverified, 0 supported", () => {
    const inputs: OutreachAuditInput[] = [
      // 11 never-contacted
      ...Array.from({ length: 11 }, (_, i) => mk({ id: `imp${i}`, lastOutboundAt: null })),
      // 5 texted, no inbound
      ...Array.from({ length: 5 }, (_, i) => mk({ id: `unv${i}`, lastOutboundAt: "2026-05-06T20:00:00Z" })),
    ];
    const { findings, summary } = auditOutreachStatuses(inputs);
    expect(summary.total_reply_claiming).toBe(16);
    expect(summary.impossible).toBe(11);
    expect(summary.unverified).toBe(5);
    expect(summary.supported).toBe(0);
    // impossible sorts first
    expect(findings[0].verdict).toBe("impossible");
  });

  it("drops not_applicable records and tallies by state", () => {
    const { findings, summary } = auditOutreachStatuses([
      mk({ state: "MI", lastOutboundAt: null }),
      mk({ state: "TX", lastInboundAt: "2026-05-06T00:00:00Z", lastOutboundAt: "2026-05-05T00:00:00Z" }),
      mk({ outreachStatus: "Texted" }), // dropped
    ]);
    expect(findings).toHaveLength(2);
    expect(summary.by_state).toEqual({ MI: 1, TX: 1 });
  });
});
