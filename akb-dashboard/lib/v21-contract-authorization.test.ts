import { describe, it, expect } from "vitest";
import { evaluateV21ContractAuthorization } from "./v21-contract-authorization";
import { extractDDRehabSignals } from "./dd-rehab-signals";
import type { TimelineEntry } from "@/types/jarvis";

const inbound = (body: string): TimelineEntry => ({
  timestamp: "2026-06-13T05:00:00Z", channel: "sms", direction: "in", body,
  sender: "agent", propertyMatch: { recordId: "rec", confidence: 1 },
});
const noDD = extractDDRehabSignals([]);

describe("V21 contract authorization — the enforcement gate", () => {
  it("scored landlord V21 authorizes immediately", () => {
    const v = evaluateV21ContractAuthorization({ v21Value: 42_000, lane: "landlord", ddSignals: noDD });
    expect(v.authorized).toBe(true);
    if (v.authorized) expect(v.basis).toBe("scored_distress");
  });

  it("null V21 never authorizes", () => {
    const v = evaluateV21ContractAuthorization({ v21Value: null, lane: "landlord", ddSignals: noDD });
    expect(v.authorized).toBe(false);
  });

  describe("PROVISIONAL V21 cannot pass until DD promotes (the A-prime proof)", () => {
    it("provisional + NO DD → pending, NOT authorized", () => {
      const v = evaluateV21ContractAuthorization({ v21Value: 42_000, lane: "landlord_provisional", ddSignals: noDD });
      expect(v.authorized).toBe(false);
      if (!v.authorized) expect(v.reason).toBe("provisional_dd_pending");
    });

    it("provisional + agent confirms as-is (original mechanical) → PROMOTED, authorized", () => {
      const dd = extractDDRehabSignals([inbound("Roof original, plumbing is cast iron original")]);
      const v = evaluateV21ContractAuthorization({ v21Value: 42_000, lane: "landlord_provisional", ddSignals: dd });
      expect(v.authorized).toBe(true);
      if (v.authorized) expect(v.basis).toBe("provisional_dd_corroborated");
    });

    it("provisional + agent says renovated (all updated) → CONTRADICTED, NOT authorized (the Rosemary case)", () => {
      const dd = extractDDRehabSignals([inbound("Everything updated — new HVAC, new water heater, electrical replaced 2015, all new PEX plumbing, roof done 2019")]);
      const v = evaluateV21ContractAuthorization({ v21Value: 42_000, lane: "landlord_provisional", ddSignals: dd });
      expect(v.authorized).toBe(false);
      if (!v.authorized) {
        expect(v.reason).toBe("provisional_contradicted_renovated");
        expect(v.detail).toContain("no contract number authorized on a hallucination");
      }
    });
  });
});
