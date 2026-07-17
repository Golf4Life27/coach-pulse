import { describe, it, expect } from "vitest";
import { buildInboundReplyDraft, detectsSellerDebt, type DraftTriggerListing } from "./reply-draft-trigger";
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

// A body that throws if the model stub is ever called — proves the DD "ask"
// path replaces the generated reply (never invokes generate).
const NEVER = () => {
  throw new Error("generate must not be called on the DD ask path");
};

describe("buildInboundReplyDraft — SMS (quo-sync path)", () => {
  it("queues a jarvis_reply proposal with a send_sms payload + mirror fields", async () => {
    const res = await buildInboundReplyDraft({
      listing: LISTING,
      notes: "prior thread…",
      inbound: { msgId: "ACsms123", body: COSTS, toPhoneE164: "+13135551212" },
      channel: "sms",
      deps: { generate: stubGenerate("Happy to walk you through it, Dana."), ddLive: false, nowMs: 1_000 },
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
      deps: { generate: stubGenerate("Those are paid from proceeds at closing through title."), ddLive: false, nowMs: 2_000 },
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
      deps: { generate: stubGenerate(null, "draft_invented_number ($99,000 with no stamped offer on record)"), ddLive: false, nowMs: 6_000 },
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

describe("buildInboundReplyDraft — B2 DD-volley (watched-first)", () => {
  it("DD kill switch (ddLive false) → normal recommended reply, no DD state", async () => {
    const res = await buildInboundReplyDraft({
      listing: LISTING,
      notes: "",
      inbound: { msgId: "ACa", body: COSTS, toPhoneE164: "+13135551212" },
      channel: "sms",
      deps: { generate: stubGenerate("normal reply"), ddLive: false, nowMs: 1_000 },
    });
    expect(res.draftText).toBe("normal reply");
    expect(res.extraFields).toBeUndefined();
  });

  it("DD volley is LIVE BY DEFAULT (2026-07-16) — only DD_VOLLEY_LIVE=false disables", async () => {
    // No ddLive injected, no env set in tests → the default path runs the
    // volley: seller_costs opens with the payoff question, generate not called.
    const res = await buildInboundReplyDraft({
      listing: LISTING,
      notes: "",
      inbound: { msgId: "ACdefault", body: COSTS, toPhoneE164: "+13135551212" },
      channel: "sms",
      deps: { generate: NEVER, nowMs: 1_000, nowIso: "2026-07-16T02:00:00.000Z" },
    });
    expect(res.drafted).toBe(true);
    expect(res.draftText).toMatch(/still owed/i);
    expect(res.extraFields?.DD_Volley_State).toBeTruthy();
  });

  it("DD on + engagement → the DD question IS the draft (generate never called)", async () => {
    const res = await buildInboundReplyDraft({
      listing: LISTING,
      notes: "",
      inbound: { msgId: "ACdd1", body: COSTS, toPhoneE164: "+13135551212" },
      channel: "sms",
      deps: { generate: NEVER, ddLive: true, nowMs: 1_000, nowIso: "2026-07-13T02:00:00.000Z" },
    });
    // seller_costs opens with the payoff question.
    expect(res.drafted).toBe(true);
    expect(res.draftText).toMatch(/still owed/i);
    expect(res.proposal!.reasoning).toMatch(/DD volley/);
    const payload = JSON.parse(res.proposal!.actionPayload);
    expect(payload.action).toBe("send_sms");
    expect(payload.draftBody).toMatch(/still owed/i);
    // State persisted with the first slot asked.
    const state = JSON.parse(res.extraFields!.DD_Volley_State as string);
    expect(state.classification).toBe("seller_costs");
    expect(state.asked).toEqual(["payoff_amount"]);
    expect(state.volleyCount).toBe(1);
  });

  it("DD on + answering a pending question → stamps the answer + asks the next", async () => {
    const priorState = JSON.stringify({
      status: "active",
      classification: "seller_costs",
      volleyCount: 1,
      asked: ["payoff_amount"],
      answers: [],
      openedAt: "2026-07-13T01:00:00.000Z",
      updatedAt: "2026-07-13T01:00:00.000Z",
    });
    const res = await buildInboundReplyDraft({
      listing: { ...LISTING, ddVolleyState: priorState },
      notes: "prior",
      inbound: { msgId: "ACdd2", body: "About 40k left on the mortgage", toPhoneE164: "+13135551212" },
      channel: "sms",
      deps: { generate: NEVER, ddLive: true, nowMs: 2_000, nowIso: "2026-07-13T02:00:00.000Z" },
    });
    // The payoff answer is stamped to the notes ledger…
    expect(res.notesAppend).toMatch(/\[DD Volley\] payoff_amount/);
    expect(res.notesAppend).toMatch(/40k/);
    // …and the next slot (lien_details) is asked.
    const state = JSON.parse(res.extraFields!.DD_Volley_State as string);
    expect(state.answers.map((a: { slot: string }) => a.slot)).toEqual(["payoff_amount"]);
    expect(state.asked).toEqual(["payoff_amount", "lien_details"]);
  });

  it("DD on + non-engagement classification → falls through to normal reply", async () => {
    const res = await buildInboundReplyDraft({
      listing: LISTING,
      notes: "",
      inbound: { msgId: "ACdd3", body: "We'll take it, let's move forward.", toPhoneE164: "+13135551212" },
      channel: "sms",
      deps: { generate: stubGenerate("normal reply for acceptance"), ddLive: true, nowMs: 3_000, nowIso: "2026-07-13T02:00:00.000Z" },
    });
    // acceptance opens no volley → normal reply, no DD state.
    expect(res.draftText).toBe("normal reply for acceptance");
    expect(res.extraFields).toBeUndefined();
  });
});

describe("buildInboundReplyDraft — closer → dismissed (no Send button, no HOLD noise)", () => {
  it("a dismissed generation yields draftMeta (mirror written) but NO proposal", async () => {
    const res = await buildInboundReplyDraft({
      listing: LISTING,
      notes: "",
      inbound: { msgId: "ACcloser", body: "Ok, you're welcome. Take care!", toPhoneE164: "+13135551212" },
      channel: "sms",
      deps: {
        generate: async (_ctx, opts) => ({
          draft: null,
          holdReason: "no_reply_needed_conversation_closer",
          meta: {
            state: "dismissed",
            generated_at: "2026-07-13T22:00:00.000Z",
            classification: "unknown",
            confidence: 0.4,
            channel: "sms",
            inbound_msg_id: opts?.inboundMsgId ?? undefined,
            hold_reason: "no_reply_needed_conversation_closer",
          },
        }),
        nowMs: 9_000,
      },
    });
    expect(res.skipped).toBe("no_reply_needed");
    expect(res.proposal).toBeNull();
    expect(res.draftMeta?.state).toBe("dismissed");
    // The mirror carries the msg id, so this inbound is never re-processed.
    expect(res.draftMeta?.inbound_msg_id).toBe("ACcloser");
  });
});

describe("detectsSellerDebt — the creative-lane signal (exit auto-sort)", () => {
  it("catches the Mount Gilead disclosure verbatim", () => {
    expect(detectsSellerDebt("Thank you for the offer, but she has second mortgage The least I can accept is 210.")).toBe(true);
  });
  it("catches payoff / owes / behind-on-payments shapes", () => {
    expect(detectsSellerDebt("The payoff amount is around 180k")).toBe(true);
    expect(detectsSellerDebt("He owes about $95,000 on it")).toBe(true);
    expect(detectsSellerDebt("She's behind on payments right now")).toBe(true);
  });
  it("plain negotiation talk does not trigger it", () => {
    expect(detectsSellerDebt("Seller countered at 66,500")).toBe(false);
    expect(detectsSellerDebt("Too low, need you closer to asking")).toBe(false);
  });
});
