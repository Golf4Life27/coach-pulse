// @agent: outreach — Quo→Verification_Notes sync (idempotent append) tests.
import { describe, it, expect } from "vitest";
import { extractCitedQuoIds, appendQuoMessagesToNotes } from "./quo-sync";

const NOW_ISO = "2026-06-07T03:55:00.000Z";

// Fake Quo ids — long enough to match the regex, NOT in Twilio Account
// SID format (mix non-hex chars so push-protection doesn't false-flag).
const ID_OUTBOUND = "ACzzMOCKzzOUTzzzzz0123456789xyzw";
const ID_INBOUND_1 = "ACzzMOCKzzINzzzzzzzz0123zzwaverlk";
const ID_INBOUND_2 = "ACzzMOCKzzINzzzzzzzz0123zzburwoodk";
const ID_REPEAT = "ACzzMOCKzzREPEATzzzzzzz01234zzzwk";

describe("extractCitedQuoIds", () => {
  it("finds every Quo id already cited (outbound + inbound markers)", () => {
    const notes = `[H2 sent 2026-06-05T15:31:26Z] Quo msg ${ID_OUTBOUND}: Hi Victoria...

[Quo inbound msg ${ID_INBOUND_1} ts=... ]`;
    const ids = extractCitedQuoIds(notes);
    expect(ids.has(ID_OUTBOUND)).toBe(true);
    expect(ids.has(ID_INBOUND_1)).toBe(true);
  });
  it("empty notes → empty set", () => {
    expect(extractCitedQuoIds(null).size).toBe(0);
    expect(extractCitedQuoIds("").size).toBe(0);
  });
});

describe("appendQuoMessagesToNotes — idempotent verbatim append", () => {
  it("appends NEW inbound verbatim with provenance + dollar-escalation tag", () => {
    const existing = `[H2 sent 2026-05-29T17:34:01Z] Quo msg ${ID_OUTBOUND}: Hi Alan, ...cash offer at $68,250...`;
    const r = appendQuoMessagesToNotes(existing, [
      { id: ID_INBOUND_1, body: "Thank. Seller will not take less 100k.", createdAt: "2026-05-29T21:25:00.000Z", direction: "incoming" },
    ], { syncMarkerSource: "quo_sync_test", nowIso: NOW_ISO });
    expect(r.newEvents).toHaveLength(1);
    expect(r.notes).toContain("Thank. Seller will not take less 100k.");
    expect(r.notes).toContain(`[Quo inbound msg ${ID_INBOUND_1}`);
    expect(r.notes).toContain("⚠ ESCALATE: $100,000");
    expect(r.escalationCount).toBe(1);
  });

  it("SKIPS messages whose Quo id is already cited (idempotent)", () => {
    const existing = `[Quo inbound msg ${ID_INBOUND_1} ts=2026-06-05T15:48 src=quo_sync ingested_at=...]`;
    const r = appendQuoMessagesToNotes(existing, [
      { id: ID_INBOUND_1, body: "Already cited body", createdAt: "2026-06-05T15:48:00.000Z", direction: "incoming" },
    ], { nowIso: NOW_ISO });
    expect(r.newEvents).toHaveLength(0);
    expect(r.skippedAlreadyPresent).toEqual([ID_INBOUND_1]);
    expect(r.notes).toBe(existing);
  });

  it("SKIPS outgoing messages (sender wrote them at send time)", () => {
    const r = appendQuoMessagesToNotes("", [
      { id: ID_OUTBOUND, body: "Hi, this is Alex...", createdAt: "2026-06-05T15:30:00.000Z", direction: "outgoing" },
    ], { nowIso: NOW_ISO });
    expect(r.newEvents).toHaveLength(0);
  });

  it("preserves body VERBATIM (Burwood fixture — Mainstay corporate reply)", () => {
    const body = "Albert from Mainstay... corporate investor seeking an offer at or very close to list price... submit your best offer and the seller will decide to counter";
    const r = appendQuoMessagesToNotes("", [
      { id: ID_INBOUND_2, body, createdAt: "2026-06-05T15:52:00.000Z", direction: "incoming" },
    ], { nowIso: NOW_ISO });
    expect(r.notes).toContain(body);
    expect(r.notes).toContain("corporate investor seeking an offer at or very close to list price");
  });

  it("re-running with the SAME messages produces NO new appends (idempotent)", () => {
    const first = appendQuoMessagesToNotes("", [
      { id: ID_REPEAT, body: "Hi", createdAt: "2026-06-06T00:00:00.000Z", direction: "incoming" },
    ], { nowIso: NOW_ISO });
    const second = appendQuoMessagesToNotes(first.notes, [
      { id: ID_REPEAT, body: "Hi", createdAt: "2026-06-06T00:00:00.000Z", direction: "incoming" },
    ], { nowIso: NOW_ISO });
    expect(second.newEvents).toHaveLength(0);
    expect(second.notes).toBe(first.notes);
  });

  it("escalationCount counts only events with dollar amounts", () => {
    const r = appendQuoMessagesToNotes("", [
      { id: ID_INBOUND_1, body: "Thanks for the text.", createdAt: "2026-06-06T00:00:00.000Z", direction: "incoming" },
      { id: ID_INBOUND_2, body: "$70k works", createdAt: "2026-06-06T00:01:00.000Z", direction: "incoming" },
    ], { nowIso: NOW_ISO });
    expect(r.newEvents).toHaveLength(2);
    expect(r.escalationCount).toBe(1);
  });
});
