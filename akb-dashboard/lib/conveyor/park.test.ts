import { describe, expect, it } from "vitest";
import { canAutoDispose } from "./park";

describe("canAutoDispose", () => {
  it("allows auto-disposal when neither an offer nor a thread exists", () => {
    expect(canAutoDispose({ hasDeliveredOffer: false, hasOpenThread: false })).toBe(true);
  });

  it("blocks auto-disposal when an offer has been delivered", () => {
    expect(canAutoDispose({ hasDeliveredOffer: true, hasOpenThread: false })).toBe(false);
  });

  it("blocks auto-disposal when an open conversation thread exists", () => {
    expect(canAutoDispose({ hasDeliveredOffer: false, hasOpenThread: true })).toBe(false);
  });

  it("blocks auto-disposal when both conditions hold", () => {
    expect(canAutoDispose({ hasDeliveredOffer: true, hasOpenThread: true })).toBe(false);
  });
});
