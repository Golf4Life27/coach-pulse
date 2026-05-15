// @agent: maverick — airtable-spine summarizer tests.

import { describe, it, expect } from "vitest";
import { summarizeSpine } from "./airtable-spine";

describe("airtable-spine summarizeSpine", () => {
  it("maps field-id-keyed fields to typed entries", () => {
    const r = summarizeSpine([
      {
        id: "recSPINE001",
        fields: {
          fldkeMrHBhx4X8aml: "Principle: 65% Rule",
          fld36Jlm4Fo4vLG1L: "2026-05-13",
          fldajtCDNGYjsnGBR: "65% of List Price is the canonical opening offer at outreach.",
          fldYxNN1KLOSLadI4: "Phase 0b smoke result",
          fld4IRmHf2h2fiNKX: "Cheap, deterministic, volume-friendly.",
          fldgowtyhcDEPRpqE: "Pricing Agent runs at gate stage.",
          fldlFqie4S86aaLes: { id: "selXX", name: "Design", color: "blueLight2" },
        },
      },
    ]);
    expect(r.total_since).toBe(1);
    expect(r.recent_decisions[0]).toMatchObject({
      id: "recSPINE001",
      decision_title: "Principle: 65% Rule",
      decision_date: "2026-05-13",
      phase_at_time: "Design",
    });
  });

  it("falls back to '(untitled)' when title field is missing", () => {
    const r = summarizeSpine([{ id: "recA", fields: {} }]);
    expect(r.recent_decisions[0].decision_title).toBe("(untitled)");
    expect(r.recent_decisions[0].decision_date).toBeNull();
    expect(r.recent_decisions[0].phase_at_time).toBeNull();
  });

  it("accepts legacy string-form singleSelect for phase_at_time", () => {
    const r = summarizeSpine([
      { id: "recA", fields: { fldlFqie4S86aaLes: "Development" } },
    ]);
    expect(r.recent_decisions[0].phase_at_time).toBe("Development");
  });

  it("handles empty input cleanly", () => {
    const r = summarizeSpine([]);
    expect(r).toEqual({ total_since: 0, recent_decisions: [] });
  });
});
