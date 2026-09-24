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
