import { describe, it, expect, vi } from "vitest";
import { DEFAULT_ALERT_EMAIL, pageOperator } from "./runner";
import type { PulseDetection } from "./types";

const det: PulseDetection = {
  id: "send_lane_tripwire_blanks",
  detector_id: "send_lane_tripwire",
  severity: "critical",
  title: "Send lane firing blanks",
  description: "6 runs sent 0",
  suggested_action: "Check Quo credits",
  detected_at: "2026-09-02T14:25:29Z",
};
const env = { ALERT_PHONE: "+16302172539", ALERT_FROM: "+16302505865" };

describe("pageOperator email fallback", () => {
  it("falls back to email when the SMS page throws (the 402 case) and reports success", async () => {
    const auditFn = vi.fn(async () => {});
    const sendFn = vi.fn(async () => {
      throw new Error("Quo send error 402: not enough prepaid credits");
    });
    const emailFn = vi.fn(async () => ({ success: true, audit_status: "confirmed_success" as const }));
    const ok = await pageOperator(det, env, auditFn, sendFn as never, emailFn as never);
    expect(ok).toBe(true);
    expect(emailFn).toHaveBeenCalledTimes(1);
    const call = (emailFn.mock.calls as unknown as Array<[{ to: string; subject: string; body: string }]>)[0][0];
    expect(call.to).toBe(DEFAULT_ALERT_EMAIL);
    expect(call.subject).toBe("AKB CRITICAL: Send lane firing blanks");
    expect(call.body).toContain("Quo send error 402");
    const events = (auditFn.mock.calls as unknown as Array<[{ event: string }]>).map((c) => c[0].event);
    expect(events).toEqual(["pulse_page_failed", "pulse_page_email_fallback"]);
  });

  it("honours ALERT_EMAIL and reports an email failure honestly", async () => {
    const auditFn = vi.fn(async () => {});
    const sendFn = vi.fn(async () => {
      throw new Error("boom");
    });
    const emailFn = vi.fn(async () => ({ success: false, audit_status: "confirmed_failure" as const, error: "no refresh token" }));
    const ok = await pageOperator(det, { ...env, ALERT_EMAIL: "ops@example.com" }, auditFn, sendFn as never, emailFn as never);
    expect(ok).toBe(false);
    expect((emailFn.mock.calls as unknown as Array<[{ to: string }]>)[0][0].to).toBe("ops@example.com");
    const auditCalls = auditFn.mock.calls as unknown as Array<[{ event: string; status: string }]>;
    const last = auditCalls[auditCalls.length - 1][0];
    expect(last.event).toBe("pulse_page_email_fallback");
    expect(last.status).toBe("confirmed_failure");
  });

  it("does not email when the SMS page succeeds, and skips email when disabled", async () => {
    const auditFn = vi.fn(async () => {});
    const emailFn = vi.fn(async () => ({ success: true, audit_status: "confirmed_success" as const }));
    expect(await pageOperator(det, env, auditFn, (async () => {}) as never, emailFn as never)).toBe(true);
    expect(emailFn).not.toHaveBeenCalled();
    const sendFail = vi.fn(async () => {
      throw new Error("x");
    });
    expect(await pageOperator(det, env, auditFn, sendFail as never, null)).toBe(false);
  });
});
