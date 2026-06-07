// @agent: outreach — reliable-Quo tests (standing rules pinned).
import { describe, it, expect } from "vitest";
import {
  reliableSendVerdict,
  checkDuplicateSend,
  detectFeedDiscrepancy,
  DUP_WINDOW_HOURS_DEFAULT,
} from "./reliable-quo";

const ID_OK = "ACzzMOCKzzCONFIRMEDzzzzz0123zzz9";
const ID_OTHER = "ACzzMOCKzzOTHERzzzzzzzzz0123zzz9";

describe("reliableSendVerdict — STANDING RULE: no send is 'sent' until fetched back and seen", () => {
  it("CONFIRMED only when POST 2xx AND per-ID lookup found AND body matches", () => {
    const r = reliableSendVerdict({
      postOk: true,
      postedId: ID_OK,
      fetchedById: { id: ID_OK, body: "Hi Charles, ...$45,000...", createdAt: "...", direction: "outgoing" },
      intendedBody: "Hi Charles, ...$45,000...",
    });
    expect(r.verdict).toBe("confirmed_sent");
  });

  it("ATTEMPTED-UNCONFIRMED when POST 2xx but lookup did NOT see the row (the bug)", () => {
    const r = reliableSendVerdict({
      postOk: true,
      postedId: ID_OK,
      fetchedById: null,
      intendedBody: "Hi Charles...",
    });
    expect(r.verdict).toBe("attempted_unconfirmed");
    expect(r.reason).toContain("did NOT see the row");
  });

  it("ATTEMPTED-UNCONFIRMED when lookup returns a DIFFERENT id", () => {
    const r = reliableSendVerdict({
      postOk: true,
      postedId: ID_OK,
      fetchedById: { id: ID_OTHER, body: "...", createdAt: "...", direction: "outgoing" },
      intendedBody: "...",
    });
    expect(r.verdict).toBe("attempted_unconfirmed");
  });

  it("ATTEMPTED-UNCONFIRMED when body diverges (truncation / charset)", () => {
    const r = reliableSendVerdict({
      postOk: true,
      postedId: ID_OK,
      fetchedById: { id: ID_OK, body: "Hi Charles", createdAt: "...", direction: "outgoing" },
      intendedBody: "Hi Charles, ...full script...",
    });
    expect(r.verdict).toBe("attempted_unconfirmed");
    expect(r.reason).toContain("body diverges");
  });

  it("SEND_FAILED on POST non-2xx", () => {
    expect(reliableSendVerdict({ postOk: false, postedId: null, fetchedById: null, intendedBody: "..." }).verdict).toBe("send_failed");
  });
});

describe("checkDuplicateSend — structural duplicate refusal", () => {
  const NOW = new Date("2026-06-07T18:00:00Z");

  it("REFUSES identical-body send within 24h window (today's manual-duplicate fixture)", () => {
    const r = checkDuplicateSend({
      recentOutbound: [{ body: "Hi Charles, this is Alex with AKB Solutions. I see 15875 Strathmoor St is still available. ...$45,000...", createdAt: "2026-06-07T14:00:00Z" }],
      intendedBody:   "Hi Charles, this is Alex with AKB Solutions. I see 15875 Strathmoor St is still available. ...$45,000...",
      now: NOW,
    });
    expect(r.verdict).toBe("duplicate_within_window");
    expect(r.matchedPrior!.ageHours).toBeCloseTo(4, 1);
  });

  it("normalizes whitespace + case before comparing (Quo whitespace-mangling resilience)", () => {
    const r = checkDuplicateSend({
      recentOutbound: [{ body: "HI charles,   THIS IS alex", createdAt: "2026-06-07T17:00:00Z" }],
      intendedBody:   "Hi Charles, this is Alex",
      now: NOW,
    });
    expect(r.verdict).toBe("duplicate_within_window");
  });

  it("ALLOWS send when prior is outside the window (older than 24h)", () => {
    const r = checkDuplicateSend({
      recentOutbound: [{ body: "same body", createdAt: "2026-06-05T17:00:00Z" }],
      intendedBody: "same body",
      now: NOW,
    });
    expect(r.verdict).toBe("send_allowed");
  });

  it("ALLOWS send when bodies differ", () => {
    const r = checkDuplicateSend({
      recentOutbound: [{ body: "Hi Charles, $51,250...", createdAt: "2026-06-07T14:00:00Z" }],
      intendedBody:   "Hi Charles, $45,000...",
      now: NOW,
    });
    expect(r.verdict).toBe("send_allowed");
  });

  it("DUP_WINDOW_HOURS_DEFAULT is 24h", () => {
    expect(DUP_WINDOW_HOURS_DEFAULT).toBe(24);
  });

  it("empty body → allowed (no duplicate possible)", () => {
    expect(checkDuplicateSend({ recentOutbound: [{ body: "x", createdAt: "2026-06-07T17:00:00Z" }], intendedBody: "   ", now: NOW }).verdict).toBe("send_allowed");
  });
});

describe("detectFeedDiscrepancy — surfaces the lossy-feed-walk class", () => {
  it("FLAGS feed-only ids (feed says present, per-ID lookup says missing)", () => {
    const r = detectFeedDiscrepancy({
      feedMessages: [
        { id: ID_OK, from: "+1", to: "+2", body: "x", direction: "incoming", createdAt: "..." },
      ],
      lookupResults: new Map([[ID_OK, null]]),
    });
    expect(r.feedOnlyIds).toEqual([ID_OK]);
    expect(r.confirmedCount).toBe(0);
  });

  it("FLAGS body divergence between feed and lookup", () => {
    const r = detectFeedDiscrepancy({
      feedMessages: [
        { id: ID_OK, from: "+1", to: "+2", body: "ABC", direction: "incoming", createdAt: "..." },
      ],
      lookupResults: new Map([[ID_OK, { body: "XYZ" }]]),
    });
    expect(r.bodyDivergenceIds).toEqual([ID_OK]);
  });

  it("clean feed → all confirmed", () => {
    const r = detectFeedDiscrepancy({
      feedMessages: [
        { id: ID_OK, from: "+1", to: "+2", body: "abc", direction: "incoming", createdAt: "..." },
      ],
      lookupResults: new Map([[ID_OK, { body: "abc" }]]),
    });
    expect(r.confirmedCount).toBe(1);
    expect(r.feedOnlyIds).toEqual([]);
  });
});
