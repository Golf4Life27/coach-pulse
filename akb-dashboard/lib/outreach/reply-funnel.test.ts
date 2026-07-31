import { describe, it, expect } from "vitest";
import { deriveOutcome, rollupReplyFunnel } from "./reply-funnel";

describe("deriveOutcome", () => {
  it("a contract stamp outranks whatever the status says", () => {
    // Status drift is real (the 2026-07-28 audit); the contract is the fact.
    expect(deriveOutcome({ id: "r1", outreachStatus: "Texted", contractExecutedAt: "2026-07-01" }))
      .toBe("contracted");
  });

  it("replied but still sitting on the send-side status is DROPPED", () => {
    expect(deriveOutcome({ id: "r2", outreachStatus: "Texted" })).toBe("dropped");
    expect(deriveOutcome({ id: "r3", outreachStatus: "" })).toBe("dropped");
    expect(deriveOutcome({ id: "r4", outreachStatus: null })).toBe("dropped");
  });

  it("maps the live and closed statuses", () => {
    expect(deriveOutcome({ id: "a", outreachStatus: "Negotiating" })).toBe("negotiating");
    expect(deriveOutcome({ id: "b", outreachStatus: "Counter Received" })).toBe("negotiating");
    expect(deriveOutcome({ id: "c", outreachStatus: "Response Received" })).toBe("engaged");
    expect(deriveOutcome({ id: "d", outreachStatus: "Parked" })).toBe("parked");
    expect(deriveOutcome({ id: "e", outreachStatus: "Dead" })).toBe("dead");
  });
});

describe("rollupReplyFunnel", () => {
  const now = new Date("2026-07-31T00:00:00Z");

  it("reports coverage honestly when classifications are missing", () => {
    const s = rollupReplyFunnel(
      [
        { id: "1", outreachStatus: "Dead", replyClassification: "rejection" },
        { id: "2", outreachStatus: "Dead" }, // predates the persistence fix
        { id: "3", outreachStatus: "Negotiating", replyClassification: "counter" },
        { id: "4", outreachStatus: "Texted" },
      ],
      now,
    );
    expect(s.replies).toBe(4);
    expect(s.classified).toBe(2);
    expect(s.classificationCoveragePct).toBe(50);
    // Unclassified records are bucketed VISIBLY, never silently dropped.
    expect(s.byClassificationOutcome["(unclassified)"]).toEqual({ dead: 1, dropped: 1 });
  });

  it("surfaces dropped threads oldest-first as the work-list", () => {
    const s = rollupReplyFunnel(
      [
        { id: "recent", outreachStatus: "Texted", lastInboundAt: "2026-07-30T00:00:00Z" },
        { id: "ancient", outreachStatus: "Texted", lastInboundAt: "2026-06-01T00:00:00Z" },
      ],
      now,
    );
    expect(s.dropped.map((d) => d.id)).toEqual(["ancient", "recent"]);
    expect(s.dropped[0].ageHours).toBe(1440);
  });

  it("computes reply→contract, the load-bearing number", () => {
    const s = rollupReplyFunnel(
      [
        { id: "1", contractExecutedAt: "2026-07-01" },
        ...Array.from({ length: 99 }, (_, i) => ({ id: `d${i}`, outreachStatus: "Dead" })),
      ],
      now,
    );
    expect(s.replyToContractPct).toBe(1);
    expect(s.byOutcome.contracted).toBe(1);
    expect(s.byOutcome.dead).toBe(99);
  });

  it("an empty cohort does not divide by zero", () => {
    const s = rollupReplyFunnel([], now);
    expect(s.replies).toBe(0);
    expect(s.replyToContractPct).toBe(0);
    expect(s.classificationCoveragePct).toBe(0);
  });
});
