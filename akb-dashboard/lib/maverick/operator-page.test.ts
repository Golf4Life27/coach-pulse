// @agent: maverick — operator paging helper (the FIRST Decision Card producer).

import { describe, it, expect, vi, beforeEach } from "vitest";

const auditMock = vi.fn(async (_entry: Record<string, unknown>) => {});
vi.mock("@/lib/audit-log", () => ({
  audit: (entry: Record<string, unknown>) => auditMock(entry),
}));
vi.mock("@/lib/quo", () => ({ sendMessage: vi.fn(async () => {}) }));

import {
  composeOperatorPageSms,
  clampTtlHours,
  resolveOperatorPhone,
  pageOperatorWithCard,
} from "./operator-page";
import { CARD_KV_PREFIX, type CardOption, type DecisionCard } from "./decision-card";
import { makeMemoryKv } from "./oauth/kv";
import { estimateSmsSegments, findNonGsm7Chars } from "@/lib/sms/gsm7";

const NOW = new Date("2026-09-12T15:00:00.000Z");
const CARD_URL = "https://coach-pulse-ten.vercel.app/a/Ab3dEf9hIjKlMnOpQrStUvWxYz0123456789AbCdEf";

function option(over: Partial<CardOption> = {}): CardOption {
  return {
    key: "nudge",
    label: "Nudge: status check",
    style: "primary",
    action: { type: "append_note", recordId: "recMONTROSE", table: "listings", note: "n" },
    confirmation: "Ruling recorded.",
    ...over,
  };
}

function baseEnv(over: Record<string, string | undefined> = {}) {
  return {
    ALERT_FROM: "+16302505865",
    ALERT_PHONE: "+13125550100",
    DASHBOARD_BASE_URL: "https://coach-pulse-ten.vercel.app",
    ...over,
  };
}

describe("composeOperatorPageSms — the URL is budgeted FIRST and never truncated", () => {
  it("puts headline, reason and url on their own lines", () => {
    const body = composeOperatorPageSms(
      "STALLED: 1102 Montrose Ave. Offer accepted 11d ago at $55,750, silent 216h, no executed contract.",
      "Tap to nudge, re-open terms, or walk.",
      CARD_URL,
    );
    expect(body.split("\n")).toEqual([
      "STALLED: 1102 Montrose Ave. Offer accepted 11d ago at $55,750, silent 216h, no executed contract.",
      "Tap to nudge, re-open terms, or walk.",
      CARD_URL,
    ]);
    expect(body.length).toBeLessThanOrEqual(300);
  });

  it("keeps the URL WHOLE and trims the headline instead when the headline is long", () => {
    const headline = `URGENT: ${"word ".repeat(80)}end.`;
    const body = composeOperatorPageSms(headline, null, CARD_URL);
    expect(body).toContain(CARD_URL);
    expect(body.endsWith(CARD_URL)).toBe(true);
    expect(body.length).toBeLessThanOrEqual(300);
    // Trimmed at a word boundary with an ellipsis, never mid-word garbage.
    expect(body.split("\n")[0]).toMatch(/\.\.\.$/);
  });

  it("DROPS the URL entirely rather than truncate it when it cannot fit whole", () => {
    const absurdUrl = `https://example.com/a/${"z".repeat(280)}`;
    const body = composeOperatorPageSms("STALLED: 1102 Montrose Ave.", null, absurdUrl);
    expect(body).not.toContain("zzz");
    expect(body).toBe("STALLED: 1102 Montrose Ave.");
  });

  it("drops the reason before it drops the link (link outranks the why)", () => {
    const headline = `STALLED: ${"x".repeat(230)}`;
    const body = composeOperatorPageSms(headline, "Tap to nudge, re-open terms, or walk.", CARD_URL);
    expect(body).toContain(CARD_URL);
    expect(body).not.toContain("Tap to nudge");
    expect(body.length).toBeLessThanOrEqual(300);
  });

  it("normalizes smart characters so the body bills as GSM-7 (never UCS-2)", () => {
    const body = composeOperatorPageSms(
      "STALLED: 1102 Montrose Ave — offer accepted",
      "Agent’s scope → re-open terms…",
      CARD_URL,
    );
    expect(body).toContain("Ave - offer accepted");
    expect(body).toContain("Agent's scope -> re-open terms...");
    expect(findNonGsm7Chars(body)).toEqual([]);
    expect(estimateSmsSegments(body).encoding).toBe("gsm7");
  });

  it("omits the link line when there is no url", () => {
    expect(composeOperatorPageSms("ACT NOW: 1 Main St.", "why", null)).toBe(
      "ACT NOW: 1 Main St.\nwhy",
    );
  });
});

describe("clampTtlHours / resolveOperatorPhone", () => {
  it("defaults to 24h and clamps to 1..168", () => {
    expect(clampTtlHours(undefined)).toBe(24);
    expect(clampTtlHours(0)).toBe(1);
    expect(clampTtlHours(-5)).toBe(1);
    expect(clampTtlHours(999)).toBe(168);
    expect(clampTtlHours(48)).toBe(48);
    expect(clampTtlHours(Number.NaN)).toBe(24);
  });

  it("walks ALERT_PHONE -> OPERATOR_PERSONAL_PHONE -> Stage4 target -> the operator cell", () => {
    expect(resolveOperatorPhone({ ALERT_PHONE: "+1111", OPERATOR_PERSONAL_PHONE: "+2222" })).toBe("+1111");
    expect(resolveOperatorPhone({ ALERT_PHONE: "  ", OPERATOR_PERSONAL_PHONE: "+2222" })).toBe("+2222");
    expect(resolveOperatorPhone({ MAVERICK_STAGE4_SMS_TARGET: "+3333" })).toBe("+3333");
    expect(resolveOperatorPhone({})).toBe("+16302172539");
  });
});

describe("pageOperatorWithCard — fail-closed refusals happen BEFORE anything is minted", () => {
  beforeEach(() => auditMock.mockClear());

  it("refuses a disallowed action type and never writes a card", async () => {
    const kv = makeMemoryKv();
    const setEx = vi.spyOn(kv, "setEx");
    const send = vi.fn(async () => {});
    const res = await pageOperatorWithCard(
      {
        title: "t",
        context: [],
        options: [option({ action: { type: "sign_contract", recordId: "recX" } })],
        sms: { headline: "STALLED: 1 Main St." },
        audit: { agent: "maverick", event: "accepted_silence_paged", recordId: "recX" },
      },
      { kv, send, env: baseEnv(), now: NOW },
    );
    expect(res).toMatchObject({ sent: false, reason: "disallowed_action", token: null, cardUrl: null });
    expect(setEx).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("refuses when ALERT_FROM is unset — channel separation beats delivery", async () => {
    const kv = makeMemoryKv();
    const setEx = vi.spyOn(kv, "setEx");
    const send = vi.fn(async () => {});
    const res = await pageOperatorWithCard(
      {
        title: "t",
        context: [],
        options: [option()],
        sms: { headline: "STALLED: 1 Main St." },
        audit: { agent: "maverick", event: "accepted_silence_paged" },
      },
      { kv, send, env: baseEnv({ ALERT_FROM: undefined }), now: NOW },
    );
    expect(res.sent).toBe(false);
    expect(res.reason).toBe("alert_from_not_set");
    expect(res.token).toBeNull();
    expect(setEx).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("refuses more than 3 options", async () => {
    const res = await pageOperatorWithCard(
      {
        title: "t",
        context: [],
        options: [option({ key: "a" }), option({ key: "b" }), option({ key: "c" }), option({ key: "d" })],
        sms: { headline: "h" },
        audit: { agent: "maverick", event: "e" },
      },
      { kv: makeMemoryKv(), send: vi.fn(async () => {}), env: baseEnv(), now: NOW },
    );
    expect(res.reason).toBe("invalid_option_count");
  });
});

describe("pageOperatorWithCard — happy path", () => {
  beforeEach(() => auditMock.mockClear());

  it("mints a card with 1..3 options, sends the card URL from the Maverick line, audits both rows", async () => {
    const kv = makeMemoryKv();
    const send = vi.fn(async () => {});
    const res = await pageOperatorWithCard(
      {
        title: "1102 Montrose Ave: offer accepted, silent 9d, no executed contract",
        context: ["Accepted at $55,750", "Agent: Sarah Kim"],
        options: [
          option(),
          option({ key: "reopen", label: "Re-open terms", style: "secondary" }),
          option({
            key: "walk",
            label: "Walk away",
            style: "danger",
            action: { type: "mark_dead", recordId: "recMONTROSE", table: "listings" },
          }),
        ],
        ttlHours: 48,
        sms: { headline: "STALLED: 1102 Montrose Ave.", reason: "Tap to nudge, re-open terms, or walk." },
        audit: { agent: "maverick", event: "accepted_silence_paged", recordId: "recMONTROSE" },
      },
      { kv, send, env: baseEnv(), now: NOW },
    );

    expect(res.sent).toBe(true);
    expect(res.reason).toBeNull();
    expect(res.token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(res.cardUrl).toBe(`https://coach-pulse-ten.vercel.app/a/${res.token}`);

    // The stored card is what the redeem route will execute — verify it landed.
    const stored = JSON.parse((await kv.get(`${CARD_KV_PREFIX}${res.token}`))!) as DecisionCard;
    expect(stored.options.map((o) => o.key)).toEqual(["nudge", "reopen", "walk"]);
    expect(stored.expiresAt).toBe("2026-09-14T15:00:00.000Z"); // +48h
    expect(stored.title).toContain("1102 Montrose Ave");

    // Sent FROM the Maverick line, TO the operator alert phone, body carries the link.
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]).toEqual([
      "+13125550100",
      res.body,
      { from: "+16302505865" },
    ]);
    expect(res.body).toContain(res.cardUrl);
    expect(estimateSmsSegments(res.body).encoding).toBe("gsm7");

    const events = auditMock.mock.calls.map((c) => c[0].event as string);
    expect(events).toContain("decision_card_created");
    expect(events).toContain("accepted_silence_paged");
    const created = auditMock.mock.calls
      .map((c) => c[0])
      .find((e) => e.event === "decision_card_created")!;
    expect(created.agent).toBe("maverick");
    expect(created.inputSummary).toMatchObject({
      producer: "accepted_silence_paged",
      options: ["append_note", "append_note", "mark_dead"],
      ttl_hours: 48,
    });
    expect(created.outputSummary).toMatchObject({ token: res.token, has_url: true });
  });

  it("with NO KV: no card, cardUrl null, still sends using the fallback link", async () => {
    const send = vi.fn(async () => {});
    const res = await pageOperatorWithCard(
      {
        title: "t",
        context: [],
        options: [option()],
        sms: { headline: "ACT NOW: 1102 Montrose Ave. Agent countered." },
        audit: { agent: "crier", event: "reply_alert_sent", recordId: "recMONTROSE" },
        fallbackLink: "https://coach-pulse-ten.vercel.app/pipeline/recMONTROSE",
      },
      { kv: null, send, env: baseEnv(), now: NOW },
    );
    expect(res.sent).toBe(true);
    expect(res.token).toBeNull();
    expect(res.cardUrl).toBeNull();
    expect(res.body).toContain("/pipeline/recMONTROSE");
    const events = auditMock.mock.calls.map((c) => c[0].event as string);
    expect(events).not.toContain("decision_card_created");
  });

  it("with no KV and no fallback link: sends a linkless alert rather than nothing", async () => {
    const send = vi.fn(async () => {});
    const res = await pageOperatorWithCard(
      {
        title: "t",
        context: [],
        options: [option()],
        sms: { headline: "ACT NOW: 1102 Montrose Ave." },
        audit: { agent: "crier", event: "reply_alert_sent" },
      },
      { kv: null, send, env: baseEnv(), now: NOW },
    );
    expect(res.sent).toBe(true);
    expect(res.body).toBe("ACT NOW: 1102 Montrose Ave.");
  });

  it("omits the link when no base URL is configured (never sends a broken one)", async () => {
    const kv = makeMemoryKv();
    const send = vi.fn(async () => {});
    const res = await pageOperatorWithCard(
      {
        title: "t",
        context: [],
        options: [option()],
        sms: { headline: "ACT NOW: 1102 Montrose Ave." },
        audit: { agent: "crier", event: "reply_alert_sent" },
      },
      { kv, send, env: { ALERT_FROM: "+16302505865", ALERT_PHONE: "+13125550100" }, now: NOW },
    );
    expect(res.token).not.toBeNull(); // the card exists...
    expect(res.cardUrl).toBeNull(); // ...but is unlinkable
    expect(res.body).toBe("ACT NOW: 1102 Montrose Ave.");
  });

  it("never throws when the send fails — reports it as a reason", async () => {
    const res = await pageOperatorWithCard(
      {
        title: "t",
        context: [],
        options: [option()],
        sms: { headline: "ACT NOW: 1102 Montrose Ave." },
        audit: { agent: "crier", event: "reply_alert_sent" },
      },
      {
        kv: makeMemoryKv(),
        send: vi.fn(async () => {
          throw new Error("quo 429 rate limited");
        }),
        env: baseEnv(),
        now: NOW,
      },
    );
    expect(res.sent).toBe(false);
    expect(res.reason).toContain("quo 429");
    expect(res.token).not.toBeNull(); // the card is live; only the text failed
  });

  it("never throws when the KV write fails — sends without a card link", async () => {
    const kv = makeMemoryKv();
    kv.setEx = async () => {
      throw new Error("KV setEx failed: 500");
    };
    const send = vi.fn(async () => {});
    const res = await pageOperatorWithCard(
      {
        title: "t",
        context: [],
        options: [option()],
        sms: { headline: "ACT NOW: 1102 Montrose Ave." },
        audit: { agent: "crier", event: "reply_alert_sent" },
        fallbackLink: "https://coach-pulse-ten.vercel.app/pipeline/recMONTROSE",
      },
      { kv, send, env: baseEnv(), now: NOW },
    );
    expect(res.sent).toBe(true);
    expect(res.token).toBeNull();
    expect(res.cardUrl).toBeNull();
    expect(res.body).toContain("/pipeline/recMONTROSE");
  });
});
