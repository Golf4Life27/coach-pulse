import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mock for sendBuyerReplyAlert's I/O (Quo send + audit) ──────────────────
const sendMessage = vi.fn(async (..._a: unknown[]) => ({ id: "MSGtest", status: "queued" as const }));
vi.mock("@/lib/quo", () => ({ sendMessage: (...a: unknown[]) => sendMessage(...a) }));
vi.mock("@/lib/audit-log", () => ({ audit: vi.fn(async () => {}) }));

// ── KV stub so the Decision Card path can actually mint in a test ──────────
// kvConfigured()/kvProd are module-level in lib/maverick/oauth/kv (they read
// KV_REST_API_* at import), so the only way to exercise "a card WAS minted" is
// to swap the module. `kvState.on` flips between the two shipping realities:
// KV wired (card URL) and KV absent (pipeline link fallback).
const kvState = vi.hoisted(() => ({ on: false, client: null as null | { get(k: string): Promise<string | null> } }));
vi.mock("@/lib/maverick/oauth/kv", async (importActual) => {
  const actual = await importActual<typeof import("./maverick/oauth/kv")>();
  const mem = actual.makeMemoryKv();
  kvState.client = mem;
  return { ...actual, kvConfigured: () => kvState.on, kvProd: mem };
});

import {
  buildReplyAlertBody,
  alertAction,
  alertRecommendation,
  sendBuyerReplyAlert,
  sendReplyAlert,
  cardOptionsForReply,
  pipelineLink,
  type ReplyAlertInput,
} from "./reply-alert";
import { isAllowedCardAction, CARD_KV_PREFIX, type DecisionCard } from "./maverick/decision-card";
import type { ReplyClassification } from "./reply-triage";
import { estimateSmsSegments, findNonGsm7Chars } from "./sms/gsm7";

describe("buildReplyAlertBody — tiered, decision-first (operator 2026-06-10)", () => {
  it("tier 1 counter: leads with DECISION NEEDED, short address, action, recommendation with real numbers, link", () => {
    const { body, priceGap } = buildReplyAlertBody({
      recordId: "recVOZVgXT0GPenAt",
      address: "15864 Tracey St, Detroit, MI 48227",
      tier: "tier_1_decision",
      classification: "counter",
      outreachOfferPrice: 48750,
      underwrittenMao: 50000,
    });
    expect(body).toMatch(/^DECISION NEEDED: 15864 Tracey St\./);
    expect(body).toContain("Agent countered");
    expect(body).toContain("Recommend: hold at $48,750 (MAO $50,000)");
    expect(body).toContain("/pipeline/recVOZVgXT0GPenAt");
    expect(priceGap).toBe(false);
  });

  it("tier 1 counter with MISSING numbers: falls back to 'hold sticky opener' + flags the gap — never fabricates", () => {
    const { body, priceGap } = buildReplyAlertBody({
      recordId: "recA",
      address: "1 Main St, Detroit, MI",
      tier: "tier_1_decision",
      classification: "counter",
      outreachOfferPrice: null,
      underwrittenMao: null,
    });
    expect(body).toContain("Recommend: hold sticky opener");
    expect(body).not.toContain("$"); // no invented number anywhere
    expect(priceGap).toBe(true);
  });

  it("tier 1 interest: 'advance to offer or DD'", () => {
    const { body } = buildReplyAlertBody({
      recordId: "recB",
      address: "2 Oak St, Detroit, MI",
      tier: "tier_1_decision",
      classification: "interest",
    });
    expect(body).toContain("Agent is interested");
    expect(body).toContain("Recommend: advance to offer or DD");
  });

  it("tier 1 unknown: 'operator review'", () => {
    const { body } = buildReplyAlertBody({
      recordId: "recC",
      address: "3 Elm St, Detroit, MI",
      tier: "tier_1_decision",
      classification: "unknown",
    });
    expect(body).toContain("Agent replied, intent unclear");
    expect(body).toContain("Recommend: operator review");
  });

  it("tier 2 acceptance: ACT NOW prefix, action, link — no recommendation line", () => {
    const { body } = buildReplyAlertBody({
      recordId: "recD",
      address: "4 Pine St, Detroit, MI 48227",
      tier: "tier_2_urgent",
      classification: "acceptance",
    });
    expect(body).toMatch(/^ACT NOW: 4 Pine St\./);
    expect(body).toContain("Seller said yes, draft contract");
    expect(body).toContain("/pipeline/recD");
    expect(body).not.toContain("Recommend:");
  });

  it("STANDING RULE: the body never includes the inbound text (it is not even an input)", () => {
    // The type no longer accepts inboundBody — compile-time enforcement.
    // Runtime spot-check: nothing in the composed body except the decision
    // scaffolding + record facts.
    const { body } = buildReplyAlertBody({
      recordId: "recE",
      address: "5 Cedar St",
      tier: "tier_1_decision",
      classification: "interest",
    });
    expect(body).toBe(
      `DECISION NEEDED: 5 Cedar St. Agent is interested. Recommend: advance to offer or DD. ${body.split(" ").pop()}`,
    );
  });

  it("missing address falls back gracefully", () => {
    const { body } = buildReplyAlertBody({
      recordId: "recF",
      address: null,
      tier: "tier_1_decision",
      classification: "unknown",
    });
    expect(body).toContain("unknown address");
  });
});

describe("alertAction / alertRecommendation", () => {
  it("maps every classification to an action", () => {
    expect(alertAction("counter")).toBe("Agent countered");
    expect(alertAction("interest")).toBe("Agent is interested");
    expect(alertAction("acceptance")).toBe("Seller said yes, draft contract");
    expect(alertAction("unknown")).toBe("Agent replied, intent unclear");
  });

  it("counter recommendation requires BOTH opener and MAO present", () => {
    expect(alertRecommendation({ recordId: "r", address: null, tier: "tier_1_decision", classification: "counter", outreachOfferPrice: 48750, underwrittenMao: null }).priceGap).toBe(true);
    expect(alertRecommendation({ recordId: "r", address: null, tier: "tier_1_decision", classification: "counter", outreachOfferPrice: null, underwrittenMao: 50000 }).priceGap).toBe(true);
  });
});

// THE 2026-08-06 MISS (257 Chalmers Dr NW, 2241 1st St): a bare "No" paged the
// operator as "intent unclear". classifyReply had matched it exactly, triage
// had already drafted the re-engagement — only the alert's switch was missing
// a case, so the system reported confusion it did not have.
describe("alertAction covers EVERY classification triage can produce", () => {
  it("names a soft no instead of calling it unclear", () => {
    expect(alertAction("soft_no")).toBe("Agent declined, re-engagement drafted");
  });

  it("names the high-intent replies that were also falling through", () => {
    // An agent proposing a showing is the closest thing to a yes that exists
    // before a contract. It must never render as confusion.
    expect(alertAction("appointment")).toBe("Agent proposed a showing/call time");
    expect(alertAction("offer_format")).toBe("Agent wants the offer in writing");
    expect(alertAction("seller_costs")).toBe("Agent asked who pays what");
    expect(alertAction("disclosure_step")).toBe("Compliance disclosure - needs you personally");
  });

  it("reserves 'intent unclear' for the ONLY case that is genuinely unclear", () => {
    expect(alertAction("unknown")).toBe("Agent replied, intent unclear");
  });

  it("no classification but 'unknown' may claim confusion", () => {
    // Guards the regression directly: if a future classification renders as
    // "intent unclear", it is either genuinely unknown or this test fails.
    const named = ["acceptance", "counter", "interest", "rejection", "soft_no",
      "offer_format", "appointment", "seller_costs", "disclosure_step"] as const;
    for (const c of named) {
      expect(alertAction(c)).not.toMatch(/intent unclear/);
    }
  });
});

// GSM-7 SEGMENT COST (2026-09-09, Spine rec6C9KnSL89PP4y5): sendBuyerReplyAlert
// had no test at all, and its composed body carried the one smart character
// the outbound-templates GSM-7 sweep missed (an em-dash between the address
// and the buyer's name — it never runs through a pure builder the sweep's
// guard suite could reach). Pin the plain-hyphen text AND the GSM-7 encoding
// so a future smart character regresses loudly.
describe("sendBuyerReplyAlert — buyer body composition stays GSM-7 clean", () => {
  const ORIGINAL_ENV = process.env;
  beforeEach(() => {
    sendMessage.mockClear();
    process.env = { ...ORIGINAL_ENV, ALERT_PHONE: "+13125550100", ALERT_FROM: "+16302505865" };
  });
  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it("composes a plain-hyphen body and sends it GSM-7 encoded", async () => {
    await sendBuyerReplyAlert({
      recordId: "recBUYER1",
      address: "123 Main St, Detroit, MI",
      buyerName: "Marcus",
      amountUsd: 42_000,
      dealUrl: "https://coach-pulse-ten.vercel.app/dispo/recBUYER1",
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const body = sendMessage.mock.calls[0]?.[1] as string;
    expect(body).toBe("ACT NOW (buyer): 123 Main St - Marcus $42,000. https://coach-pulse-ten.vercel.app/dispo/recBUYER1");
    expect(estimateSmsSegments(body).encoding).toBe("gsm7");
  });
});

describe("scope line — GSM-7 safety (untested path that shipped a U+2192, 2026-09-09)", () => {
  const withScope = () =>
    buildReplyAlertBody({
      recordId: "recbHNKmFSiGXrfus",
      address: "1005 2nd St, Birmingham, AL 35214",
      tier: "tier_1_decision",
      classification: "counter",
      outreachOfferPrice: 74500,
      underwrittenMao: 80000,
      scope: { tier: "heavy", scopeRehab: 146300, storedRehab: 22937, ceiling: 51708 },
    });

  it("renders the scope line with an ASCII arrow", () => {
    const { body } = withScope();
    expect(body).toContain("-> ceiling $51,708");
    expect(body).not.toContain("\u2192");
  });

  it("bills as GSM-7 — the whole point of the fix", () => {
    const { body } = withScope();
    expect(findNonGsm7Chars(body)).toEqual([]);
    expect(estimateSmsSegments(body).encoding).toBe("gsm7");
  });
});

// ── BUILD 1 (2026-09-12): the alert now carries a DECISION CARD ────────────
// Before this, a Tier 1/2 alert ended at a password-gated /pipeline link: Alex
// reads "Agent countered" on his phone and then needs a laptop to do anything
// about it. These tests pin the three pre-declared taps and the link swap.
describe("cardOptionsForReply — exactly three pre-declared, allowlisted taps", () => {
  const TODAY = "2026-09-12";
  const base = (over: Partial<ReplyAlertInput> = {}): ReplyAlertInput => ({
    recordId: "recMONTROSE",
    address: "1102 Montrose Ave, Chicago, IL 60613",
    tier: "tier_1_decision",
    classification: "counter",
    ...over,
  });

  it("every classification yields exactly 3 options, all inside the card allowlist", () => {
    const classifications: ReplyClassification[] = [
      "acceptance", "counter", "interest", "rejection", "soft_no", "offer_format",
      "appointment", "seller_costs", "disclosure_step", "hostile", "list_anchored",
      "flat_no", "auto_reply", "identity_question", "agent_redirect", "unknown",
    ];
    for (const classification of classifications) {
      const opts = cardOptionsForReply(base({ classification }), TODAY);
      expect(opts, classification).toHaveLength(3);
      for (const o of opts) {
        expect(isAllowedCardAction(o.action.type), `${classification}/${o.key}`).toBe(true);
        expect(o.action.recordId).toBe("recMONTROSE");
        expect(o.action.table).toBe("listings");
        expect(o.confirmation.length).toBeGreaterThan(0);
      }
      // One primary, one secondary pause, one danger walk — always in that order.
      expect(opts.map((o) => o.style)).toEqual(["primary", "secondary", "danger"]);
      expect(opts[1].key).toBe("pause");
      expect(opts[2].key).toBe("walk");
    }
  });

  it("EVERY note carries the literal operator-ruling prefix the triage routine executes on", () => {
    for (const classification of ["acceptance", "counter", "interest", "unknown"] as ReplyClassification[]) {
      const notes = cardOptionsForReply(base({ classification, outreachOfferPrice: 55750 }), TODAY)
        .map((o) => o.action.note)
        .filter((n): n is string => typeof n === "string");
      expect(notes.length).toBeGreaterThan(0);
      for (const n of notes) expect(n.startsWith(`OPERATOR RULING via card ${TODAY}:`)).toBe(true);
    }
  });

  it("pause holds until today + 2 days (UTC), in the YYYY-MM-DD the hold handler demands", () => {
    const pause = cardOptionsForReply(base(), TODAY)[1];
    expect(pause.action.type).toBe("hold");
    expect(pause.action.until).toBe("2026-09-14");
    expect(pause.action.until).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(pause.confirmation).toBe("Held 48 hours. Nothing goes out until then.");
    // Month and year rollover (the off-by-one a local-time shim would produce).
    expect(cardOptionsForReply(base(), "2026-09-30")[1].action.until).toBe("2026-10-02");
    expect(cardOptionsForReply(base(), "2026-12-31")[1].action.until).toBe("2027-01-02");
  });

  it("acceptance: PROCEED note + the contract-drafting confirmation", () => {
    const [proceed] = cardOptionsForReply(base({ classification: "acceptance" }), TODAY);
    expect(proceed.key).toBe("proceed");
    expect(proceed.label).toBe("Proceed: draft contract");
    expect(proceed.action.type).toBe("append_note");
    expect(proceed.action.note).toBe(
      `OPERATOR RULING via card ${TODAY}: PROCEED - draft the contract at the accepted terms. Tier C cleared by operator tap.`,
    );
    expect(proceed.confirmation).toBe("Ruling recorded. Maverick drafts the contract at the accepted terms.");
  });

  it("counter WITH a sticky opener: the label and the ruling both carry the number", () => {
    const [hold] = cardOptionsForReply(base({ outreachOfferPrice: 55750 }), TODAY);
    expect(hold.key).toBe("hold_price");
    expect(hold.label).toBe("Hold at $55,750");
    expect(hold.action.note).toBe(
      `OPERATOR RULING via card ${TODAY}: HOLD at $55,750 - reply that we are firm at $55,750. Tier C cleared by operator tap.`,
    );
  });

  it("counter with NO opener on the record: never fabricates a number", () => {
    const [hold] = cardOptionsForReply(base({ outreachOfferPrice: null }), TODAY);
    expect(hold.label).toBe("Hold sticky opener");
    expect(hold.action.note).toContain("HOLD at the sticky opener on record");
    expect(hold.action.note).not.toContain("$");
    expect(hold.confirmation).not.toContain("$");
  });

  it("every other classification advances within doctrine, with no new number", () => {
    const [advance] = cardOptionsForReply(base({ classification: "appointment" }), TODAY);
    expect(advance.key).toBe("advance");
    expect(advance.label).toBe("Advance");
    expect(advance.action.note).toBe(
      `OPERATOR RULING via card ${TODAY}: ADVANCE - Maverick proceeds to the next step (written offer, showing, or answer) within doctrine, no new number without comp-level verification.`,
    );
  });

  it("walk away is mark_dead and nothing more", () => {
    const walk = cardOptionsForReply(base(), TODAY)[2];
    expect(walk.action.type).toBe("mark_dead");
    expect(walk.action.note).toBeUndefined();
    expect(walk.confirmation).toBe("Marked dead. Nothing more goes to this agent.");
  });
});

describe("buildReplyAlertBody link parameter — the card URL replaces the laptop trip", () => {
  const input: ReplyAlertInput = {
    recordId: "recMONTROSE",
    address: "1102 Montrose Ave, Chicago, IL 60613",
    tier: "tier_2_urgent",
    classification: "counter",
  };

  it("defaults to the pipeline link (unchanged behavior)", () => {
    expect(buildReplyAlertBody(input).body).toBe(
      `ACT NOW: 1102 Montrose Ave. Agent countered. ${pipelineLink("recMONTROSE")}`,
    );
  });

  it("substitutes a supplied link, and omits it entirely when null", () => {
    const card = "https://coach-pulse-ten.vercel.app/a/TOKEN123";
    expect(buildReplyAlertBody(input, card).body).toBe("ACT NOW: 1102 Montrose Ave. Agent countered. " + card);
    expect(buildReplyAlertBody(input, null).body).toBe("ACT NOW: 1102 Montrose Ave. Agent countered.");
    expect(buildReplyAlertBody(input, null).body).not.toMatch(/\s$/);
  });
});

describe("sendReplyAlert — pages a card when KV can mint one, the pipeline link when it cannot", () => {
  const ORIGINAL_ENV = process.env;
  const input: ReplyAlertInput = {
    recordId: "recMONTROSE",
    address: "1102 Montrose Ave, Chicago, IL 60613",
    tier: "tier_2_urgent",
    classification: "acceptance",
  };

  beforeEach(() => {
    sendMessage.mockClear();
    process.env = {
      ...ORIGINAL_ENV,
      ALERT_PHONE: "+13125550100",
      ALERT_FROM: "+16302505865",
      DASHBOARD_BASE_URL: "https://coach-pulse-ten.vercel.app",
    };
  });
  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it("with KV configured: mints a card and the SMS carries the CARD url, not the pipeline link", async () => {
    kvState.on = true;
    try {
      const res = await sendReplyAlert(input);
      expect(res.sent).toBe(true);
      const body = sendMessage.mock.calls[0]?.[1] as string;
      expect(body).toContain("ACT NOW: 1102 Montrose Ave. Seller said yes, draft contract.");
      expect(body).not.toContain("/pipeline/");
      const token = body.match(/\/a\/([A-Za-z0-9_-]+)/)?.[1];
      expect(token, body).toBeTruthy();
      expect(body).toContain(`https://coach-pulse-ten.vercel.app/a/${token}`);
      expect(estimateSmsSegments(body).encoding).toBe("gsm7");

      // The stored card is what a tap will execute: the three reply options,
      // 48h TTL, every action on this record.
      const raw = await kvState.client!.get(`${CARD_KV_PREFIX}${token}`);
      const card = JSON.parse(raw!) as DecisionCard;
      expect(card.options.map((o) => o.key)).toEqual(["proceed", "pause", "walk"]);
      expect(card.options.every((o) => o.action.recordId === "recMONTROSE")).toBe(true);
      expect(card.title).toBe("ACT NOW: 1102 Montrose Ave. Seller said yes, draft contract.");
      expect(card.context[0]).toBe("1102 Montrose Ave, Chicago, IL 60613");
      const ttlH = (Date.parse(card.expiresAt) - Date.parse(card.createdAt)) / 3_600_000;
      expect(ttlH).toBe(48);
    } finally {
      kvState.on = false;
    }
  });

  it("with NO KV configured: falls back to the pipeline link and still sends", async () => {
    const res = await sendReplyAlert(input);
    expect(res.sent).toBe(true);
    expect(res.priceGap).toBe(false);
    const body = sendMessage.mock.calls[0]?.[1] as string;
    expect(body).toContain("ACT NOW: 1102 Montrose Ave. Seller said yes, draft contract.");
    expect(body).toContain("/pipeline/recMONTROSE");
    expect(estimateSmsSegments(body).encoding).toBe("gsm7");
    // Sent from the Maverick line — channel separation.
    expect(sendMessage.mock.calls[0]?.[2]).toEqual({ from: "+16302505865" });
  });

  it("refuses (audited) when ALERT_FROM is unset — the reason surfaces on the result", async () => {
    process.env = { ...process.env, ALERT_FROM: "" };
    const res = await sendReplyAlert(input);
    expect(res).toEqual({ sent: false, reason: "alert_from_not_set", priceGap: false });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("refuses when ALERT_PHONE is unset", async () => {
    process.env = { ...process.env, ALERT_PHONE: "" };
    const res = await sendReplyAlert(input);
    expect(res).toEqual({ sent: false, reason: "alert_phone_not_set", priceGap: false });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("tier 0 still never pages", async () => {
    const res = await sendReplyAlert({ ...input, tier: "tier_0_auto_close" });
    expect(res).toEqual({ sent: false, reason: "tier_0_no_alert", priceGap: false });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("priceGap still comes from the body builder (counter with missing numbers)", async () => {
    const res = await sendReplyAlert({
      ...input,
      tier: "tier_1_decision",
      classification: "counter",
      outreachOfferPrice: null,
      underwrittenMao: null,
    });
    expect(res.sent).toBe(true);
    expect(res.priceGap).toBe(true);
    const body = sendMessage.mock.calls[0]?.[1] as string;
    expect(body).toContain("Recommend: hold sticky opener");
  });

  it("STANDING RULE holds on the card too: the inbound text is not an input anywhere", () => {
    // Compile-time: ReplyAlertInput has no inbound field. Runtime: the card's
    // context lines are record facts only.
    const opts = cardOptionsForReply(input, "2026-09-12");
    expect(JSON.stringify(opts)).not.toMatch(/inbound/i);
  });
});
