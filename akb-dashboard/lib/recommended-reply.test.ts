import { describe, it, expect } from "vitest";
import {
  buildDraftSystemPrompt,
  classificationConfidence,
  conversationTail,
  draftPolicy,
  extractDollarAmounts,
  flagsFromNotes,
  generateRecommendedReply,
  parseDraftMeta,
  validateReplyDraft,
  type ReplyDraftContext,
  isConversationCloser,
} from "./recommended-reply";
import { classifyReply, triageSellerReply } from "./reply-triage";
import { parseSendEmailPayload } from "./approve-send";

const noAudit = async () => {};

function ctx(o: Partial<ReplyDraftContext> = {}): ReplyDraftContext {
  return {
    recordId: "recTEST0000000001",
    street: "9360 Cheyenne St",
    channel: "sms",
    classification: "seller_costs",
    inbound: "Are you covering costs? There is a water bill, and a tax bill... And I need to be paid.",
    conversationTail: "",
    stickyOfferUsd: 30_000,
    ceilingUsd: 42_000,
    listPriceUsd: 49_999,
    cappedToList: false,
    flags: { estate: false, lien: true, probate: false, multiOffer: false },
    agentFirstName: "Pamela",
    ...o,
  };
}

// ── L3 extension: the Cheyenne class classifies instead of falling through ──

describe("L3 extension — cost/lien/format/appointment/disclosure classify", () => {
  it("REGRESSION 9360 Cheyenne: 'Are you covering costs...' → seller_costs, never unknown", () => {
    const r1 = classifyReply("Are you covering costs? There is a water bill, and a tax bill... And I need to be paid.");
    expect(r1.classification).toBe("seller_costs");
    const r2 = classifyReply("Let me call the lien holder.");
    expect(r2.classification).toBe("seller_costs");
  });

  it("who-pays variants classify as seller_costs", () => {
    expect(classifyReply("Who pays closing costs?").classification).toBe("seller_costs");
    expect(classifyReply("Will you cover the back taxes?").classification).toBe("seller_costs");
    expect(classifyReply("What about my commission").classification).toBe("seller_costs");
  });

  it("offer-format requests classify (email me your offer / GAR form / in writing)", () => {
    expect(classifyReply("Can you email me your offer?").classification).toBe("offer_format");
    expect(classifyReply("Put it on a GAR form please").classification).toBe("offer_format");
    expect(classifyReply("I need that in writing").classification).toBe("offer_format");
  });

  it("appointment/showing steps classify", () => {
    expect(classifyReply("Can we schedule a walkthrough Thursday?").classification).toBe("appointment");
    expect(classifyReply("Call me at 3pm tomorrow").classification).toBe("appointment");
  });

  it("disclosure steps classify and outrank cost words", () => {
    expect(classifyReply("Please read and agree to the IABS before we proceed").classification).toBe("disclosure_step");
    expect(classifyReply("Information About Brokerage Services attached").classification).toBe("disclosure_step");
  });

  it("a counter with a number still outranks seller_costs", () => {
    expect(classifyReply("I need $120k to cover the liens, that's my lowest").classification).toBe("counter");
  });

  it("hard rejection still wins over everything", () => {
    expect(classifyReply("STOP. Do not text me about the lien").classification).toBe("rejection");
  });

  it("triage routes the new classes to needs-decision with reasoning", () => {
    const t = triageSellerReply("Are you covering costs? There is a water bill", "Response Received");
    expect(t.needsDecision).toBe(true);
    expect(t.decisionKind).toBe("pricing");
    expect(t.queueStatus).toBe("Negotiating");
    expect(t.reasoning).toContain("proceeds");
  });
});

// ── Guardrails ──────────────────────────────────────────────────────────────

describe("validateReplyDraft — HARD GUARDRAILS", () => {
  it("G1: a draft can never exceed the ceiling", () => {
    const v = validateReplyDraft("We can go up to $45,000 for you.", ctx({ ceilingUsd: 42_000 }));
    expect(v.ok).toBe(false);
    expect(v.holdReason).toContain("draft_exceeds_ceiling");
  });

  it("G1: any non-sticky number holds (sticky-or-silence)", () => {
    const v = validateReplyDraft("Our offer is $31,500 cash.", ctx({ stickyOfferUsd: 30_000 }));
    expect(v.ok).toBe(false);
    expect(v.holdReason).toContain("draft_number_not_sticky");
  });

  it("G1: with no stamped offer on record, ANY number is fabricated → hold", () => {
    const v = validateReplyDraft("We could do around $25,000.", ctx({ stickyOfferUsd: null }));
    expect(v.ok).toBe(false);
    expect(v.holdReason).toContain("draft_invented_number");
  });

  it("G1: the sticky number verbatim passes", () => {
    const v = validateReplyDraft(
      "Our $30,000 cash offer stands — liens and bills get paid from the proceeds at closing through the title company, and you keep what's left.",
      ctx(),
    );
    expect(v).toEqual({ ok: true, holdReason: null });
  });

  it("G2: cost-coverage question never yields 'we'll cover on top'", () => {
    const v = validateReplyDraft(
      "Yes! We'll pay the water bill and taxes on top of the offer.",
      ctx(),
    );
    expect(v.ok).toBe(false);
    expect(v.holdReason).toBe("cost_coverage_on_top_forbidden");
  });

  it("G2: a seller_costs draft without proceeds framing holds", () => {
    const v = validateReplyDraft("Don't worry about the bills, we'll handle everything.", ctx());
    expect(v.ok).toBe(false);
    expect(v.holdReason).toBe("seller_costs_missing_proceeds_framing");
  });

  it("G3: legal/title assertions hold (lien validity is the title company's fact)", () => {
    const v = validateReplyDraft(
      "That lien is not a problem at all, it's invalid — payoffs happen from proceeds at closing.",
      ctx(),
    );
    expect(v.ok).toBe(false);
    expect(v.holdReason).toBe("legal_title_assertion_forbidden");
  });

  it("G3: lien/estate deals must defer to the title company", () => {
    const v = validateReplyDraft(
      "The bills get paid from the sale proceeds at closing, you net the rest.",
      ctx({ flags: { estate: false, lien: true, probate: false, multiOffer: false } }),
    );
    expect(v.ok).toBe(false);
    expect(v.holdReason).toBe("missing_title_company_deferral");
  });

  it("G4: disclosure acknowledgment is never drafted", () => {
    expect(validateReplyDraft("anything", ctx({ classification: "disclosure_step" })).holdReason).toBe(
      "operator_must_acknowledge_disclosure",
    );
    const v = validateReplyDraft(
      "I acknowledge the IABS disclosure on Alex's behalf.",
      ctx({ classification: "interest" }),
    );
    expect(v.ok).toBe(false);
  });

  it("empty/failed generation holds, never queues", () => {
    expect(validateReplyDraft("", ctx()).holdReason).toBe("generation_failed_empty");
    expect(validateReplyDraft("[Draft generation failed]", ctx()).holdReason).toBe("generation_failed");
  });

  it("extractDollarAmounts reads $113,750 / $114k / $30,000 shapes", () => {
    expect(extractDollarAmounts("at $113,750 or maybe $114k, not $30,000")).toEqual([113_750, 114_000, 30_000]);
  });
});

// ── Generator: draft-or-hold, never silent ──────────────────────────────────

describe("generateRecommendedReply — every inbound drafts or HOLDs with reason", () => {
  it("a passing draft queues (state=queued) with the audit event", async () => {
    const events: string[] = [];
    const g = await generateRecommendedReply(
      ctx({ flags: { estate: false, lien: false, probate: false, multiOffer: false }, classification: "interest" }),
      {},
      {
        synthesize: async () => ({
          text: "Hey Pamela, yes — cash, as-is, and we close on your timeline. Want me to send the paperwork over today?",
          model: "m",
          stop_reason: "end_turn",
          usage: null,
          elapsed_ms: 1,
        }),
        writeAudit: (async (e: { event: string }) => {
          events.push(e.event);
        }) as never,
        nowIso: "2026-07-12T18:00:00Z",
      },
    );
    expect(g.draft).toContain("cash, as-is");
    expect(g.meta.state).toBe("queued");
    expect(events).toEqual(["reply_draft_created"]);
  });

  it("a guardrail-violating generation HOLDs with the reason (refuse-and-surface)", async () => {
    const g = await generateRecommendedReply(
      ctx({ ceilingUsd: 42_000 }),
      {},
      {
        synthesize: async () => ({
          text: "We can stretch to $50,000 if that helps, paid from proceeds at closing via the title company.",
          model: "m",
          stop_reason: "end_turn",
          usage: null,
          elapsed_ms: 1,
        }),
        writeAudit: noAudit as never,
      },
    );
    expect(g.draft).toBeNull();
    expect(g.holdReason).toContain("draft_exceeds_ceiling");
    expect(g.meta.state).toBe("hold");
  });

  it("UNCLASSIFIED never silently drops — unknown still drafts (or holds)", async () => {
    const g = await generateRecommendedReply(
      ctx({ classification: "unknown", stickyOfferUsd: null, flags: { estate: false, lien: false, probate: false, multiOffer: false } }),
      {},
      {
        synthesize: async () => ({
          text: "Happy to clarify anything — what would be most helpful to cover first?",
          model: "m",
          stop_reason: "end_turn",
          usage: null,
          elapsed_ms: 1,
        }),
        writeAudit: noAudit as never,
      },
    );
    expect(g.draft).not.toBeNull();
    expect(g.meta.state).toBe("queued");
  });

  it("model failure → HOLD with generation_error, never a throw", async () => {
    const g = await generateRecommendedReply(ctx(), {}, {
      synthesize: async () => {
        throw new Error("Anthropic 529: overloaded");
      },
      writeAudit: noAudit as never,
    });
    expect(g.draft).toBeNull();
    expect(g.holdReason).toContain("generation_error");
  });

  it("disclosure_step never calls the model at all", async () => {
    let called = 0;
    const g = await generateRecommendedReply(ctx({ classification: "disclosure_step" }), {}, {
      synthesize: async () => {
        called++;
        throw new Error("should not be called");
      },
      writeAudit: noAudit as never,
    });
    expect(called).toBe(0);
    expect(g.holdReason).toBe("operator_must_acknowledge_disclosure");
  });
});

// ── Context pack + plumbing ─────────────────────────────────────────────────

describe("context pack + plumbing", () => {
  it("flagsFromNotes reads estate/lien/probate/multi-offer from the ledger", () => {
    const f = flagsFromNotes("Seller: Estate of Hazel Hughes, executrix. Title must verify Letters Testamentary. Agent says multiple offers.");
    expect(f).toEqual({ estate: true, lien: false, probate: true, multiOffer: true });
  });

  it("conversationTail keeps the newest end of long notes", () => {
    const notes = `${"x".repeat(5000)}NEWEST`;
    const tail = conversationTail(notes, 100);
    expect(tail.endsWith("NEWEST")).toBe(true);
    expect(tail.length).toBe(100);
  });

  it("the system prompt forbids numbers entirely when no sticky offer exists", () => {
    const p = buildDraftSystemPrompt(ctx({ stickyOfferUsd: null }));
    expect(p).toContain("MAY NOT WRITE ANY DOLLAR FIGURE");
    const p2 = buildDraftSystemPrompt(ctx({ stickyOfferUsd: 30_000 }));
    expect(p2).toContain("$30,000");
  });

  it("draftPolicy: disclosure holds, rejection is not this lane, rest draft", () => {
    expect(draftPolicy("disclosure_step")).toBe("hold");
    expect(draftPolicy("rejection")).toBe("none");
    expect(draftPolicy("seller_costs")).toBe("draft");
    expect(draftPolicy("unknown")).toBe("draft");
  });

  it("confidence: matched pattern 0.9, unknown 0.4", () => {
    expect(classificationConfidence("seller_costs", "pat")).toBe(0.9);
    expect(classificationConfidence("unknown", null)).toBe(0.4);
  });

  it("parseDraftMeta round-trips and rejects junk", () => {
    expect(parseDraftMeta(JSON.stringify({ state: "queued", channel: "sms" }))?.state).toBe("queued");
    expect(parseDraftMeta("not json")).toBeNull();
    expect(parseDraftMeta("")).toBeNull();
  });

  it("parseSendEmailPayload accepts only complete send_email payloads", () => {
    const good = JSON.stringify({ action: "send_email", to: "a@b.com", subject: "Re: X", draftBody: "hi" });
    expect(parseSendEmailPayload(good)?.to).toBe("a@b.com");
    expect(parseSendEmailPayload(JSON.stringify({ action: "send_sms", to: "a@b.com", subject: "s", draftBody: "x" }))).toBeNull();
    expect(parseSendEmailPayload(JSON.stringify({ action: "send_email", to: "not-an-email", subject: "s", draftBody: "x" }))).toBeNull();
    expect(parseSendEmailPayload(JSON.stringify({ action: "send_email", to: "a@b.com", subject: "", draftBody: "x" }))).toBeNull();
  });
});

describe("conversation-closer policy (685 Bolton leak, 2026-07-13)", () => {
  it("the verbatim Bolton closer is detected", () => {
    expect(
      isConversationCloser("Ok, you're welcome. I understand. Ok, I will let you know if that happens. Have a great day!"),
    ).toBe(true);
  });

  it("questions, money, and long messages are never closers", () => {
    expect(isConversationCloser("Sounds good — can you send the contract?")).toBe(false);
    expect(isConversationCloser("Sounds good, we can do $27,000")).toBe(false);
    expect(isConversationCloser("x".repeat(250))).toBe(false);
    expect(isConversationCloser("")).toBe(false);
  });

  it("generateRecommendedReply short-circuits an unknown closer to DISMISSED without a model call", async () => {
    let synthCalled = false;
    const gen = await generateRecommendedReply(
      {
        recordId: "recBOLTON",
        street: "685 Bolton Rd NW",
        channel: "sms",
        classification: "unknown",
        inbound: "Ok, you're welcome. Take care!",
        conversationTail: "",
        stickyOfferUsd: null,
        ceilingUsd: null,
        listPriceUsd: null,
        cappedToList: false,
        flags: { estate: false, lien: false, probate: false, multiOffer: false },
        agentFirstName: null,
      },
      {},
      {
        synthesize: async () => {
          synthCalled = true;
          return { text: "should never run" } as never;
        },
        writeAudit: async () => {},
        nowIso: "2026-07-13T22:00:00.000Z",
      },
    );
    expect(synthCalled).toBe(false);
    expect(gen.draft).toBeNull();
    expect(gen.meta.state).toBe("dismissed");
    expect(gen.holdReason).toBe("no_reply_needed_conversation_closer");
  });

  it("a CLASSIFIED intent with closer-looking phrasing still drafts (classification outranks)", async () => {
    let synthCalled = false;
    const gen = await generateRecommendedReply(
      {
        recordId: "rec1",
        street: "1 Test St",
        channel: "sms",
        classification: "acceptance",
        inbound: "Sounds good, we'll take it",
        conversationTail: "",
        stickyOfferUsd: 50_000,
        ceilingUsd: 60_000,
        listPriceUsd: 70_000,
        cappedToList: false,
        flags: { estate: false, lien: false, probate: false, multiOffer: false },
        agentFirstName: "Sam",
      },
      {},
      {
        synthesize: async () => {
          synthCalled = true;
          return { text: "Great — I'll get the paperwork moving today." } as never;
        },
        writeAudit: async () => {},
        nowIso: "2026-07-13T22:00:00.000Z",
      },
    );
    expect(synthCalled).toBe(true);
    expect(gen.meta.state).toBe("queued");
  });
});

describe("meta-commentary validator (the leaked-reasoning draft)", () => {
  const CTX = {
    recordId: "recX",
    street: "685 Bolton Rd NW",
    channel: "sms" as const,
    classification: "unknown" as const,
    inbound: "ok",
    conversationTail: "",
    stickyOfferUsd: null,
    ceilingUsd: null,
    listPriceUsd: null,
    cappedToList: false,
    flags: { estate: false, lien: false, probate: false, multiOffer: false },
    agentFirstName: null,
  };

  it("the verbatim Bolton leak is HELD, never sendable", () => {
    const v = validateReplyDraft(
      "No reply needed — this is a conversation closer. Sending another message would be over-communication.\n\nIf a draft is required for the record: You're welcome, take care!",
      CTX,
    );
    expect(v.ok).toBe(false);
    expect(v.holdReason).toBe("generation_meta_commentary");
  });

  it("a normal message passes", () => {
    expect(validateReplyDraft("Happy to answer any questions the seller has.", CTX).ok).toBe(true);
  });
});
