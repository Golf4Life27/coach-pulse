// @agent: ops — session cookie signing/verification tests.

import { describe, it, expect } from "vitest";
import {
  mintSessionValue,
  verifySessionValue,
  sessionSecret,
} from "./session-cookie";

const SECRET_A = "secret-a-value-for-tests";
const SECRET_B = "secret-b-value-for-tests";

describe("mintSessionValue / verifySessionValue round trip", () => {
  it("a freshly minted value verifies", () => {
    const expiresAtMs = Date.now() + 1000;
    const value = mintSessionValue(expiresAtMs, SECRET_A);
    const result = verifySessionValue(value, Date.now(), SECRET_A);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.expiresAtMs).toBe(expiresAtMs);
  });

  it("a tampered signature fails bad_signature", () => {
    const expiresAtMs = Date.now() + 1000;
    const value = mintSessionValue(expiresAtMs, SECRET_A);
    const [exp, mac] = value.split(".");
    const tampered = `${exp}.${mac.slice(0, -1)}${mac.at(-1) === "A" ? "B" : "A"}`;
    const result = verifySessionValue(tampered, Date.now(), SECRET_A);
    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("a tampered expiry fails bad_signature — the expiry is covered by the MAC", () => {
    const expiresAtMs = Date.now() + 1000;
    const value = mintSessionValue(expiresAtMs, SECRET_A);
    const [, mac] = value.split(".");
    // Push the expiry far into the future while keeping the original MAC.
    const tampered = `${expiresAtMs + 1_000_000_000}.${mac}`;
    const result = verifySessionValue(tampered, Date.now(), SECRET_A);
    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("the literal legacy value 'authenticated' is rejected — this is the whole point", () => {
    const result = verifySessionValue("authenticated", Date.now(), SECRET_A);
    expect(result).toEqual({ ok: false, reason: "malformed" });
  });

  it("an expired value fails expired", () => {
    const expiresAtMs = Date.now() - 1000;
    const value = mintSessionValue(expiresAtMs, SECRET_A);
    const result = verifySessionValue(value, Date.now(), SECRET_A);
    expect(result).toEqual({ ok: false, reason: "expired" });
  });

  it("a null secret fails no_secret regardless of the value", () => {
    const value = mintSessionValue(Date.now() + 1000, SECRET_A);
    expect(verifySessionValue(value, Date.now(), null)).toEqual({
      ok: false,
      reason: "no_secret",
    });
  });

  it("a value signed with secret A does not verify under secret B (password rotation kills sessions)", () => {
    const expiresAtMs = Date.now() + 1000;
    const value = mintSessionValue(expiresAtMs, SECRET_A);
    const result = verifySessionValue(value, Date.now(), SECRET_B);
    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });

  it.each([
    ["empty string", ""],
    ["a lone dot", "."],
    ["three dot-separated garbage segments", "a.b.c"],
    ["a non-numeric expiry", "NaN.xyz"],
    ["a 10KB string", "x".repeat(10_000)],
    [undefined, undefined],
    [null, null],
  ])("garbage input (%s) never throws and returns a typed failure", (_label, input) => {
    expect(() => verifySessionValue(input as never, Date.now(), SECRET_A)).not.toThrow();
    const result = verifySessionValue(input as never, Date.now(), SECRET_A);
    expect(result.ok).toBe(false);
  });
});

describe("sessionSecret precedence", () => {
  it("DASHBOARD_SESSION_SECRET wins when both are set", () => {
    const secret = sessionSecret({
      DASHBOARD_SESSION_SECRET: "explicit-secret",
      DASHBOARD_PASSWORD: "hunter2",
    } as unknown as NodeJS.ProcessEnv);
    expect(secret).toBe("explicit-secret");
  });

  it("falls back to a password-derived secret when only the password is set", () => {
    const secret = sessionSecret({
      DASHBOARD_PASSWORD: "hunter2",
    } as unknown as NodeJS.ProcessEnv);
    expect(secret).not.toBeNull();
    // The derived secret must not equal the raw password — a leaked
    // signature must not be a password oracle.
    expect(secret).not.toBe("hunter2");
  });

  it("is null when neither is set", () => {
    expect(sessionSecret({} as unknown as NodeJS.ProcessEnv)).toBeNull();
  });

  it("derives the same secret from the same password (deterministic)", () => {
    const env = { DASHBOARD_PASSWORD: "hunter2" } as unknown as NodeJS.ProcessEnv;
    expect(sessionSecret(env)).toBe(sessionSecret(env));
  });
});
