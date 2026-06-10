import { describe, it, expect } from "vitest";
import { buildReplyAlertBody } from "./reply-alert";

describe("buildReplyAlertBody", () => {
  it("includes classification tag, address, inbound snippet, and record link", () => {
    const body = buildReplyAlertBody({
      recordId: "recABC123",
      address: "13235 Freeland St, Detroit, MI 48227",
      agentName: "Sam",
      inboundBody: "Hi theyre in the process of accepting a much higher offer",
      classification: "rejection",
    });
    expect(body).toMatch(/^\[AKB\]/);
    expect(body).toContain("REJECTION");
    expect(body).toContain("13235 Freeland");
    expect(body).toContain("Sam");
    expect(body).toContain("much higher offer");
    expect(body).toContain("/pipeline/recABC123");
  });

  it("clips the inbound snippet to keep the alert SMS-friendly", () => {
    const longBody = "A".repeat(500);
    const body = buildReplyAlertBody({
      recordId: "recXYZ",
      address: "1 Main",
      agentName: null,
      inboundBody: longBody,
      classification: "interest",
    });
    // The snippet itself is clipped to 120 chars; total alert ≈ static
    // prefix + link, well under 2 SMS segments.
    expect(body.length).toBeLessThan(400);
    // The clipped snippet must not contain the full 500-A string.
    expect(body.indexOf("A".repeat(120)) >= 0).toBe(true);
    expect(body.indexOf("A".repeat(121)) >= 0).toBe(false);
  });

  it("collapses whitespace in the inbound so newlines don't break the SMS", () => {
    const body = buildReplyAlertBody({
      recordId: "recA",
      address: "1 Main",
      agentName: null,
      inboundBody: "yes\n\ninterested\tcall me",
      classification: "interest",
    });
    expect(body).toContain("yes interested call me");
  });

  it("handles missing agent name + address gracefully", () => {
    const body = buildReplyAlertBody({
      recordId: "recZ",
      address: null,
      agentName: null,
      inboundBody: "hi",
      classification: "unknown",
    });
    expect(body).toContain("unknown address");
    expect(body).toContain("UNKNOWN reply");
  });
});
