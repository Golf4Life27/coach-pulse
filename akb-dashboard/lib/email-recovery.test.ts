import { describe, it, expect } from "vitest";
import {
  emailRecoveryVerdict,
  selectEmailRecoveryCandidates,
  buildRecoveryEmail,
  buildEmailSentNote,
} from "./email-recovery";
import { SOURCE_VERSION_V2 } from "./source-version";
import type { Listing } from "./types";

const QUARANTINE_NOTE =
  "[H2 quarantine 2026-07-09T15:20:00.000Z] Carrier could not deliver to '+12058756959' (status: undelivered) — number marked Dead, no retry.";

function carrierDead(overrides: Partial<Listing> = {}): Listing {
  return {
    id: "recDEADMAIL00001",
    address: "1505 17th St, Birmingham, AL 35204",
    city: "Birmingham",
    zip: "35204",
    listPrice: 89_000,
    mao: null,
    dom: null,
    offerTier: null,
    liveStatus: "Active",
    executionPath: "Auto Proceed",
    outreachStatus: "Dead",
    lastOutreachDate: null,
    agentName: "Angela James",
    agentPhone: "+12058756959",
    agentEmail: "angela@example.com",
    verificationUrl: "https://example.com/x",
    notes: QUARANTINE_NOTE,
    distressScore: null,
    distressBucket: null,
    bedrooms: 3,
    bathrooms: 1,
    buildingSqFt: 1200,
    yearBuilt: 1950,
    portfolioDetected: false,
    stageCalc: null,
    approvedForOutreach: true,
    flipScore: null,
    offMarketOverride: false,
    restrictionText: null,
    ddChecklist: null,
    doNotText: false,
    state: "AL",
    sourceVersion: SOURCE_VERSION_V2,
    actionHoldUntil: null,
    actionCardState: null,
    lastInboundAt: null,
    lastOutboundAt: "2026-07-09T15:19:00.000Z",
    lastEmailOutreachDate: null,
    envelopeId: null,
    ...overrides,
  };
}

describe("emailRecoveryVerdict", () => {
  it("admits a carrier-dead v2 record with a valid email", () => {
    expect(emailRecoveryVerdict(carrierDead())).toEqual({ eligible: true, reason: null });
  });

  it("only CARRIER-dead records qualify — other Dead dispositions stay dead", () => {
    expect(emailRecoveryVerdict(carrierDead({ notes: "operator marked dead: too low" })).reason).toBe(
      "not_carrier_quarantined",
    );
    expect(emailRecoveryVerdict(carrierDead({ outreachStatus: "Walked" })).reason).toBe("not_dead");
  });

  it("one recovery email ever — the sent stamp blocks a second", () => {
    const v = emailRecoveryVerdict(
      carrierDead({ notes: `${QUARANTINE_NOTE}\n\n[H2 email sent 2026-07-10T14:00:00Z] Gmail msg m1: Cash offer — 1505 17th St` }),
    );
    expect(v.reason).toBe("recovery_email_already_sent");
  });

  it("respects opt-out across channels, era, email validity, liveness, market", () => {
    expect(emailRecoveryVerdict(carrierDead({ doNotText: true })).reason).toBe("opted_out");
    expect(emailRecoveryVerdict(carrierDead({ sourceVersion: "v1_legacy" })).reason).toBe("not_v2");
    expect(emailRecoveryVerdict(carrierDead({ agentEmail: "not-an-email" })).reason).toBe("no_valid_email");
    expect(emailRecoveryVerdict(carrierDead({ agentEmail: null })).reason).toBe("no_valid_email");
    expect(emailRecoveryVerdict(carrierDead({ liveStatus: "Off Market" })).reason).toBe("not_active");
    expect(emailRecoveryVerdict(carrierDead({ state: "NC" })).eligible).toBe(false);
  });
});

describe("selectEmailRecoveryCandidates", () => {
  it("oldest quarantine first", () => {
    const older = carrierDead({ id: "recOLDER00000001", lastOutboundAt: "2026-07-05T10:00:00Z" });
    const newer = carrierDead({ id: "recNEWER00000001", lastOutboundAt: "2026-07-09T10:00:00Z" });
    expect(selectEmailRecoveryCandidates([newer, older]).map((l) => l.id)).toEqual([
      "recOLDER00000001",
      "recNEWER00000001",
    ]);
  });
});

describe("buildRecoveryEmail + stamp", () => {
  it("relief-framed letter with the value-anchored number and street only", () => {
    const { subject, body } = buildRecoveryEmail("Angela James", "1505 17th St, Birmingham, AL 35204", 42_250);
    expect(subject).toBe("Cash offer — 1505 17th St");
    expect(body).toContain("cash offer of $42,250 on 1505 17th St");
    expect(body).toContain("close on your timeline");
    expect(body).not.toContain("Birmingham, AL 35204,"); // street only in the ask
  });

  it("the sent stamp appends and marks idempotency", () => {
    const notes = buildEmailSentNote(QUARANTINE_NOTE, "2026-07-11T15:00:00Z", "m123", "Cash offer — 1505 17th St", "Hi Angela,\n\nThis is Alex…");
    expect(notes).toContain("[H2 email sent 2026-07-11T15:00:00Z] Gmail msg m123");
    expect(emailRecoveryVerdict(carrierDead({ notes })).reason).toBe("recovery_email_already_sent");
  });
});
