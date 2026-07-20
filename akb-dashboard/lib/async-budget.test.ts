import { describe, it, expect } from "vitest";
import { withBudget } from "./async-budget";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("withBudget — one slow source degrades, never the whole route", () => {
  it("a source inside its budget resolves normally and is never flagged", async () => {
    const degraded: string[] = [];
    const v = await withBudget(Promise.resolve(42), 1_000, 0, "texts", degraded);
    expect(v).toBe(42);
    // Give the (cleared) timer a beat — no late false flag.
    await sleep(20);
    expect(degraded).toEqual([]);
  });

  it("a source past its budget resolves the fallback and is flagged", async () => {
    const degraded: string[] = [];
    const v = await withBudget(
      sleep(200).then(() => "late"),
      20,
      "fallback",
      "email",
      degraded,
    );
    expect(v).toBe("fallback");
    expect(degraded).toEqual(["email"]);
  });

  it("a rejecting source resolves the fallback and is flagged — no throw escapes", async () => {
    const degraded: string[] = [];
    const v = await withBudget(Promise.reject(new Error("quo 500")), 1_000, [] as number[], "texts", degraded);
    expect(v).toEqual([]);
    expect(degraded).toEqual(["texts"]);
  });

  it("timeout then late rejection double-settles nothing (no duplicate flags)", async () => {
    const degraded: string[] = [];
    const v = await withBudget(
      sleep(100).then(() => {
        throw new Error("late fail");
      }),
      20,
      "fallback",
      "attribution",
      degraded,
    );
    expect(v).toBe("fallback");
    await sleep(150);
    expect(degraded).toEqual(["attribution"]);
  });
});
