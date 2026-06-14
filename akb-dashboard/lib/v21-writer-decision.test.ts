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
