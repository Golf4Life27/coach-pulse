import { describe, it, expect } from "vitest";
import {
  currentSpendLane,
  withSpendLane,
  laneFromRequest,
  isSpendLane,
  SPEND_LANE_HEADER,
  DEFAULT_SPEND_LANE,
} from "./lane-context";

describe("spend lane context", () => {
  it("untagged work is the batch lane — a forgotten call site yields before live work", () => {
    expect(currentSpendLane()).toBe("batch");
    expect(DEFAULT_SPEND_LANE).toBe("batch");
  });

  it("withSpendLane scopes the lane to the work inside it, across awaits", async () => {
    const seen = await withSpendLane("sweep", async () => {
      await new Promise((r) => setTimeout(r, 1));
      return currentSpendLane();
    });
    expect(seen).toBe("sweep");
    expect(currentSpendLane()).toBe("batch");
  });

  it("two lanes running concurrently do not leak into each other (the warm-container case)", async () => {
    const [a, b] = await Promise.all([
      withSpendLane("live", async () => {
        await new Promise((r) => setTimeout(r, 2));
        return currentSpendLane();
      }),
      withSpendLane("sweep", async () => {
        await new Promise((r) => setTimeout(r, 1));
        return currentSpendLane();
      }),
    ]);
    expect(a).toBe("live");
    expect(b).toBe("sweep");
  });

  it("a per-record route is live unless a sweep forwarded its lane", () => {
    const bare = new Request("https://x/api/agents/appraiser/arv/rec1");
    expect(laneFromRequest(bare, "live")).toBe("live");
    const fromSweep = new Request("https://x/api/agents/appraiser/arv/rec1", {
      headers: { [SPEND_LANE_HEADER]: "sweep" },
    });
    expect(laneFromRequest(fromSweep, "live")).toBe("sweep");
  });

  it("a garbage header cannot buy the live lane — it falls back", () => {
    const req = new Request("https://x/api/agents/appraiser/arv/rec1", {
      headers: { [SPEND_LANE_HEADER]: "vip" },
    });
    expect(laneFromRequest(req, "batch")).toBe("batch");
    expect(isSpendLane("vip")).toBe(false);
    expect(isSpendLane("discovery")).toBe(true);
  });
});
