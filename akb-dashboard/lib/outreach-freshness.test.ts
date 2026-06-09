import { describe, it, expect } from "vitest";
import { isOutreachFresh } from "./outreach-freshness";

const NOW = new Date("2026-06-09T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

describe("isOutreachFresh", () => {
  it("fresh: Active + verified 2h ago (within 48h)", () => {
    const r = isOutreachFresh({ lastVerified: hoursAgo(2), liveStatus: "Active" }, NOW);
    expect(r.fresh).toBe(true);
  });

  it("STALE: verified 60h ago (> 48h window)", () => {
    const r = isOutreachFresh({ lastVerified: hoursAgo(60), liveStatus: "Active" }, NOW);
    expect(r.fresh).toBe(false);
    expect(r.reason).toBe("verify_stale");
  });

  it("never_verified: no Last_Verified", () => {
    expect(isOutreachFresh({ lastVerified: null, liveStatus: "Active" }, NOW).reason).toBe("never_verified");
  });

  it("not fresh when Live_Status is not Active even if recently verified", () => {
    const r = isOutreachFresh({ lastVerified: hoursAgo(1), liveStatus: "Off Market" }, NOW);
    expect(r.fresh).toBe(false);
    expect(r.reason).toContain("live_status");
  });

  it("respects a tighter 24h window", () => {
    expect(isOutreachFresh({ lastVerified: hoursAgo(30), liveStatus: "Active" }, NOW, 24).fresh).toBe(false);
    expect(isOutreachFresh({ lastVerified: hoursAgo(20), liveStatus: "Active" }, NOW, 24).fresh).toBe(true);
  });

  it("rejects a future Last_Verified (clock issue)", () => {
    expect(isOutreachFresh({ lastVerified: hoursAgo(-5), liveStatus: "Active" }, NOW).reason).toBe("last_verified_in_future");
  });
});
