// M8 / Gate 3 — proof that the M6 capture path carries the opt-out signal.
// A synthetic STOP, matched or unmatched, surfaces optOut so the executor can
// flip Do_Not_Text number-level when INBOUND_CAPTURE_LIVE is on.

import { describe, it, expect } from "vitest";
import { planInboundCapture } from "./capture";
import type { InboundMessage, MatchableListing } from "./types";

const PHONE = "+13135550142";

function sms(body: string, sender = PHONE): InboundMessage {
  return { channel: "sms", externalId: `AC${body.length}`, sender, body, receivedAt: "2026-06-18T12:00:00Z" };
}

const listing: MatchableListing = {
  id: "recAGENTLISTING01",
  agentPhone: PHONE,
  agentEmail: null,
  outreachStatus: "Texted",
};

describe("planInboundCapture — opt-out signal (M8 wiring to M6)", () => {
  it("a matched STOP surfaces optOut on the matched plan", () => {
    const plan = planInboundCapture(sms("STOP"), [listing]);
    expect(plan.kind).toBe("matched");
    if (plan.kind === "matched") expect(plan.optOut.optOut).toBe(true);
  });

  it("an unmatched STOP (unknown phone) still surfaces optOut (fail-closed catch-all)", () => {
    const plan = planInboundCapture(sms("please remove my number", "+19998887777"), [listing]);
    expect(plan.kind).toBe("unmatched");
    if (plan.kind === "unmatched") expect(plan.optOut.optOut).toBe(true);
  });

  it("a normal interested reply does NOT flag optOut", () => {
    const plan = planInboundCapture(sms("yes, send me the offer"), [listing]);
    expect(plan.kind).toBe("matched");
    if (plan.kind === "matched") expect(plan.optOut.optOut).toBe(false);
  });
});
