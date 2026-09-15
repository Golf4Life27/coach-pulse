// @agent: maverick — operator alert (credential-proof sibling of jarvis-send).

import { describe, it, expect, vi, beforeEach } from "vitest";

const auditMock = vi.fn(async (_entry: Record<string, unknown>) => {});
vi.mock("@/lib/audit-log", () => ({
  audit: (entry: Record<string, unknown>) => auditMock(entry),
}));

import {
  ALERT_MAX_LEN,
  composeOperatorAlert,
  deriveAlertKey,
  sendOperatorAlert,
} from "./operator-alert";
import { makeMemoryKv } from "./oauth/kv";

const NOW_INSIDE = new Date("2026-09-15T16:00:00Z"); // 11:00 CT
const NOW_OUTSIDE = new Date("2026-09-15T04:00:00Z"); // 23:00 CT (previous day)

function baseEnv(over: Record<string, string | undefined> = {}) {
  return {
    ALERT_FROM: "PNMhSUQXFw",
    ALERT_PHONE: "+16302172539",
    ...over,
  };
}

function fakeSend(status: "queued" | "sent" | "delivered" = "queued") {
  return vi.fn(async (_to: string, _body: string, _opts?: { from?: string }) => ({
    id: "msg_1",
    status,
    httpStatus: 202,
    raw: null,
  }));
}

beforeEach(() => auditMock.mockClear());

describe("composeOperatorAlert", () => {
  it("normalizes em-dashes and curly quotes for GSM-7", () => {
    const body = composeOperatorAlert("Agent’s scope — re-open terms…");
    expect(body).toBe("Agent's scope - re-open terms...");
  });

  it("replaces remaining non-GSM-7 characters (e.g. emoji) with ?", () => {
    const body = composeOperatorAlert("Deal closed \u{1F389} great work");
    expect(body).toBe("Deal closed ? great work");
  });

  it("collapses runs of spaces/tabs to one space but keeps newlines", () => {
    const body = composeOperatorAlert("Line one\t\t here   now\nLine two");
    expect(body).toBe("Line one here now\nLine two");
  });

  it("trims text over 300 chars at a word boundary", () => {
    const long = "word ".repeat(80) + "end.";
    const body = composeOperatorAlert(long);
    expect(body.length).toBeLessThanOrEqual(ALERT_MAX_LEN);
    expect(body).toMatch(/\.\.\.$/);
    expect(body).not.toMatch(/\s\.\.\.$/); // no mid-word garbage before the ellipsis
  });
});

describe("deriveAlertKey", () => {
  it("sanitizes an explicit key and caps it at 80 chars", () => {
    const key = deriveAlertKey("body", "Contract Signed! @123 #{stage-4}".repeat(3));
    expect(key.length).toBeLessThanOrEqual(80);
    expect(key).toMatch(/^[a-zA-Z0-9_:.-]+$/);
  });

  it("derives the same key for the same body", () => {
    expect(deriveAlertKey("STALLED: 1 Main St.")).toBe(deriveAlertKey("STALLED: 1 Main St."));
  });

  it("derives a different key for a different body", () => {
    expect(deriveAlertKey("STALLED: 1 Main St.")).not.toBe(deriveAlertKey("STALLED: 2 Main St."));
  });
});

describe("sendOperatorAlert — fail-closed sequence", () => {
  it("refuses with empty_body and never calls send", async () => {
    const send = fakeSend();
    const res = await sendOperatorAlert(
      { message: "   " },
      { kv: makeMemoryKv(), send, env: baseEnv(), now: NOW_INSIDE },
    );
    expect(res).toMatchObject({ sent: false, reason: "empty_body" });
    expect(send).not.toHaveBeenCalled();
  });

  it("refuses with alert_from_not_set and never calls send", async () => {
    const send = fakeSend();
    const res = await sendOperatorAlert(
      { message: "STALLED: 1 Main St." },
      { kv: makeMemoryKv(), send, env: baseEnv({ ALERT_FROM: "" }), now: NOW_INSIDE },
    );
    expect(res.sent).toBe(false);
    expect(res.reason).toBe("alert_from_not_set");
    expect(send).not.toHaveBeenCalled();
  });

  it("refuses outside the Chicago window; urgent:true bypasses it", async () => {
    const send1 = fakeSend();
    const outside = await sendOperatorAlert(
      { message: "STALLED: 1 Main St." },
      { kv: makeMemoryKv(), send: send1, env: baseEnv(), now: NOW_OUTSIDE },
    );
    expect(outside.sent).toBe(false);
    expect(outside.reason).toBe("outside_window");
    expect(send1).not.toHaveBeenCalled();

    const send2 = fakeSend();
    const urgent = await sendOperatorAlert(
      { message: "STALLED: 1 Main St.", urgent: true },
      { kv: makeMemoryKv(), send: send2, env: baseEnv(), now: NOW_OUTSIDE },
    );
    expect(urgent.sent).toBe(true);
    expect(send2).toHaveBeenCalledTimes(1);
  });

  it("dedupes a second call with the same key", async () => {
    const kv = makeMemoryKv();
    const send = fakeSend();
    const first = await sendOperatorAlert(
      { message: "STALLED: 1 Main St.", key: "same-key" },
      { kv, send, env: baseEnv(), now: NOW_INSIDE },
    );
    const second = await sendOperatorAlert(
      { message: "STALLED: 1 Main St.", key: "same-key" },
      { kv, send, env: baseEnv(), now: NOW_INSIDE },
    );
    expect(first.sent).toBe(true);
    expect(second.sent).toBe(false);
    expect(second.reason).toBe("duplicate");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("enforces the daily cap across distinct messages", async () => {
    const kv = makeMemoryKv();
    const send = fakeSend();
    const env = baseEnv({ MAVERICK_ALERT_DAILY_CAP: "2" });
    const r1 = await sendOperatorAlert({ message: "Alert one." }, { kv, send, env, now: NOW_INSIDE });
    const r2 = await sendOperatorAlert({ message: "Alert two." }, { kv, send, env, now: NOW_INSIDE });
    const r3 = await sendOperatorAlert({ message: "Alert three." }, { kv, send, env, now: NOW_INSIDE });
    expect(r1.sent).toBe(true);
    expect(r2.sent).toBe(true);
    expect(r3.sent).toBe(false);
    expect(r3.reason).toBe("daily_cap");
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("sends FROM the Maverick line TO the operator phone on success", async () => {
    const send = fakeSend("queued");
    const res = await sendOperatorAlert(
      { message: "STALLED: 1 Main St." },
      { kv: makeMemoryKv(), send, env: baseEnv(), now: NOW_INSIDE },
    );
    expect(res.sent).toBe(true);
    expect(res.quoMessageId).toBe("msg_1");
    expect(res.quoStatus).toBe("queued");
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toBe("+16302172539");
    expect(send.mock.calls[0][2]).toEqual({ from: "PNMhSUQXFw" });
  });

  it("never throws when Quo errors — reports quo_error", async () => {
    const send = vi.fn(async () => {
      throw new Error("quo 429 rate limited");
    });
    const res = await sendOperatorAlert(
      { message: "STALLED: 1 Main St." },
      { kv: makeMemoryKv(), send, env: baseEnv(), now: NOW_INSIDE },
    );
    expect(res.sent).toBe(false);
    expect(res.reason).toBe("quo_error");
  });

  it("releases the dedupe claim on a Quo error so the next firing can retry", async () => {
    const kv = makeMemoryKv();
    const failing = vi.fn(async () => {
      throw new Error("quo 502");
    });
    const first = await sendOperatorAlert(
      { message: "STALLED: 1 Main St.", key: "triage-2026-09-15-rec1" },
      { kv, send: failing, env: baseEnv(), now: NOW_INSIDE },
    );
    expect(first.reason).toBe("quo_error");
    const send = fakeSend();
    const second = await sendOperatorAlert(
      { message: "STALLED: 1 Main St.", key: "triage-2026-09-15-rec1" },
      { kv, send, env: baseEnv(), now: NOW_INSIDE },
    );
    expect(second.sent).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("with kv: null, skips dedupe entirely — two identical sends both go", async () => {
    const send = fakeSend();
    const first = await sendOperatorAlert(
      { message: "STALLED: 1 Main St." },
      { kv: null, send, env: baseEnv(), now: NOW_INSIDE },
    );
    const second = await sendOperatorAlert(
      { message: "STALLED: 1 Main St." },
      { kv: null, send, env: baseEnv(), now: NOW_INSIDE },
    );
    expect(first.sent).toBe(true);
    expect(second.sent).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
  });
});
