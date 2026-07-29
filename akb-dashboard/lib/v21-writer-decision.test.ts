import { describe, it, expect } from "vitest";
import { decideV21Write } from "./v21-writer-decision";

const base = { liveStatus: "Active", yourMao: null, state: "MI", zip: "48227" };

describe("decideV21Write — A-prime confidence tiers (single predicate, two tiers)", () => {
  it("distressScore>0 → landlord AUTHORIZED (scored)", () => {
    expect(decideV21Write({ ...base, distressScore: 7.4 }, { priceable: true })).toEqual({ write: true, lane: "landlord" });
  });
  it("score + redflag both → landlord AUTHORIZED (scored wins)", () => {
    expect(decideV21Write({ ...base, distressScore: 4.5, redFlags: ["water_damage"] }, { priceable: true })).toEqual({ write: true, lane: "landlord" });
  });
  it("redflag-only (null score, vision-only) → landlord_PROVISIONAL", () => {
    expect(decideV21Write({ ...base, redFlags: ["water_damage"], distressScore: null }, { priceable: true })).toEqual({ write: true, lane: "landlord_provisional" });
  });
  it("disrepair redflag, null score → provisional (vision-only)", () => {
    expect(decideV21Write({ ...base, redFlags: ["disrepair"], distressScore: null }, { priceable: true })).toEqual({ write: true, lane: "landlord_provisional" });
  });
  it("Rosemary shape (water_damage redflag, null score) → provisional, NOT a clean write", () => {
    const d = decideV21Write({ ...base, zip: "48213", redFlags: ["overgrown_lot", "signs_of_squatting", "water_damage"], distressScore: null }, { priceable: true });
    expect(d).toEqual({ write: true, lane: "landlord_provisional" });
  });
  it("no distress at all (no score, no condition redflag) → flipper HOLD", () => {
    expect(decideV21Write({ ...base, distressScore: null, redFlags: ["debris_present"] }, { priceable: true }))
      .toEqual({ write: false, reason: "flipper_lane_holds_no_comp_arv_math" });
  });
});

describe("decideV21Write — gates", () => {
  it("not priceable → skip", () => {
    expect(decideV21Write({ ...base, distressScore: 10 }, { priceable: false })).toEqual({ write: false, reason: "not_priceable" });
  });
  it("not Active → skip", () => {
    expect(decideV21Write({ ...base, liveStatus: "Off Market", distressScore: 10 }, { priceable: true })).toEqual({ write: false, reason: "not_active" });
  });
  it("idempotent — already has a live Your_MAO_V21 → skip", () => {
    expect(decideV21Write({ ...base, yourMao: 42000, distressScore: 10 }, { priceable: true })).toEqual({ write: false, reason: "already_has_v21" });
  });
});

describe("decideV21Write — reply-triggered re-price (allowReprice bypass)", () => {
  it("allowReprice bypasses the idempotency guard on an already-underwritten record", () => {
    // Same input that skips with already_has_v21 above — but the reply
    // trigger deliberately recomputes, so the guard is lifted.
    expect(decideV21Write({ ...base, yourMao: 42000, distressScore: 10 }, { priceable: true, allowReprice: true }))
      .toEqual({ write: true, lane: "landlord" });
  });
  it("allowReprice preserves the provisional tier (vision-only distress)", () => {
    expect(decideV21Write({ ...base, yourMao: 38000, redFlags: ["water_damage"], distressScore: null }, { priceable: true, allowReprice: true }))
      .toEqual({ write: true, lane: "landlord_provisional" });
  });
  it("allowReprice still respects priceable/active/landlord-track gates", () => {
    // A flipper-track record's re-price is its ARV refresh, never this lane.
    expect(decideV21Write({ ...base, yourMao: 42000, distressScore: null, redFlags: ["debris_present"] }, { priceable: true, allowReprice: true }))
      .toEqual({ write: false, reason: "flipper_lane_holds_no_comp_arv_math" });
    expect(decideV21Write({ ...base, yourMao: 42000, liveStatus: "Off Market", distressScore: 10 }, { priceable: true, allowReprice: true }))
      .toEqual({ write: false, reason: "not_active" });
    expect(decideV21Write({ ...base, yourMao: 42000, distressScore: 10 }, { priceable: false, allowReprice: true }))
      .toEqual({ write: false, reason: "not_priceable" });
  });
});

// ── Spend gates (2026-07-29 audit) ─────────────────────────────────────
// Two defects cost real money on a 1,000-call/month plan running 6,247
// calls in 27 days: (1) this lane checked only Live_Status, so a record the
// operator had KILLED still burned paid calls while the MLS listing stayed
// up; (2) a HOLD wrote no Your_MAO_V21, so the idempotency guard could
// never suppress it and the record re-entered the daily candidate pool
// forever, re-paying for rent and /properties every run.

describe("decideV21Write — graveyard gate", () => {
  const scored = { ...base, distressScore: 7.4 };

  it("refuses a blacklisted (operator-killed) record even while MLS-active", () => {
    expect(decideV21Write({ ...scored, blacklist: true }, { priceable: true }))
      .toEqual({ write: false, reason: "graveyard_status" });
  });

  it("refuses a Do_Not_Text record (carrier opt-out)", () => {
    expect(decideV21Write({ ...scored, doNotText: true }, { priceable: true }))
      .toEqual({ write: false, reason: "graveyard_status" });
  });

  it.each(["Dead", "dead", " Parked ", "PARKED"])(
    "refuses graveyard Outreach_Status %j regardless of case/whitespace",
    (status) => {
      expect(decideV21Write({ ...scored, outreachStatus: status }, { priceable: true }))
        .toEqual({ write: false, reason: "graveyard_status" });
    },
  );

  it("still writes for live deal statuses", () => {
    for (const status of ["Negotiating", "Response Received", "Texted", ""]) {
      expect(decideV21Write({ ...scored, outreachStatus: status }, { priceable: true }))
        .toEqual({ write: true, lane: "landlord" });
    }
  });

  // A kill outranks a seller reply: reprice must not resurrect a dead deal.
  it("refuses a killed record even on the reply-triggered reprice path", () => {
    expect(
      decideV21Write({ ...scored, yourMao: 42000, blacklist: true }, { priceable: true, allowReprice: true }),
    ).toEqual({ write: false, reason: "graveyard_status" });
  });
});

describe("decideV21Write — HOLD backoff", () => {
  const scored = { ...base, distressScore: 7.4 };
  const now = new Date("2026-07-29T00:00:00Z");
  const holdMarker = (day: string) =>
    `[MAO_V2.1 status=hold lane=landlord your_mao=- investor_mao=- cap=- rent=900 taxes=- @${day}]`;

  it("suppresses a record that HELD 1 day ago", () => {
    expect(
      decideV21Write({ ...scored, notes: holdMarker("2026-07-28") }, { priceable: true, now }),
    ).toEqual({ write: false, reason: "hold_backoff" });
  });

  it("suppresses right up to the window edge (13 days)", () => {
    expect(
      decideV21Write({ ...scored, notes: holdMarker("2026-07-16") }, { priceable: true, now }),
    ).toEqual({ write: false, reason: "hold_backoff" });
  });

  // NOT permanent — a missing rehab estimate or tax record can arrive later.
  it("retries once the window has fully elapsed (14 days)", () => {
    expect(
      decideV21Write({ ...scored, notes: holdMarker("2026-07-15") }, { priceable: true, now }),
    ).toEqual({ write: true, lane: "landlord" });
  });

  it("does not suppress on an ok marker — only holds back off", () => {
    const okMarker =
      "[MAO_V2.1 status=ok lane=landlord your_mao=41000 investor_mao=52000 cap=0.0900 rent=900 taxes=1200 @2026-07-28]";
    expect(decideV21Write({ ...scored, notes: okMarker }, { priceable: true, now }))
      .toEqual({ write: true, lane: "landlord" });
  });

  it("ignores a legacy marker with no date stamp rather than blocking forever", () => {
    const legacy = "[MAO_V2.1 status=hold lane=landlord your_mao=- investor_mao=- cap=- rent=- taxes=-]";
    expect(decideV21Write({ ...scored, notes: legacy }, { priceable: true, now }))
      .toEqual({ write: true, lane: "landlord" });
  });

  // A live human outranks a cost heuristic.
  it("a seller-reply reprice bypasses the backoff", () => {
    expect(
      decideV21Write(
        { ...scored, notes: holdMarker("2026-07-28") },
        { priceable: true, allowReprice: true, now },
      ),
    ).toEqual({ write: true, lane: "landlord" });
  });

  it("no notes → no backoff", () => {
    expect(decideV21Write({ ...scored, notes: null }, { priceable: true, now }))
      .toEqual({ write: true, lane: "landlord" });
  });
});
