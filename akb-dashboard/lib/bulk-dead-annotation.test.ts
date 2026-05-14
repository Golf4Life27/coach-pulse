// Unit tests for annotateBulkDead — pure function, no I/O.
// Per Alex 5/14 validation gate: tests must pass on annotation
// function before bulk operation fires.

import { describe, it, expect } from "vitest";
import { annotateBulkDead, BULK_DEAD_SENTINEL } from "./bulk-dead-annotation";

const NOW = new Date("2026-05-14T18:00:00Z");

describe("annotateBulkDead — happy paths", () => {
  it("empty notes get annotation cleanly", () => {
    const r = annotateBulkDead({
      recordId: "recA",
      currentNotes: null,
      lastOutreachDate: "2026-04-10", // 34 days
      now: NOW,
    });
    expect(r.decision).toBe("annotate");
    if (r.decision !== "annotate") return;
    expect(r.daysSince).toBe(34);
    expect(r.newNotes).toBe(
      "05/14 — BULK DEAD per stale records policy. 34 days since first touch, no reply. D3 cadence engine predates this record; too stale to resurrect.",
    );
    expect(r.newNotes).toContain(BULK_DEAD_SENTINEL);
  });

  it("existing notes are preserved and the annotation is appended after a blank line", () => {
    const existing = "Agent rep was friendly. Said motivated seller, will follow up.";
    const r = annotateBulkDead({
      recordId: "recB",
      currentNotes: existing,
      lastOutreachDate: "2026-03-28", // 47 days
      now: NOW,
    });
    expect(r.decision).toBe("annotate");
    if (r.decision !== "annotate") return;
    expect(r.daysSince).toBe(47);
    expect(r.newNotes.startsWith(existing)).toBe(true);
    expect(r.newNotes).toContain(
      "05/14 — BULK DEAD per stale records policy. 47 days since first touch",
    );
    // Blank-line separation between existing and annotation.
    expect(r.newNotes).toContain("\n\n05/14 — BULK DEAD");
  });

  it("existing notes with trailing whitespace get cleaned before append (no triple newline)", () => {
    const existing = "Prior outreach notes.\n\n   ";
    const r = annotateBulkDead({
      recordId: "recC",
      currentNotes: existing,
      lastOutreachDate: "2026-04-13", // 31 days
      now: NOW,
    });
    expect(r.decision).toBe("annotate");
    if (r.decision !== "annotate") return;
    expect(r.newNotes).toBe(
      "Prior outreach notes.\n\n05/14 — BULK DEAD per stale records policy. 31 days since first touch, no reply. D3 cadence engine predates this record; too stale to resurrect.",
    );
    // No more than 2 consecutive newlines anywhere in the result.
    expect(r.newNotes.match(/\n{3,}/)).toBeNull();
  });
});

describe("annotateBulkDead — idempotency", () => {
  it("existing notes that already contain BULK DEAD sentinel skip cleanly", () => {
    const existing =
      "Original notes.\n\n5/14 — BULK DEAD per stale records policy. 34 days since first touch, no reply. D3 cadence engine predates this record; too stale to resurrect.";
    const r = annotateBulkDead({
      recordId: "recD",
      currentNotes: existing,
      lastOutreachDate: "2026-04-10",
      now: NOW,
    });
    expect(r.decision).toBe("skip_already_annotated");
  });

  it("sentinel match is substring-based — works with day variations", () => {
    // Hand-written variant from one of Alex's first 50 — same sentinel,
    // different day stamp.
    const existing =
      "Hand-written notes.\n\n5/13 — BULK DEAD per stale records policy. 28 days since first touch, no reply.";
    const r = annotateBulkDead({
      recordId: "recE",
      currentNotes: existing,
      lastOutreachDate: "2026-04-15",
      now: NOW,
    });
    expect(r.decision).toBe("skip_already_annotated");
  });

  it("re-annotation of a fresh record produces the same output (deterministic with fixed now)", () => {
    const inputs = {
      recordId: "recF",
      currentNotes: null,
      lastOutreachDate: "2026-04-10",
      now: NOW,
    };
    const r1 = annotateBulkDead(inputs);
    const r2 = annotateBulkDead(inputs);
    expect(r1).toEqual(r2);
  });
});

describe("annotateBulkDead — date math edges", () => {
  it("computes 30 days correctly", () => {
    const r = annotateBulkDead({
      recordId: "rec30",
      currentNotes: null,
      lastOutreachDate: "2026-04-14",
      now: NOW,
    });
    expect(r.decision).toBe("annotate");
    if (r.decision !== "annotate") return;
    expect(r.daysSince).toBe(30);
  });

  it("computes 45 days correctly", () => {
    const r = annotateBulkDead({
      recordId: "rec45",
      currentNotes: null,
      lastOutreachDate: "2026-03-30",
      now: NOW,
    });
    expect(r.decision).toBe("annotate");
    if (r.decision !== "annotate") return;
    expect(r.daysSince).toBe(45);
  });

  it("computes 67 days correctly (oldest end of cohort)", () => {
    const r = annotateBulkDead({
      recordId: "rec67",
      currentNotes: null,
      lastOutreachDate: "2026-03-08",
      now: NOW,
    });
    expect(r.decision).toBe("annotate");
    if (r.decision !== "annotate") return;
    expect(r.daysSince).toBe(67);
  });
});

describe("annotateBulkDead — skip-on-missing", () => {
  it("null lastOutreachDate → skip_missing_outreach_date", () => {
    const r = annotateBulkDead({
      recordId: "recNullDate",
      currentNotes: null,
      lastOutreachDate: null,
      now: NOW,
    });
    expect(r.decision).toBe("skip_missing_outreach_date");
  });

  it("malformed lastOutreachDate → skip_missing_outreach_date", () => {
    const r = annotateBulkDead({
      recordId: "recBadDate",
      currentNotes: null,
      lastOutreachDate: "not-a-date",
      now: NOW,
    });
    expect(r.decision).toBe("skip_missing_outreach_date");
  });
});
