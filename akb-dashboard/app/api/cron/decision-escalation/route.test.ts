// P0-17 (2026-09-24): this cron read ONLY OPERATOR_PERSONAL_PHONE directly —
// that var was never set in prod, so the cron ran hourly for months finding
// overdue money decisions (audit rows: phone_configured:false, due 32, sent
// 0) while the operator-page path (same phone, resolveOperatorPhone's
// waterfall) sent fine. Fix: use the same shared resolver here too.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ConveyorItem } from "@/lib/conveyor/model";

const sendMock = vi.fn(async (..._args: unknown[]) => {});
vi.mock("@/lib/quo", () => ({ sendMessage: (...args: unknown[]) => sendMock(...args) }));

const ITEM: ConveyorItem = {
  key: "action_item:itm-1",
  source: "action_item",
  type: "2B",
  title: "Old money decision",
  reasoning: "Needs a ruling.",
  recordId: "recX",
  href: "/pipeline/recX",
  dollars: 5_000,
  deadlineAt: null,
  deadlineImplied: false,
  postedAt: "2026-07-11T06:00:00Z", // 10h old at NOW — clears the default 6h age gate
  verbatim: null,
  actions: [],
};

const fetchItemsMock = vi.fn(async (..._args: unknown[]) => [ITEM]);
vi.mock("@/lib/decision-feed-server", () => ({
  fetchConveyorItemsServer: (...args: unknown[]) => fetchItemsMock(...args),
}));

const NOW = new Date("2026-07-11T16:00:00Z"); // 11:00 Chicago — inside the 8-21 send window

const ENV_KEYS = [
  "OPERATOR_PERSONAL_PHONE",
  "ALERT_PHONE",
  "MAVERICK_STAGE4_SMS_TARGET",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "CRON_SECRET",
  "MAVERICK_MCP_TOKEN",
  "MAVERICK_CRON_ENABLED",
] as const;

function withCleanEnv(): () => void {
  const prior: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) prior[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  return () => {
    for (const k of ENV_KEYS) {
      if (prior[k] === undefined) delete process.env[k];
      else process.env[k] = prior[k];
    }
  };
}

describe("decision-escalation cron — P0-17 shared phone resolver", () => {
  let restoreEnv: () => void;

  beforeEach(() => {
    restoreEnv = withCleanEnv();
    sendMock.mockClear();
    fetchItemsMock.mockClear();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
    restoreEnv();
    vi.doUnmock("@/lib/maverick/operator-page");
  });

  it("sends through resolveOperatorPhone's fallback when OPERATOR_PERSONAL_PHONE is absent", async () => {
    // No phone env at all — the old code would read OPERATOR_PERSONAL_PHONE
    // directly, get "", and go report-only forever. The shared resolver
    // falls back to the operator-confirmed default cell instead.
    const { GET } = await import("./route");
    const res = await GET(new Request("https://x/api/cron/decision-escalation"));
    const body = await res.json();

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][0]).toBe("+16302172539"); // resolveOperatorPhone's last-resort default
    expect(body.sent).toHaveLength(1);
    expect(body.mode).toBe("live");
  });

  it("still sends nothing when no phone resolves at all (fail-closed, not a crash)", async () => {
    vi.doMock("@/lib/maverick/operator-page", () => ({ resolveOperatorPhone: () => "" }));
    const { GET } = await import("./route");
    const res = await GET(new Request("https://x/api/cron/decision-escalation"));
    const body = await res.json();

    expect(sendMock).not.toHaveBeenCalled();
    expect(body.sent).toHaveLength(0);
    expect(body.mode).toBe("report_only_no_phone");
    expect(body.skipped[0]).toMatchObject({ reason: "no_operator_phone_env" });
  });
});

// ── P0-17 follow-up (2026-09-24): one digest text per run, not one per
// decision. Needs a REAL (in-memory) KV so the setNx dedupe claim actually
// persists across the multiple GET() calls each test makes — kvConfigured()
// and kvProd are mocked here, and requests authenticate via CRON_SECRET so
// the auth waterfall (now required because kvConfigured() reports true)
// still lets the request through.
describe("decision-escalation cron — one digest text per run", () => {
  let restoreEnv: () => void;
  const CRON_SECRET = "test-cron-secret-0123456789";

  function cronRequest(): Request {
    return new Request("https://x/api/cron/decision-escalation", {
      headers: { authorization: `Bearer ${CRON_SECRET}` },
    });
  }

  function item(over: Partial<ConveyorItem> & { key: string; title: string; dollars: number }): ConveyorItem {
    return {
      source: "action_item",
      type: "2B",
      reasoning: "Needs a ruling.",
      recordId: null,
      href: null,
      deadlineAt: null,
      deadlineImplied: false,
      postedAt: "2026-07-11T06:00:00Z", // 10h old at NOW — clears the default 6h age gate
      verbatim: null,
      actions: [],
      ...over,
    };
  }

  beforeEach(() => {
    restoreEnv = withCleanEnv();
    process.env.CRON_SECRET = CRON_SECRET;
    process.env.MAVERICK_CRON_ENABLED = "true";
    sendMock.mockClear();
    fetchItemsMock.mockClear();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.resetModules();
    vi.doMock("@/lib/maverick/oauth/kv", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@/lib/maverick/oauth/kv")>();
      return { ...actual, kvConfigured: () => true, kvProd: actual.makeMemoryKv() };
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    restoreEnv();
    vi.doUnmock("@/lib/maverick/oauth/kv");
  });

  it("bundles every unclaimed due item into ONE digest (top 3 + a count) and claims all of them; a repeat run sends nothing; a new item next to already-claimed ones sends alone", async () => {
    const five = [1, 2, 3, 4, 5].map((n) =>
      item({ key: `action_item:itm-${n}`, title: `Decision ${n}`, dollars: n * 1_000 }),
    );
    fetchItemsMock.mockResolvedValue(five);

    const { GET } = await import("./route");
    const res = await GET(cronRequest());
    const body = await res.json();

    expect(sendMock).toHaveBeenCalledTimes(1);
    const sms = sendMock.mock.calls[0][1] as string;
    expect(sms).toContain("Decision 1");
    expect(sms).toContain("Decision 2");
    expect(sms).toContain("Decision 3");
    expect(sms).not.toContain("Decision 4");
    expect(sms).not.toContain("Decision 5");
    expect(sms).toContain("+2 more overdue in your queue");
    expect(body.outcome).toBe("sent");
    expect(body.sent).toHaveLength(5); // all 5 claimed, bundled into the one send

    // Same 5 items again — every one is already claimed within 24h: no send.
    sendMock.mockClear();
    const res2 = await GET(cronRequest());
    const body2 = await res2.json();
    expect(sendMock).not.toHaveBeenCalled();
    expect(body2.outcome).toBe("nothing_new");
    expect(body2.sent).toHaveLength(0);

    // A 6th, brand-new item shows up alongside the 5 already-claimed ones —
    // only the new one sends, named alone (no "+N more" for a single item).
    const sixth = item({ key: "action_item:itm-6", title: "Decision 6", dollars: 6_000 });
    fetchItemsMock.mockResolvedValue([...five, sixth]);
    sendMock.mockClear();
    const res3 = await GET(cronRequest());
    const body3 = await res3.json();
    expect(sendMock).toHaveBeenCalledTimes(1);
    const sms3 = sendMock.mock.calls[0][1] as string;
    expect(sms3).toContain("Decision 6");
    expect(sms3).not.toContain("more overdue");
    expect(body3.sent).toHaveLength(1);
    expect(body3.sent[0]).toMatchObject({ key: "action_item:itm-6" });
  });

  it("releases every claim taken this run when the send fails, so the next run retries all of them", async () => {
    const two = [1, 2].map((n) =>
      item({ key: `action_item:fail-${n}`, title: `Fail decision ${n}`, dollars: n * 1_000 }),
    );
    fetchItemsMock.mockResolvedValue(two);
    sendMock.mockImplementationOnce(async () => {
      throw new Error("quo 500");
    });

    const { GET } = await import("./route");
    const res = await GET(cronRequest());
    const body = await res.json();
    expect(body.outcome).toBe("send_failed");
    expect(body.sent).toHaveLength(0);
    expect(body.skipped).toHaveLength(2);

    // Claims were released on failure — the retry run claims + sends both.
    const res2 = await GET(cronRequest());
    const body2 = await res2.json();
    expect(sendMock).toHaveBeenCalledTimes(2); // 1 failed attempt + 1 retry
    expect(body2.outcome).toBe("sent");
    expect(body2.sent).toHaveLength(2);
  });

  it("still sends nothing when no phone resolves, even with items due", async () => {
    vi.doMock("@/lib/maverick/operator-page", () => ({ resolveOperatorPhone: () => "" }));
    fetchItemsMock.mockResolvedValue([
      item({ key: "action_item:np-1", title: "No phone decision", dollars: 5_000 }),
    ]);

    const { GET } = await import("./route");
    const res = await GET(cronRequest());
    const body = await res.json();

    expect(sendMock).not.toHaveBeenCalled();
    expect(body.mode).toBe("report_only_no_phone");
    expect(body.sent).toHaveLength(0);
    vi.doUnmock("@/lib/maverick/operator-page");
  });
});
