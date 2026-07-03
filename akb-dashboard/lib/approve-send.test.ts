// Approve-actually-sends (Wire 2): payload parsing + static gate order.
import { describe, it, expect } from "vitest";
import {
  parseSendSmsPayload,
  approveSendStaticSkip,
  approveSendClaimKey,
  APPROVE_SEND_MAX_BODY,
} from "./approve-send";

const PAYLOAD = JSON.stringify({
  recordId: "recABCDEFGHIJKLMN",
  action: "send_sms",
  to: "+13218909374",
  draftBody: "Hi Jeff — buyer is AKB Solutions LLC and/or Assigns.",
  inboundBody: "I will need your name as you'd like it to appear on the deed.",
  classification: "interest",
});

describe("parseSendSmsPayload — only an explicit send_sms with phone + draft dispatches", () => {
  it("parses the scan-comms jarvis_reply payload shape", () => {
    const p = parseSendSmsPayload(PAYLOAD);
    expect(p?.to).toBe("+13218909374");
    expect(p?.draftBody).toContain("AKB Solutions");
    expect(p?.recordId).toBe("recABCDEFGHIJKLMN");
    expect(p?.inboundBody).toContain("deed");
  });
  it("refuses non-send actions, missing phone/draft, and garbage", () => {
    expect(parseSendSmsPayload(JSON.stringify({ action: "mark_dead", to: "+1", draftBody: "x" }))).toBeNull();
    expect(parseSendSmsPayload(JSON.stringify({ action: "send_sms", draftBody: "x" }))).toBeNull();
    expect(parseSendSmsPayload(JSON.stringify({ action: "send_sms", to: "+1555" }))).toBeNull();
    expect(parseSendSmsPayload("not json")).toBeNull();
    expect(parseSendSmsPayload(null)).toBeNull();
    expect(parseSendSmsPayload("")).toBeNull();
  });
});

describe("approveSendStaticSkip — mistake rails (judgment stays with the operator)", () => {
  const ok = { body: "Sounds good, sending it over.", toE164: "+13218909374", doNotText: false };
  it("passes a normal operator reply — numbers allowed (negotiation lane)", () => {
    expect(approveSendStaticSkip(ok)).toBeNull();
    expect(approveSendStaticSkip({ ...ok, body: "We can do $44,000 cash." })).toBeNull();
  });
  it("gate order: empty body → too long → no phone → do_not_text", () => {
    expect(approveSendStaticSkip({ ...ok, body: "   " })).toBe("empty_body");
    expect(approveSendStaticSkip({ ...ok, body: "x".repeat(APPROVE_SEND_MAX_BODY + 1) })).toBe("body_too_long");
    expect(approveSendStaticSkip({ ...ok, toE164: "" })).toBe("no_phone");
    expect(approveSendStaticSkip({ ...ok, doNotText: true })).toBe("do_not_text");
  });
  it("body at exactly the cap passes", () => {
    expect(approveSendStaticSkip({ ...ok, body: "x".repeat(APPROVE_SEND_MAX_BODY) })).toBeNull();
  });
});

describe("claim key", () => {
  it("is per-PROPOSAL (multiple replies per record are legit; double-click is not)", () => {
    expect(approveSendClaimKey("recProposal123")).toBe("approve_send:recProposal123");
  });
});
