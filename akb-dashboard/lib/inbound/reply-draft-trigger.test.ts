import { describe, it, expect } from "vitest";
import { buildInboundReplyDraft, type DraftTriggerListing } from "./reply-draft-trigger";
import type { GeneratedReply } from "@/lib/recommended-reply";

const LISTING: DraftTriggerListing = {
  id: "recCHEYENNE00001",
  address: "9360 Cheyenne St, Detroit, MI 48227",
  outreachStatus: "Response Received",
  underwrittenMao: 45000,
  mao: 30000,
  listPrice: 65000,
  agentName: "Dana Rivers",
  agentEmail: "dana@example.com",
  draftReplyMeta: null,
};

// Deterministic stub — never hits the model. Returns a queued draft unless
// told to HOLD. inboundMsgId is echoed into meta so idempotency can be tested.
function stubGenerate(draftText: string | null, holdReason: string | null = null) {
  return async (
    _ctx: unknown,
    opts?: { matchedPattern?: string | null; inboundMsgId?: string | null },
  ): Promise<GeneratedReply> => ({
    draft: draftText,
    holdReason,
    meta: {
      state: draftText ? "queued" : "hold",
      generated_at: "2026-07-13T02:00:00.000Z",
      classification: "seller_costs",
      confidence: 0.9,
      channel: "sms",
      inbound_msg_id: opts?.inboundMsgId ?? undefined,
      hold_reason: holdReason ?? undefined,
    },
  });
}

const COSTS = "Are you covering the water bill and back taxes? I need to be paid.";

describe("buildInboundReplyDraft — SMS (quo-sync path)", () => {
  it("queues a jarvis_reply proposal with a send_sms payload + mirror fields", async () => {
    const res = await buildInboundReplyDraft({
      listing: LISTING,
      notes: "prior thread…",
      inbound: { msgId: "ACsms123", body: COSTS, toPhoneE164: "+13135551212" },
      channel: "sms",
      deps: { generate: stubGenerate("Happy to walk you through it, Dana."), nowMs: 1_000 },
    });
    expect(res.skipped).toBeNull();
    expect(res.drafted).toBe(true);
    expect(res.proposal).not.toBeNull();
    expect(res.proposal!.proposalId).toBe("jarvis_reply-1000-E00001");
    expect(res.draftText).toBe("Happy to walk you through it, Dana.");
    const payload = JSON.parse(res.proposal!.actionPayload);
    expect(payload.action).toBe("send_sms");
    expect(payload.to).toBe("+13135551212");
    expect(res.proposal!.reasoning).toMatch(/^SMS inbound \[/);
  });
});

describe("buildInboundReplyDraft — email (gmail-sync path)", () => {
  it("queues a send_email payload with a Re: subject and parsed reply-to", async () => {
    const res = await buildInboundReplyDraft({
      listing: LISTING,
      notes: "prior thread…",
      inbound: {
        msgId: "gmail-abc",
        body: COSTS,
        from: "Dana Rivers <dana@brokerage.com>",
        subject: "Re: 9360 Cheyenne",
      },
      channel: "email",
      deps: { generate: stubGenerate("Those are paid from proceeds at closing through title."), nowMs: 2_000 },
    });
    expect(res.skipped).toBeNull();
    const payload = JSON.parse(res.proposal!.actionPayload);
    expect(payload.action).toBe("send_email");
    expect(payload.to).toBe("dana@brokerage.com");
    expect(payload.subject).toMatch(/^Re: /);
    expect(res.proposal!.reasoning).toMatch(/^Email inbound \[/);
  });
});

describe("buildInboundReplyDraft — idempotency + dedup", () => {
  it("skips 'already_drafted' when the prior meta was this same inbound", async () => {
    const res = await buildInboundReplyDraft({
      listing: {
        ...LISTING,
        draftReplyMeta: JSON.stringify({ state: "queued", inbound_msg_id: "ACsms123", classification: "seller_costs" }),
      },
      notes: "",
      inbound: { msgId: "ACsms123", body: COSTS, toPhoneE164: "+13135551212" },
      channel: "sms",
      deps: { generate: stubGenerate("should not be called"), nowMs: 3_000 },
    });
    expect(res.skipped).toBe("already_drafted");
    expect(res.proposal).toBeNull();
    expect(res.drafted).toBe(false);
  });

  it("skips 'pending_proposal' when another path already queued a reply", async () => {
    const res = await buildInboundReplyDraft({
      listing: LISTING,
      notes: "",
      inbound: { msgId: "ACsmsNEW", body: COSTS, toPhoneE164: "+13135551212" },
      channel: "sms",
      hasPendingProposal: true,
      deps: { generate: stubGenerate("should not be called"), nowMs: 4_000 },
    });
    expect(res.skipped).toBe("pending_proposal");
    expect(res.proposal).toBeNull();
  });

  it("a tier-0 rejection short-circuits BEFORE the pending-proposal check", async () => {
    const res = await buildInboundReplyDraft({
      listing: LISTING,
      notes: "",
      inbound: { msgId: "ACsmsREJ", body: "This one is under contract now, sorry.", toPhoneE164: "+13135551212" },
      channel: "sms",
      hasPendingProposal: true, // even so, tier-0 wins
      deps: { generate: stubGenerate("should not be called"), nowMs: 5_000 },
    });
    expect(res.skipped).toBe("tier0_auto_close");
    expect(res.proposal).toBeNull();
  });
});

describe("buildInboundReplyDraft — HOLD (refuse-and-surface)", () => {
  it("a null draft becomes a hold_review proposal, never silently dropped", async () => {
    const res = await buildInboundReplyDraft({
      listing: LISTING,
      notes: "",
      inbound: { msgId: "ACsmsHOLD", body: COSTS, toPhoneE164: "+13135551212" },
      channel: "sms",
      deps: { generate: stubGenerate(null, "draft_invented_number ($99,000 with no stamped offer on record)"), nowMs: 6_000 },
    });
    expect(res.skipped).toBeNull();
    expect(res.drafted).toBe(false);
    expect(res.holdReason).toMatch(/invented_number/);
    expect(res.proposal).not.toBeNull();
    const payload = JSON.parse(res.proposal!.actionPayload);
    expect(payload.action).toBe("hold_review");
    expect(res.proposal!.reasoning).toMatch(/^HOLD \(/);
  });
});
