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

// ── Live-draft gate (2026-07-18, the Canfield two-drafts mess) ─────────────
import { proposalIsLiveDraft, filterLiveReplyProposals } from "./draft-dismissal";

describe("proposalIsLiveDraft — the record's meta is the ONE pointer", () => {
  const queuedMeta = JSON.stringify({ state: "queued", proposal_id: "jarvis_reply-123-abc" });

  it("live only when queued/hold AND the ids match", () => {
    expect(proposalIsLiveDraft("jarvis_reply-123-abc", queuedMeta)).toBe(true);
    expect(proposalIsLiveDraft("jarvis_reply-123-abc", JSON.stringify({ state: "hold", proposal_id: "jarvis_reply-123-abc" }))).toBe(true);
  });

  it("a replaced draft's old proposal is history — id mismatch → not live", () => {
    // The Canfield shape: record meta points at the manual repair, the old
    // "what did I miss?" proposal keeps its Pending row. Never renders.
    const repairMeta = JSON.stringify({ state: "queued", proposal_id: "manual-repair-canfield-20260717" });
    expect(proposalIsLiveDraft("jarvis_reply-1784319652053-0", repairMeta)).toBe(false);
  });

  it("dismissed/sent metas never render a proposal (the Sunbeam zombies)", () => {
    for (const state of ["dismissed", "sent"]) {
      expect(proposalIsLiveDraft("jarvis_reply-123-abc", JSON.stringify({ state, proposal_id: "jarvis_reply-123-abc" }))).toBe(false);
    }
  });

  it("no meta / garbage meta / no key → not live (fail toward hiding)", () => {
    expect(proposalIsLiveDraft("jarvis_reply-123-abc", null)).toBe(false);
    expect(proposalIsLiveDraft("jarvis_reply-123-abc", "not json")).toBe(false);
    expect(proposalIsLiveDraft(null, queuedMeta)).toBe(false);
  });
});

describe("filterLiveReplyProposals", () => {
  const rows = [
    { id: "recLIVE", proposalType: "jarvis_reply", recordId: "recA", proposalKey: "jarvis_reply-1-a" },
    { id: "recSTALE", proposalType: "jarvis_reply", recordId: "recA", proposalKey: "jarvis_reply-0-old" },
    { id: "recDEAD", proposalType: "jarvis_reply", recordId: "recSUNBEAM", proposalKey: "jarvis_reply-9-z" },
    { id: "recOTHER", proposalType: "frontier_retire", recordId: "recB", proposalKey: null },
  ];
  const metas = new Map<string, string | null | undefined>([
    ["recA", JSON.stringify({ state: "queued", proposal_id: "jarvis_reply-1-a" })],
    ["recSUNBEAM", JSON.stringify({ state: "dismissed", proposal_id: "jarvis_reply-9-z" })],
  ]);

  it("keeps the pointed-at draft, drops stale + dead, passes non-reply types through", () => {
    expect(filterLiveReplyProposals(rows, metas).map((r) => r.id)).toEqual(["recLIVE", "recOTHER"]);
  });

  it("accepts the Airtable row id namespace too", () => {
    const m = new Map([["recA", JSON.stringify({ state: "queued", proposal_id: "recLIVE" })]]);
    expect(filterLiveReplyProposals(rows.slice(0, 2), m).map((r) => r.id)).toEqual(["recLIVE"]);
  });
});
