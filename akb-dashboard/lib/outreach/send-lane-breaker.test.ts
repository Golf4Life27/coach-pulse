import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  SEND_LANE_BREAKER_KEY,
  SEND_LANE_402_TTL_S,
  _resetSendLaneBreakerMemory,
  checkSendLaneBreaker,
  clearSendLaneBreaker,
  isQuoCreditsExhausted,
  tripSendLaneBreaker,
} from "./send-lane-breaker";
import { QuoSendError } from "@/lib/quo";
import { makeMemoryKv } from "@/lib/maverick/oauth/kv";

const NOW = new Date("2026-09-02T14:02:03Z");

describe("isQuoCreditsExhausted", () => {
  it("recognises the structured 402, the legacy message string, and nothing else", () => {
    expect(isQuoCreditsExhausted(new QuoSendError(402, { message: "The organization does not have enough prepaid credits" }))).toBe(true);
    expect(isQuoCreditsExhausted(new Error('Quo send error 402: {"message":"x"}'))).toBe(true);
    expect(isQuoCreditsExhausted(new Error("not have enough prepaid credits to send the message"))).toBe(true);
    expect(isQuoCreditsExhausted(new QuoSendError(401, {}))).toBe(false);
    expect(isQuoCreditsExhausted(new Error("Quo send error 4020: nope"))).toBe(false);
    expect(isQuoCreditsExhausted(new Error("network"))).toBe(false);
    expect(isQuoCreditsExhausted(null)).toBe(false);
  });
});

describe("send-lane breaker (KV)", () => {
  beforeEach(() => _resetSendLaneBreakerMemory());

  it("is open by default, trips on a 402 with one audit row, and clears", async () => {
    const kv = makeMemoryKv();
    const auditFn = vi.fn(async () => {});
    expect(await checkSendLaneBreaker(kv, NOW)).toEqual({ tripped: false, tripped_at: null });

    await tripSendLaneBreaker("h2_outreach", new QuoSendError(402, {}), kv, auditFn, NOW);
    expect(await checkSendLaneBreaker(kv, NOW)).toEqual({ tripped: true, tripped_at: NOW.toISOString() });
    expect(await kv.get(SEND_LANE_BREAKER_KEY)).toBe(NOW.toISOString());
    expect(auditFn).toHaveBeenCalledTimes(1);
    const calls = auditFn.mock.calls as unknown as Array<[{ event: string; decision?: string; inputSummary?: { lane: string; ttl_s: number } }]>;
    const row = calls[0][0];
    expect(row.event).toBe("quo_credits_exhausted");
    expect(row.decision).toBe("lane_tripped");
    expect(row.inputSummary).toEqual({ lane: "h2_outreach", ttl_s: SEND_LANE_402_TTL_S });

    await clearSendLaneBreaker(kv);
    expect(await checkSendLaneBreaker(kv, NOW)).toEqual({ tripped: false, tripped_at: null });
  });

  it("falls back to memory when KV is absent and heals after the TTL", async () => {
    const auditFn = vi.fn(async () => {});
    await tripSendLaneBreaker("h2_bump", new Error("Quo send error 402: {}"), null, auditFn, NOW);
    expect((await checkSendLaneBreaker(null, NOW)).tripped).toBe(true);
    const later = new Date(NOW.getTime() + (SEND_LANE_402_TTL_S + 1) * 1000);
    expect((await checkSendLaneBreaker(null, later)).tripped).toBe(false);
  });

  it("fails open when KV throws", async () => {
    const kv = makeMemoryKv();
    kv.get = async () => {
      throw new Error("kv down");
    };
    expect((await checkSendLaneBreaker(kv, NOW)).tripped).toBe(false);
  });
});
