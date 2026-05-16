// @agent: maverick — OAuth access + refresh token tests.

import { describe, it, expect } from "vitest";
import {
  ACCESS_TTL_SECONDS,
  REFRESH_TTL_SECONDS,
  consumeRefreshToken,
  deleteAccessToken,
  deleteRefreshToken,
  issueTokenPair,
  loadAccessToken,
  loadFamily,
  revokeFamily,
  tokenKind,
} from "./tokens";
import { makeMemoryKv } from "./kv";

describe("issueTokenPair", () => {
  it("issues a tokens pair with the expected prefixes + TTL math", async () => {
    const kv = makeMemoryKv();
    const now = new Date("2026-05-15T12:00:00Z");
    const pair = await issueTokenPair(
      kv,
      { client_id: "mc_x", subject: "alex", scope: "maverick:state" },
      now,
    );
    expect(pair.access.token).toMatch(/^mat_/);
    expect(pair.refresh.token).toMatch(/^mrt_/);
    expect(new Date(pair.access.expires_at).getTime() - now.getTime()).toBe(
      ACCESS_TTL_SECONDS * 1000,
    );
    expect(new Date(pair.refresh.expires_at).getTime() - now.getTime()).toBe(
      REFRESH_TTL_SECONDS * 1000,
    );
    expect(pair.refresh.family_id).toMatch(/^fam_/);
  });

  it("reuses family_id on subsequent rotations (so replay-detection can correlate)", async () => {
    const kv = makeMemoryKv();
    const initial = await issueTokenPair(kv, {
      client_id: "mc_x",
      subject: "alex",
      scope: "maverick:state",
    });
    const rotated = await issueTokenPair(kv, {
      client_id: "mc_x",
      subject: "alex",
      scope: "maverick:state",
      family_id: initial.refresh.family_id,
    });
    expect(rotated.refresh.family_id).toBe(initial.refresh.family_id);
    expect(rotated.refresh.token).not.toBe(initial.refresh.token);
  });

  it("writes a family record alongside the token pair", async () => {
    const kv = makeMemoryKv();
    const pair = await issueTokenPair(kv, {
      client_id: "mc_x",
      subject: "alex",
      scope: "maverick:state",
    });
    const fam = await loadFamily(kv, pair.refresh.family_id);
    expect(fam).not.toBeNull();
    expect(fam!.revoked).toBe(false);
    expect(fam!.client_id).toBe("mc_x");
  });
});

describe("loadAccessToken", () => {
  it("returns the persisted record", async () => {
    const kv = makeMemoryKv();
    const pair = await issueTokenPair(kv, {
      client_id: "mc_x",
      subject: "alex",
      scope: "maverick:state",
    });
    const loaded = await loadAccessToken(kv, pair.access.token);
    expect(loaded).toEqual(pair.access);
  });
  it("returns null on unknown token", async () => {
    expect(await loadAccessToken(makeMemoryKv(), "mat_unknown")).toBeNull();
  });
});

describe("consumeRefreshToken — single-use GETDEL semantics", () => {
  it("returns the record on first call and null on second", async () => {
    const kv = makeMemoryKv();
    const pair = await issueTokenPair(kv, {
      client_id: "mc_x",
      subject: "alex",
      scope: "maverick:state",
    });
    const first = await consumeRefreshToken(kv, pair.refresh.token);
    expect(first).not.toBeNull();
    const second = await consumeRefreshToken(kv, pair.refresh.token);
    expect(second).toBeNull();
  });
});

describe("revokeFamily", () => {
  it("marks the family revoked + records the reason", async () => {
    const kv = makeMemoryKv();
    const pair = await issueTokenPair(kv, {
      client_id: "mc_x",
      subject: "alex",
      scope: "maverick:state",
    });
    await revokeFamily(kv, pair.refresh.family_id, "test_reason");
    const fam = await loadFamily(kv, pair.refresh.family_id);
    expect(fam!.revoked).toBe(true);
    expect(fam!.revoked_reason).toBe("test_reason");
  });
  it("no-ops on unknown family_id", async () => {
    const kv = makeMemoryKv();
    await revokeFamily(kv, "fam_nope", "x");
    expect(await loadFamily(kv, "fam_nope")).toBeNull();
  });
});

describe("deleteAccessToken + deleteRefreshToken", () => {
  it("return 1 when the token existed, 0 when it didn't", async () => {
    const kv = makeMemoryKv();
    const pair = await issueTokenPair(kv, {
      client_id: "mc_x",
      subject: "alex",
      scope: "maverick:state",
    });
    expect(await deleteAccessToken(kv, pair.access.token)).toBe(1);
    expect(await deleteAccessToken(kv, pair.access.token)).toBe(0);
    expect(await deleteRefreshToken(kv, pair.refresh.token)).toBe(1);
    expect(await deleteRefreshToken(kv, pair.refresh.token)).toBe(0);
  });
});

describe("tokenKind", () => {
  it("classifies by prefix", () => {
    expect(tokenKind("mat_abc")).toBe("access");
    expect(tokenKind("mrt_abc")).toBe("refresh");
    expect(tokenKind("code_abc")).toBe("unknown");
    expect(tokenKind("nothing")).toBe("unknown");
  });
});
