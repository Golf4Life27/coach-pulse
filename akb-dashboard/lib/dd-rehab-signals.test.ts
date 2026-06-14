import { describe, it, expect } from "vitest";
import { extractDDRehabSignals } from "./dd-rehab-signals";
import { narrowRehabBandFromDD, walkthroughBand } from "./dd-rehab-band";
import { evaluateDDOfferGate, CONTRACT_BAND_WIDTH_CEILING } from "./offer-readiness-dd-gate";
import type { TimelineEntry } from "@/types/jarvis";

const inbound = (body: string, ts = "2026-06-13T05:00:00Z"): TimelineEntry => ({
  timestamp: ts,
  channel: "sms",
  direction: "in",
  body,
  sender: "agent",
  propertyMatch: { recordId: "rec", confidence: 1 },
});

describe("extractDDRehabSignals — pulls structured ages out of agent replies", () => {
  it("extracts 'roof 5 years old, electrical updated 2010, plumbing original'", () => {
    const r = extractDDRehabSignals([
      inbound("Roof is 5 years old, electrical was updated in 2010, plumbing is original cast iron"),
    ]);
    expect(r.roof.bucket).toBe("updated_post1980");
    expect(r.electrical.bucket).toBe("updated_post1980");
    expect(r.plumbing.bucket).toBe("original_pre1980");
    expect(r.hvac.bucket).toBe("unknown");
    expect(r.waterHeater.bucket).toBe("unknown");
    expect(r.answeredCount).toBe(3);
  });
  it("knob & tube → original_pre1980 even with 'partially updated' nearby", () => {
    const r = extractDDRehabSignals([
      inbound("Electrical is originally knob and tube, partially updated by previous owner"),
    ]);
    expect(r.electrical.bucket).toBe("original_pre1980");
  });
  it("Rosemary-shape reply: renovated turnkey, all new", () => {
    const r = extractDDRehabSignals([
      inbound("Everything is updated — new HVAC, new water heater, electrical panel was replaced 3 years ago, all new plumbing PEX, roof done in 2019"),
    ]);
    expect(r.hvac.bucket).toBe("updated_post1980");
    expect(r.waterHeater.bucket).toBe("updated_post1980");
    expect(r.electrical.bucket).toBe("updated_post1980");
    expect(r.plumbing.bucket).toBe("updated_post1980");
    expect(r.roof.bucket).toBe("updated_post1980");
    expect(r.answeredCount).toBe(5);
  });
  it("no DD answer at all → all unknown, count 0", () => {
    const r = extractDDRehabSignals([inbound("Send your best offer in writing.")]);
    expect(r.answeredCount).toBe(0);
  });
  it("ignores outbound messages", () => {
    const out: TimelineEntry = { ...inbound("Roof 1 year old"), direction: "out" };
    expect(extractDDRehabSignals([out]).answeredCount).toBe(0);
  });
  it("newest answer wins per mechanical", () => {
    const r = extractDDRehabSignals([
      inbound("Roof original from 1929", "2026-06-10T00:00:00Z"),
      inbound("Sorry I was wrong, roof was replaced 2 years ago", "2026-06-13T00:00:00Z"),
    ]);
    expect(r.roof.bucket).toBe("updated_post1980");
  });
  it("ROOF-only answer doesn't claim electrical as updated", () => {
    const r = extractDDRehabSignals([inbound("Roof is new")]);
    expect(r.roof.bucket).toBe("updated_post1980");
    expect(r.electrical.bucket).toBe("unknown");
  });
});

describe("narrowRehabBandFromDD — band shrinks per answered mechanical", () => {
  const start = { low: 15_000, mid: 30_000, high: 45_000 }; // photos-only ±50%
  it("zero DD answers → band unchanged source=photos_only", () => {
    const r = extractDDRehabSignals([]);
    const b = narrowRehabBandFromDD(start, r);
    expect(b.source).toBe("photos_only");
    expect(b.mid).toBe(30_000);
    expect(b.rationale.toLowerCase()).toContain("photos only");
  });
  it("all 5 updated (Rosemary turnkey shape) → mid drops, band narrows hard", () => {
    const r = extractDDRehabSignals([
      inbound("New HVAC, new water heater, electrical panel replaced 3 years ago, all new plumbing, roof done in 2019"),
    ]);
    const b = narrowRehabBandFromDD(start, r);
    expect(b.source).toBe("photos_plus_dd");
    expect(b.mid).toBeLessThan(start.mid);
    expect(b.widthPct).toBeLessThan(0.50);
  });
  it("all 5 original → mid rises", () => {
    const r = extractDDRehabSignals([
      inbound("Roof original. HVAC original. Water heater original. Knob and tube electrical. Cast iron plumbing."),
    ]);
    const b = narrowRehabBandFromDD(start, r);
    expect(b.mid).toBeGreaterThan(start.mid);
  });
});

describe("walkthroughBand — ±10% contractor variance", () => {
  it("$22,000 walkthrough → $19,800–$24,200", () => {
    const b = walkthroughBand(22_000);
    expect(b.low).toBe(19_800);
    expect(b.high).toBe(24_200);
    expect(b.widthPct).toBeCloseTo(0.10, 2);
    expect(b.source).toBe("walkthrough");
  });
});

describe("evaluateDDOfferGate — door_opener passes, contract is gated", () => {
  const noAnswers = extractDDRehabSignals([]);
  const fullAnswers = extractDDRehabSignals([
    inbound("Roof 5 yrs, HVAC 8 yrs, water heater 3 yrs, electrical updated 2015, plumbing PEX new"),
  ]);
  const start = { low: 15_000, mid: 30_000, high: 45_000 };

  it("door_opener always passes (DD is collected via the opener loop)", () => {
    const v = evaluateDDOfferGate("door_opener", noAnswers, narrowRehabBandFromDD(start, noAnswers));
    expect(v.ok).toBe(true);
  });
  it("contract with photos_only band → HOLD", () => {
    const v = evaluateDDOfferGate("contract", noAnswers, narrowRehabBandFromDD(start, noAnswers));
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.missing).toContain("dd_volley_started_no_answers");
      expect(v.missing).toContain("rehab_band_unnarrowed_by_dd_or_walkthrough");
    }
  });
  it("contract with walkthrough band → ok even without DD answers", () => {
    const v = evaluateDDOfferGate("contract", noAnswers, walkthroughBand(22_000));
    expect(v.ok).toBe(true);
  });
  it("contract with DD-narrowed band that's still > ±25% → HOLD with band-too-wide reason", () => {
    const wide = { low: 0, mid: 30_000, high: 80_000 }; // ±83%
    const v = evaluateDDOfferGate("contract", fullAnswers, narrowRehabBandFromDD(wide, fullAnswers));
    if (!v.ok) {
      expect(v.missing.some((m) => m.startsWith("rehab_band_too_wide"))).toBe(true);
    }
  });
  it(`contract band-width ceiling is ${CONTRACT_BAND_WIDTH_CEILING * 100}% per doctrine`, () => {
    expect(CONTRACT_BAND_WIDTH_CEILING).toBe(0.25);
  });
});
