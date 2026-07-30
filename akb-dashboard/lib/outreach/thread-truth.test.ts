// Thread-truth — regression guard for the 2026-07-30 Canfield incident
// (Spine recJesmOUJXksQ11V): an operator manual send invisible to record
// notes must physically block the next send.

import { describe, it, expect } from "vitest";
import type { QuoMessage } from "@/lib/quo";
import {
  evaluateThreadTruth,
  parseKnownQuoIds,
  newestKnownInboundTs,
  THREAD_TRUTH_SKEW_MS,
} from "./thread-truth";

const msg = (over: Partial<QuoMessage>): QuoMessage => ({
  id: "AC000000000000000000000000000000",
  from: "+18155569965",
  to: "+17347093339",
  body: "x",
  direction: "outgoing",
  createdAt: "2026-07-17T20:30:00.000Z",
  ...over,
});

// The Canfield notes as the record knew them at send time: three recorded
// sends, three recorded inbounds — and NO trace of the operator's apology.
const CANFIELD_NOTES = [
  "[H2 sent 2026-07-09T19:45:54.544Z] Quo msg AC08a9a32420364cb28fd69ce6d2db20: ...",
  "[H2 bump 1 sent 2026-07-12] Quo msg AC69709025103842609fbd2a137ceafd: ...",
  "[H2 bump 2 sent 2026-07-17] Quo msg AC3ded6f3c1a3f4cc8ab667b9a981b59: ...",
  "[Quo inbound msg AC4c9e930536544408940baf6b1bedae ts=2026-07-09T19:46:42.219Z]",
  "[Quo inbound msg ACcf87e6065dd946948143813901b4a7 ts=2026-07-12T20:16:47.190Z]",
  "[Quo inbound msg AC4b0fd0aee9b14292a44922795e2a0e ts=2026-07-17T20:18:27.517Z]",
].join("\n");

describe("parseKnownQuoIds", () => {
  it("extracts every send and inbound id, case-insensitively", () => {
    const ids = parseKnownQuoIds(CANFIELD_NOTES);
    expect(ids.size).toBe(6);
    expect(ids.has("AC08A9A32420364CB28FD69CE6D2DB20")).toBe(true);
    expect(ids.has("AC4B0FD0AEE9B14292A44922795E2A0E")).toBe(true);
  });
  it("empty/null notes → empty set", () => {
    expect(parseKnownQuoIds(null).size).toBe(0);
    expect(parseKnownQuoIds("no ids here").size).toBe(0);
  });
});

describe("newestKnownInboundTs", () => {
  it("takes the max of field and note ts= markers", () => {
    const t = newestKnownInboundTs("2026-07-10T00:00:00.000Z", CANFIELD_NOTES);
    expect(t).toBe(Date.parse("2026-07-17T20:18:27.517Z"));
  });
  it("null field + no markers → null", () => {
    expect(newestKnownInboundTs(null, "nothing")).toBeNull();
  });
});

describe("evaluateThreadTruth — the Canfield case", () => {
  const known = parseKnownQuoIds(CANFIELD_NOTES);
  const knownInbound = newestKnownInboundTs(null, CANFIELD_NOTES);

  it("REFUSES: the operator's manual apology is in the thread but not the notes", () => {
    const thread: QuoMessage[] = [
      msg({ id: "AC3DED6F3C1A3F4CC8AB667B9A981B59" }), // recorded bump 2
      msg({ id: "AC4B0FD0AEE9B14292A44922795E2A0E", direction: "incoming", createdAt: "2026-07-17T20:18:27.517Z" }),
      // The invisible manual send:
      msg({ id: "ACFFFF00000000000000000000000000", body: "Michael, I'm so sorry! These were showing up as failed to send...", createdAt: "2026-07-17T21:00:00.000Z" }),
    ];
    const v = evaluateThreadTruth({ thread, knownQuoIds: known, newestKnownInboundMs: knownInbound, enforceUnseenInbound: true });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("unrecorded_outbound_in_thread");
    expect(v.evidence?.bodyPreview).toContain("so sorry");
  });

  it("PASSES a clean recorded cadence (bump follows recorded opener)", () => {
    const thread: QuoMessage[] = [
      msg({ id: "AC08A9A32420364CB28FD69CE6D2DB20" }),
      msg({ id: "AC69709025103842609FBD2A137CEAFD" }),
    ];
    const v = evaluateThreadTruth({ thread, knownQuoIds: known, newestKnownInboundMs: knownInbound, enforceUnseenInbound: true });
    expect(v.ok).toBe(true);
  });

  it("REFUSES on inbound newer than the record knows (ingestion lag)", () => {
    const thread: QuoMessage[] = [
      msg({ id: "ACAAAA000000000000000000000000AA", direction: "incoming", createdAt: "2026-07-30T16:05:18.000Z" }),
    ];
    const v = evaluateThreadTruth({ thread, knownQuoIds: known, newestKnownInboundMs: knownInbound, enforceUnseenInbound: true });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("unseen_inbound_in_thread");
  });

  it("reply purpose is exempt from unseen-inbound but NOT from unrecorded-outbound", () => {
    const freshInbound = msg({ id: "ACAAAA000000000000000000000000AA", direction: "incoming", createdAt: "2026-07-30T16:05:18.000Z" });
    const exempt = evaluateThreadTruth({ thread: [freshInbound], knownQuoIds: known, newestKnownInboundMs: knownInbound, enforceUnseenInbound: false });
    expect(exempt.ok).toBe(true);
    const manual = msg({ id: "ACBBBB000000000000000000000000BB" });
    const still = evaluateThreadTruth({ thread: [freshInbound, manual], knownQuoIds: known, newestKnownInboundMs: knownInbound, enforceUnseenInbound: false });
    expect(still.ok).toBe(false);
    expect(still.reason).toBe("unrecorded_outbound_in_thread");
  });

  it("tolerates clock skew inside the window; catches beyond it", () => {
    const base = Date.parse("2026-07-17T20:18:27.517Z");
    const inside = msg({ id: "ACCCCC000000000000000000000000CC", direction: "incoming", createdAt: new Date(base + THREAD_TRUTH_SKEW_MS - 1000).toISOString() });
    expect(evaluateThreadTruth({ thread: [inside], knownQuoIds: known, newestKnownInboundMs: base, enforceUnseenInbound: true }).ok).toBe(true);
    const beyond = msg({ id: "ACDDDD000000000000000000000000DD", direction: "incoming", createdAt: new Date(base + THREAD_TRUTH_SKEW_MS + 1000).toISOString() });
    expect(evaluateThreadTruth({ thread: [beyond], knownQuoIds: known, newestKnownInboundMs: base, enforceUnseenInbound: true }).ok).toBe(false);
  });

  it("virgin record + any inbound in thread → refuse (record thinks thread is untouched)", () => {
    const thread = [msg({ id: "ACEEEE000000000000000000000000EE", direction: "incoming", createdAt: "2026-07-01T00:00:00.000Z" })];
    const v = evaluateThreadTruth({ thread, knownQuoIds: new Set(), newestKnownInboundMs: null, enforceUnseenInbound: true });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("unseen_inbound_in_thread");
  });
});
