import { describe, it, expect } from "vitest";
import { detectCaptureGaps } from "./comms-integrity";

const NOW = "2026-07-11T16:00:00Z";

const msg = (direction: "inbound" | "outbound" | "system", timestamp: string) => ({ direction, timestamp });

describe("detectCaptureGaps", () => {
  it("clean record — stamps matched by timeline messages", () => {
    const v = detectCaptureGaps({
      lastInboundAt: "2026-07-08T14:00:00Z",
      lastOutboundAt: "2026-07-08T15:00:00Z",
      messages: [msg("inbound", "2026-07-08T14:05:00Z"), msg("outbound", "2026-07-08T15:01:00Z")],
      nowIso: NOW,
    });
    expect(v.ok).toBe(true);
    expect(v.gaps).toHaveLength(0);
  });

  it("the 3731 Baltimore class: inbound stamp with an EMPTY inbound timeline", () => {
    const v = detectCaptureGaps({
      lastInboundAt: "2026-07-08T14:00:00Z",
      lastOutboundAt: null,
      messages: [msg("outbound", "2026-07-01T12:00:00Z"), msg("system", "2026-07-08T14:00:00Z")],
      nowIso: NOW,
    });
    expect(v.ok).toBe(false);
    expect(v.gaps).toHaveLength(1);
    expect(v.gaps[0].direction).toBe("inbound");
    expect(v.gaps[0].detail).toContain("NO inbound message at all");
  });

  it("later-message-never-landed: stamp newer than everything captured", () => {
    const v = detectCaptureGaps({
      lastInboundAt: "2026-07-09T10:00:00Z",
      lastOutboundAt: null,
      messages: [msg("inbound", "2026-06-20T10:00:00Z")],
      nowIso: NOW,
    });
    expect(v.ok).toBe(false);
    expect(v.gaps[0].detail).toContain("never landed");
  });

  it("grace window: a stamp younger than the tolerance never alerts (sync-cron lag)", () => {
    const v = detectCaptureGaps({
      lastInboundAt: "2026-07-11T12:00:00Z", // 4h old < 24h tolerance
      lastOutboundAt: null,
      messages: [],
      nowIso: NOW,
    });
    expect(v.ok).toBe(true);
  });

  it("tolerance absorbs append-lag offsets", () => {
    const v = detectCaptureGaps({
      lastInboundAt: "2026-07-08T14:00:00Z",
      lastOutboundAt: null,
      // Appended 20h later by a sync cron — inside the 24h tolerance.
      messages: [msg("inbound", "2026-07-08T02:00:00Z")],
      nowIso: NOW,
    });
    expect(v.ok).toBe(true);
  });

  it("outbound coverage spans SMS and email stamps (latest wins)", () => {
    const v = detectCaptureGaps({
      lastInboundAt: null,
      lastOutboundAt: "2026-07-01T10:00:00Z",
      lastEmailOutreachDate: "2026-07-09T10:00:00Z",
      messages: [msg("outbound", "2026-07-01T10:00:00Z")],
      nowIso: NOW,
    });
    expect(v.ok).toBe(false);
    expect(v.gaps[0].direction).toBe("outbound");
    expect(v.gaps[0].stampedAt).toBe("2026-07-09T10:00:00.000Z");
  });

  it("no stamps → nothing claimed → ok, and unparseable stamps are ignored", () => {
    expect(detectCaptureGaps({ lastInboundAt: null, lastOutboundAt: null, messages: [], nowIso: NOW }).ok).toBe(true);
    expect(
      detectCaptureGaps({ lastInboundAt: "garbage", lastOutboundAt: null, messages: [], nowIso: NOW }).ok,
    ).toBe(true);
  });
});
