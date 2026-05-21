// Phase 11.5 (INV-006) — outreach-status-reconcile pure helper tests.

import { describe, it, expect } from "vitest";
import {
  shouldAutoTransition,
  notesContainMarker,
  buildAuditNoteLine,
  RECONCILE_IDEMPOTENCY_MARKER,
  type ReconcileListing,
} from "./outreach-status-reconcile";

function rec(over: Partial<ReconcileListing> = {}): ReconcileListing {
  return {
    envelopeId: null,
    outreachStatus: null,
    notes: null,
    ...over,
  };
}

describe("shouldAutoTransition — INV-006 transition predicate", () => {
  // Case 1 — Envelope populated + Negotiating + no marker → transitions
  it("auto-transitions Negotiating record with Envelope_ID set", () => {
    const d = shouldAutoTransition(
      rec({ envelopeId: "envelope-guid-xyz", outreachStatus: "Negotiating" }),
    );
    expect(d.action).toBe("transition");
    expect(d.reason).toBe("should_transition");
  });

  // Case 2 — Envelope populated + Response Received + no marker → transitions
  it("auto-transitions Response Received record with Envelope_ID set", () => {
    const d = shouldAutoTransition(
      rec({ envelopeId: "envelope-guid-abc", outreachStatus: "Response Received" }),
    );
    expect(d.action).toBe("transition");
    expect(d.reason).toBe("should_transition");
  });

  // Case 3 — Envelope populated + Negotiating + marker present → SKIPS
  it("skips record already auto-transitioned (idempotency marker present)", () => {
    const d = shouldAutoTransition(
      rec({
        envelopeId: "envelope-guid-xyz",
        outreachStatus: "Negotiating",
        notes: "5/20 — System: auto-transitioned to Offer Accepted (Envelope_ID ...).",
      }),
    );
    expect(d.action).toBe("skip");
    expect(d.reason).toBe("already_transitioned");
  });

  // Case 4 — Envelope populated + Offer Accepted → SKIPS (no work to do)
  it("skips record already in Offer Accepted state", () => {
    const d = shouldAutoTransition(
      rec({ envelopeId: "envelope-guid-xyz", outreachStatus: "Offer Accepted" }),
    );
    expect(d.action).toBe("skip");
    expect(d.reason).toBe("status_not_eligible");
  });

  // Case 5 — Envelope populated + Dead → SKIPS (terminal state)
  it("skips Dead records even if Envelope_ID populated", () => {
    const d = shouldAutoTransition(
      rec({ envelopeId: "envelope-guid-xyz", outreachStatus: "Dead" }),
    );
    expect(d.action).toBe("skip");
    expect(d.reason).toBe("status_not_eligible");
  });

  // Case 6 — No envelope + Negotiating → SKIPS (no trigger signal)
  it("skips record without Envelope_ID regardless of status", () => {
    const d = shouldAutoTransition(
      rec({ envelopeId: null, outreachStatus: "Negotiating" }),
    );
    expect(d.action).toBe("skip");
    expect(d.reason).toBe("no_envelope_id");
  });

  it("skips when Envelope_ID is empty string (whitespace-trimmed)", () => {
    const d = shouldAutoTransition(
      rec({ envelopeId: "   ", outreachStatus: "Negotiating" }),
    );
    expect(d.action).toBe("skip");
    expect(d.reason).toBe("no_envelope_id");
  });

  it("marker substring match is case-insensitive", () => {
    const d = shouldAutoTransition(
      rec({
        envelopeId: "env-abc",
        outreachStatus: "Negotiating",
        notes: "Some prior note. AUTO-TRANSITIONED TO OFFER ACCEPTED earlier.",
      }),
    );
    expect(d.action).toBe("skip");
    expect(d.reason).toBe("already_transitioned");
  });

  it("notes marker check is null-safe", () => {
    expect(notesContainMarker(null)).toBe(false);
    expect(notesContainMarker("")).toBe(false);
    expect(notesContainMarker("any prior note text")).toBe(false);
    expect(notesContainMarker(`some text ${RECONCILE_IDEMPOTENCY_MARKER} more text`)).toBe(true);
  });
});

describe("buildAuditNoteLine", () => {
  it("emits a Notes line with idempotency marker substring + envelope ID", () => {
    const now = new Date("2026-05-20T18:30:00Z");
    const line = buildAuditNoteLine(now, "envelope-guid-test-123");
    expect(line).toContain(RECONCILE_IDEMPOTENCY_MARKER);
    expect(line).toContain("envelope-guid-test-123");
    expect(line).toContain("INV-006 reconciler");
    // Roundtrip: a record stamped with this note should be detected by
    // the marker scanner — locks idempotency consistency.
    expect(notesContainMarker(line)).toBe(true);
  });
});
