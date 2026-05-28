// Phase 2.8 / Q.6 — Quo throttle tests (pure path).

import { describe, it, expect } from "vitest";
import { QuoThrottleError, classifyThrottle } from "./quo-throttle";

describe("classifyThrottle", () => {
  it("under limit → not at_limit, remaining > 0 (default 20)", () => {
    const status = classifyThrottle({ recent_send_count: 10 });
    expect(status.at_limit).toBe(false);
    expect(status.remaining).toBe(10);
    expect(status.limit).toBe(20);
  });

  it("at limit → at_limit true, remaining 0", () => {
    const status = classifyThrottle({ recent_send_count: 15, limit: 15 });
    expect(status.at_limit).toBe(true);
    expect(status.remaining).toBe(0);
  });

  it("over limit → at_limit true, remaining 0 (clamped)", () => {
    const status = classifyThrottle({ recent_send_count: 25 });
    expect(status.at_limit).toBe(true);
    expect(status.remaining).toBe(0);
  });

  it("respects custom limit", () => {
    const status = classifyThrottle({ recent_send_count: 5, limit: 10 });
    expect(status.at_limit).toBe(false);
    expect(status.remaining).toBe(5);
  });

  it("respects custom window_ms (echoed back)", () => {
    const status = classifyThrottle({ recent_send_count: 1, window_ms: 600_000 });
    expect(status.window_ms).toBe(600_000);
  });
});

describe("QuoThrottleError", () => {
  it("constructs with required fields + descriptive message", () => {
    const err = new QuoThrottleError({
      limit: 15,
      sends_in_window: 17,
      window_ms: 3_600_000,
    });
    expect(err.name).toBe("QuoThrottleError");
    expect(err.message).toContain("17/15");
    expect(err.message).toContain("60 minutes");
    expect(err.limit).toBe(15);
  });
});
