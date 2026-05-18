// @agent: scribe — DocuSign client pure-helper tests.

import { describe, it, expect } from "vitest";
import {
  buildJwtAssertion,
  normalizeEnvelopeStatus,
  isRecipientTerminal,
  isEnvelopeInFlight,
  isEnvelopeCompleted,
  isEnvelopeVoidedOrExpired,
  summarizeEnvelope,
  rollupEnvelopes,
  type DocusignEnvelope,
  type DocusignRecipient,
  type EnvelopeSummary,
} from "./docusign";
import { generateKeyPairSync } from "crypto";

const NOW = new Date("2026-05-18T12:00:00Z");

// Generate an RSA keypair once for the JWT signing tests so they
// don't depend on env or a fixture file.
const KEY_PAIR = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

describe("buildJwtAssertion", () => {
  it("produces a three-segment JWT (header.payload.signature)", () => {
    const jwt = buildJwtAssertion({
      integrationKey: "intkey-uuid",
      userId: "user-uuid",
      privateKeyPem: KEY_PAIR.privateKey,
      audience: "account.docusign.com",
      scope: "signature impersonation",
      lifetimeSeconds: 3600,
      now: NOW,
    });
    const parts = jwt.split(".");
    expect(parts).toHaveLength(3);
  });

  it("uses RS256 alg in the header", () => {
    const jwt = buildJwtAssertion({
      integrationKey: "x",
      userId: "y",
      privateKeyPem: KEY_PAIR.privateKey,
      audience: "account.docusign.com",
      scope: "signature impersonation",
      lifetimeSeconds: 3600,
      now: NOW,
    });
    const headerJson = Buffer.from(jwt.split(".")[0], "base64").toString("utf-8");
    expect(JSON.parse(headerJson)).toEqual({ alg: "RS256", typ: "JWT" });
  });

  it("embeds iss, sub, iat, exp, aud, scope in the payload", () => {
    const jwt = buildJwtAssertion({
      integrationKey: "intkey-uuid",
      userId: "user-uuid",
      privateKeyPem: KEY_PAIR.privateKey,
      audience: "account.docusign.com",
      scope: "signature impersonation",
      lifetimeSeconds: 1800,
      now: NOW,
    });
    const payloadJson = Buffer.from(jwt.split(".")[1], "base64").toString("utf-8");
    const payload = JSON.parse(payloadJson);
    expect(payload.iss).toBe("intkey-uuid");
    expect(payload.sub).toBe("user-uuid");
    expect(payload.aud).toBe("account.docusign.com");
    expect(payload.scope).toBe("signature impersonation");
    expect(payload.iat).toBe(Math.floor(NOW.getTime() / 1000));
    expect(payload.exp).toBe(payload.iat + 1800);
  });

  it("throws when the private key is invalid", () => {
    expect(() =>
      buildJwtAssertion({
        integrationKey: "x",
        userId: "y",
        privateKeyPem: "not-a-real-key",
        audience: "account.docusign.com",
        scope: "signature impersonation",
        lifetimeSeconds: 3600,
        now: NOW,
      }),
    ).toThrow();
  });
});

describe("normalizeEnvelopeStatus", () => {
  it("downcases known statuses", () => {
    expect(normalizeEnvelopeStatus("Sent")).toBe("sent");
    expect(normalizeEnvelopeStatus("COMPLETED")).toBe("completed");
    expect(normalizeEnvelopeStatus("voided")).toBe("voided");
  });

  it("returns 'unknown' for unrecognized values", () => {
    expect(normalizeEnvelopeStatus("foobar")).toBe("unknown");
    expect(normalizeEnvelopeStatus("")).toBe("unknown");
  });
});

describe("recipient/envelope classifiers", () => {
  it("isRecipientTerminal recognizes signed/completed/declined/autoresponded", () => {
    expect(isRecipientTerminal("signed")).toBe(true);
    expect(isRecipientTerminal("completed")).toBe(true);
    expect(isRecipientTerminal("declined")).toBe(true);
    expect(isRecipientTerminal("autoresponded")).toBe(true);
    expect(isRecipientTerminal("sent")).toBe(false);
    expect(isRecipientTerminal("delivered")).toBe(false);
  });

  it("isEnvelopeInFlight catches mid-route statuses", () => {
    expect(isEnvelopeInFlight("sent")).toBe(true);
    expect(isEnvelopeInFlight("delivered")).toBe(true);
    expect(isEnvelopeInFlight("signed")).toBe(true);
    expect(isEnvelopeInFlight("completed")).toBe(false);
    expect(isEnvelopeInFlight("voided")).toBe(false);
  });

  it("isEnvelopeCompleted is true only for 'completed'", () => {
    expect(isEnvelopeCompleted("completed")).toBe(true);
    expect(isEnvelopeCompleted("signed")).toBe(false);
  });

  it("isEnvelopeVoidedOrExpired covers voided/declined/timedout", () => {
    expect(isEnvelopeVoidedOrExpired("voided")).toBe(true);
    expect(isEnvelopeVoidedOrExpired("declined")).toBe(true);
    expect(isEnvelopeVoidedOrExpired("timedout")).toBe(true);
    expect(isEnvelopeVoidedOrExpired("completed")).toBe(false);
    expect(isEnvelopeVoidedOrExpired("sent")).toBe(false);
  });
});

function envelope(over: Partial<DocusignEnvelope> & { envelopeId: string; status: DocusignEnvelope["status"] }): DocusignEnvelope {
  return {
    emailSubject: "23 Fields Ave — Cash Offer",
    sentDateTime: "2026-05-15T14:00:00Z",
    lastModifiedDateTime: "2026-05-15T14:00:00Z",
    ...over,
  };
}

function recipient(over: Partial<DocusignRecipient> & { recipientId: string }): DocusignRecipient {
  return {
    name: "Candice Hardaway",
    email: "candice@example.com",
    status: "sent",
    routingOrder: "1",
    ...over,
  };
}

describe("summarizeEnvelope", () => {
  it("returns the deep link URL and normalized status", () => {
    const r = summarizeEnvelope(
      envelope({ envelopeId: "env-1", status: "sent" }),
      [recipient({ recipientId: "r1" })],
      NOW,
    );
    expect(r.envelopeId).toBe("env-1");
    expect(r.status).toBe("sent");
    expect(r.deep_link_url).toContain("env-1");
    expect(r.deep_link_url).toContain("docusign.com");
  });

  it("identifies the pending recipient and computes hours-awaiting", () => {
    const r = summarizeEnvelope(
      envelope({
        envelopeId: "env-2",
        status: "delivered",
        lastModifiedDateTime: "2026-05-18T06:00:00Z", // 6 hours ago
      }),
      [recipient({ recipientId: "r1", name: "Candice", status: "sent" })],
      NOW,
    );
    expect(r.awaiting_recipient_name).toBe("Candice");
    expect(r.awaiting_hours).toBeCloseTo(6, 0);
  });

  it("picks the lowest routing order pending recipient when multiple are open", () => {
    const r = summarizeEnvelope(
      envelope({ envelopeId: "env-3", status: "sent" }),
      [
        recipient({ recipientId: "r2", name: "Second", routingOrder: "2", status: "sent" }),
        recipient({ recipientId: "r1", name: "First", routingOrder: "1", status: "sent" }),
      ],
      NOW,
    );
    expect(r.awaiting_recipient_name).toBe("First");
  });

  it("skips terminal recipients (already signed) when selecting pending", () => {
    const r = summarizeEnvelope(
      envelope({ envelopeId: "env-4", status: "delivered" }),
      [
        recipient({ recipientId: "r1", name: "Candice", routingOrder: "1", status: "signed" }),
        recipient({ recipientId: "r2", name: "Alex", routingOrder: "2", status: "sent" }),
      ],
      NOW,
    );
    expect(r.awaiting_recipient_name).toBe("Alex");
  });

  it("flags awaiting_is_alex when the pending recipient email matches the configured Alex email", () => {
    const r = summarizeEnvelope(
      envelope({ envelopeId: "env-5", status: "delivered" }),
      [recipient({ recipientId: "r1", name: "Alex", email: "Alex@akb-properties.com", status: "sent" })],
      NOW,
    );
    expect(r.awaiting_is_alex).toBe(true);
  });

  it("awaiting_is_alex is false when pending recipient is someone else", () => {
    const r = summarizeEnvelope(
      envelope({ envelopeId: "env-6", status: "delivered" }),
      [recipient({ recipientId: "r1", email: "candice@example.com", status: "sent" })],
      NOW,
    );
    expect(r.awaiting_is_alex).toBe(false);
  });

  it("awaiting_hours is null when no recipient is pending (fully signed envelope)", () => {
    const r = summarizeEnvelope(
      envelope({ envelopeId: "env-7", status: "completed" }),
      [recipient({ recipientId: "r1", status: "signed" })],
      NOW,
    );
    expect(r.awaiting_hours).toBeNull();
    expect(r.awaiting_recipient_name).toBeNull();
  });
});

describe("rollupEnvelopes", () => {
  function summary(over: Partial<EnvelopeSummary> & { envelopeId: string; status: EnvelopeSummary["status"] }): EnvelopeSummary {
    return {
      subject: null,
      last_modified_iso: null,
      awaiting_recipient_name: null,
      awaiting_recipient_email: null,
      awaiting_hours: null,
      awaiting_is_alex: false,
      deep_link_url: "",
      ...over,
    };
  }

  it("counts active in-flight envelopes", () => {
    const r = rollupEnvelopes(
      [
        summary({ envelopeId: "1", status: "sent" }),
        summary({ envelopeId: "2", status: "delivered" }),
        summary({ envelopeId: "3", status: "completed" }),
      ],
      NOW,
    );
    expect(r.active_count).toBe(2);
  });

  it("counts envelopes awaiting Alex and tracks the max awaiting hours", () => {
    const r = rollupEnvelopes(
      [
        summary({ envelopeId: "1", status: "delivered", awaiting_is_alex: true, awaiting_hours: 5 }),
        summary({ envelopeId: "2", status: "sent", awaiting_is_alex: true, awaiting_hours: 30 }),
        summary({ envelopeId: "3", status: "sent", awaiting_is_alex: false, awaiting_hours: 100 }),
      ],
      NOW,
    );
    expect(r.awaiting_alex_count).toBe(2);
    expect(r.max_awaiting_alex_hours).toBe(30);
  });

  it("counts envelopes completed within the last week", () => {
    const r = rollupEnvelopes(
      [
        summary({ envelopeId: "1", status: "completed", last_modified_iso: "2026-05-17T12:00:00Z" }), // 1d ago
        summary({ envelopeId: "2", status: "completed", last_modified_iso: "2026-05-12T12:00:00Z" }), // 6d ago
        summary({ envelopeId: "3", status: "completed", last_modified_iso: "2026-05-01T12:00:00Z" }), // 17d ago
      ],
      NOW,
    );
    expect(r.signed_this_week).toBe(2);
  });

  it("counts voided + declined + timedout envelopes together", () => {
    const r = rollupEnvelopes(
      [
        summary({ envelopeId: "1", status: "voided" }),
        summary({ envelopeId: "2", status: "declined" }),
        summary({ envelopeId: "3", status: "timedout" }),
        summary({ envelopeId: "4", status: "completed" }),
      ],
      NOW,
    );
    expect(r.voided_or_expired).toBe(3);
  });

  it("returns zeros + null max when input is empty", () => {
    expect(rollupEnvelopes([], NOW)).toEqual({
      active_count: 0,
      awaiting_alex_count: 0,
      signed_this_week: 0,
      voided_or_expired: 0,
      max_awaiting_alex_hours: null,
    });
  });
});
