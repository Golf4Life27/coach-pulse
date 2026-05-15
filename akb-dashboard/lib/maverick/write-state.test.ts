// @agent: maverick — write-state pure-function tests.
//
// I/O wrappers (Airtable POST, audit write) are exercised by
// integration paths against the deployed endpoint. These tests
// target the pure parts: arg validation, spine-row composition,
// orchestration with DI'd stubs.

import { describe, it, expect, vi } from "vitest";
import {
  validateWriteStateArgs,
  buildSpineRow,
  writeState,
  WRITE_STATE_EVENT_TYPES,
  MAVERICK_ROSTER_AGENTS,
  type WriteStateDeps,
} from "./write-state";

// ────────────── validateWriteStateArgs ──────────────

describe("validateWriteStateArgs — happy paths", () => {
  it("accepts minimal valid input (event_type + title + description)", () => {
    const r = validateWriteStateArgs({
      event_type: "decision",
      title: "Day 4 ships",
      description: "write_state + recall live",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.args.event_type).toBe("decision");
      expect(r.args.title).toBe("Day 4 ships");
      expect(r.args.description).toBe("write_state + recall live");
      expect(r.args.attribution_agent).toBeUndefined();
    }
  });

  it("normalizes whitespace on title + description", () => {
    const r = validateWriteStateArgs({
      event_type: "build_event",
      title: "  trimmed  ",
      description: "  also trimmed\n",
    });
    if (!r.ok) throw new Error("expected ok");
    expect(r.args.title).toBe("trimmed");
    expect(r.args.description).toBe("also trimmed");
  });

  it("accepts every event_type from the canonical enum", () => {
    for (const t of WRITE_STATE_EVENT_TYPES) {
      const r = validateWriteStateArgs({
        event_type: t,
        title: "x",
        description: "x",
      });
      expect(r.ok).toBe(true);
    }
  });

  it("accepts every roster agent for attribution_agent", () => {
    for (const a of MAVERICK_ROSTER_AGENTS) {
      const r = validateWriteStateArgs({
        event_type: "decision",
        title: "x",
        description: "x",
        attribution_agent: a,
      });
      expect(r.ok).toBe(true);
    }
  });

  it("accepts valid 17-char related_spine_decision + related_listing", () => {
    const r = validateWriteStateArgs({
      event_type: "principle_amendment",
      title: "x",
      description: "x",
      related_spine_decision: "recABC12345678901",
      related_listing: "recDEF12345678901",
    });
    expect(r.ok).toBe(true);
  });
});

describe("validateWriteStateArgs — rejections", () => {
  it("rejects non-object input", () => {
    expect(validateWriteStateArgs("string").ok).toBe(false);
    expect(validateWriteStateArgs(null).ok).toBe(false);
    expect(validateWriteStateArgs(123).ok).toBe(false);
  });

  it("rejects missing event_type", () => {
    const r = validateWriteStateArgs({ title: "x", description: "x" });
    if (r.ok) throw new Error("expected fail");
    expect(r.error).toMatch(/event_type/);
  });

  it("rejects unknown event_type", () => {
    const r = validateWriteStateArgs({ event_type: "rollback", title: "x", description: "x" });
    if (r.ok) throw new Error("expected fail");
    expect(r.error).toMatch(/event_type must be one of/);
  });

  it("rejects empty/whitespace-only title", () => {
    expect(validateWriteStateArgs({ event_type: "decision", title: "", description: "x" }).ok).toBe(false);
    expect(validateWriteStateArgs({ event_type: "decision", title: "   ", description: "x" }).ok).toBe(false);
  });

  it("rejects empty/whitespace-only description", () => {
    expect(validateWriteStateArgs({ event_type: "decision", title: "x", description: "" }).ok).toBe(false);
    expect(validateWriteStateArgs({ event_type: "decision", title: "x", description: "  \n  " }).ok).toBe(false);
  });

  it("rejects malformed related_spine_decision (wrong length or no rec prefix)", () => {
    const r1 = validateWriteStateArgs({
      event_type: "decision",
      title: "x",
      description: "x",
      related_spine_decision: "abc123",
    });
    const r2 = validateWriteStateArgs({
      event_type: "decision",
      title: "x",
      description: "x",
      related_spine_decision: "rec_too_short",
    });
    expect(r1.ok).toBe(false);
    expect(r2.ok).toBe(false);
  });

  it("rejects unknown attribution_agent", () => {
    const r = validateWriteStateArgs({
      event_type: "decision",
      title: "x",
      description: "x",
      attribution_agent: "rogue_agent",
    });
    if (r.ok) throw new Error("expected fail");
    expect(r.error).toMatch(/attribution_agent must be one of/);
  });

  it("rejects non-string reasoning when provided", () => {
    expect(
      validateWriteStateArgs({
        event_type: "decision",
        title: "x",
        description: "x",
        reasoning: 42,
      }).ok,
    ).toBe(false);
  });
});

// ────────────── buildSpineRow ──────────────

describe("buildSpineRow — Airtable mapping", () => {
  const NOW = new Date(Date.UTC(2026, 4, 15, 12, 0, 0));

  it("maps title/description/event_type/attribution into the spine row shape", () => {
    const row = buildSpineRow(
      {
        event_type: "decision",
        title: "Quo throttle rate locked at 15/hour",
        description: "Per Day 2 audit + 10DLC trust-score data.",
        reasoning: "Carrier-spam-flagging is unrecoverable; pace conservatively.",
        attribution_agent: "crier",
      },
      NOW,
    );
    expect(row.Decision_Title).toBe("Quo throttle rate locked at 15/hour");
    expect(row.Decision_Date).toBe("2026-05-15");
    expect(row.Description).toBe("Per Day 2 audit + 10DLC trust-score data.");
    expect(row.Why).toBe("Carrier-spam-flagging is unrecoverable; pace conservatively.");
    expect(row.Trigger_Event).toBe("event_type=decision; written_by=crier");
  });

  it("defaults attribution to 'maverick' when caller omits it", () => {
    const row = buildSpineRow(
      { event_type: "build_event", title: "x", description: "y" },
      NOW,
    );
    expect(row.Trigger_Event).toBe("event_type=build_event; written_by=maverick");
  });

  it("appends related-record pointers to Description in a parseable footer", () => {
    const row = buildSpineRow(
      {
        event_type: "principle_amendment",
        title: "Offer Discipline tightened",
        description: "Drift-down threshold from 10% to 8%.",
        related_spine_decision: "recXXXXXXXXXXXXXX",
        related_listing: "recYYYYYYYYYYYYYY",
      },
      NOW,
    );
    expect(row.Description).toContain("Drift-down threshold from 10% to 8%.");
    expect(row.Description).toContain("— maverick metadata —");
    expect(row.Description).toContain("Related Spine decision: recXXXXXXXXXXXXXX");
    expect(row.Description).toContain("Related listing: recYYYYYYYYYYYYYY");
  });

  it("omits the metadata footer entirely when no related records", () => {
    const row = buildSpineRow(
      { event_type: "decision", title: "x", description: "clean description" },
      NOW,
    );
    expect(row.Description).toBe("clean description");
    expect(row.Description).not.toContain("metadata");
  });

  it("omits Why when reasoning is absent", () => {
    const row = buildSpineRow(
      { event_type: "decision", title: "x", description: "y" },
      NOW,
    );
    expect(row.Why).toBeUndefined();
  });

  it("Decision_Date is UTC-anchored regardless of local timezone", () => {
    // 23:30 UTC on May 15 — still May 15 UTC even if local TZ would
    // roll over to May 16.
    const lateUtc = new Date(Date.UTC(2026, 4, 15, 23, 30, 0));
    const row = buildSpineRow(
      { event_type: "decision", title: "x", description: "y" },
      lateUtc,
    );
    expect(row.Decision_Date).toBe("2026-05-15");
  });
});

// ────────────── writeState orchestration ──────────────

describe("writeState — orchestration", () => {
  function stubDeps(): WriteStateDeps {
    return {
      createSpineRecord: vi.fn().mockResolvedValue({ id: "recSPINE0000001" }),
      writeAudit: vi.fn().mockResolvedValue(undefined),
      now: () => new Date(Date.UTC(2026, 4, 15, 12, 0, 0)),
    };
  }

  it("creates the Spine row + writes audit + returns both IDs", async () => {
    const deps = stubDeps();
    const result = await writeState(
      {
        event_type: "decision",
        title: "T",
        description: "D",
      },
      deps,
    );
    expect(result.written).toBe(true);
    expect(result.spine_record_id).toBe("recSPINE0000001");
    expect(typeof result.audit_event_id).toBe("string");
    expect(deps.createSpineRecord).toHaveBeenCalledTimes(1);
    expect(deps.writeAudit).toHaveBeenCalledTimes(1);
  });

  it("audit event is attributed to the chosen agent (default: maverick)", async () => {
    const deps = stubDeps();
    await writeState(
      { event_type: "decision", title: "T", description: "D", attribution_agent: "sentry" },
      deps,
    );
    const auditCall = (deps.writeAudit as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
    expect(auditCall.agent).toBe("sentry");
    expect(auditCall.event).toBe("write_state.decision");
    expect(auditCall.status).toBe("confirmed_success");
    expect(auditCall.recordId).toBe("recSPINE0000001");
  });

  it("event name includes the event_type so audit queries can group by type", async () => {
    const deps = stubDeps();
    await writeState(
      { event_type: "principle_amendment", title: "T", description: "D" },
      deps,
    );
    const auditCall = (deps.writeAudit as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
    expect(auditCall.event).toBe("write_state.principle_amendment");
  });

  it("denormalizes related-record pointers + description preview into the audit entry", async () => {
    const deps = stubDeps();
    await writeState(
      {
        event_type: "deal_state_change",
        title: "23 Fields moved to Negotiating",
        description: "Candice replied with verbal accept.",
        related_listing: "recABC1234567890",
        related_spine_decision: "recDEF1234567890",
      },
      deps,
    );
    const auditCall = (deps.writeAudit as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
    const input = auditCall.inputSummary as Record<string, unknown>;
    expect(input.related_listing).toBe("recABC1234567890");
    expect(input.related_spine_decision).toBe("recDEF1234567890");
    expect(input.description_preview).toBe("Candice replied with verbal accept.");
  });

  it("propagates Spine-write errors out (no audit on failed spine create)", async () => {
    const deps = stubDeps();
    deps.createSpineRecord = vi.fn().mockRejectedValue(new Error("Airtable 503"));
    await expect(
      writeState({ event_type: "decision", title: "T", description: "D" }, deps),
    ).rejects.toThrow("Airtable 503");
    expect(deps.writeAudit).not.toHaveBeenCalled();
  });
});
