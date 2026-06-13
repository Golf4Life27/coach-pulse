import { describe, it, expect } from "vitest";
import { decideV21Write } from "./v21-writer-decision";

const base = { liveStatus: "Active", yourMao: null, state: "MI", zip: "48227" };

describe("decideV21Write — Flag-1 landlord-only-on-distress", () => {
  it("distressed (distressScore>0) + priceable + Active + no V21 → WRITE landlord", () => {
    const d = decideV21Write({ ...base, distressScore: 7.4 }, { priceable: true });
    expect(d).toEqual({ write: true, lane: "landlord" });
  });
  it("distressed via condition keyword (disrepair) → WRITE landlord", () => {
    const d = decideV21Write({ ...base, redFlags: ["disrepair"], distressScore: null }, { priceable: true });
    expect(d).toEqual({ write: true, lane: "landlord" });
  });
  it("NO distress signal → flipper HOLD (does NOT borrow landlord lane)", () => {
    const d = decideV21Write({ ...base, distressScore: null }, { priceable: true });
    expect(d).toEqual({ write: false, reason: "flipper_lane_holds_no_comp_arv_math" });
  });
  it("the 5 eyeball records' shape (ARV+rehab present, distress null) → flipper HOLD", () => {
    // Rosemary/Frisbee/etc: no distressScore → flipper → contract HOLD
    expect(decideV21Write({ ...base, zip: "48213", distressScore: null }, { priceable: true }).write).toBe(false);
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
