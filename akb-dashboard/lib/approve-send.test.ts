// Approve-actually-sends (Wire 2): payload parsing + static gate order.
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks for the sendApprovedReply I/O path (release-on-failure guard) ──
const sendMessageWithId = vi.fn();
const setNx = vi.fn();
const del = vi.fn();
vi.mock("@/lib/quo", () => ({ sendMessageWithId: (...a: unknown[]) => sendMessageWithId(...a) }));
vi.mock("@/lib/maverick/oauth/kv", () => ({
  kvConfigured: () => true,
  kvProd: {
    setNx: (...a: unknown[]) => setNx(...a),
    del: (...a: unknown[]) => del(...a),
  },
}));
vi.mock("@/lib/h2-working-hours", () => ({
  evaluateSendWindow: () => ({ inside: true, meta: { local_hour: 10, timezone: "America/Detroit" } }),
}));
vi.mock("@/lib/audit-log", () => ({ audit: vi.fn(async () => {}) }));

import {
  parseSendSmsPayload,
  approveSendStaticSkip,
  approveSendClaimKey,
  APPROVE_SEND_MAX_BODY,
  sendApprovedReply,
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

describe("sendApprovedReply — dispatch claim lifecycle (the 14851 Indiana stuck-claim bug)", () => {
  const input = {
    proposalId: "jarvis_reply-123-ABCDEF",
    recordId: "rec87JNYqI12WUILQ",
    toE164: "+13058149310",
    body: "Sure, happy to connect with them directly.",
    state: "MI",
    doNotText: false,
    address: "14851 Indiana St",
  };

  beforeEach(() => {
    sendMessageWithId.mockReset();
    setNx.mockReset();
    del.mockReset();
  });

  it("RELEASES the claim when the Quo send throws, so a retry is possible", async () => {
    setNx.mockResolvedValue(true); // claim acquired
    sendMessageWithId.mockRejectedValue(new Error("Quo 503 upstream")); // send fails
    const res = await sendApprovedReply(input);
    expect(res.sent).toBe(false);
    expect(res.reason).toMatch(/send_error/);
    // The bug: without this the claim stuck for 7 days → permanent already_dispatched.
    expect(del).toHaveBeenCalledWith("approve_send:jarvis_reply-123-ABCDEF");
  });

  it("HOLDS the claim on a successful send (that IS a real dispatch)", async () => {
    setNx.mockResolvedValue(true);
    sendMessageWithId.mockResolvedValue({ id: "ACsent123" });
    const res = await sendApprovedReply(input);
    expect(res.sent).toBe(true);
    expect(res.quoMessageId).toBe("ACsent123");
    expect(del).not.toHaveBeenCalled();
  });

  it("still guards a genuine double-dispatch: claim already held → already_dispatched, no send", async () => {
    setNx.mockResolvedValue(false); // claim already exists
    const res = await sendApprovedReply(input);
    expect(res.reason).toBe("already_dispatched");
    expect(sendMessageWithId).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled(); // an in-flight peer holds it — don't yank it
  });
});
