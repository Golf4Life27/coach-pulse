// Operator-action queue: ranking doctrine + anti-staleness rails.
import { describe, it, expect } from "vitest";
import {
  rankOperatorActions,
  urgencyBucket,
  urgencyLabel,
  isLive,
  readOperatorActions,
  upsertOperatorActions,
  completeOperatorActions,
  OPERATOR_ACTIONS_KV_KEY,
  type OperatorAction,
} from "./operator-actions";
import { makeMemoryKv } from "@/lib/maverick/oauth/kv";

const NOW = "2026-07-02T20:00:00.000Z";

function action(over: Partial<OperatorAction> & { id: string }): OperatorAction {
  return {
    title: over.id,
    why: "because",
    instructions: null,
    href: null,
    revenueUsd: null,
    deadlineAt: null,
    expiresAt: "2026-07-10T00:00:00.000Z",
    postedAt: "2026-07-02T12:00:00.000Z",
    postedBy: "maverick",
    ...over,
  };
}

describe("ranking doctrine — urgency first, then revenue, then freshness", () => {
  it("an overdue $8k beats a next-week $20k (time urgency first)", () => {
    const overdue8k = action({ id: "overdue", revenueUsd: 8_000, deadlineAt: "2026-07-02T19:00:00.000Z" });
    const later20k = action({ id: "later", revenueUsd: 20_000, deadlineAt: "2026-07-09T00:00:00.000Z" });
    const ranked = rankOperatorActions([later20k, overdue8k], NOW);
    expect(ranked.map((a) => a.id)).toEqual(["overdue", "later"]);
  });

  it("same urgency bucket → higher revenue first (Joyce/Jeff shape)", () => {
    const joyce = action({ id: "joyce", revenueUsd: 12_000, deadlineAt: "2026-07-04T17:00:00.000Z" });
    const jeff = action({ id: "jeff", revenueUsd: 8_000, deadlineAt: "2026-07-03T20:00:00.000Z" });
    // jeff is under_24h, joyce under_72h → jeff first despite lower revenue.
    expect(rankOperatorActions([joyce, jeff], NOW).map((a) => a.id)).toEqual(["jeff", "joyce"]);
    // Move both into the same bucket → revenue decides.
    const joyce24 = { ...joyce, deadlineAt: "2026-07-03T10:00:00.000Z" };
    expect(rankOperatorActions([jeff, joyce24], NOW).map((a) => a.id)).toEqual(["joyce", "jeff"]);
  });

  it("no-deadline items rank below dated ones; freshness breaks ties", () => {
    const fresh = action({ id: "fresh", postedAt: "2026-07-02T18:00:00.000Z" });
    const older = action({ id: "older", postedAt: "2026-07-01T18:00:00.000Z" });
    const dated = action({ id: "dated", deadlineAt: "2026-07-08T00:00:00.000Z" });
    expect(rankOperatorActions([older, fresh, dated], NOW).map((a) => a.id)).toEqual([
      "dated",
      "fresh",
      "older",
    ]);
  });
});

describe("anti-staleness rails", () => {
  it("expired and done items never render", () => {
    const expired = action({ id: "expired", expiresAt: "2026-07-02T19:59:00.000Z" });
    const done = action({ id: "done", done: true });
    const live = action({ id: "live" });
    expect(isLive(expired, NOW)).toBe(false);
    expect(isLive(done, NOW)).toBe(false);
    expect(rankOperatorActions([expired, done, live], NOW).map((a) => a.id)).toEqual(["live"]);
  });

  it("urgency buckets + labels", () => {
    expect(urgencyBucket(action({ id: "x", deadlineAt: "2026-07-02T19:00:00.000Z" }), NOW)).toBe("overdue");
    expect(urgencyBucket(action({ id: "x", deadlineAt: "2026-07-03T10:00:00.000Z" }), NOW)).toBe("under_24h");
    expect(urgencyBucket(action({ id: "x", deadlineAt: "2026-07-04T17:00:00.000Z" }), NOW)).toBe("under_72h");
    expect(urgencyBucket(action({ id: "x" }), NOW)).toBe("none");
    expect(urgencyLabel(action({ id: "x", deadlineAt: "2026-07-02T19:00:00.000Z" }), NOW)).toBe("OVERDUE");
    expect(urgencyLabel(action({ id: "x", deadlineAt: "2026-07-03T02:00:00.000Z" }), NOW)).toBe("due in 6h");
  });
});

describe("KV round-trip", () => {
  it("upsert de-dupes by id, complete hides, read survives garbage", async () => {
    const kv = makeMemoryKv();
    await upsertOperatorActions(kv, [action({ id: "a" }), action({ id: "b" })]);
    await upsertOperatorActions(kv, [action({ id: "a", title: "a-v2" })]);
    let all = await readOperatorActions(kv);
    expect(all).toHaveLength(2);
    expect(all.find((x) => x.id === "a")?.title).toBe("a-v2");

    const done = await completeOperatorActions(kv, ["b", "missing"]);
    expect(done.completed).toBe(1);
    all = await readOperatorActions(kv);
    expect(rankOperatorActions(all, NOW).map((x) => x.id)).toEqual(["a"]);

    await kv.set(OPERATOR_ACTIONS_KV_KEY, "not json");
    expect(await readOperatorActions(kv)).toEqual([]);
  });
});
