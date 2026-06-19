// M6 Reply Capture & Triage — prove-don't-claim tests.
//
// The anchor cases are the exact failures the milestone exists to fix:
//   - Leonard "$700, 2-bed rented" from a KNOWN agent phone → lands MATCHED
//     on the right record (was relayed by hand).
//   - Sonny-style reply from an UNKNOWN phone → routes to the fail-closed
//     catch-all (never silently dropped).
//   - Leonard's email reply to the 14303 Hubbell thread → appended to the
//     record's notes (was fetched ephemerally and never persisted).

import { describe, it, expect } from "vitest";
import { matchInboundToListing, extractEmailAddress } from "./match";
import { planInboundCapture } from "./capture";
import { parseQuoWebhookPayload } from "./webhook-parse";
import { appendGmailMessagesToNotes } from "./gmail-capture";
import { unmatchedReplyKey } from "./catch-all";
import type { InboundMessage, MatchableListing } from "./types";

const LISTINGS: MatchableListing[] = [
  { id: "rec14303Hubbell", agentPhone: "(313) 555-1212", agentEmail: "LpickettIII@rchlegacy.com", outreachStatus: "Texted" },
  { id: "recOther", agentPhone: "313-555-9000", agentEmail: "agent2@example.com", outreachStatus: "Negotiating" },
];

const sms = (over: Partial<InboundMessage> = {}): InboundMessage => ({
  channel: "sms", externalId: "AC0000000000001", sender: "+13135551212", body: "yes", receivedAt: "2026-06-16T19:00:00Z", ...over,
});

describe("match", () => {
  it("matches SMS by E.164 across different stored formats", () => {
    expect(matchInboundToListing(sms({ sender: "+13135551212" }), LISTINGS)?.id).toBe("rec14303Hubbell");
    expect(matchInboundToListing(sms({ sender: "3135551212" }), LISTINGS)?.id).toBe("rec14303Hubbell");
  });
  it("returns null for an unknown phone (→ catch-all)", () => {
    expect(matchInboundToListing(sms({ sender: "+15869998888" }), LISTINGS)).toBeNull();
  });
  it("matches email by bare address, ignoring display name + case", () => {
    const m: InboundMessage = { channel: "email", externalId: "g1", sender: "Leonard Pickett <lpickettiii@RCHLEGACY.com>", body: "hi", receivedAt: "2026-06-16T20:00:00Z" };
    expect(matchInboundToListing(m, LISTINGS)?.id).toBe("rec14303Hubbell");
  });
  it("extractEmailAddress pulls the address out of a From header", () => {
    expect(extractEmailAddress("Leonard P <LP@x.com>")).toBe("lp@x.com");
    expect(extractEmailAddress("LP@x.com")).toBe("lp@x.com");
  });
});

describe("planInboundCapture — Leonard / Sonny anchor cases", () => {
  it("Leonard '$700, 2-bed rented' from a KNOWN phone lands MATCHED on the record", () => {
    const plan = planInboundCapture(sms({ body: "$700, 2-bed rented", externalId: "ACleonard" }), LISTINGS);
    expect(plan.kind).toBe("matched");
    if (plan.kind !== "matched") throw new Error("unreachable");
    expect(plan.listingId).toBe("rec14303Hubbell");
    expect(plan.triage.classification).toBe("interest");
    expect(plan.newStatus).toBe("Negotiating"); // Texted → Negotiating on interest
  });

  it("Sonny-style reply from an UNKNOWN phone routes to the catch-all (never dropped)", () => {
    const plan = planInboundCapture(sms({ sender: "+15869998888", body: "Yes interested, call me", externalId: "ACsonny" }), LISTINGS);
    expect(plan.kind).toBe("unmatched");
    if (plan.kind !== "unmatched") throw new Error("unreachable");
    expect(plan.fields.Key).toBe("sms:ACsonny");
    expect(plan.fields.Channel).toBe("sms");
    expect(plan.fields.Classification).toBe("interest");
    expect(plan.fields.Status).toBe("New");
  });

  it("a dollar-amount reply escalates (negotiation point)", () => {
    const plan = planInboundCapture(sms({ body: "I can do $70k cash, send the contract" }), LISTINGS);
    expect(plan.kind).toBe("matched");
    if (plan.kind !== "matched") throw new Error("unreachable");
    expect(plan.escalate).toBe(true);
    expect(plan.amounts.amounts[0].amountUsd).toBe(70000);
    expect(plan.triage.classification).toBe("acceptance"); // "send the contract"
  });

  it("rejection routes to Dead", () => {
    const plan = planInboundCapture(sms({ body: "not interested, under contract" }), LISTINGS);
    if (plan.kind !== "matched") throw new Error("expected matched");
    expect(plan.triage.classification).toBe("rejection");
    expect(plan.newStatus).toBe("Dead");
  });

  it("our own echo / empty bodies are ignored (never create a phantom reply)", () => {
    expect(planInboundCapture(sms({ body: "This is Alex with AKB Solutions, interested in your listing" }), LISTINGS).kind).toBe("ignored");
    expect(planInboundCapture(sms({ body: "   " }), LISTINGS).kind).toBe("ignored");
  });

  it("an unmatched reply key is stable per channel+id (idempotent catch-all)", () => {
    const m = sms({ sender: "+15869998888", externalId: "ACdup" });
    expect(unmatchedReplyKey(m)).toBe("sms:ACdup");
  });
});

describe("parseQuoWebhookPayload", () => {
  it("maps a Quo incoming webhook to an InboundMessage", () => {
    const msg = parseQuoWebhookPayload({
      data: { object: { id: "ACwebhook1", from: "+13135551212", body: "yes interested", direction: "incoming", createdAt: "2026-06-16T19:05:00Z", conversationId: "CN1" } },
    });
    expect(msg).not.toBeNull();
    expect(msg!.channel).toBe("sms");
    expect(msg!.externalId).toBe("ACwebhook1");
    expect(msg!.sender).toBe("+13135551212");
    expect(msg!.threadId).toBe("CN1");
  });
  it("drops outbound echoes and malformed payloads (fail-closed → null)", () => {
    expect(parseQuoWebhookPayload({ data: { object: { id: "AC1", from: "+1", body: "hi", direction: "outgoing" } } })).toBeNull();
    expect(parseQuoWebhookPayload({ data: { object: { id: "AC1", from: "+1", body: "  " } } })).toBeNull();
    expect(parseQuoWebhookPayload({ nonsense: true })).toBeNull();
    expect(parseQuoWebhookPayload(null)).toBeNull();
  });
  it("end-to-end: a webhook payload from a known phone plans a matched capture", () => {
    const msg = parseQuoWebhookPayload({ data: { object: { id: "ACe2e", from: "(313) 555-1212", body: "call me", direction: "incoming" } } })!;
    const plan = planInboundCapture(msg, LISTINGS);
    expect(plan.kind).toBe("matched");
  });
});

describe("appendGmailMessagesToNotes — Hubbell email reply persisted", () => {
  const OUR = "alex@akb-properties.com";
  it("appends an inbound agent reply, skips our own sent message, idempotent on re-run", () => {
    const msgs = [
      { id: "sent1", from: "alex@akb-properties.com", body: "Cash offer inquiry on 14303 Hubbell", date: "2026-06-16T18:57:00Z" },
      { id: "reply1", from: "Leonard Pickett <LpickettIII@rchlegacy.com>", body: "Seller will take $90k, send the contract", date: "2026-06-16T21:00:00Z" },
    ];
    const r1 = appendGmailMessagesToNotes("prior notes", msgs, OUR);
    expect(r1.newEvents).toHaveLength(1);             // only the inbound reply
    expect(r1.newEvents[0].id).toBe("reply1");
    expect(r1.escalationCount).toBe(1);                // $90k detected
    expect(r1.notes).toContain("[Gmail inbound msg reply1");
    expect(r1.notes).toContain("Seller will take $90k");

    // Idempotent: re-running the same fetch appends nothing.
    const r2 = appendGmailMessagesToNotes(r1.notes, msgs, OUR);
    expect(r2.newEvents).toHaveLength(0);
    expect(r2.skippedAlreadyPresent).toContain("reply1");
    expect(r2.notes).toBe(r1.notes);
  });
});
