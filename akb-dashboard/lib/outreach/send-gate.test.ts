import { describe, it, expect, vi } from "vitest";
import {
  dedupeKey,
  normalizeDedupeBody,
  normalizeDedupePhone,
  evaluateStaticGate,
  sendGuarded,
  OPENER_PURPOSES,
  SMS_DEDUPE_TTL_S,
  type SendPurpose,
} from "@/lib/outreach/send-gate";
import { makeMemoryKv } from "@/lib/maverick/oauth/kv";
import type { QuoSendResult } from "@/lib/quo";

const OK: QuoSendResult = { id: "msg_1", status: "queued", httpStatus: 202, raw: null };

/** A sender spy that records every dispatch. */
function spySender() {
  const calls: Array<{ to: string; body: string }> = [];
  const fn = vi.fn(async (to: string, body: string) => {
    calls.push({ to, body });
    return OK;
  });
  return { fn, calls };
}

const base = {
  to: "+12058756959",
  body: "Hi Angela — cash offer on 1505 17th St?",
  purpose: "first_touch" as SendPurpose,
  recordId: "rec123",
};

// ── (c) dedupe key logic — PURE, testable with no KV ──────────────────

describe("dedupe key (pure)", () => {
  it("uses the sms:dedupe:{phone}:{16-hex} shape", () => {
    const k = dedupeKey("+12058756959", "hello there");
    expect(k).toMatch(/^sms:dedupe:12058756959:[0-9a-f]{16}$/);
  });

  it("is stable for the same phone + body", () => {
    expect(dedupeKey("+12058756959", "abc")).toBe(dedupeKey("+12058756959", "abc"));
  });

  it("differs when the body differs", () => {
    expect(dedupeKey("+12058756959", "abc")).not.toBe(dedupeKey("+12058756959", "abd"));
  });

  it("differs when the phone differs", () => {
    expect(dedupeKey("+12058756959", "abc")).not.toBe(dedupeKey("+12058756950", "abc"));
  });

  it("collides across phone FORMATTING — same handset, same key", () => {
    expect(dedupeKey("+1 (205) 875-6959", "abc")).toBe(dedupeKey("+12058756959", "abc"));
    expect(normalizeDedupePhone("+1 (205) 875-6959")).toBe("12058756959");
  });

  it("collides across whitespace + case — same text to the human receiving it", () => {
    expect(dedupeKey("+12058756959", "Hello   There\n")).toBe(
      dedupeKey("+12058756959", "hello there"),
    );
    expect(normalizeDedupeBody("  Hello \n\t There  ")).toBe("hello there");
  });

  it("suppression window is 30 minutes", () => {
    expect(SMS_DEDUPE_TTL_S).toBe(1800);
  });
});

// ── (a) (b) (d) — the pure gate floor ─────────────────────────────────

describe("evaluateStaticGate", () => {
  const ok = { purpose: "reply", recordId: "rec1", to: "+15551234567", body: "hi" };

  it("passes a well-formed request", () => {
    expect(evaluateStaticGate(ok)).toBeNull();
  });

  // (d) mandatory audit tags
  it("refuses a missing purpose", () => {
    expect(evaluateStaticGate({ ...ok, purpose: "" })).toBe("missing_purpose");
    expect(evaluateStaticGate({ ...ok, purpose: null })).toBe("missing_purpose");
  });

  it("refuses an unknown purpose", () => {
    expect(evaluateStaticGate({ ...ok, purpose: "blast" })).toBe("invalid_purpose");
  });

  it("refuses a missing recordId", () => {
    expect(evaluateStaticGate({ ...ok, recordId: "" })).toBe("missing_record_id");
    expect(evaluateStaticGate({ ...ok, recordId: "   " })).toBe("missing_record_id");
  });

  it("checks the audit tags BEFORE the payload — an untagged send never proceeds", () => {
    expect(evaluateStaticGate({ purpose: "", recordId: "", to: "", body: "" })).toBe(
      "missing_purpose",
    );
  });

  it("refuses an empty phone or body", () => {
    expect(evaluateStaticGate({ ...ok, to: "" })).toBe("missing_phone");
    expect(evaluateStaticGate({ ...ok, body: "  " })).toBe("empty_body");
  });

  // (a) Do_Not_Text — number-level, no purpose escapes it
  it("refuses Do_Not_Text for EVERY purpose", () => {
    for (const purpose of ["first_touch", "bump", "reply", "followup"]) {
      expect(evaluateStaticGate({ ...ok, purpose, listing: { doNotText: true } })).toBe(
        "do_not_text",
      );
    }
  });

  it("does not refuse when doNotText is false / absent / null", () => {
    expect(evaluateStaticGate({ ...ok, listing: { doNotText: false } })).toBeNull();
    expect(evaluateStaticGate({ ...ok, listing: {} })).toBeNull();
    expect(evaluateStaticGate({ ...ok, listing: null })).toBeNull();
  });

  // (b) renovated veto — every offer-stating purpose (2026-07-28, audit
  // finding #2: a followup RESTATES an offer to a silent thread, so it is an
  // opener wearing a different tag; only a conversational reply is exempt).
  it("vetoes a renovated listing for first_touch, bump, and followup", () => {
    for (const purpose of ["first_touch", "bump", "followup"]) {
      expect(evaluateStaticGate({ ...ok, purpose, listing: { renovatedLanguage: true } })).toBe(
        "renovated_listing_veto",
      );
    }
  });

  it("ALLOWS a renovated listing for reply — a live conversation is not an opener", () => {
    expect(
      evaluateStaticGate({ ...ok, purpose: "reply", listing: { renovatedLanguage: true } }),
    ).toBeNull();
  });

  it("OPENER_PURPOSES is exactly {first_touch, bump, followup} — every purpose except reply", () => {
    expect([...OPENER_PURPOSES].sort()).toEqual(["bump", "first_touch", "followup"]);
  });

  it("Do_Not_Text outranks the renovated veto", () => {
    expect(
      evaluateStaticGate({
        ...ok,
        purpose: "first_touch",
        listing: { doNotText: true, renovatedLanguage: true },
      }),
    ).toBe("do_not_text");
  });
});

// ── sendGuarded — end to end with an in-memory KV ─────────────────────

describe("sendGuarded", () => {
  it("sends a clean first_touch and reports the dedupe claim as enforced", async () => {
    const s = spySender();
    const r = await sendGuarded(base, { kv: makeMemoryKv(), send: s.fn });
    expect(r.sent).toBe(true);
    expect(r.refused).toBe(false);
    expect(r.result).toEqual(OK);
    expect(r.dedupe.enforced).toBe(true);
    expect(r.dedupe.degraded).toBe(false);
    expect(s.calls).toHaveLength(1);
  });

  it("(c) REFUSES an identical body to the same number inside the window", async () => {
    const kv = makeMemoryKv();
    const s = spySender();
    const first = await sendGuarded(base, { kv, send: s.fn });
    const second = await sendGuarded(base, { kv, send: s.fn });
    expect(first.sent).toBe(true);
    expect(second.sent).toBe(false);
    expect(second.refused).toBe(true);
    expect(second.reason).toBe("duplicate_within_window");
    expect(s.calls).toHaveLength(1); // the sender was never touched the 2nd time
  });

  it("(c) suppresses ACROSS RECORDS — the two same-phone listings bug", async () => {
    const kv = makeMemoryKv();
    const s = spySender();
    await sendGuarded({ ...base, recordId: "recAAA", purpose: "reply" }, { kv, send: s.fn });
    const dup = await sendGuarded(
      { ...base, recordId: "recBBB", purpose: "reply" },
      { kv, send: s.fn },
    );
    expect(dup.reason).toBe("duplicate_within_window");
    expect(s.calls).toHaveLength(1);
  });

  it("(c) allows a DIFFERENT body to the same number", async () => {
    const kv = makeMemoryKv();
    const s = spySender();
    await sendGuarded(base, { kv, send: s.fn });
    const other = await sendGuarded({ ...base, body: "Different message entirely" }, { kv, send: s.fn });
    expect(other.sent).toBe(true);
    expect(s.calls).toHaveLength(2);
  });

  it("(c) allows the same body to a DIFFERENT number", async () => {
    const kv = makeMemoryKv();
    const s = spySender();
    await sendGuarded(base, { kv, send: s.fn });
    const other = await sendGuarded({ ...base, to: "+15550001111" }, { kv, send: s.fn });
    expect(other.sent).toBe(true);
    expect(s.calls).toHaveLength(2);
  });

  it("(a) refuses Do_Not_Text without touching the sender", async () => {
    const s = spySender();
    const r = await sendGuarded(
      { ...base, listing: { doNotText: true } },
      { kv: makeMemoryKv(), send: s.fn },
    );
    expect(r.reason).toBe("do_not_text");
    expect(s.calls).toHaveLength(0);
  });

  it("(b) refuses a renovated listing on first_touch but allows it on reply", async () => {
    const s = spySender();
    const opener = await sendGuarded(
      { ...base, purpose: "first_touch", listing: { renovatedLanguage: true } },
      { kv: makeMemoryKv(), send: s.fn },
    );
    expect(opener.reason).toBe("renovated_listing_veto");

    const reply = await sendGuarded(
      { ...base, purpose: "reply", listing: { renovatedLanguage: true } },
      { kv: makeMemoryKv(), send: s.fn },
    );
    expect(reply.sent).toBe(true);
    expect(s.calls).toHaveLength(1);
  });

  it("(b) refuses a renovated listing on followup too — a re-touch restating an offer is an opener, not a conversation (audit finding #2, 2026-07-28)", async () => {
    const s = spySender();
    const followup = await sendGuarded(
      { ...base, purpose: "followup", listing: { renovatedLanguage: true } },
      { kv: makeMemoryKv(), send: s.fn },
    );
    expect(followup.reason).toBe("renovated_listing_veto");
    expect(s.calls).toHaveLength(0);
  });

  it("(d) refuses a send with no purpose or no recordId", async () => {
    const s = spySender();
    const noPurpose = await sendGuarded(
      { ...base, purpose: "" as unknown as SendPurpose },
      { kv: makeMemoryKv(), send: s.fn },
    );
    const noRecord = await sendGuarded({ ...base, recordId: "" }, { kv: makeMemoryKv(), send: s.fn });
    expect(noPurpose.reason).toBe("missing_purpose");
    expect(noRecord.reason).toBe("missing_record_id");
    expect(s.calls).toHaveLength(0);
  });

  it("FAILS OPEN when KV throws — an infra outage must never dark all outreach", async () => {
    const s = spySender();
    const brokenKv = {
      ...makeMemoryKv(),
      setNx: async () => {
        throw new Error("KV setNx failed: 503");
      },
    };
    const r = await sendGuarded(base, { kv: brokenKv, send: s.fn });
    expect(r.sent).toBe(true);
    expect(r.dedupe.degraded).toBe(true);
    expect(r.dedupe.enforced).toBe(false);
    expect(s.calls).toHaveLength(1);
  });

  it("FAILS OPEN when KV is absent entirely", async () => {
    const s = spySender();
    const r = await sendGuarded(base, { kv: null, send: s.fn });
    expect(r.sent).toBe(true);
    expect(r.dedupe.degraded).toBe(true);
    expect(s.calls).toHaveLength(1);
  });

  it("KV outage does NOT weaken the pure checks (a)/(b)/(d)", async () => {
    const s = spySender();
    const brokenKv = {
      ...makeMemoryKv(),
      setNx: async () => {
        throw new Error("KV down");
      },
    };
    const dnt = await sendGuarded(
      { ...base, listing: { doNotText: true } },
      { kv: brokenKv, send: s.fn },
    );
    const reno = await sendGuarded(
      { ...base, purpose: "bump", listing: { renovatedLanguage: true } },
      { kv: brokenKv, send: s.fn },
    );
    const untagged = await sendGuarded({ ...base, recordId: "" }, { kv: brokenKv, send: s.fn });
    expect(dnt.reason).toBe("do_not_text");
    expect(reno.reason).toBe("renovated_listing_veto");
    expect(untagged.reason).toBe("missing_record_id");
    expect(s.calls).toHaveLength(0);
  });

  it("rethrows a send failure AND releases the claim so a retry is not locked out", async () => {
    const kv = makeMemoryKv();
    const boom = vi.fn(async () => {
      throw new Error("Quo send error 500");
    });
    await expect(sendGuarded(base, { kv, send: boom })).rejects.toThrow("Quo send error 500");

    // The failed send left no claim behind — the retry goes through.
    const s = spySender();
    const retry = await sendGuarded(base, { kv, send: s.fn });
    expect(retry.sent).toBe(true);
    expect(s.calls).toHaveLength(1);
  });

  it("passes the `from` channel override through to the sender", async () => {
    const calls: Array<{ from?: string }> = [];
    const send = vi.fn(async (_to: string, _body: string, opts: { from?: string } = {}) => {
      calls.push(opts);
      return OK;
    });
    await sendGuarded({ ...base, from: "PNMhSUQXFw" }, { kv: makeMemoryKv(), send });
    expect(calls[0]).toEqual({ from: "PNMhSUQXFw" });
  });
});
