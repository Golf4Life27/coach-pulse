// @agent: maverick — Decision Card tests (Layer 2, Phase C).

import { describe, it, expect, vi } from "vitest";
import {
  isRedeemable,
  findOption,
  cardUrl,
  resolveBaseUrl,
  isAllowedCardAction,
  putCard,
  getCard,
  redeemCard,
  type DecisionCard,
  type CardOption,
} from "./decision-card";
import { makeMemoryKv } from "./oauth/kv";

const NOW = "2026-09-10T12:00:00.000Z";

function option(over: Partial<CardOption> = {}): CardOption {
  return {
    key: "mark_dead",
    label: "Mark dead",
    style: "danger",
    action: { type: "mark_dead", recordId: "recABC123" },
    confirmation: "Marked dead. Nothing more will go to this agent.",
    ...over,
  };
}

function card(over: Partial<DecisionCard> = {}): DecisionCard {
  return {
    token: "tok_test_" + Math.random().toString(36).slice(2),
    title: "Joyce countered at $210k",
    context: ["List $235k", "Comps support $225-230k", "Their counter: $210k cash, 21-day close"],
    options: [option()],
    createdAt: NOW,
    expiresAt: new Date(new Date(NOW).getTime() + 3600_000).toISOString(), // +1h
    ...over,
  };
}

describe("isRedeemable", () => {
  it("refuses an expired card", () => {
    const c = card({ expiresAt: "2026-09-10T11:00:00.000Z" }); // 1h before NOW
    expect(isRedeemable(c, NOW)).toEqual({ ok: false, reason: "expired" });
  });

  it("refuses a card at exactly its expiry instant", () => {
    const c = card({ expiresAt: NOW });
    expect(isRedeemable(c, NOW)).toEqual({ ok: false, reason: "expired" });
  });

  it("refuses an already-redeemed card and reports already_used", () => {
    const c = card({ redeemedAt: "2026-09-10T11:30:00.000Z", redeemedOptionKey: "mark_dead" });
    expect(isRedeemable(c, NOW)).toEqual({ ok: false, reason: "already_used" });
  });

  it("allows a live, unredeemed card", () => {
    const c = card();
    expect(isRedeemable(c, NOW)).toEqual({ ok: true });
  });
});

describe("findOption", () => {
  it("finds an exact key match", () => {
    const c = card({ options: [option({ key: "accept" }), option({ key: "counter" })] });
    expect(findOption(c, "counter")?.key).toBe("counter");
  });

  it("does not match on prefix", () => {
    const c = card({ options: [option({ key: "accept" })] });
    expect(findOption(c, "acc")).toBeNull();
    expect(findOption(c, "accept_all")).toBeNull();
  });

  it("does not match on case difference", () => {
    const c = card({ options: [option({ key: "accept" })] });
    expect(findOption(c, "Accept")).toBeNull();
    expect(findOption(c, "ACCEPT")).toBeNull();
  });

  it("does not match with surrounding whitespace", () => {
    const c = card({ options: [option({ key: "accept" })] });
    expect(findOption(c, " accept")).toBeNull();
    expect(findOption(c, "accept ")).toBeNull();
  });

  it("returns null when no option matches", () => {
    const c = card({ options: [option({ key: "accept" })] });
    expect(findOption(c, "nonexistent")).toBeNull();
  });
});

describe("cardUrl", () => {
  it("builds /a/<token> off the base URL", () => {
    expect(cardUrl("tok123", "https://dash.example.com")).toBe("https://dash.example.com/a/tok123");
  });
});

describe("resolveBaseUrl", () => {
  it("prefers DASHBOARD_BASE_URL and strips a trailing slash", () => {
    expect(
      resolveBaseUrl({
        DASHBOARD_BASE_URL: "https://alex.example.com/",
        VERCEL_PROJECT_PRODUCTION_URL: "prod.vercel.app",
        VERCEL_URL: "preview.vercel.app",
      }),
    ).toBe("https://alex.example.com");
  });

  it("trims DASHBOARD_BASE_URL and strips multiple trailing slashes", () => {
    expect(resolveBaseUrl({ DASHBOARD_BASE_URL: "  https://alex.example.com//  " })).toBe(
      "https://alex.example.com",
    );
  });

  it("falls back to VERCEL_PROJECT_PRODUCTION_URL when no DASHBOARD_BASE_URL", () => {
    expect(
      resolveBaseUrl({ VERCEL_PROJECT_PRODUCTION_URL: "prod.vercel.app", VERCEL_URL: "preview.vercel.app" }),
    ).toBe("https://prod.vercel.app");
  });

  it("falls back to VERCEL_URL when neither of the above is set", () => {
    expect(resolveBaseUrl({ VERCEL_URL: "preview.vercel.app" })).toBe("https://preview.vercel.app");
  });

  it("returns null when nothing is set", () => {
    expect(resolveBaseUrl({})).toBeNull();
  });
});

describe("isAllowedCardAction", () => {
  it("allows the declared safe verbs", () => {
    for (const t of ["mark_dead", "hold", "clear", "append_note", "send_buyer_blast"]) {
      expect(isAllowedCardAction(t)).toBe(true);
    }
  });

  it("rejects sign_contract and walk_away", () => {
    expect(isAllowedCardAction("sign_contract")).toBe(false);
    expect(isAllowedCardAction("walk_away")).toBe(false);
  });

  it("rejects an unknown type", () => {
    expect(isAllowedCardAction("delete_everything")).toBe(false);
  });
});

describe("putCard / getCard", () => {
  it("round-trips a card through KV", async () => {
    const kv = makeMemoryKv();
    const c = card();
    await putCard(kv, c, NOW);
    const back = await getCard(kv, c.token);
    expect(back).toEqual(c);
  });

  it("returns null for a missing token", async () => {
    const kv = makeMemoryKv();
    expect(await getCard(kv, "nope")).toBeNull();
  });

  it("returns null (never throws) on unparseable JSON", async () => {
    const kv = makeMemoryKv();
    await kv.set("maverick:card:corrupt", "{not json");
    expect(await getCard(kv, "corrupt")).toBeNull();
  });

  it("clamps the TTL to a 60s floor for a near-immediate expiry", async () => {
    const kv = makeMemoryKv();
    const setEx = vi.spyOn(kv, "setEx");
    const c = card({ expiresAt: new Date(new Date(NOW).getTime() + 5_000).toISOString() }); // +5s
    await putCard(kv, c, NOW);
    expect(setEx).toHaveBeenCalledWith(expect.stringContaining(c.token), expect.any(String), 60);
  });

  it("clamps the TTL to a 7-day ceiling for a far-future expiry", async () => {
    const kv = makeMemoryKv();
    const setEx = vi.spyOn(kv, "setEx");
    const c = card({ expiresAt: new Date(new Date(NOW).getTime() + 30 * 24 * 3600_000).toISOString() }); // +30d
    await putCard(kv, c, NOW);
    const sevenDaysSeconds = 7 * 24 * 3600;
    expect(setEx).toHaveBeenCalledWith(expect.stringContaining(c.token), expect.any(String), sevenDaysSeconds);
  });

  it("does not clamp a normal in-range TTL", async () => {
    const kv = makeMemoryKv();
    const setEx = vi.spyOn(kv, "setEx");
    const c = card({ expiresAt: new Date(new Date(NOW).getTime() + 3600_000).toISOString() }); // +1h
    await putCard(kv, c, NOW);
    expect(setEx).toHaveBeenCalledWith(expect.stringContaining(c.token), expect.any(String), 3600);
  });
});

describe("redeemCard", () => {
  it("succeeds on a live card and returns the matching option", async () => {
    const kv = makeMemoryKv();
    const c = card();
    await putCard(kv, c, NOW);
    const result = await redeemCard(kv, c.token, "mark_dead", NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.option.key).toBe("mark_dead");
      expect(result.card.redeemedAt).toBe(NOW);
      expect(result.card.redeemedOptionKey).toBe("mark_dead");
    }
  });

  it("refuses redemption on an unknown token", async () => {
    const kv = makeMemoryKv();
    const result = await redeemCard(kv, "nonexistent-token", "mark_dead", NOW);
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });

  it("refuses redemption on an expired card", async () => {
    const kv = makeMemoryKv();
    const c = card({ expiresAt: "2026-09-10T11:00:00.000Z" });
    await putCard(kv, c, "2026-09-10T10:00:00.000Z");
    const result = await redeemCard(kv, c.token, "mark_dead", NOW);
    expect(result).toEqual({ ok: false, reason: "expired" });
  });

  it("refuses redemption on an already-redeemed card and reports already_used", async () => {
    const kv = makeMemoryKv();
    const c = card();
    await putCard(kv, c, NOW);
    const first = await redeemCard(kv, c.token, "mark_dead", NOW);
    expect(first.ok).toBe(true);

    const second = await redeemCard(kv, c.token, "mark_dead", NOW);
    expect(second).toEqual({ ok: false, reason: "already_used" });
  });

  it("refuses an unknown option key and executes nothing", async () => {
    const kv = makeMemoryKv();
    const executed: string[] = [];
    const c = card({
      options: [option({ key: "accept" }), option({ key: "counter" })],
    });
    await putCard(kv, c, NOW);

    const result = await redeemCard(kv, c.token, "reject_everything", NOW);
    expect(result).toEqual({ ok: false, reason: "unknown_option" });

    // Simulate the route: it only executes when result.ok is true, so a
    // caller that faithfully follows the contract never reaches an
    // executor here. Assert that directly.
    if (result.ok) executed.push((result as { option: CardOption }).option.action.type);
    expect(executed).toEqual([]);

    // The card must still be live and unredeemed — an unknown option must
    // not burn the single-use claim.
    const stillLive = await getCard(kv, c.token);
    expect(stillLive?.redeemedAt).toBeUndefined();
  });

  it("does not match an option key by prefix, case, or whitespace on redeem", async () => {
    const kv = makeMemoryKv();
    const c = card({ options: [option({ key: "accept" })] });
    await putCard(kv, c, NOW);
    expect(await redeemCard(kv, c.token, "Accept", NOW)).toEqual({ ok: false, reason: "unknown_option" });
    expect(await redeemCard(kv, c.token, "accept ", NOW)).toEqual({ ok: false, reason: "unknown_option" });
  });

  it("concurrent double-redeem: exactly one of two simultaneous calls succeeds", async () => {
    const kv = makeMemoryKv();
    const c = card();
    await putCard(kv, c, NOW);

    const [a, b] = await Promise.all([
      redeemCard(kv, c.token, "mark_dead", NOW),
      redeemCard(kv, c.token, "mark_dead", NOW),
    ]);

    const results = [a, b];
    const successes = results.filter((r) => r.ok);
    const failures = results.filter((r) => !r.ok);
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ ok: false, reason: "already_used" });
  });
});
