import { describe, it, expect } from "vitest";
import { deadFlipDraftDismissal, terminalStatusInFields } from "./draft-dismissal";

const NOW = "2026-07-16T23:00:00.000Z";
const QUEUED = JSON.stringify({ state: "queued", classification: "interest", channel: "sms", inbound_msg_id: "AC123" });

describe("terminalStatusInFields", () => {
  it("detects Dead/Walked/Terminated; ignores live statuses and non-strings", () => {
    expect(terminalStatusInFields({ Outreach_Status: "Dead" })).toBe("Dead");
    expect(terminalStatusInFields({ Outreach_Status: "Walked" })).toBe("Walked");
    expect(terminalStatusInFields({ Outreach_Status: "Negotiating" })).toBeNull();
    expect(terminalStatusInFields({ List_Price: 5 })).toBeNull();
  });
});

describe("deadFlipDraftDismissal — a dying deal takes its queued draft with it", () => {
  it("queued draft + Dead flip → text cleared, meta dismissed, idempotency key preserved", () => {
    const d = deadFlipDraftDismissal({ Outreach_Status: "Dead" }, QUEUED, NOW)!;
    expect(d.Draft_Reply_Text).toBe("");
    const meta = JSON.parse(d.Draft_Reply_Meta as string);
    expect(meta.state).toBe("dismissed");
    expect(meta.hold_reason).toBe("deal_dead_auto_dismiss");
    expect(meta.inbound_msg_id).toBe("AC123"); // ingest idempotency survives
  });
  it("HELD drafts are dismissed too", () => {
    const d = deadFlipDraftDismissal({ Outreach_Status: "Terminated" }, JSON.stringify({ state: "hold" }), NOW)!;
    expect(JSON.parse(d.Draft_Reply_Meta as string).state).toBe("dismissed");
  });
  it("no-ops: live status / no draft / sent-dismissed history / caller-owned fields / garbage meta", () => {
    expect(deadFlipDraftDismissal({ Outreach_Status: "Negotiating" }, QUEUED, NOW)).toBeNull();
    expect(deadFlipDraftDismissal({ Outreach_Status: "Dead" }, null, NOW)).toBeNull();
    expect(deadFlipDraftDismissal({ Outreach_Status: "Dead" }, JSON.stringify({ state: "sent" }), NOW)).toBeNull();
    expect(deadFlipDraftDismissal({ Outreach_Status: "Dead", Draft_Reply_Text: "x" }, QUEUED, NOW)).toBeNull();
    expect(deadFlipDraftDismissal({ Outreach_Status: "Dead" }, "not json", NOW)).toBeNull();
  });
});
