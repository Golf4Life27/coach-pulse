// @agent: orchestrator — stale-deal self-triage classifier tests.
import { describe, it, expect } from "vitest";
import {
  detectDecline,
  lastMovementMs,
  isStale,
  classifyStaleDeal,
  alreadyTriaged,
  buildTriageNote,
  appendTriageNote,
  STALE_DAYS_DEFAULT,
  STALE_TRIAGE_SENTINEL,
  type StaleClassifyInput,
} from "./stale-triage";

describe("detectDecline", () => {
  it("flags an explicit pass", () => {
    const d = detectDecline("Thanks but we'll pass on this one.");
    expect(d.declined).toBe(true);
    expect(d.matched).toBe("we'll pass");
  });
  it("flags a gone-listing (under contract)", () => {
    expect(detectDecline("Sorry, it's already under contract.").declined).toBe(true);
  });
  it("flags do-not-contact", () => {
    expect(detectDecline("Please do not contact me again").declined).toBe(true);
  });
  it("is case-insensitive", () => {
    expect(detectDecline("NOT INTERESTED").declined).toBe(true);
  });
  it("does NOT flag a neutral / interested reply", () => {
    expect(detectDecline("Sure, send me the offer and I'll review it.").declined).toBe(false);
    expect(detectDecline("What's your number?").declined).toBe(false);
  });
  it("does NOT flag empty / null", () => {
    expect(detectDecline(null).declined).toBe(false);
    expect(detectDecline("").declined).toBe(false);
    expect(detectDecline(undefined).declined).toBe(false);
  });
});

describe("lastMovementMs / isStale", () => {
  const now = new Date("2026-06-05T00:00:00.000Z");

  it("picks the most-recent timestamp across all activity fields", () => {
    const ms = lastMovementMs({
      lastInboundAt: "2026-05-01T00:00:00.000Z",
      lastOutboundAt: "2026-06-01T00:00:00.000Z",
      lastOutreachDate: "2026-04-01T00:00:00.000Z",
    });
    expect(ms).toBe(Date.parse("2026-06-01T00:00:00.000Z"));
  });

  it("returns null when no timestamps present", () => {
    expect(lastMovementMs({})).toBeNull();
  });

  it("a record with NO movement is stale (never moved)", () => {
    const r = isStale({}, now);
    expect(r.stale).toBe(true);
    expect(r.daysSinceMovement).toBeNull();
  });

  it("fresh movement (<14d) is NOT stale", () => {
    const r = isStale({ lastInboundAt: "2026-06-01T00:00:00.000Z" }, now);
    expect(r.stale).toBe(false);
    expect(r.daysSinceMovement).toBe(4);
  });

  it("old movement (>14d) IS stale", () => {
    const r = isStale({ lastOutboundAt: "2026-04-01T00:00:00.000Z" }, now);
    expect(r.stale).toBe(true);
    expect(r.daysSinceMovement).toBe(65); // 2119 Palo Alto profile
  });

  it("exactly 14d is NOT stale (strict >)", () => {
    const last = new Date(now.getTime() - STALE_DAYS_DEFAULT * 86_400_000).toISOString();
    expect(isStale({ lastInboundAt: last }, now).stale).toBe(false);
  });
});

describe("classifyStaleDeal — terminal signals dispose", () => {
  const base: StaleClassifyInput = {
    isActive: true,
    mlsActive: true,
    declined: false,
    hasResponded: false,
    landlordYourMao: null,
  };

  it("delisted (Live_Status not active) → dispose_dead/delisted", () => {
    const r = classifyStaleDeal({ ...base, isActive: false });
    expect(r.verdict).toBe("dispose_dead");
    expect(r.disposeCategory).toBe("delisted");
  });

  it("off-market (MLS not active) → dispose_dead/delisted", () => {
    const r = classifyStaleDeal({ ...base, mlsActive: false });
    expect(r.verdict).toBe("dispose_dead");
    expect(r.disposeCategory).toBe("delisted");
  });

  it("declined reply → dispose_dead/declined_reply, reason carries the phrase", () => {
    const r = classifyStaleDeal({ ...base, declined: true, declineMatch: "not interested" });
    expect(r.verdict).toBe("dispose_dead");
    expect(r.disposeCategory).toBe("declined_reply");
    expect(r.reason).toContain("not interested");
  });

  it("uneconomic NEGATIVE landlord MAO → dispose_dead/uneconomic_negative_spread", () => {
    const r = classifyStaleDeal({ ...base, landlordYourMao: -12000 });
    expect(r.verdict).toBe("dispose_dead");
    expect(r.disposeCategory).toBe("uneconomic_negative_spread");
  });

  it("zero landlord MAO disposes (≤0)", () => {
    expect(classifyStaleDeal({ ...base, landlordYourMao: 0 }).verdict).toBe("dispose_dead");
  });

  it("a POSITIVE landlord MAO does NOT dispose (Callaghan +$43,500 case)", () => {
    // Callaghan with corrected $4,515 taxes / 10% cap = +$43,500 → NOT uneconomic.
    const r = classifyStaleDeal({ ...base, landlordYourMao: 43500 });
    expect(r.verdict).not.toBe("dispose_dead");
  });

  it("null (uncomputable) landlord MAO NEVER disposes — falls through", () => {
    const r = classifyStaleDeal({ ...base, landlordYourMao: null, hasResponded: false });
    expect(r.verdict).not.toBe("dispose_dead");
  });

  it("uncomputable economics arrive as null, not a legacy negative (V2.1 quarantine contract)", () => {
    // The route NO LONGER reads the legacy Your_MAO / Real_ARV_Median fields
    // (quarantined — old ARV formula, banned AVM basis). It computes the
    // V2.1 landlord MAO fresh and passes it ONLY when status==="ok"; a HOLD
    // (missing rent/taxes/cap/rehab, or NOI≤0) arrives as null. This pins
    // the contract: null never disposes; a real V2.1 negative (the genuine
    // dispose signal, e.g. Dreamland once its rent is persisted) does.
    const uncomputable = classifyStaleDeal({ ...base, landlordYourMao: null, hasResponded: true });
    expect(uncomputable.verdict).toBe("hold");
    const realV21Negative = classifyStaleDeal({ ...base, landlordYourMao: -12556, hasResponded: true });
    expect(realV21Negative.verdict).toBe("dispose_dead");
  });
});

describe("classifyStaleDeal — re-engage lane", () => {
  it("active + MLS-active + no prior response → reengage_queue (flag only)", () => {
    const r = classifyStaleDeal({
      isActive: true,
      mlsActive: true,
      declined: false,
      hasResponded: false,
      landlordYourMao: 43500,
    });
    expect(r.verdict).toBe("reengage_queue");
    expect(r.disposeCategory).toBeNull();
    expect(r.reason).toContain("outreach stays OFF");
  });
});

describe("classifyStaleDeal — HOLD (conservative default)", () => {
  it("responded then went cold → hold (ambiguous, not a clean dispose)", () => {
    const r = classifyStaleDeal({
      isActive: true,
      mlsActive: true,
      declined: false,
      hasResponded: true,
      landlordYourMao: null,
    });
    expect(r.verdict).toBe("hold");
    expect(r.disposeCategory).toBeNull();
    expect(r.reason).toContain("cold");
  });

  it("never disposes on a positive-but-stale responded deal", () => {
    const r = classifyStaleDeal({
      isActive: true,
      mlsActive: true,
      declined: false,
      hasResponded: true,
      landlordYourMao: 50000,
    });
    expect(r.verdict).toBe("hold");
  });
});

describe("classifyStaleDeal — precedence", () => {
  it("delisted beats everything (even a positive MAO + responded)", () => {
    const r = classifyStaleDeal({
      isActive: false,
      mlsActive: true,
      declined: false,
      hasResponded: true,
      landlordYourMao: 50000,
    });
    expect(r.disposeCategory).toBe("delisted");
  });

  it("blacklist beats EVERYTHING — even responded + positive MAO + active listing", () => {
    // Burwood-class: corporate seller on never-resurface list, still
    // texted/active. Blacklist is a Canon §9 sourced fact (operator-curated,
    // explicit list — zero false-positive risk, not the inference we avoided).
    const r = classifyStaleDeal({
      isActive: true,
      mlsActive: true,
      declined: false,
      hasResponded: true,
      landlordYourMao: 50000,
      onBlacklist: true,
    });
    expect(r.verdict).toBe("dispose_dead");
    expect(r.disposeCategory).toBe("blacklist");
    expect(r.reason).toContain("blocklist");
  });

  it("blacklist disposes even when delisted (would've been delisted anyway, but reason is more specific)", () => {
    const r = classifyStaleDeal({
      isActive: false,
      mlsActive: false,
      declined: false,
      hasResponded: false,
      landlordYourMao: null,
      onBlacklist: true,
    });
    expect(r.disposeCategory).toBe("blacklist");
  });

  it("non-blacklist (onBlacklist omitted) behaves exactly as before", () => {
    const r = classifyStaleDeal({
      isActive: true,
      mlsActive: true,
      declined: false,
      hasResponded: false,
      landlordYourMao: null,
    });
    expect(r.verdict).toBe("reengage_queue");
  });

  it("declined beats uneconomic", () => {
    const r = classifyStaleDeal({
      isActive: true,
      mlsActive: true,
      declined: true,
      declineMatch: "not selling",
      landlordYourMao: -5000,
      hasResponded: false,
    });
    expect(r.disposeCategory).toBe("declined_reply");
  });
});

describe("annotation helpers (idempotent durability)", () => {
  const now = new Date("2026-06-05T00:00:00.000Z");
  const disposeResult = classifyStaleDeal({
    isActive: false,
    mlsActive: true,
    declined: false,
    hasResponded: false,
    landlordYourMao: null,
  });

  it("buildTriageNote stamps the sentinel, verdict tag, reason, and age", () => {
    const line = buildTriageNote(disposeResult, 65, now);
    expect(line).toContain(STALE_TRIAGE_SENTINEL);
    expect(line).toContain("DISPOSE→DEAD");
    expect(line).toContain("delisted");
    expect(line).toContain("65d stale");
    expect(line).toContain("2026-06-05");
  });

  it("buildTriageNote handles null movement age", () => {
    expect(buildTriageNote(disposeResult, null, now)).toContain("no recorded movement");
  });

  it("alreadyTriaged detects a prior annotation (skip on re-sweep)", () => {
    const line = buildTriageNote(disposeResult, 65, now);
    expect(alreadyTriaged(null)).toBe(false);
    expect(alreadyTriaged("some other notes")).toBe(false);
    expect(alreadyTriaged(line)).toBe(true);
  });

  it("appendTriageNote preserves existing notes, blank-line separated", () => {
    const line = buildTriageNote(disposeResult, 65, now);
    expect(appendTriageNote(null, line)).toBe(line);
    expect(appendTriageNote("prior context", line)).toBe(`prior context\n\n${line}`);
  });

  it("re-sweep is a no-op: appended notes already contain the sentinel", () => {
    const line = buildTriageNote(disposeResult, 65, now);
    const after = appendTriageNote("prior", line);
    expect(alreadyTriaged(after)).toBe(true);
  });
});
